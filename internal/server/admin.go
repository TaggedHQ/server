package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/TaggedHQ/server/internal/store"
	"github.com/TaggedHQ/server/internal/util"
)

// adminFlagKey is the userinfo key holding a per-user stored admin role.
const adminFlagKey = "is_admin"

// dbAdminFlag reads the stored admin role from an already-open user database.
func dbAdminFlag(db *store.ItemDB) bool {
	ob, err := db.SelectOne(db.DB(), "userinfo", "key = ?", adminFlagKey)
	if err != nil || ob == nil {
		return false
	}
	b, _ := ob["value"].(bool)
	return b
}

// isAdmin reports effective admin rights: config ("root") admin OR the stored
// per-user role in the given (open) database.
func (s *Server) isAdmin(username string, db *store.ItemDB) bool {
	if s.isConfigAdmin(username) {
		return true
	}
	return db != nil && dbAdminFlag(db)
}

// whoamiHandler reports the current user's identity and admin status. Available
// to any authenticated user; the UI uses it to decide whether to show the admin
// menu.
func (s *Server) whoamiHandler(username string, db *store.ItemDB) response {
	return jsonResp(200, map[string]any{
		"username": username,
		"is_admin": s.isAdmin(username, db),
	})
}

// adminHandler dispatches admin-only sub-routes. `sub` is the path after
// "admin" (e.g. "/users", "/password", "/user"). The caller has already
// verified the requester is an admin.
func (s *Server) adminHandler(req *request, sub, adminUser string) response {
	switch sub {
	case "", "/", "/users", "/users/":
		switch req.method() {
		case "GET":
			return s.adminListUsers()
		case "PUT", "POST":
			return s.adminCreateUser(req)
		}
		return textResp(405, "method not allowed")
	case "/password":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminResetPassword(req)
		}
		return textResp(405, "method not allowed")
	case "/user":
		if req.method() == "DELETE" {
			return s.adminDeleteUser(req, adminUser)
		}
		return textResp(405, "method not allowed")
	case "/admin":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminSetAdmin(req, adminUser)
		}
		return textResp(405, "method not allowed")
	default:
		return textResp(404, "not found: /admin"+sub+" is not a valid admin path")
	}
}

// userRow is one entry in the admin user list.
type userRow struct {
	Username    string `json:"username"`
	Registered  bool   `json:"registered"`   // has a password set (vs. token-only)
	IsAdmin     bool   `json:"is_admin"`     // effective admin (config OR stored role)
	ConfigAdmin bool   `json:"config_admin"` // root admin from config (role can't be toggled)
	SizeBytes   int64  `json:"size_bytes"`
	Modified    int64  `json:"modified"` // unix seconds
}

func (s *Server) adminListUsers() response {
	entries, err := os.ReadDir(s.rootUserDir)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var users []userRow
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".db") {
			continue // skip -wal/-shm/-journal siblings and dirs
		}
		username, err := util.Filename2User(name)
		if err != nil {
			continue
		}
		configAdmin := s.isConfigAdmin(username)
		row := userRow{Username: username, ConfigAdmin: configAdmin}
		if info, err := e.Info(); err == nil {
			row.SizeBytes = info.Size()
			row.Modified = info.ModTime().Unix()
		}
		registered, storedAdmin := s.userFlags(filepath.Join(s.rootUserDir, name))
		row.Registered = registered
		row.IsAdmin = configAdmin || storedAdmin
		users = append(users, row)
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Username < users[j].Username })
	if users == nil {
		users = []userRow{}
	}
	return jsonResp(200, map[string]any{"users": users})
}

// userFlags opens a user DB once and reports whether it has a password set and
// whether it carries the stored admin role.
func (s *Server) userFlags(dbPath string) (registered, storedAdmin bool) {
	db, err := store.Open(dbPath)
	if err != nil {
		return false, false
	}
	defer db.Close()
	if err := db.EnsureTable("userinfo", "!key", "st"); err != nil {
		return false, false
	}
	if ob, err := db.SelectOne(db.DB(), "userinfo", "key = ?", passwordHashKey); err == nil && ob != nil {
		if v, _ := ob["value"].(string); v != "" {
			registered = true
		}
	}
	storedAdmin = dbAdminFlag(db)
	return registered, storedAdmin
}

func (s *Server) adminCreateUser(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and password")
	}
	status, err := s.registerUser(body.Username, body.Password)
	if err != nil {
		return textResp(status, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

func (s *Server) adminResetPassword(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and password")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	if len(body.Password) < 4 {
		return textResp(400, "password must be at least 4 characters")
	}
	db, err := store.Open(s.userDBPath(username))
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()
	if err := db.EnsureTable("userinfo", "!key", "st"); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	if err := storePasswordHash(db, body.Password); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

func (s *Server) adminDeleteUser(req *request, adminUser string) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	if username == adminUser {
		return textResp(400, "you cannot delete your own account")
	}
	base := s.userDBPath(username)
	// Remove the database and its SQLite sidecar files.
	found := false
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err := os.Remove(base + suffix); err == nil {
			if suffix == "" {
				found = true
			}
		} else if suffix == "" && !os.IsNotExist(err) {
			return textResp(500, "internal error: "+err.Error())
		}
	}
	if !found {
		return textResp(404, "user not found")
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// adminSetAdmin grants or revokes the stored admin role for a user. Config
// ("root") admins cannot be changed here, and an admin cannot change their own
// role (to avoid locking themselves out).
func (s *Server) adminSetAdmin(req *request, adminUser string) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
		IsAdmin  bool   `json:"is_admin"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and is_admin")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	if username == adminUser {
		return textResp(400, "you cannot change your own admin status")
	}
	if s.isConfigAdmin(username) {
		return textResp(400, "this user is a config-defined admin and cannot be changed here")
	}
	db, err := store.Open(s.userDBPath(username))
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()
	if err := db.EnsureTable("userinfo", "!key", "st"); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	st := now()
	tx, err := db.Begin()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	if err := db.PutOne(tx, "userinfo", store.Item{"key": adminFlagKey, "st": st, "mt": st, "value": body.IsAdmin}); err != nil {
		tx.Rollback()
		return textResp(500, "internal error: "+err.Error())
	}
	if err := tx.Commit(); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}
