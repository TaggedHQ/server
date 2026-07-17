package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// setupState is the operator's persisted first-run choice: which storage backend
// to use and (for Postgres) its connection string. It lives in setupFile next to
// jwt.key in the data dir. NOTE: for Postgres this file contains the database
// password in plaintext — it carries the same trust level as jwt.key, so keep the
// data dir private.
type setupState struct {
	Backend string `json:"backend"` // "sqlite" or "postgres"
	DBURL   string `json:"db_url"`  // Postgres DSN (empty for sqlite)
	// RegistrationOpen controls whether visitors can self-register via /register.
	// A pointer so an absent field (older setup.json) is distinguishable from an
	// explicit false and falls back to the open default. Managed from the Admin ·
	// Servers page.
	RegistrationOpen *bool `json:"registration_open,omitempty"`
	// OAuth holds the configured external identity providers (client secrets
	// included — hence the 0600 file). Managed from the Admin · OAuth page.
	OAuth []oauthProvider `json:"oauth,omitempty"`
	// Roles maps a role key ("user"/"admin"/"controller") to the capabilities it
	// grants. Absent (older setup.json) falls back to defaultRoleCaps. Managed
	// from the Admin · Roles page.
	Roles map[string][]string `json:"roles,omitempty"`
	// Groups holds the user groups and their controllers. Managed from the
	// Admin · Groups page.
	Groups []group `json:"groups,omitempty"`
}

const setupFile = "setup.json"

// loadSetup reads the persisted backend choice from dir, or returns nil if the
// operator has not completed the wizard (file absent).
func loadSetup(dir string) (*setupState, error) {
	raw, err := os.ReadFile(filepath.Join(dir, setupFile))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var s setupState
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// saveSetup persists the backend choice to dir (0600, since it may hold a DB
// password), writing atomically via a temp file + rename.
func saveSetup(dir string, s setupState) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, setupFile+".tmp")
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, setupFile))
}

// setupRequired reports whether no accounts exist yet on the active backend.
func (s *Server) setupRequired() (bool, error) {
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return false, err
	}
	return len(metas) == 0, nil
}

// setupStatusHandler (GET api/v2/setup_status) tells the UI whether to show the
// first-run wizard and whether the backend choice is operator-locked. Unauthenticated.
func (s *Server) setupStatusHandler() response {
	required, err := s.setupRequired()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{
		"setup_required":    required,
		"backend_locked":    s.backendLocked,
		"backend":           s.currentBackend(),
		"registration_open": s.registrationEnabled(),
	})
}

// setupHandler (POST api/v2/setup) performs first-run setup: optionally switches
// the storage backend, then creates the first (admin) account and returns a
// web-token so the UI logs straight in. Unauthenticated, but only works while no
// accounts exist yet. Ignores backend/db_url when the backend is operator-locked.
func (s *Server) setupHandler(req *request) response {
	if req.method() != "POST" {
		return textResp(405, "method not allowed: /setup can only be used with POST")
	}
	if required, err := s.setupRequired(); err != nil {
		return textResp(500, "internal error: "+err.Error())
	} else if !required {
		return textResp(409, "setup has already been completed")
	}

	var body struct {
		Backend  string `json:"backend"`
		DBURL    string `json:"db_url"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(req, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}

	// Apply the backend choice (unless pinned by the operator).
	if !s.backendLocked {
		kind := strings.ToLower(strings.TrimSpace(body.Backend))
		if kind == "" {
			kind = "sqlite"
		}
		switch kind {
		case "sqlite":
			if s.currentBackend() != "sqlite" {
				if err := s.reconfigureBackend("sqlite", ""); err != nil {
					return textResp(400, "could not switch to the Simple Server: "+err.Error())
				}
			}
		case "postgres":
			dbURL := strings.TrimSpace(body.DBURL)
			if dbURL == "" {
				return textResp(400, "a PostgreSQL connection URL is required for the Performance Server")
			}
			if err := s.reconfigureBackend("postgres", dbURL); err != nil {
				return textResp(400, "could not connect to PostgreSQL: "+err.Error())
			}
			// Refuse to adopt a database that already has accounts.
			if required, err := s.setupRequired(); err != nil {
				return textResp(500, "internal error: "+err.Error())
			} else if !required {
				return textResp(409, "that PostgreSQL database already contains accounts")
			}
		default:
			return textResp(400, "unknown server type: "+kind)
		}
	}

	// Create the first account and grant it admin rights.
	status, err := s.registerUser(body.Username, body.Password)
	if err != nil {
		return textResp(status, err.Error())
	}
	username := strings.TrimSpace(body.Username)
	if err := s.setStoredAdmin(username, true); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	token, err := s.getWebtokenUnsafe(username, false)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "token": token, "username": username})
}
