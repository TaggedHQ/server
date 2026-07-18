package server

import (
	"encoding/json"
	"slices"
	"testing"
)

// roleKeys lists the current role keys, in order.
func roleKeys(s *Server) []string {
	out := []string{}
	for _, r := range s.listRoles() {
		out = append(out, r.Key)
	}
	return out
}

// newRole creates a role over the API and returns its key.
func newRole(t *testing.T, s *Server, token, label string, caps ...string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"label": label, "caps": caps})
	w := doAPI(t, s, "POST", "/api/v2/admin/role", token, string(body))
	if w.Code != 200 {
		t.Fatalf("create role %q: %d %s", label, w.Code, w.Body.String())
	}
	var out struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode key: %v", err)
	}
	return out.Key
}

func TestCustomRoleIsCreatedWithASlugKey(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)

	if got := newRole(t, s, token, "Team Lead"); got != "team-lead" {
		t.Errorf("key = %q, want %q", got, "team-lead")
	}
	// A clashing name gets its own key rather than overwriting.
	if got := newRole(t, s, token, "Team Lead"); got != "team-lead-2" {
		t.Errorf("second key = %q, want %q", got, "team-lead-2")
	}
	if got := roleKeys(s); !slices.Contains(got, "team-lead-2") {
		t.Errorf("roles = %v, want the second role present", got)
	}
}

// "user" and "admin" are the two the server cannot run without.
func TestSystemRolesCannotBeDeleted(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)

	for _, key := range []string{roleUser, roleAdmin} {
		w := doAPI(t, s, "DELETE", "/api/v2/admin/role", token, `{"role":"`+key+`"}`)
		if w.Code != 400 {
			t.Errorf("delete %q: got %d, want 400", key, w.Code)
		}
		if _, ok := s.findRole(key); !ok {
			t.Errorf("%q was deleted", key)
		}
	}
}

// Controller ships with a fresh install but is ordinary data.
func TestControllerRoleCanBeDeleted(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)

	w := doAPI(t, s, "DELETE", "/api/v2/admin/role", token, `{"role":"`+roleController+`"}`)
	if w.Code != 200 {
		t.Fatalf("delete controller: %d %s", w.Code, w.Body.String())
	}
	if _, ok := s.findRole(roleController); ok {
		t.Error("the controller role survived deletion")
	}
}

// Deleting a role somebody holds would silently change what they can do.
func TestRoleInUseCannotBeDeleted(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	key := newRole(t, s, token, "Team Lead")
	mkPasswordUser(t, s, "u@x.com", "secret")

	if w := doAPI(t, s, "PUT", "/api/v2/admin/userrole", token,
		`{"username":"u@x.com","role":"`+key+`"}`); w.Code != 200 {
		t.Fatalf("assign role: %d %s", w.Code, w.Body.String())
	}
	w := doAPI(t, s, "DELETE", "/api/v2/admin/role", token, `{"role":"`+key+`"}`)
	if w.Code != 400 {
		t.Fatalf("delete a role in use: got %d, want 400", w.Code)
	}
	if _, ok := s.findRole(key); !ok {
		t.Error("the role was deleted despite being held")
	}

	// Move the holder off it and the delete goes through.
	if w := doAPI(t, s, "PUT", "/api/v2/admin/userrole", token,
		`{"username":"u@x.com","role":"user"}`); w.Code != 200 {
		t.Fatalf("reassign: %d %s", w.Code, w.Body.String())
	}
	if w := doAPI(t, s, "DELETE", "/api/v2/admin/role", token, `{"role":"`+key+`"}`); w.Code != 200 {
		t.Fatalf("delete after reassigning: %d %s", w.Code, w.Body.String())
	}
}

