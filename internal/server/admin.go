package server

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/TaggedHQ/server/internal/store"
)

// adminFlagKey is the userinfo key holding a per-user stored admin role.
const adminFlagKey = "is_admin"

// dbAdminFlag reads the stored admin role from an already-open user database.
func dbAdminFlag(db store.UserDB) bool {
	ob, err := db.Get("userinfo", adminFlagKey)
	if err != nil || ob == nil {
		return false
	}
	b, _ := ob["value"].(bool)
	return b
}

// isAdmin reports effective admin rights: config ("root") admin OR the stored
// per-user role in the given (open) database.
func (s *Server) isAdmin(username string, db store.UserDB) bool {
	if s.isConfigAdmin(username) {
		return true
	}
	return db != nil && dbAdminFlag(db)
}

// whoamiHandler reports the current user's identity and admin status. Available
// to any authenticated user; the UI uses it to decide whether to show the admin
// menu.
func (s *Server) whoamiHandler(username string, db store.UserDB) response {
	return jsonResp(200, map[string]any{
		"username":               username,
		"is_admin":               s.isAdmin(username, db),
		"is_controller":          s.isController(username, db),
		"totp_enabled":           totpEnabled(db),
		"backup_codes_remaining": len(backupHashes(db)),
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
	case "/server":
		switch req.method() {
		case "GET":
			return s.adminGetServer()
		case "PUT", "POST":
			return s.adminSetServer(req)
		}
		return textResp(405, "method not allowed")
	case "/controller":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminSetController(req)
		}
		return textResp(405, "method not allowed")
	case "/oauth":
		switch req.method() {
		case "GET":
			return s.adminGetOAuth(req)
		case "PUT", "POST":
			return s.adminSetOAuth(req)
		}
		return textResp(405, "method not allowed")
	default:
		return textResp(404, "not found: /admin"+sub+" is not a valid admin path")
	}
}

// userRow is one entry in the admin user list.
type userRow struct {
	Username     string `json:"username"`
	Registered   bool   `json:"registered"`    // has a password set (vs. token-only)
	IsAdmin      bool   `json:"is_admin"`      // effective admin (config OR stored role)
	ConfigAdmin  bool   `json:"config_admin"`  // root admin from config (role can't be toggled)
	IsController bool   `json:"is_controller"` // stored controller role (can switch to other users)
	SizeBytes    int64  `json:"size_bytes"`
	Modified     int64  `json:"modified"` // unix seconds
}

func (s *Server) adminListUsers() response {
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var users []userRow
	for _, m := range metas {
		configAdmin := s.isConfigAdmin(m.Username)
		row := userRow{
			Username:    m.Username,
			ConfigAdmin: configAdmin,
			SizeBytes:   m.SizeBytes,
			Modified:    m.Modified,
		}
		registered, storedAdmin, storedController := s.userFlags(m.Username)
		row.Registered = registered
		row.IsAdmin = configAdmin || storedAdmin
		row.IsController = storedController
		users = append(users, row)
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Username < users[j].Username })
	if users == nil {
		users = []userRow{}
	}
	return jsonResp(200, map[string]any{"users": users})
}

// userFlags opens a user DB once and reports whether it has a password set and
// whether it carries the stored admin / controller roles.
func (s *Server) userFlags(username string) (registered, storedAdmin, storedController bool) {
	db, err := s.openUserDB(username)
	if err != nil {
		return false, false, false
	}
	defer db.Close()
	if ob, err := db.Get("userinfo", passwordHashKey); err == nil && ob != nil {
		if v, _ := ob["value"].(string); v != "" {
			registered = true
		}
	}
	storedAdmin = dbAdminFlag(db)
	storedController = dbControllerFlag(db)
	return registered, storedAdmin, storedController
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
	db, err := s.openUserDB(username)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()
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
	if err := s.getStore().DeleteUser(username); err != nil {
		if errors.Is(err, store.ErrUserNotFound) {
			return textResp(404, "user not found")
		}
		return textResp(500, "internal error: "+err.Error())
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
	if err := s.setStoredAdmin(username, body.IsAdmin); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// setStoredAdmin sets (or clears) the per-user stored admin role in the user's
// database.
func (s *Server) setStoredAdmin(username string, isAdmin bool) error {
	db, err := s.openUserDB(username)
	if err != nil {
		return err
	}
	defer db.Close()
	st := now()
	return db.Write(func(tx store.WTx) error {
		return tx.Upsert("userinfo", store.Item{"key": adminFlagKey, "st": st, "mt": st, "value": isAdmin})
	})
}

// adminSetController grants or revokes the stored controller role for a user.
// Unlike admin, there is no lockout risk, so an admin may toggle it on any
// account (including their own).
func (s *Server) adminSetController(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username     string `json:"username"`
		IsController bool   `json:"is_controller"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and is_controller")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	if err := s.setStoredController(username, body.IsController); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// setStoredController sets (or clears) the per-user stored controller role in
// the user's database.
func (s *Server) setStoredController(username string, isController bool) error {
	db, err := s.openUserDB(username)
	if err != nil {
		return err
	}
	defer db.Close()
	st := now()
	return db.Write(func(tx store.WTx) error {
		return tx.Upsert("userinfo", store.Item{"key": controllerFlagKey, "st": st, "mt": st, "value": isController})
	})
}

// adminGetServer returns server-wide settings shown on the Admin · Servers page.
func (s *Server) adminGetServer() response {
	return jsonResp(200, map[string]any{
		"registration_open": s.registrationEnabled(),
	})
}

// adminSetServer updates server-wide settings. Currently only the
// self-registration switch. Body is JSON {"registration_open": bool}.
func (s *Server) adminSetServer(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		RegistrationOpen *bool `json:"registration_open"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with registration_open")
	}
	if body.RegistrationOpen == nil {
		return textResp(400, "registration_open is required")
	}
	if err := s.setRegistrationEnabled(*body.RegistrationOpen); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "registration_open": *body.RegistrationOpen})
}

// adminGetOAuth returns the full OAuth provider configuration (secrets included,
// admin-only) plus the callback base URL the operator must register with each
// provider (redirect_uri = <callback_base>/<provider-id>).
func (s *Server) adminGetOAuth(req *request) response {
	providers := s.listOAuthProviders()
	if providers == nil {
		providers = []oauthProvider{}
	}
	return jsonResp(200, map[string]any{
		"providers":     providers,
		"callback_base": externalBaseURL(req.r) + s.cfg.PathPrefix + "api/v2/oauth/callback",
	})
}

// adminSetOAuth replaces the OAuth provider configuration. Body is JSON
// {"providers": [ ... ]}.
func (s *Server) adminSetOAuth(req *request) response {
	raw, err := req.getBody(256 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Providers []oauthProvider `json:"providers"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with a providers array")
	}
	if err := s.setOAuthProviders(body.Providers); err != nil {
		return textResp(400, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}
