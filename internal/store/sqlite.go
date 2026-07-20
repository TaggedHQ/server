package store

import (
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/TaggedHQ/server/internal/util"
)

// SQLiteBackend is the "Simple Server": one SQLite file per user under
// rootUserDir, byte-compatible with the original itemdb schema.
type SQLiteBackend struct {
	rootUserDir string
}

// NewSQLiteBackend returns a backend rooted at rootUserDir (the caller has
// already created the directory).
func NewSQLiteBackend(rootUserDir string) (*SQLiteBackend, error) {
	return &SQLiteBackend{rootUserDir: rootUserDir}, nil
}

func (b *SQLiteBackend) userDBPath(username string) string {
	return util.User2Filename(b.rootUserDir, username)
}

// UserDB opens (creating if needed) the user's file and ensures all tables exist.
func (b *SQLiteBackend) UserDB(username string) (UserDB, error) {
	idb, err := Open(b.userDBPath(username))
	if err != nil {
		return nil, err
	}
	if err := ensureAllTables(idb); err != nil {
		idb.Close()
		return nil, err
	}
	return &sqliteUserDB{idb: idb}, nil
}

// ensureAllTables creates the three Python-era tables with the same indices as
// the Python server, so existing database files stay byte-compatible, plus the
// skills table this server adds on top.
func ensureAllTables(idb *ItemDB) error {
	if err := idb.EnsureTable(TableUserinfo, "!key", "st"); err != nil {
		return err
	}
	if err := idb.EnsureTable(TableRecords, "!key", "st", "t1", "t2"); err != nil {
		return err
	}
	if err := idb.EnsureTable(TableSettings, "!key", "st"); err != nil {
		return err
	}
	return idb.EnsureTable(TableSkills, "!key", "st")
}

// ListUsers enumerates the *.db files in rootUserDir.
func (b *SQLiteBackend) ListUsers() ([]UserMeta, error) {
	entries, err := os.ReadDir(b.rootUserDir)
	if err != nil {
		return nil, err
	}
	var users []UserMeta
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".db") {
			continue // skip -wal/-shm/-journal siblings and dirs
		}
		username, err := util.Filename2User(name)
		if err != nil {
			continue
		}
		row := UserMeta{Username: username}
		if info, err := e.Info(); err == nil {
			row.SizeBytes = info.Size()
			row.Modified = info.ModTime().Unix()
		}
		users = append(users, row)
	}
	return users, nil
}

// DeleteUser removes the user's database and its SQLite sidecar files.
func (b *SQLiteBackend) DeleteUser(username string) error {
	base := b.userDBPath(username)
	found := false
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err := os.Remove(base + suffix); err == nil {
			if suffix == "" {
				found = true
			}
		} else if suffix == "" && !os.IsNotExist(err) {
			return err
		}
	}
	if !found {
		return ErrUserNotFound
	}
	return nil
}

// Close is a no-op; SQLite handles are per-user and closed via UserDB.Close.
func (b *SQLiteBackend) Close() error { return nil }

// sqliteUserDB adapts *ItemDB to the UserDB interface.
type sqliteUserDB struct {
	idb *ItemDB
}

func (u *sqliteUserDB) Mtime() float64 { return u.idb.Mtime() }
func (u *sqliteUserDB) Close() error   { return u.idb.Close() }

func (u *sqliteUserDB) Get(table, key string) (Item, error) {
	return u.idb.SelectOne(u.idb.DB(), table, "key = ?", key)
}

func (u *sqliteUserDB) All(table string) ([]Item, error) {
	return u.idb.SelectAll(u.idb.DB(), table)
}

func (u *sqliteUserDB) ItemsSince(table string, since float64) ([]Item, error) {
	return u.idb.Select(u.idb.DB(), table, "st >= "+strconv.FormatFloat(since, 'f', -1, 64))
}

// QueryRecords builds the same predicate as the Python get_records: a timerange
// clause plus optional tag/running/hidden filters. The tag LIKE pattern is
// embedded as a literal because modernc.org/sqlite mishandles a bound pattern on
// the RHS of LIKE (see the memory note); metacharacters are escaped first.
func (u *sqliteUserDB) QueryRecords(f RecordFilter) ([]Item, error) {
	var parts []string
	parts = append(parts, fmt.Sprintf(
		"(t2 >= %d AND t1 <= %d) OR (t1 == t2 AND t1 <= %d)", f.T1, f.T2, f.T2))
	for _, tag := range f.Tags {
		esc := escapeLike(tag)
		p1 := sqlQuote("%#" + esc + " %")
		p2 := sqlQuote("%#" + esc)
		parts = append(parts, fmt.Sprintf(
			"json_extract(_ob, '$.ds') LIKE %s ESCAPE '\\' OR json_extract(_ob, '$.ds') LIKE %s ESCAPE '\\'",
			p1, p2))
	}
	if f.Running != nil && *f.Running {
		parts = append(parts, "t1 == t2")
	}
	if f.Running != nil && !*f.Running {
		parts = append(parts, "t1 != t2")
	}
	if f.Hidden != nil && *f.Hidden {
		parts = append(parts, "json_extract(_ob, '$.ds') LIKE 'HIDDEN%'")
	}
	if f.Hidden != nil && !*f.Hidden {
		parts = append(parts, "json_extract(_ob, '$.ds') NOT LIKE 'HIDDEN%'")
	}
	for i, p := range parts {
		parts[i] = "(" + p + ")"
	}
	return u.idb.Select(u.idb.DB(), TableRecords, strings.Join(parts, " AND "))
}

func (u *sqliteUserDB) Write(fn func(WTx) error) error {
	tx, err := u.idb.Begin()
	if err != nil {
		return err
	}
	if err := fn(&sqliteTx{idb: u.idb, tx: tx}); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// sqliteTx is the write side of a transaction.
type sqliteTx struct {
	idb *ItemDB
	tx  *sql.Tx
}

func (t *sqliteTx) Get(table, key string) (Item, error) {
	return t.idb.SelectOne(t.tx, table, "key = ?", key)
}

func (t *sqliteTx) Upsert(table string, item Item) error {
	return t.idb.Put(t.tx, table, item)
}

// escapeLike escapes the LIKE metacharacters (\, %, _) so a tag can be embedded
// in a `LIKE ... ESCAPE '\'` pattern. Mirrors the escaping the Python server
// applies before binding.
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "%", "\\%")
	s = strings.ReplaceAll(s, "_", "\\_")
	return s
}

// sqlQuote wraps s in single quotes as a SQL string literal, doubling embedded
// single quotes so the literal is injection-safe.
func sqlQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
