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

// disabledFlagKey is the userinfo key holding the per-user deactivated flag. A
// deactivated account keeps all its data but cannot log in, and its existing
// tokens stop working (see authenticate).
const disabledFlagKey = "disabled"

// dbDisabledFlag reports whether an already-open user database is deactivated.
func dbDisabledFlag(db store.UserDB) bool {
	ob, err := db.Get("userinfo", disabledFlagKey)
	if err != nil || ob == nil {
		return false
	}
	b, _ := ob["value"].(bool)
	return b
}

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
	caps := s.capsOf(username, db)
	return jsonResp(200, map[string]any{
		"username":      username,
		"role":          s.userRole(username, db),
		"caps":          capList(caps),
		"profile":       readProfile(db),
		"avatar":        readAvatar(db),
		"is_admin":      s.isAdmin(username, db),
		"is_controller": s.isController(username, db),
		// Which optional modules are on, so every page can reveal exactly the nav
		// entries that lead somewhere.
		"modules":                s.enabledModules(),
		"has_password":           hasPassword(db),
		"totp_enabled":           totpEnabled(db),
		"backup_codes_remaining": len(backupHashes(db)),
		"passkeys":               len(storedCredentials(db)),
	})
}

// adminRouteCap maps each admin sub-route to the capability it requires.
var adminRouteCap = map[string]string{
	"":             capUsersManage,
	"/":            capUsersManage,
	"/users":       capUsersManage,
	"/users/":      capUsersManage,
	"/password":    capUsersManage,
	"/user":        capUsersManage,
	"/profile":     capUsersManage,
	"/disable":     capUsersManage,
	"/mfa":         capUsersManage,
	"/admin":       capRolesManage,
	"/controller":  capRolesManage,
	"/roles":       capRolesManage,
	"/role":        capRolesManage,
	"/userrole":    capRolesManage,
	"/groups":      capGroupsManage,
	"/group":       capGroupsManage,
	"/user-groups": capGroupsManage,
	"/server":      capServerManage,
	"/oauth":       capOAuthManage,
}

// adminHandler dispatches admin-only sub-routes. `sub` is the path after
// "admin" (e.g. "/users", "/password", "/user"). The caller has already been
// verified to hold at least one admin capability; `caps` is their full set, and
// each route is gated on the capability adminRouteCap names for it.
func (s *Server) adminHandler(req *request, sub, adminUser string, caps map[string]bool) response {
	need, known := adminRouteCap[sub]
	if !known {
		return textResp(404, "not found: /admin"+sub+" is not a valid admin path")
	}
	if !caps[need] {
		return textResp(403, "forbidden: your role does not have the "+need+" permission")
	}
	switch sub {
	case "", "/", "/users", "/users/":
		switch req.method() {
		case "GET":
			return s.adminListUsers()
		case "PUT", "POST":
			return s.adminCreateUser(req)
		}
	case "/password":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminResetPassword(req)
		}
	case "/user":
		if req.method() == "DELETE" {
			return s.adminDeleteUser(req, adminUser)
		}
	case "/profile":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminSetProfile(req)
		}
	case "/disable":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminSetDisabled(req, adminUser)
		}
	case "/mfa":
		if req.method() == "DELETE" {
			return s.adminResetMFA(req)
		}
	case "/admin":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminSetAdmin(req, adminUser)
		}
	case "/controller":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminSetController(req)
		}
	case "/roles":
		switch req.method() {
		case "GET":
			return s.adminGetRoles()
		case "PUT", "POST":
			return s.adminSetRole(req)
		}
	case "/role":
		switch req.method() {
		case "POST":
			return s.adminCreateRole(req)
		case "PUT":
			return s.adminRenameRole(req)
		case "DELETE":
			return s.adminDeleteRole(req)
		}
	case "/userrole":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminSetUserRole(req, adminUser)
		}
	case "/groups":
		switch req.method() {
		case "GET":
			return s.adminGetGroups()
		case "PUT", "POST":
			return s.adminSaveGroup(req)
		}
	case "/group":
		if req.method() == "DELETE" {
			return s.adminDeleteGroup(req)
		}
	case "/user-groups":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.adminSetUserGroups(req)
		}
	case "/server":
		switch req.method() {
		case "GET":
			return s.adminGetServer()
		case "PUT", "POST":
			return s.adminSetServer(req)
		}
	case "/oauth":
		switch req.method() {
		case "GET":
			return s.adminGetOAuth(req)
		case "PUT", "POST":
			return s.adminSetOAuth(req)
		}
	}
	return textResp(405, "method not allowed")
}

// userRow is one entry in the admin user list. It embeds the profile so the page
// can render, search and edit the directory fields without a request per user.
type userRow struct {
	Username     string      `json:"username"`
	Registered   bool        `json:"registered"`    // has a password set (vs. token-only)
	IsAdmin      bool        `json:"is_admin"`      // effective admin (config OR stored role)
	ConfigAdmin  bool        `json:"config_admin"`  // root admin from config (role can't be toggled)
	IsController bool        `json:"is_controller"` // role grants "switch to users"
	Role         string      `json:"role"`          // role key the account holds
	RoleLabel    string      `json:"role_label"`    // its display name
	Disabled     bool        `json:"disabled"`      // deactivated: data kept, but cannot log in
	TOTPEnabled  bool        `json:"totp_enabled"`  // authenticator app confirmed
	Passkeys     int         `json:"passkeys"`      // number of registered WebAuthn credentials
	Profile      userProfile `json:"profile"`
	Avatar       string      `json:"avatar"` // data URI, or "" when unset
	SizeBytes    int64       `json:"size_bytes"`
	Modified     int64       `json:"modified"` // unix seconds
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
		snap := s.userSnapshot(m.Username)
		row.Registered = snap.Registered
		row.IsAdmin = configAdmin || snap.Admin
		row.IsController = snap.Controller
		row.Role = snap.Role
		if def, ok := s.findRole(snap.Role); ok {
			row.RoleLabel = def.Label
		}
		row.Disabled = snap.Disabled
		row.TOTPEnabled = snap.TOTPEnabled
		row.Passkeys = snap.Passkeys
		row.Profile = snap.Profile
		row.Avatar = snap.Avatar
		users = append(users, row)
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Username < users[j].Username })
	if users == nil {
		users = []userRow{}
	}
	return jsonResp(200, map[string]any{"users": users})
}

