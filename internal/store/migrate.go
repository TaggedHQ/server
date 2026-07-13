package store

import (
	"fmt"
	"io"
)

// MigrateSQLiteToPostgres copies every per-user SQLite database under
// rootUserDir into the Postgres database at dbURL. It is idempotent (all writes
// are upserts) and prints a per-user summary to out.
func MigrateSQLiteToPostgres(rootUserDir, dbURL string, out io.Writer) error {
	src, err := NewSQLiteBackend(rootUserDir)
	if err != nil {
		return err
	}
	dst, err := NewPostgresBackend(dbURL)
	if err != nil {
		return err
	}
	defer dst.Close()

	users, err := src.ListUsers()
	if err != nil {
		return err
	}

	for _, u := range users {
		sdb, err := src.UserDB(u.Username)
		if err != nil {
			return fmt.Errorf("open source %q: %w", u.Username, err)
		}
		counts, err := copyUser(sdb, dst, u.Username)
		sdb.Close()
		if err != nil {
			return fmt.Errorf("migrate %q: %w", u.Username, err)
		}
		fmt.Fprintf(out, "migrated %-30s userinfo=%d records=%d settings=%d\n",
			u.Username, counts[TableUserinfo], counts[TableRecords], counts[TableSettings])
	}
	fmt.Fprintf(out, "done: %d user(s)\n", len(users))
	return nil
}

func copyUser(sdb UserDB, dst Backend, username string) (map[string]int, error) {
	ddb, err := dst.UserDB(username)
	if err != nil {
		return nil, err
	}
	defer ddb.Close()

	counts := map[string]int{}
	for _, table := range []string{TableUserinfo, TableRecords, TableSettings} {
		items, err := sdb.All(table)
		if err != nil {
			return nil, err
		}
		if len(items) == 0 {
			continue
		}
		if err := ddb.Write(func(tx WTx) error {
			for _, it := range items {
				if err := tx.Upsert(table, it); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return nil, err
		}
		counts[table] = len(items)
	}
	return counts, nil
}
