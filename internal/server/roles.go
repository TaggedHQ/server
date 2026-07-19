package server

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/TaggedHQ/server/internal/store"
)

// The permission model. Every user holds exactly one role, stored per user (see
// roleFlagKey) and falling back to the older is_admin / is_controller booleans
// for accounts created before roles were assignable. A role grants a set of
// capabilities, and every privileged route is gated on a capability rather than
// on the role itself -- so operators can re-shape what each role may do, and add
// roles of their own, from the Admin - Roles page.
//
// "user" and "admin" are system roles: always present, never deletable. Every
// other role, including the "controller" a fresh install ships with, is ordinary
// data. Nothing keys off the "controller" name; what makes a role oversee groups
// is holding the users.actas capability.
//
// Config ("root") admins listed in the `admins` setting bypass the matrix and
// always hold every capability: they are the escape hatch if the matrix is ever
// edited into a corner.

// Capability keys. Keep these stable: they are persisted in setup.json.
const (
	capUsersManage  = "users.manage"  // create / delete users, reset passwords
	capRolesManage  = "roles.manage"  // assign roles, edit the permission matrix
	capGroupsManage = "groups.manage" // create groups, manage membership
	capServerManage = "server.manage" // server-wide settings
	capOAuthManage  = "oauth.manage"  // identity provider configuration
	capUsersActAs   = "users.actas"   // view/edit another user's data ("switch to")
	capI18nManage   = "translations.manage"
)

// Role keys. Also persisted, also stable.
const (
	roleUser       = "user"
	roleAdmin      = "admin"
	roleController = "controller"
)

// capDef describes one capability for the Roles page.
type capDef struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Desc  string `json:"desc"`
}

// allCaps is the catalog, in display order.
var allCaps = []capDef{
	{capUsersManage, "Manage users", "Create and delete accounts, reset passwords."},
	{capRolesManage, "Manage roles", "Assign roles to users and edit role permissions."},
	{capGroupsManage, "Manage groups", "Create groups and assign members and controllers."},
	{capServerManage, "Server settings", "Change server-wide settings such as self-registration."},
	{capOAuthManage, "OAuth providers", "Configure external identity providers."},
	{capUsersActAs, "Switch to users", "View and edit the data of users in the groups they control."},
	{capI18nManage, "Translations", "Add languages and translate the interface."},
}

// roleDef describes one role. Operators can add their own, so the label and
// description are data rather than fixed presentation.
type roleDef struct {
	Key   string   `json:"key"`
	Label string   `json:"label"`
	Desc  string   `json:"desc"`
	Caps  []string `json:"caps"`
	// System marks a role the server cannot run without: it can never be
	// deleted, and its key and label are fixed. Only "user" and "admin" are
	// system roles -- every account needs a floor to fall back to, and someone
	// has to be able to administer the server. "controller" ships with a fresh
	// install but is an ordinary role that can be renamed or removed.
	System bool `json:"system"`
}

// roleSlugRe validates a role key. Keys are generated from the label and are
// persisted, so they stay URL- and JSON-safe.
var roleSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// defaultRoles is the set a fresh server starts with, and the fallback for a
// setup.json written before roles were configurable.
func defaultRoles() []roleDef {
	return []roleDef{
		{Key: roleUser, Label: "User", System: true,
			Desc: "Standard account. Full access to their own time data only.",
			Caps: []string{}},
		{Key: roleAdmin, Label: "Admin", System: true,
			Desc: "Administers the server: users, roles, groups and settings.",
			Caps: []string{capUsersManage, capRolesManage, capGroupsManage, capServerManage, capOAuthManage, capI18nManage}},
		{Key: roleController, Label: "Controller",
			Desc: "Oversees the users in the groups they control.",
			Caps: []string{capUsersActAs}},
	}
}

