// Package store is a minimal Go port of the `itemdb` Python library, limited to
// the surface that the timetagger server uses. It reproduces itemdb's exact
// SQLite schema so that database files remain byte-compatible with the Python
// server and the existing client sync protocol keeps working:
//
//	CREATE TABLE IF NOT EXISTS <name> (_ob TEXT NOT NULL, <key> NOT NULL PRIMARY KEY) WITHOUT ROWID;
//	ALTER TABLE <name> ADD <index>;          -- for each non-unique index
//	CREATE INDEX IF NOT EXISTS idx_<name>_<index> ON <name> (<index>);
//
// Items are stored as JSON in the `_ob` column; indexed fields are also written
// to their own columns for fast querying. Writes go through INSERT OR REPLACE,
// upserting on the primary key.
package store

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

// Item is a single stored object.
type Item = map[string]any

// executor abstracts *sql.DB and *sql.Tx so read/write helpers work with either.
type executor interface {
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

// ItemDB is a connection to a single per-user SQLite database file.
type ItemDB struct {
	db       *sql.DB
	mtime    float64
	indices  map[string][]string // table -> plain index field names (order stable)
	uniqueed map[string][]string // table -> unique index field names
}

// Open opens (creating if needed) the database at filename. mtime is captured
// from the file BEFORE the connection is made, matching itemdb.__init__, so the
// /updates early-exit behaves identically.
func Open(filename string) (*ItemDB, error) {
	mtime := float64(-1)
	if fi, err := os.Stat(filename); err == nil && !fi.IsDir() {
		mtime = float64(fi.ModTime().UnixNano()) / 1e9
	}
	db, err := sql.Open("sqlite", filename)
	if err != nil {
		return nil, err
	}
	// A single connection per file avoids SQLite lock contention within a
	// request, matching the Python one-connection-per-request model.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout=60000"); err != nil {
		db.Close()
		return nil, err
	}
	return &ItemDB{
		db:       db,
		mtime:    mtime,
		indices:  map[string][]string{},
		uniqueed: map[string][]string{},
	}, nil
}

// Close closes the underlying connection.
func (d *ItemDB) Close() error { return d.db.Close() }

// Mtime returns the file modification time captured at Open, as a Unix
// timestamp (float seconds), or -1 if the file did not exist.
func (d *ItemDB) Mtime() float64 { return d.mtime }

