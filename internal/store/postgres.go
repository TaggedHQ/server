package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver
)

// PostgresBackend is the "Performance Server": a single connection pool over
// shared, multi-tenant tables keyed by username. Items are stored as JSONB in
// the same `_ob` shape as the SQLite backend, so the HTTP API is unchanged.
type PostgresBackend struct {
	db *sql.DB
}

// pgSchema is the idempotent DDL applied once at startup.
const pgSchema = `
CREATE TABLE IF NOT EXISTS userinfo (
    username text NOT NULL,
    key      text NOT NULL,
    st       double precision,
    _ob      jsonb NOT NULL,
    PRIMARY KEY (username, key)
);
CREATE INDEX IF NOT EXISTS idx_userinfo_user_st ON userinfo (username, st);

CREATE TABLE IF NOT EXISTS records (
    username text NOT NULL,
    key      text NOT NULL,
    st       double precision,
    t1       bigint,
    t2       bigint,
    _ob      jsonb NOT NULL,
    PRIMARY KEY (username, key)
);
CREATE INDEX IF NOT EXISTS idx_records_user_st ON records (username, st);
CREATE INDEX IF NOT EXISTS idx_records_user_t  ON records (username, t1, t2);

CREATE TABLE IF NOT EXISTS settings (
    username text NOT NULL,
    key      text NOT NULL,
    st       double precision,
    _ob      jsonb NOT NULL,
    PRIMARY KEY (username, key)
);
CREATE INDEX IF NOT EXISTS idx_settings_user_st ON settings (username, st);

CREATE TABLE IF NOT EXISTS skills (
    username text NOT NULL,
    key      text NOT NULL,
    st       double precision,
    _ob      jsonb NOT NULL,
    PRIMARY KEY (username, key)
);
CREATE INDEX IF NOT EXISTS idx_skills_user_st ON skills (username, st);

CREATE TABLE IF NOT EXISTS users (
    username text PRIMARY KEY,
    mtime    double precision
);
`

// NewPostgresBackend dials dbURL, tunes the pool, and applies the schema.
func NewPostgresBackend(dbURL string) (*PostgresBackend, error) {
	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		return nil, err
	}
	// A pool is the whole point of the Performance Server: many concurrent
	// requests share these connections instead of contending on one file.
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(time.Hour)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("connecting to postgres: %w", err)
	}
	if _, err := db.Exec(pgSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("applying postgres schema: %w", err)
	}
	return &PostgresBackend{db: db}, nil
}

// UserDB returns a handle for username. It reads the user's mtime once (matching
// the SQLite "captured at open" semantics) so a write during the request does
// not retroactively change the /updates early-exit.
func (b *PostgresBackend) UserDB(username string) (UserDB, error) {
	mtime := float64(-1)
	row := b.db.QueryRow(`SELECT mtime FROM users WHERE username = $1`, username)
	var m sql.NullFloat64
	if err := row.Scan(&m); err != nil {
		if err != sql.ErrNoRows {
			return nil, err
		}
	} else if m.Valid {
		mtime = m.Float64
	}
	return &pgUserDB{db: b.db, username: username, mtime: mtime}, nil
}