// ensureSystemRoles guarantees "user" and "admin" are present, keeps their
// System flag and label authoritative, and re-adds either if a hand-edited
// setup.json dropped it -- without one the server would have no role to fall
// back to, or no way into the admin pages.
func ensureSystemRoles(in []roleDef) []roleDef {
	out := make([]roleDef, 0, len(in)+2)
	seen := map[string]bool{}
	for _, r := range in {
		if r.Key == "" || seen[r.Key] {
			continue
		}
		seen[r.Key] = true
		if def, ok := builtinRole(r.Key); ok && def.System {
			// Capabilities stay as configured; identity does not.
			r.Label, r.System = def.Label, true
			for c := range lockedCaps[r.Key] {
				if !slices.Contains(r.Caps, c) {
					r.Caps = append(r.Caps, c)
				}
			}
			sort.Strings(r.Caps)
		}
		out = append(out, r)
	}
	// Put any missing system role back, in its canonical position.
	for _, def := range defaultRoles() {
		if def.System && !seen[def.Key] {
			out = append([]roleDef{def}, out...)
		}
	}
	return out
}

// builtinRole returns the shipped definition for a key, if it is one of them.
func builtinRole(key string) (roleDef, bool) {
	for _, r := range defaultRoles() {
		if r.Key == key {
			return r, true
		}
	}
	return roleDef{}, false
}

// rolesFromLegacyCaps rebuilds full definitions from a setup.json that only
// stored the capability matrix, so an older install keeps its edits.
func rolesFromLegacyCaps(caps map[string][]string) []roleDef {
	out := defaultRoles()
	for i := range out {
		if c, ok := caps[out[i].Key]; ok {
			out[i].Caps = c
		}
	}
	return out
}

// lockedCaps are capabilities that cannot be removed from a role, because doing
// so could leave a server with no way back into the admin pages. Enforced here
// and reflected (as disabled switches) in the UI.
var lockedCaps = map[string]map[string]bool{
	roleAdmin: {capUsersManage: true, capRolesManage: true},
}

// validCap reports whether key names a known capability.
func validCap(key string) bool {
	for _, c := range allCaps {
		if c.Key == key {
			return true
		}
	}
	return false
}

// listRoles returns a copy of the role list, in display order.
func (s *Server) listRoles() []roleDef {
	s.rolesMu.RLock()
	defer s.rolesMu.RUnlock()
	out := make([]roleDef, len(s.roles))
	for i, r := range s.roles {
		out[i] = r
		caps := append([]string(nil), r.Caps...)
		sort.Strings(caps)
		if caps == nil {
			caps = []string{}
		}
		out[i].Caps = caps
	}
	return out
}

// findRole returns the definition for a role key.
func (s *Server) findRole(key string) (roleDef, bool) {
	s.rolesMu.RLock()
	defer s.rolesMu.RUnlock()
	for _, r := range s.roles {
		if r.Key == key {
			return r, true
		}
	}
	return roleDef{}, false
}

// roleCaps returns the capability set granted to a role.
func (s *Server) roleCaps(role string) map[string]bool {
	out := map[string]bool{}
	r, ok := s.findRole(role)
	if !ok {
		return out
	}
	for _, c := range r.Caps {
		out[c] = true
	}
	return out
}

// userHoldsCap reports whether a username's role grants a capability. It opens
// the user's database, so prefer capsOf when one is already open.
func (s *Server) userHoldsCap(username, cap string) bool {
	if s.isConfigAdmin(username) {
		return true
	}
	db, err := s.openUserDB(username)
	if err != nil {
		return false
	}
	defer db.Close()
	return s.capsOf(username, db)[cap]
}

// roleHasCap reports whether a role grants a capability. Group eligibility is
// decided this way rather than by role key, so a custom role that is given
// "switch to users" oversees groups exactly like the built-in Controller does.
func (s *Server) roleHasCap(role, cap string) bool {
	return s.roleCaps(role)[cap]
}

