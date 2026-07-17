package server

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/TaggedHQ/server/internal/store"
)

// The permission model. Every user holds exactly one role -- "user", "admin" or
// "controller" -- derived from the stored per-user flags (see adminFlagKey /
// controllerFlagKey). A role grants a set of capabilities, and every privileged
// route is gated on a capability rather than on the role itself, so operators can
// re-shape what each role may do from the Admin - Roles page.
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
}

// roleDef describes one role for the Roles page. Only Caps is editable.
type roleDef struct {
	Key   string   `json:"key"`
	Label string   `json:"label"`
	Desc  string   `json:"desc"`
	Caps  []string `json:"caps"`
}

// roleMeta holds the fixed presentation for each role, keyed by role key.
var roleMeta = map[string]struct{ Label, Desc string }{
	roleUser:       {"User", "Standard account. Full access to their own time data only."},
	roleAdmin:      {"Admin", "Administers the server: users, roles, groups and settings."},
	roleController: {"Controller", "Oversees the users in the groups they control."},
}

// roleOrder is the display order of roles.
var roleOrder = []string{roleUser, roleAdmin, roleController}

// defaultRoleCaps is the matrix a fresh server starts with (and the fallback for
// a setup.json written before roles were configurable).
func defaultRoleCaps() map[string][]string {
	return map[string][]string{
		roleUser:       {},
		roleAdmin:      {capUsersManage, capRolesManage, capGroupsManage, capServerManage, capOAuthManage},
		roleController: {capUsersActAs},
	}
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

// roleCaps returns the capability set granted to a role.
func (s *Server) roleCaps(role string) map[string]bool {
	s.rolesMu.RLock()
	caps := s.roles[role]
	s.rolesMu.RUnlock()
	out := map[string]bool{}
	for _, c := range caps {
		out[c] = true
	}
	return out
}

// listRoles returns the full matrix for the Roles page.
func (s *Server) listRoles() []roleDef {
	out := make([]roleDef, 0, len(roleOrder))
	for _, key := range roleOrder {
		s.rolesMu.RLock()
		caps := append([]string(nil), s.roles[key]...)
		s.rolesMu.RUnlock()
		sort.Strings(caps)
		if caps == nil {
			caps = []string{}
		}
		meta := roleMeta[key]
		out = append(out, roleDef{Key: key, Label: meta.Label, Desc: meta.Desc, Caps: caps})
	}
	return out
}

// setRoleCaps validates and persists a new capability set for one role.
func (s *Server) setRoleCaps(role string, caps []string) error {
	if _, ok := roleMeta[role]; !ok {
		return fmt.Errorf("unknown role %q", role)
	}
	seen := map[string]bool{}
	clean := []string{}
	for _, c := range caps {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if !validCap(c) {
			return fmt.Errorf("unknown permission %q", c)
		}
		if seen[c] {
			continue
		}
		seen[c] = true
		clean = append(clean, c)
	}
	for c := range lockedCaps[role] {
		if !seen[c] {
			return fmt.Errorf("the %s role cannot give up the %q permission", roleMeta[role].Label, c)
		}
	}
	sort.Strings(clean)

	s.rolesMu.Lock()
	prev := s.roles[role]
	s.roles[role] = clean
	s.rolesMu.Unlock()

	if err := s.persistSetup(); err != nil {
		s.rolesMu.Lock()
		s.roles[role] = prev
		s.rolesMu.Unlock()
		return err
	}
	return nil
}

// userRole reports the role held by username. db is the user's (open) database.
func (s *Server) userRole(username string, db store.UserDB) string {
	if s.isConfigAdmin(username) {
		return roleAdmin
	}
	if db == nil {
		return roleUser
	}
	if dbAdminFlag(db) {
		return roleAdmin
	}
	if dbControllerFlag(db) {
		return roleController
	}
	return roleUser
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
		caps[capServerManage] || caps[capOAuthManage]
}

// adminGetRoles returns the permission matrix plus the capability catalog, the
// locked capabilities, and a per-role member count for the Roles page.
func (s *Server) adminGetRoles() response {
	counts := map[string]int{roleUser: 0, roleAdmin: 0, roleController: 0}
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	for _, m := range metas {
		if s.isConfigAdmin(m.Username) {
			counts[roleAdmin]++
			continue
		}
		_, storedAdmin, storedController := s.userFlags(m.Username)
		switch {
		case storedAdmin:
			counts[roleAdmin]++
		case storedController:
			counts[roleController]++
		default:
			counts[roleUser]++
		}
	}
	locked := map[string][]string{}
	for role, set := range lockedCaps {
		locked[role] = capList(set)
	}
	return jsonResp(200, map[string]any{
		"roles":        s.listRoles(),
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