// EnsureTable creates the table (if missing) with the given indices and records
// the index metadata for later Put calls. Index names prefixed with "!" are
// required+unique. Mirrors itemdb.ensure_table / _ensure_table_helper2.
func (d *ItemDB) EnsureTable(name string, indices ...string) error {
	var unique []string
	var plain []string
	for _, idx := range indices {
		key := strings.TrimPrefix(idx, "!")
		plain = append(plain, key)
		if strings.HasPrefix(idx, "!") {
			unique = append(unique, key)
		}
	}
	sort.Strings(unique)

	var b strings.Builder
	b.WriteString(fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s (_ob TEXT NOT NULL", name))
	if len(unique) == 1 {
		b.WriteString(fmt.Sprintf(", %s NOT NULL PRIMARY KEY) WITHOUT ROWID;", unique[0]))
	} else {
		for _, k := range unique {
			b.WriteString(fmt.Sprintf(", %s NOT NULL UNIQUE", k))
		}
		b.WriteString(");")
	}
	if _, err := d.db.Exec(b.String()); err != nil {
		return err
	}

	// Discover existing columns.
	existing, err := d.tableColumns(name)
	if err != nil {
		return err
	}

	sortedIdx := append([]string(nil), indices...)
	sort.Strings(sortedIdx)
	for _, idx := range sortedIdx {
		key := strings.TrimPrefix(idx, "!")
		if _, ok := existing[key]; !ok {
			if strings.HasPrefix(idx, "!") {
				return fmt.Errorf("cannot add unique index %q after the table has been created", idx)
			}
			if _, err := d.db.Exec(fmt.Sprintf("ALTER TABLE %s ADD %s;", name, key)); err != nil {
				return err
			}
		}
		if _, err := d.db.Exec(fmt.Sprintf(
			"CREATE INDEX IF NOT EXISTS idx_%s_%s ON %s (%s)", name, key, name, key,
		)); err != nil {
			return err
		}
	}

	d.indices[name] = plain
	d.uniqueed[name] = unique
	return nil
}

func (d *ItemDB) tableColumns(name string) (map[string]struct{}, error) {
	rows, err := d.db.Query(fmt.Sprintf("PRAGMA table_info('%s')", name))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := map[string]struct{}{}
	for rows.Next() {
		var cid int
		var colName, colType string
		var notnull, pk int
		var dflt any
		if err := rows.Scan(&cid, &colName, &colType, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols[colName] = struct{}{}
	}
	return cols, rows.Err()
}

// Begin starts a transaction for writes.
func (d *ItemDB) Begin() (*sql.Tx, error) { return d.db.Begin() }

// jsonEncode serializes an item to JSON. itemdb uses ensure_ascii=True; we emit
// UTF-8 (valid JSON either way) and disable Go's HTML escaping so descriptions
// containing '&', '<', '>' round-trip literally.
func jsonEncode(item Item) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(item); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// Put upserts one item into the table, within the given transaction. Only fields
// that match an index are written to their own columns; the full item always
// goes to _ob. Mirrors itemdb.put.
func (d *ItemDB) Put(x executor, table string, item Item) error {
	blob, err := jsonEncode(item)
	if err != nil {
		return err
	}
	cols := []string{"_ob"}
	vals := []any{blob}
	uniqueSet := map[string]struct{}{}
	for _, u := range d.uniqueed[table] {
		uniqueSet[u] = struct{}{}
	}
	for _, key := range d.indices[table] {
		if v, ok := item[key]; ok {
			cols = append(cols, key)
			vals = append(vals, v)
		} else if _, isUnique := uniqueSet[key]; isUnique {
			return fmt.Errorf("item does not have required field %q", key)
		}
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(vals)), ", ")
	q := fmt.Sprintf("INSERT OR REPLACE INTO %s (%s) VALUES (%s)",
		table, strings.Join(cols, ", "), placeholders)
	_, err = x.Exec(q, vals...)
	return err
}

// PutOne is a convenience wrapper matching itemdb.put_one.
func (d *ItemDB) PutOne(x executor, table string, item Item) error {
	return d.Put(x, table, item)
}

// Select runs `SELECT _ob FROM <table> WHERE <query>` with the given args and
// returns the decoded items.
func (d *ItemDB) Select(x executor, table, query string, args ...any) ([]Item, error) {
	return scanItems(x, fmt.Sprintf("SELECT _ob FROM %s WHERE %s", table, query), args...)
}

// SelectAll returns every item in the table.
func (d *ItemDB) SelectAll(x executor, table string) ([]Item, error) {
	return scanItems(x, fmt.Sprintf("SELECT _ob FROM %s", table))
}

// SelectOne returns the first matching item, or nil if none match.
func (d *ItemDB) SelectOne(x executor, table, query string, args ...any) (Item, error) {
	items, err := scanItems(x, fmt.Sprintf("SELECT _ob FROM %s WHERE %s LIMIT 1", table, query), args...)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return items[0], nil
}

// DB exposes the underlying *sql.DB so callers can pass it as an executor for
// non-transactional reads.
func (d *ItemDB) DB() *sql.DB { return d.db }

func scanItems(x executor, query string, args ...any) ([]Item, error) {
	rows, err := x.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		var blob string
		if err := rows.Scan(&blob); err != nil {
			return nil, err
		}
		var item Item
		if err := json.Unmarshal([]byte(blob), &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