// The whole point of the capability model: a custom role that is granted
// "switch to users" oversees groups exactly like the built-in Controller.
func TestCustomRoleWithActAsControlsGroups(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	key := newRole(t, s, token, "Team Lead", capUsersActAs)
	mkPasswordUser(t, s, "lead@x.com", "secret")
	mkPasswordUser(t, s, "member@x.com", "secret")
	if w := doAPI(t, s, "PUT", "/api/v2/admin/userrole", token,
		`{"username":"lead@x.com","role":"`+key+`"}`); w.Code != 200 {
		t.Fatalf("assign role: %d %s", w.Code, w.Body.String())
	}

	// Offered as a controller, not as a member.
	w := doAPI(t, s, "GET", "/api/v2/admin/groups", token, "")
	var listed struct {
		Users       []string `json:"candidate_users"`
		Controllers []string `json:"candidate_controllers"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode groups: %v", err)
	}
	if !slices.Contains(listed.Controllers, "lead@x.com") {
		t.Errorf("controller candidates = %v, want lead@x.com", listed.Controllers)
	}
	if slices.Contains(listed.Users, "lead@x.com") {
		t.Errorf("member candidates = %v, want lead@x.com excluded", listed.Users)
	}

	// And the group actually accepts them on that side.
	id := mkGroup(t, s, token, "Alpha")
	if w := doAPI(t, s, "PUT", "/api/v2/admin/groups", token,
		`{"id":"`+id+`","name":"Alpha","members":["member@x.com"],"controllers":["lead@x.com"]}`); w.Code != 200 {
		t.Fatalf("save group: %d %s", w.Code, w.Body.String())
	}
	if got := s.controllerTargets("lead@x.com"); !got["member@x.com"] {
		t.Error("the custom role cannot act as its group's member")
	}
}

// The mirror of the rule above: holding the capability rules you out as a member.
func TestRoleWithActAsCannotBeAGroupMember(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	key := newRole(t, s, token, "Team Lead", capUsersActAs)
	mkPasswordUser(t, s, "lead@x.com", "secret")
	if w := doAPI(t, s, "PUT", "/api/v2/admin/userrole", token,
		`{"username":"lead@x.com","role":"`+key+`"}`); w.Code != 200 {
		t.Fatalf("assign role: %d %s", w.Code, w.Body.String())
	}
	id := mkGroup(t, s, token, "Alpha")
	w := doAPI(t, s, "PUT", "/api/v2/admin/groups", token,
		`{"id":"`+id+`","name":"Alpha","members":["lead@x.com"],"controllers":[]}`)
	if w.Code != 400 {
		t.Fatalf("adding a controller-capable user as a member: got %d, want 400", w.Code)
	}
}

// Accounts predating assignable roles have only the old booleans; their role has
// to keep resolving so an upgrade does not silently demote anybody.
func TestLegacyFlagsStillResolveToARole(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "old-admin@x.com", "secret")
	mkPasswordUser(t, s, "old-ctrl@x.com", "secret")
	if err := s.setStoredAdmin("old-admin@x.com", true); err != nil {
		t.Fatalf("setStoredAdmin: %v", err)
	}
	if err := s.setStoredController("old-ctrl@x.com", true); err != nil {
		t.Fatalf("setStoredController: %v", err)
	}

	for _, tc := range []struct{ user, want string }{
		{"old-admin@x.com", roleAdmin},
		{"old-ctrl@x.com", roleController},
	} {
		db, err := s.openUserDB(tc.user)
		if err != nil {
			t.Fatalf("openUserDB: %v", err)
		}
		got := s.userRole(tc.user, db)
		db.Close()
		if got != tc.want {
			t.Errorf("%s resolved to %q, want %q", tc.user, got, tc.want)
		}
	}
}

// A setup.json holding only the old capability matrix must come back as full
// role definitions rather than resetting the operator's edits.
func TestLegacySetupMatrixBecomesRoleDefs(t *testing.T) {
	roles := ensureSystemRoles(rolesFromLegacyCaps(map[string][]string{
		roleUser:       {},
		roleAdmin:      {capUsersManage, capRolesManage},
		roleController: {capUsersActAs, capGroupsManage},
	}))
	byKey := map[string]roleDef{}
	for _, r := range roles {
		byKey[r.Key] = r
	}
	if got := byKey[roleController].Caps; !slices.Contains(got, capGroupsManage) {
		t.Errorf("controller caps = %v, want the edited set preserved", got)
	}
	if !byKey[roleAdmin].System || !byKey[roleUser].System {
		t.Error("the built-in roles lost their system flag")
	}
	if byKey[roleController].System {
		t.Error("controller should not be a system role")
	}
}

// A hand-edited setup.json that dropped a system role must not strand the
// server with no way into the admin pages.
func TestMissingSystemRoleIsRestored(t *testing.T) {
	roles := ensureSystemRoles([]roleDef{
		{Key: roleController, Label: "Controller", Caps: []string{capUsersActAs}},
	})
	keys := []string{}
	for _, r := range roles {
		keys = append(keys, r.Key)
	}
	for _, want := range []string{roleUser, roleAdmin} {
		if !slices.Contains(keys, want) {
			t.Errorf("roles = %v, want %q restored", keys, want)
		}
	}
	// And the admin role comes back with its locked capabilities intact.
	for _, r := range roles {
		if r.Key == roleAdmin && !slices.Contains(r.Caps, capUsersManage) {
			t.Errorf("restored admin caps = %v, want users.manage", r.Caps)
		}
	}
}

// An admin must not be able to change their own role, or a mis-click could
// remove the last route back into the admin pages.
func TestAdminCannotChangeTheirOwnRole(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	w := doAPI(t, s, "PUT", "/api/v2/admin/userrole", token,
		`{"username":"admin@x.com","role":"user"}`)
	if w.Code != 400 {
		t.Fatalf("self role change: got %d %s, want 400", w.Code, w.Body.String())
	}
}
