// Package store provides the persistence layer for Tagged. Items are stored as
// opaque JSON objects in an `_ob` column, with a handful of fields duplicated
// into their own indexed columns for querying. Two interchangeable backends
// implement the same interface so the HTTP API behaves identically regardless
// of which one is configured:
//
//   - SQLite ("Simple Server"): one database file per user, byte-compatible with
//     the original Python itemdb schema.
//   - Postgres ("Performance Server"): shared multi-tenant tables keyed by
//     username, backed by a connection pool for real concurrency.
//
// Handlers depend only on the Backend / UserDB / WTx interfaces below; the two
// SQLite-dialect-specific queries (the /updates since-filter and the /records
// tag filter) live inside each backend so each can speak its own SQL.
package store

import (
	"errors"
	"fmt"
)

// Item is a single stored object, decoded from its JSON `_ob` blob.
type Item = map[string]any

// ErrUserNotFound is returned by Backend.DeleteUser when the user does not exist.
var ErrUserNotFound = errors.New("user not found")

// Backend manages per-user stores and account-level operations.
type Backend interface {
	// UserDB returns a handle to a single user's data, ensuring the required
	// tables (SQLite) or metadata row (Postgres) exist. The caller must Close it.
	UserDB(username string) (UserDB, error)
	// SharedDB returns a handle to the cross-user store. The caller must Close it.
	SharedDB() (SharedDB, error)
	// ListUsers returns metadata for every known user.
	ListUsers() ([]UserMeta, error)
	// DeleteUser removes all of a user's data. Returns ErrUserNotFound if absent.
	DeleteUser(username string) error
	// Close releases backend-wide resources (the Postgres pool; a no-op for SQLite).
	Close() error
}

// UserMeta is a row in the admin user list.
type UserMeta struct {
	Username  string
	SizeBytes int64 // storage estimate; exact file size for SQLite
	Modified  int64 // unix seconds of last modification
}

// UserDB is a handle to one user's data. Reads go through the read methods;
// writes go through Write, which runs a single transaction.
type UserDB interface {
	// Mtime is the user's last-modification time (unix seconds, float), captured
	// when the handle was opened, or -1 if the user has no data yet. It drives
	// the /updates early-exit.
	Mtime() float64
	// Get returns the item in table with the given primary key, or nil if absent.
	Get(table, key string) (Item, error)
	// All returns every item in table.
	All(table string) ([]Item, error)
	// ItemsSince returns items in table whose `st` is >= since.
	ItemsSince(table string, since float64) ([]Item, error)
	// QueryRecords returns records matching the /records filter.
	QueryRecords(f RecordFilter) ([]Item, error)
	// Write runs fn inside one transaction, committing on nil and rolling back
	// on error.
	Write(fn func(WTx) error) error
	// Close releases the handle.
	Close() error
}

// WTx is the write side available inside UserDB.Write.
type WTx interface {
	// Get reads an item within the transaction (read-your-writes).
	Get(table, key string) (Item, error)
	// Upsert inserts or replaces item by its primary key.
	Upsert(table string, item Item) error
}

// SharedDB is a handle to the cross-user store: data owned by a group rather
// than by any one account.
//
// Everything else here is per-user, and deliberately so -- a person's records
// and settings belong to them and are read one account at a time. Shifts do not
// fit that shape for two reasons. An open shift has no assignee at all, so there
// is no user store to put it in; and the week grid reads a whole group at once,
// which under the per-user model would mean opening every member's database and
// merging, with no index on the date to narrow it. So shifts live in one store
// keyed by group and day, and the grid is a single indexed range scan.
//
// The catalog a shift refers to (locations, working areas, roles) is low-volume
// admin-owned config and stays in setup.json with the groups, exactly as the
// skill categories do. Only the shifts themselves are here.
type SharedDB interface {
	// Get returns the item in table with the given primary key, or nil if absent.
	Get(table, key string) (Item, error)
	// All returns every item in table.
	All(table string) ([]Item, error)
	// InRange returns items in table whose indexed `date` falls within
	// [from, to] inclusive and whose `gid` is one of gids. An empty gids means
	// every group. Dates are "YYYY-MM-DD", which compares correctly as text.
	InRange(table, from, to string, gids []string) ([]Item, error)
	// Write runs fn inside one transaction, committing on nil and rolling back
	// on error.
	Write(fn func(WTx) error) error
	// Close releases the handle.
	Close() error
}

// RecordFilter describes the /records query. Tags have had a leading '#'
// stripped but are NOT yet LIKE-escaped; each backend escapes them for its
// dialect.
type RecordFilter struct {
	T1, T2  int64
	Tags    []string
	Running *bool // nil = no filter
	Hidden  *bool // nil = no filter
}

// Table names shared by both backends.
const (
	TableUserinfo = "userinfo"
	TableRecords  = "records"
	TableSettings = "settings"
	// TableSkills holds one item per skill the user claims, keyed by skill id.
	// Unlike the three above it has no counterpart in the Python schema: it is
	// additive, so an older database file simply gains an empty table on open.
	TableSkills = "skills"
	// TableShifts holds planned shifts. It is the one table that lives in the
	// SharedDB rather than in a user's own store -- see the SharedDB doc for why.
	// Items are indexed by `gid` (owning group) and `date` ("YYYY-MM-DD").
	TableShifts = "shifts"
)

// NewBackend constructs the configured backend. kind "" or "sqlite" selects the
// SQLite backend rooted at rootUserDir; "postgres"/"postgresql"/"pg" selects the
// Postgres backend dialed from dbURL.
func NewBackend(kind, rootUserDir, dbURL string) (Backend, error) {
	switch kind {
	case "", "sqlite":
		return NewSQLiteBackend(rootUserDir)
	case "postgres", "postgresql", "pg":
		if dbURL == "" {
			return nil, fmt.Errorf("db_backend=postgres requires db_url to be set")
		}
		return NewPostgresBackend(dbURL)
	default:
		return nil, fmt.Errorf("unknown db_backend %q (want \"sqlite\" or \"postgres\")", kind)
	}
}
