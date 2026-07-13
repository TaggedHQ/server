package store

import (
	"os"
	"reflect"
	"sort"
	"testing"
)

// ptrBool is a helper for the tri-state filter fields.
func ptrBool(b bool) *bool { return &b }

// seedData writes a fixed set of userinfo/records/settings items for user
// "alice", so both backends can be driven through the identical scenario.
func seedData(t *testing.T, b Backend) {
	t.Helper()
	db, err := b.UserDB("alice")
	if err != nil {
		t.Fatalf("UserDB: %v", err)
	}
	defer db.Close()

	err = db.Write(func(tx WTx) error {
		if err := tx.Upsert(TableUserinfo, Item{"key": "reset_time", "st": 1.0, "mt": 1.0, "value": 0.0}); err != nil {
			return err
		}
		// records: one closed "work", one running "play", one hidden.
		recs := []Item{
			{"key": "r1", "st": 10.0, "mt": int64(10), "t1": int64(100), "t2": int64(200), "ds": "#work stuff"},
			{"key": "r2", "st": 11.0, "mt": int64(11), "t1": int64(150), "t2": int64(150), "ds": "#play now"},
			{"key": "r3", "st": 12.0, "mt": int64(12), "t1": int64(300), "t2": int64(400), "ds": "HIDDEN maintenance"},
		}
		for _, r := range recs {
			if err := tx.Upsert(TableRecords, r); err != nil {
				return err
			}
		}
		return tx.Upsert(TableSettings, Item{"key": "s1", "st": 5.0, "mt": int64(5), "value": "dark"})
	})
	if err != nil {
		t.Fatalf("seed Write: %v", err)
	}
}

// scenarioResults captures the observable outputs of every read path, so two
// backends can be compared for byte-for-byte-equivalent API behavior.
type scenarioResults struct {
	resetTime   Item
	allRecords  []Item
	sinceRecs   []Item
	tagWork     []Item
	runningOnly []Item
	notHidden   []Item
	allSettings []Item
}

func runScenario(t *testing.T, b Backend) scenarioResults {
	t.Helper()
	seedData(t, b)
	db, err := b.UserDB("alice")
	if err != nil {
		t.Fatalf("UserDB: %v", err)
	}
	defer db.Close()

	if db.Mtime() <= 0 {
		t.Errorf("Mtime should be positive after writes, got %v", db.Mtime())
	}

	var r scenarioResults
	if r.resetTime, err = db.Get(TableUserinfo, "reset_time"); err != nil {
		t.Fatalf("Get reset_time: %v", err)
	}
	if r.allRecords, err = db.All(TableRecords); err != nil {
		t.Fatalf("All records: %v", err)
	}
	if r.sinceRecs, err = db.ItemsSince(TableRecords, 11.0); err != nil {
		t.Fatalf("ItemsSince: %v", err)
	}
	if r.tagWork, err = db.QueryRecords(RecordFilter{T1: 0, T2: 1000, Tags: []string{"work"}}); err != nil {
		t.Fatalf("QueryRecords tag: %v", err)
	}
	if r.runningOnly, err = db.QueryRecords(RecordFilter{T1: 0, T2: 1000, Running: ptrBool(true)}); err != nil {
		t.Fatalf("QueryRecords running: %v", err)
	}
	if r.notHidden, err = db.QueryRecords(RecordFilter{T1: 0, T2: 1000, Hidden: ptrBool(false)}); err != nil {
		t.Fatalf("QueryRecords hidden: %v", err)
	}
	if r.allSettings, err = db.All(TableSettings); err != nil {
		t.Fatalf("All settings: %v", err)
	}
	return r
}

func keys(items []Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i], _ = it["key"].(string)
	}
	sort.Strings(out)
	return out
}