// userSnapshot is everything the admin user list needs about one account.
type userSnapshotData struct {
	Registered  bool
	Admin       bool
	Controller  bool
	Role        string
	Disabled    bool
	TOTPEnabled bool
	Passkeys    int
	Profile     userProfile
	Avatar      string
}

// userSnapshot opens a user DB once and reads the role flags together with the
// profile, so building the list costs one open per account rather than several.
func (s *Server) userSnapshot(username string) userSnapshotData {
	db, err := s.openUserDB(username)
	if err != nil {
		return userSnapshotData{}
	}
	defer db.Close()
	role := s.userRole(username, db)
	return userSnapshotData{
		Registered: dbRegistered(db),
		Role:       role,
		// Derived from the role rather than the stored booleans, so a custom
		// role that grants "switch to users" reads as a controller too.
		Admin:       role == roleAdmin,
		Controller:  s.roleHasCap(role, capUsersActAs),
		Disabled:    dbDisabledFlag(db),
		TOTPEnabled: totpEnabled(db),
		Passkeys:    len(storedCredentials(db)),
		Profile:     readProfile(db),
		Avatar:      readAvatar(db),
	}
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
	if err := s.pruneUserFromGroups(username); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// adminSetDisabled deactivates or reactivates a user. Deactivating keeps every
// entry and setting, but the account can no longer log in and its outstanding
// tokens are revoked, so open sessions stop working right away.
func (s *Server) adminSetDisabled(req *request, adminUser string) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
		Disabled bool   `json:"disabled"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and disabled")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	// Both guards mirror adminSetAdmin: never let an admin lock themselves out,
	// and never let the config-defined root admin be shut out of their own server.
	if username == adminUser {
		return textResp(400, "you cannot deactivate your own account")
	}
	if body.Disabled && s.isConfigAdmin(username) {
		return textResp(400, "this user is a config-defined admin and cannot be deactivated")
	}
	db, err := s.openUserDB(username)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()
	st := now()
	if err := db.Write(func(tx store.WTx) error {
		return tx.Upsert("userinfo", store.Item{"key": disabledFlagKey, "st": st, "mt": st, "value": body.Disabled})
	}); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	if body.Disabled {
		// Rotating both seeds invalidates every token already handed out.
		if _, err := s.getTokenSeedFromDB(db, "webtoken", true); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		if _, err := s.getTokenSeedFromDB(db, "apitoken", true); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// adminResetMFA clears a user's second factors. It is the way back in for
// someone who lost their device — they can log in with their password alone
// afterwards, and re-enrol from their account page. "scope" picks what goes:
// "totp" (authenticator secret and backup codes), "passkeys", or "all" (the
// default), which is what the details panel sends.
func (s *Server) adminResetMFA(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
		Scope    string `json:"scope"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	scope := strings.ToLower(strings.TrimSpace(body.Scope))
	if scope == "" {
		scope = "all"
	}
	if scope != "all" && scope != "totp" && scope != "passkeys" {
		return textResp(400, `scope must be "totp", "passkeys" or "all"`)
	}
	db, err := s.openUserDB(username)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()

	var steps []error
	if scope == "all" || scope == "totp" {
		steps = append(steps,
			userinfoPut(db, totpEnabledKey, false),
			userinfoPut(db, totpSecretKey, ""),
			userinfoPut(db, totpPendingKey, ""),
			userinfoPut(db, totpBackupKey, ""),
		)
	}
	if scope == "all" || scope == "passkeys" {
		steps = append(steps, saveStoredCredentials(db, nil))
	}
	if err := firstErr(steps...); err != nil {
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
	// The new role may make an existing group membership invalid (only the User
	// role can be a member, only Controllers can control a group).
	if err := s.pruneUserFromGroups(username); err != nil {
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
	// Same as for admin: a user promoted to Controller can no longer be a group
	// member, and one demoted to User can no longer control a group.
	if err := s.pruneUserFromGroups(username); err != nil {
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

// adminGetServer returns server-wide settings shown on the Admin · Settings page:
// the self-registration switch and the optional module catalog.
func (s *Server) adminGetServer() response {
	return jsonResp(200, map[string]any{
		"registration_open": s.registrationEnabled(),
		"modules":           s.listModules(),
	})
}

// adminSetServer updates server-wide settings. Body is JSON carrying either
// {"registration_open": bool} or {"module": "shifts", "enabled": bool}; each
// request changes one switch, matching how the page toggles them.
func (s *Server) adminSetServer(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		RegistrationOpen *bool  `json:"registration_open"`
		Module           string `json:"module"`
		Enabled          *bool  `json:"enabled"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}

	if body.Module != "" {
		if !validModule(body.Module) {
			return textResp(400, "unknown module: "+body.Module)
		}
		if body.Enabled == nil {
			return textResp(400, "enabled is required when setting a module")
		}
		if err := s.setModuleEnabled(body.Module, *body.Enabled); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		return jsonResp(200, map[string]any{"status": "ok", "module": body.Module, "enabled": *body.Enabled})
	}

	if body.RegistrationOpen == nil {
		return textResp(400, "registration_open or module is required")
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