// cleanCaps validates a capability list and returns it sorted and deduplicated.
func cleanCaps(caps []string) ([]string, map[string]bool, error) {
	seen := map[string]bool{}
	clean := []string{}
	for _, c := range caps {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if !validCap(c) {
			return nil, nil, fmt.Errorf("unknown permission %q", c)
		}
		if seen[c] {
			continue
		}
		seen[c] = true
		clean = append(clean, c)
	}
	sort.Strings(clean)
	return clean, seen, nil
}

// setRoleCaps validates and persists a new capability set for one role.
func (s *Server) setRoleCaps(role string, caps []string) error {
	def, ok := s.findRole(role)
	if !ok {
		return fmt.Errorf("unknown role %q", role)
	}
	clean, seen, err := cleanCaps(caps)
	if err != nil {
		return err
	}
	for c := range lockedCaps[role] {
		if !seen[c] {
			return fmt.Errorf("the %s role cannot give up the %q permission", def.Label, c)
		}
	}
	return s.mutateRoles(func(roles []roleDef) ([]roleDef, error) {
		for i := range roles {
			if roles[i].Key == role {
				roles[i].Caps = clean
				return roles, nil
			}
		}
		return nil, fmt.Errorf("unknown role %q", role)
	})
}

// mutateRoles hands fn a copy of the role list and stores what it returns,
// rolling back if the write fails. fn returns the slice rather than editing in
// place so that adding and removing roles work like any other change.
// persistSetup is called with the lock released: it re-reads the roles itself.
func (s *Server) mutateRoles(fn func([]roleDef) ([]roleDef, error)) error {
	s.rolesMu.Lock()
	prev := s.roles
	next, err := fn(append([]roleDef(nil), s.roles...))
	if err != nil {
		s.rolesMu.Unlock()
		return err
	}
	s.roles = next
	s.rolesMu.Unlock()

	if err := s.persistSetup(); err != nil {
		s.rolesMu.Lock()
		s.roles = prev
		s.rolesMu.Unlock()
		return err
	}
	return nil
}

// roleKeyFrom derives a unique role key from a label.
func (s *Server) roleKeyFrom(label string) (string, error) {
	base := slugify(label)
	if base == "" || !roleSlugRe.MatchString(base) {
		return "", fmt.Errorf("the role name must contain at least one letter or digit")
	}
	if len(base) > 32 {
		base = base[:32]
	}
	key := base
	for i := 2; ; i++ {
		if _, exists := s.findRole(key); !exists {
			return key, nil
		}
		key = fmt.Sprintf("%s-%d", base, i)
		if len(key) > 32 || i > 99 {
			return "", fmt.Errorf("could not derive a unique key for %q", label)
		}
	}
}