func TestSQLiteScenario(t *testing.T) {
	b, err := NewSQLiteBackend(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	r := runScenario(t, b)

	if got := keys(r.allRecords); !reflect.DeepEqual(got, []string{"r1", "r2", "r3"}) {
		t.Errorf("allRecords keys = %v", got)
	}
	if got := keys(r.sinceRecs); !reflect.DeepEqual(got, []string{"r2", "r3"}) {
		t.Errorf("sinceRecs keys = %v, want [r2 r3]", got)
	}
	if got := keys(r.tagWork); !reflect.DeepEqual(got, []string{"r1"}) {
		t.Errorf("tagWork keys = %v, want [r1]", got)
	}
	if got := keys(r.runningOnly); !reflect.DeepEqual(got, []string{"r2"}) {
		t.Errorf("runningOnly keys = %v, want [r2]", got)
	}
	if got := keys(r.notHidden); !reflect.DeepEqual(got, []string{"r1", "r2"}) {
		t.Errorf("notHidden keys = %v, want [r1 r2]", got)
	}
	if got := keys(r.allSettings); !reflect.DeepEqual(got, []string{"s1"}) {
		t.Errorf("allSettings keys = %v", got)
	}

	// ListUsers / DeleteUser round-trip.
	users, err := b.ListUsers()
	if err != nil || len(users) != 1 || users[0].Username != "alice" {
		t.Fatalf("ListUsers = %v, err=%v", users, err)
	}
	if err := b.DeleteUser("alice"); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}
	if err := b.DeleteUser("alice"); err != ErrUserNotFound {
		t.Errorf("second DeleteUser err = %v, want ErrUserNotFound", err)
	}
}

// TestBackendConformance asserts the Postgres backend produces the same
// observable results as SQLite. It runs only when TAGGED_TEST_PG_URL points at a
// throwaway Postgres (see docker-compose.yml); otherwise it is skipped.
func TestBackendConformance(t *testing.T) {
	pgURL := os.Getenv("TAGGED_TEST_PG_URL")
	if pgURL == "" {
		t.Skip("set TAGGED_TEST_PG_URL to run the Postgres conformance test")
	}

	sqlite, err := NewSQLiteBackend(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer sqlite.Close()
	sres := runScenario(t, sqlite)

	pg, err := NewPostgresBackend(pgURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer pg.Close()
	// Start from a clean slate so reruns are deterministic.
	_ = pg.DeleteUser("alice")
	pres := runScenario(t, pg)

	cmp := func(name string, a, b []Item) {
		if !reflect.DeepEqual(keys(a), keys(b)) {
			t.Errorf("%s: sqlite keys %v != postgres keys %v", name, keys(a), keys(b))
		}
	}
	cmp("allRecords", sres.allRecords, pres.allRecords)
	cmp("sinceRecs", sres.sinceRecs, pres.sinceRecs)
	cmp("tagWork", sres.tagWork, pres.tagWork)
	cmp("runningOnly", sres.runningOnly, pres.runningOnly)
	cmp("notHidden", sres.notHidden, pres.notHidden)
	cmp("allSettings", sres.allSettings, pres.allSettings)

	if !reflect.DeepEqual(sres.resetTime["value"], pres.resetTime["value"]) {
		t.Errorf("reset_time value: sqlite %v != postgres %v", sres.resetTime["value"], pres.resetTime["value"])
	}
}

// TestMigration exercises the SQLite->Postgres migration when a test database is
// available.
func TestMigration(t *testing.T) {
	pgURL := os.Getenv("TAGGED_TEST_PG_URL")
	if pgURL == "" {
		t.Skip("set TAGGED_TEST_PG_URL to run the migration test")
	}
	root := t.TempDir()
	src, err := NewSQLiteBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	seedData(t, src)
	src.Close()

	pg, err := NewPostgresBackend(pgURL)
	if err != nil {
		t.Fatal(err)
	}
	_ = pg.DeleteUser("alice")
	pg.Close()

	if err := MigrateSQLiteToPostgres(root, pgURL, os.Stdout); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	pg, _ = NewPostgresBackend(pgURL)
	defer pg.Close()
	db, err := pg.UserDB("alice")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	recs, err := db.All(TableRecords)
	if err != nil || len(recs) != 3 {
		t.Fatalf("after migration: %d records, err=%v", len(recs), err)
	}
}
