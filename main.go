// Command server runs Tagged: a self-hosted time tracker.
//
// It serves a JSON API (records, settings, updates, tokens) with token-based
// JWT authentication and per-user SQLite storage, plus an embedded web UI
// (dashboard, time entries, tags, accounts, admin). Everything ships in a single
// binary — no external dependencies at runtime.
package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/TaggedHQ/server/internal/config"
	"github.com/TaggedHQ/server/internal/server"
	"github.com/TaggedHQ/server/internal/store"
)

func main() {
	// Support the `version` / `--version` hooks like the Python entrypoint.
	if len(os.Args) >= 2 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		log.SetFlags(0)
		log.Printf("Tagged %s", server.Version)
		return
	}

	cfg, err := config.New(os.Args, os.Environ())
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	// One-shot migration of the SQLite databases into Postgres, then exit.
	if len(os.Args) >= 2 && os.Args[1] == "migrate-to-postgres" {
		runMigration(cfg)
		return
	}

	srv, err := server.New(cfg)
	if err != nil {
		log.Fatalf("startup error: %v", err)
	}

	log.Printf("Tagged %s using %s", server.Version, srv.BackendLabel())

	httpServer := &http.Server{
		Addr:    cfg.Bind,
		Handler: srv.Handler(),
	}

	// Serve HTTPS when both a certificate and key are configured, otherwise
	// plain HTTP. TLS is typically terminated at a reverse proxy in production
	// (see README); this native path is handy for direct/self-signed setups.
	if cfg.TLSCert != "" && cfg.TLSKey != "" {
		log.Printf("Tagged %s serving at https://%s%s", server.Version, cfg.Bind, cfg.PathPrefix)
		if err := httpServer.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey); err != nil {
			log.Fatalf("server error: %v", err)
		}
		return
	}

	log.Printf("Tagged %s serving at http://%s%s", server.Version, cfg.Bind, cfg.PathPrefix)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// runMigration copies every per-user SQLite database under the configured data
// directory into the Postgres database at cfg.DBURL. Invoked via
// `ttgo migrate-to-postgres --datadir <dir> --db-url <dsn>`.
func runMigration(cfg *config.Config) {
	if cfg.DBURL == "" {
		log.Fatalf("migrate-to-postgres requires --db-url (or TAGGED_DB_URL)")
	}
	rootUserDir := filepath.Join(config.ExpandUser(cfg.Datadir), "users")
	log.Printf("migrating SQLite databases in %s into Postgres...", rootUserDir)
	if err := store.MigrateSQLiteToPostgres(rootUserDir, cfg.DBURL, os.Stdout); err != nil {
		log.Fatalf("migration failed: %v", err)
	}
}