// ListUsers returns one row per user, with an approximate storage size.
func (b *PostgresBackend) ListUsers() ([]UserMeta, error) {
	rows, err := b.db.Query(`
		SELECT u.username, COALESCE(u.mtime, 0),
		       COALESCE(r.sz, 0) + COALESCE(s.sz, 0) + COALESCE(i.sz, 0) AS size
		FROM users u
		LEFT JOIN (SELECT username, sum(length(_ob::text)) sz FROM records  GROUP BY username) r ON r.username = u.username
		LEFT JOIN (SELECT username, sum(length(_ob::text)) sz FROM settings GROUP BY username) s ON s.username = u.username
		LEFT JOIN (SELECT username, sum(length(_ob::text)) sz FROM userinfo GROUP BY username) i ON i.username = u.username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []UserMeta
	for rows.Next() {
		var m UserMeta
		var mtime float64
		if err := rows.Scan(&m.Username, &mtime, &m.SizeBytes); err != nil {
			return nil, err
		}
		m.Modified = int64(mtime)
		users = append(users, m)
	}
	return users, rows.Err()
}

// DeleteUser removes all of a user's rows across every table in one tx. Skills
// are included: a deleted account drops out of the open skill list with it.
func (b *PostgresBackend) DeleteUser(username string) error {
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	var affected int64
	for _, table := range []string{TableRecords, TableSettings, TableUserinfo, TableSkills, "users"} {
		res, err := tx.Exec(`DELETE FROM `+table+` WHERE username = $1`, username)
		if err != nil {
			tx.Rollback()
			return err
		}
		if n, err := res.RowsAffected(); err == nil {
			affected += n
		}
	}
	if affected == 0 {
		tx.Rollback()
		return ErrUserNotFound
	}
	return tx.Commit()
}

// Close closes the connection pool.
func (b *PostgresBackend) Close() error { return b.db.Close() }

// pgUserDB is a per-user view over the shared pool.
type pgUserDB struct {
	db       *sql.DB
	username string
	mtime    float64
}

func (u *pgUserDB) Mtime() float64 { return u.mtime }
func (u *pgUserDB) Close() error   { return nil } // the pool outlives the handle

func (u *pgUserDB) Get(table, key string) (Item, error) {
	return pgSelectOne(u.db, `SELECT _ob FROM `+table+` WHERE username = $1 AND key = $2`, u.username, key)
}

func (u *pgUserDB) All(table string) ([]Item, error) {
	return pgScan(u.db, `SELECT _ob FROM `+table+` WHERE username = $1`, u.username)
}

func (u *pgUserDB) ItemsSince(table string, since float64) ([]Item, error) {
	return pgScan(u.db, `SELECT _ob FROM `+table+` WHERE username = $1 AND st >= $2`, u.username, since)
}

// QueryRecords mirrors the SQLite predicate but binds the LIKE patterns as
// parameters (Postgres has no bound-parameter LIKE bug) and reads `ds` from the
// JSONB column.
func (u *pgUserDB) QueryRecords(f RecordFilter) ([]Item, error) {
	args := []any{u.username}
	n := 1
	next := func(v any) int { args = append(args, v); n++; return n }

	var parts []string
	p1, p2, p3 := next(f.T1), next(f.T2), next(f.T2)
	parts = append(parts, fmt.Sprintf("((t2 >= $%d AND t1 <= $%d) OR (t1 = t2 AND t1 <= $%d))", p1, p2, p3))

	for _, tag := range f.Tags {
		esc := escapeLike(tag)
		a := next("%#" + esc + " %")
		b := next("%#" + esc)
		parts = append(parts, fmt.Sprintf(
			`(_ob->>'ds' LIKE $%d ESCAPE '\' OR _ob->>'ds' LIKE $%d ESCAPE '\')`, a, b))
	}
	if f.Running != nil {
		if *f.Running {
			parts = append(parts, "t1 = t2")
		} else {
			parts = append(parts, "t1 <> t2")
		}
	}
	if f.Hidden != nil {
		if *f.Hidden {
			parts = append(parts, "_ob->>'ds' LIKE 'HIDDEN%'")
		} else {
			parts = append(parts, "_ob->>'ds' NOT LIKE 'HIDDEN%'")
		}
	}

	where := "username = $1"
	for _, p := range parts {
		where += " AND " + p
	}
	return pgScan(u.db, `SELECT _ob FROM records WHERE `+where, args...)
}

func (u *pgUserDB) Write(fn func(WTx) error) error {
	tx, err := u.db.Begin()
	if err != nil {
		return err
	}
	wt := &pgTx{tx: tx, username: u.username}
	if err := fn(wt); err != nil {
		tx.Rollback()
		return err
	}
	// Bump the user's mtime only when something was actually written, so the
	// /updates early-exit stays accurate.
	if wt.wrote {
		if _, err := tx.Exec(`INSERT INTO users (username, mtime) VALUES ($1, $2)
			ON CONFLICT (username) DO UPDATE SET mtime = EXCLUDED.mtime`,
			u.username, nowEpoch()); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// pgTx is the write side of a Postgres transaction.
type pgTx struct {
	tx       *sql.Tx
	username string
	wrote    bool
}

func (t *pgTx) Get(table, key string) (Item, error) {
	return pgSelectOne(t.tx, `SELECT _ob FROM `+table+` WHERE username = $1 AND key = $2`, t.username, key)
}

func (t *pgTx) Upsert(table string, item Item) error {
	t.wrote = true
	return pgUpsert(t.tx, t.username, table, item)
}

// pgUpsert inserts or replaces one item, duplicating indexed fields into their
// own columns like the SQLite schema does.
func pgUpsert(x executor, username, table string, item Item) error {
	blob, err := json.Marshal(item)
	if err != nil {
		return err
	}
	// Coerce the indexed fields: on the normal write path t1/t2 arrive as int64,
	// but when re-read from a JSON blob (e.g. migration) they are float64, which
	// will not bind to a bigint column.
	switch table {
	case TableRecords:
		_, err = x.Exec(`INSERT INTO records (username, key, st, t1, t2, _ob) VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (username, key) DO UPDATE SET st = EXCLUDED.st, t1 = EXCLUDED.t1, t2 = EXCLUDED.t2, _ob = EXCLUDED._ob`,
			username, item["key"], asFloat(item["st"]), asInt(item["t1"]), asInt(item["t2"]), string(blob))
	default:
		_, err = x.Exec(fmt.Sprintf(`INSERT INTO %s (username, key, st, _ob) VALUES ($1, $2, $3, $4)
			ON CONFLICT (username, key) DO UPDATE SET st = EXCLUDED.st, _ob = EXCLUDED._ob`, table),
			username, item["key"], asFloat(item["st"]), string(blob))
	}
	return err
}

// asFloat/asInt coerce a decoded-JSON numeric field to the column's Go type.
func asFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case int:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	default:
		return 0
	}
}

func asInt(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case float64:
		return int64(x)
	case int:
		return int64(x)
	case json.Number:
		n, err := x.Int64()
		if err != nil {
			f, _ := x.Float64()
			return int64(f)
		}
		return n
	default:
		return 0
	}
}

func pgSelectOne(x executor, query string, args ...any) (Item, error) {
	items, err := pgScan(x, query, args...)
	if err != nil || len(items) == 0 {
		return nil, err
	}
	return items[0], nil
}

func pgScan(x executor, query string, args ...any) ([]Item, error) {
	rows, err := x.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		var blob []byte
		if err := rows.Scan(&blob); err != nil {
			return nil, err
		}
		var item Item
		if err := json.Unmarshal(blob, &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func nowEpoch() float64 { return float64(time.Now().UnixNano()) / 1e9 }