// createRole adds a new role and returns its generated key.
func (s *Server) createRole(label, desc string, caps []string) (string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", fmt.Errorf("a role name is required")
	}
	if len(label) > 40 {
		return "", fmt.Errorf("the role name must be at most 40 characters")
	}
	clean, _, err := cleanCaps(caps)
	if err != nil {
		return "", err
	}
	key, err := s.roleKeyFrom(label)
	if err != nil {
		return "", err
	}
	err = s.mutateRoles(func(roles []roleDef) ([]roleDef, error) {
		return append(roles, roleDef{
			Key: key, Label: label, Desc: strings.TrimSpace(desc), Caps: clean,
		}), nil
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

// renameRole updates the label and description of a non-system role.
func (s *Server) renameRole(key, label, desc string) error {
	def, ok := s.findRole(key)
	if !ok {
		return fmt.Errorf("unknown role %q", key)
	}
	label = strings.TrimSpace(label)
	if label == "" {
		return fmt.Errorf("a role name is required")
	}
	if len(label) > 40 {
		return fmt.Errorf("the role name must be at most 40 characters")
	}
	if def.System && label != def.Label {
		return fmt.Errorf("the %s role is built in and cannot be renamed", def.Label)
	}
	return s.mutateRoles(func(roles []roleDef) ([]roleDef, error) {
		for i := range roles {
			if roles[i].Key == key {
				roles[i].Label = label
				roles[i].Desc = strings.TrimSpace(desc)
				return roles, nil
			}
		}
		return nil, fmt.Errorf("unknown role %q", key)
	})
}

// deleteRole removes a role. System roles stay, and a role somebody still holds
// is refused rather than silently demoting them.
func (s *Server) deleteRole(key string) error {
	def, ok := s.findRole(key)
	if !ok {
		return fmt.Errorf("unknown role %q", key)
	}
	if def.System {
		return fmt.Errorf("the %s role is built in and cannot be deleted", def.Label)
	}
	holders, err := s.roleHolders(key)
	if err != nil {
		return err
	}
	if len(holders) > 0 {
		return fmt.Errorf("%d %s still %s the %s role — change their role first",
			len(holders), plural(len(holders), "user", "users"),
			plural(len(holders), "has", "have"), def.Label)
	}
	return s.mutateRoles(func(roles []roleDef) ([]roleDef, error) {
		out := make([]roleDef, 0, len(roles))
		for _, r := range roles {
			if r.Key != key {
				out = append(out, r)
			}
		}
		return out, nil
	})
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// roleHolders lists the usernames currently holding a role.
func (s *Server) roleHolders(key string) ([]string, error) {
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range metas {
		db, err := s.openUserDB(m.Username)
		if err != nil {
			continue
		}
		role := s.userRole(m.Username, db)
		db.Close()
		if role == key {
			out = append(out, m.Username)
		}
	}
	return out, nil
}

// roleFlagKey is the userinfo key holding the role a user has been assigned.
// Accounts created before custom roles have no such key; their role is derived
// from the old is_admin / is_controller booleans instead, so an upgrade needs no
// migration pass. setUserRole keeps both in step from then on.
const roleFlagKey = "role"

// userRole reports the role held by username. db is the user's (open) database.
func (s *Server) userRole(username string, db store.UserDB) string {
	if s.isConfigAdmin(username) {
		return roleAdmin
	}
	if db == nil {
		return roleUser
	}
	if key, _ := userinfoGet(db, roleFlagKey).(string); key != "" {
		// A role that has since been deleted would strand the account, so fall
		// through to the legacy derivation rather than trusting a dangling key.
		if _, ok := s.findRole(key); ok {
			return key
		}
	}
	if dbAdminFlag(db) {
		return roleAdmin
	}
	if dbControllerFlag(db) {
		return roleController
	}
	return roleUser
}

// setUserRole assigns a role. The legacy booleans are written alongside it so
// that anything still reading them -- and an older binary, if the operator rolls
// back -- sees a consistent picture.
func (s *Server) setUserRole(username, key string) error {
	def, ok := s.findRole(key)
	if !ok {
		return fmt.Errorf("unknown role %q", key)
	}
	db, err := s.openUserDB(username)
	if err != nil {
		return err
	}
	defer db.Close()
	isAdmin := key == roleAdmin
	isController := false
	for _, c := range def.Caps {
		if c == capUsersActAs {
			isController = true
		}
	}
	return firstErr(
		userinfoPut(db, roleFlagKey, key),
		userinfoPut(db, adminFlagKey, isAdmin),
		userinfoPut(db, controllerFlagKey, isController),
	)
}

// capsOf returns the effective capability set for username. Config admins hold
// every capability unconditionally.
func (s *Server) capsOf(username string, db store.UserDB) map[string]bool {
	if s.isConfigAdmin(username) {
		out := map[string]bool{}
		for _, c := range allCaps {
			out[c.Key] = true
		}
		return out
	}
	return s.roleCaps(s.userRole(username, db))
}

// hasCap reports whether username holds capability cap.
func (s *Server) hasCap(username string, db store.UserDB, cap string) bool {
	return s.capsOf(username, db)[cap]
}

// capList renders a capability set as a sorted slice, for JSON responses.
func capList(caps map[string]bool) []string {
	out := make([]string, 0, len(caps))
	for c := range caps {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// hasAnyAdminCap reports whether the set contains at least one capability that
// unlocks an admin page. Used to decide whether to show the Admin menu at all.
func hasAnyAdminCap(caps map[string]bool) bool {
	return caps[capUsersManage] || caps[capRolesManage] || caps[capGroupsManage] ||
		caps[capServerManage] || caps[capOAuthManage] || caps[capI18nManage]
}

// adminGetRoles returns the permission matrix plus the capability catalog, the
// locked capabilities, and a per-role member count for the Roles page.
func (s *Server) adminGetRoles() response {
	roles := s.listRoles()
	counts := map[string]int{}
	for _, r := range roles {
		counts[r.Key] = 0
	}
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	for _, m := range metas {
		if s.isConfigAdmin(m.Username) {
			counts[roleAdmin]++
			continue
		}
		db, err := s.openUserDB(m.Username)
		if err != nil {
			continue
		}
		counts[s.userRole(m.Username, db)]++
		db.Close()
	}
	locked := map[string][]string{}
	for role, set := range lockedCaps {
		locked[role] = capList(set)
	}
	return jsonResp(200, map[string]any{
		"roles":        roles,
		"capabilities": allCaps,
		"locked":       locked,
		"counts":       counts,
	})
}

// adminSetRole updates the capability set of a single role. Body is JSON
// {"role": "admin", "caps": ["users.manage", ...]}.
func (s *Server) adminSetRole(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Role string   `json:"role"`
		Caps []string `json:"caps"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with role and caps")
	}
	if err := s.setRoleCaps(strings.TrimSpace(body.Role), body.Caps); err != nil {
		return textResp(400, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "roles": s.listRoles()})
}

// adminCreateRole adds a role. Body is JSON {"label": ..., "desc": ..., "caps": [...]}.
func (s *Server) adminCreateRole(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Label string   `json:"label"`
		Desc  string   `json:"desc"`
		Caps  []string `json:"caps"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with a label")
	}
	key, err := s.createRole(body.Label, body.Desc, body.Caps)
	if err != nil {
		return textResp(400, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "key": key, "roles": s.listRoles()})
}

// adminRenameRole updates a role's name and description.
func (s *Server) adminRenameRole(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Role  string `json:"role"`
		Label string `json:"label"`
		Desc  string `json:"desc"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with role and label")
	}
	if err := s.renameRole(strings.TrimSpace(body.Role), body.Label, body.Desc); err != nil {
		return textResp(400, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "roles": s.listRoles()})
}

// adminDeleteRole removes a role nobody holds.
func (s *Server) adminDeleteRole(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with role")
	}
	if err := s.deleteRole(strings.TrimSpace(body.Role)); err != nil {
		return textResp(400, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "roles": s.listRoles()})
}

// adminSetUserRole assigns a role to a user. It replaces the old pair of
// admin/controller toggles, which could only express the three built-in roles.
func (s *Server) adminSetUserRole(req *request, adminUser string) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and role")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	// Same guards the old admin toggle had: never let an admin demote themselves
	// out of the admin pages, and never touch a config-defined root admin.
	if username == adminUser {
		return textResp(400, "you cannot change your own role")
	}
	if s.isConfigAdmin(username) {
		return textResp(400, "this user is a config-defined admin and cannot be changed here")
	}
	if err := s.setUserRole(username, strings.TrimSpace(body.Role)); err != nil {
		return textResp(400, err.Error())
	}
	// The new role may make an existing group membership invalid (a controller
	// cannot be a member, and a plain user cannot control a group).
	if err := s.pruneUserFromGroups(username); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}
