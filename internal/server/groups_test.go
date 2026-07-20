package server

import (
	"encoding/json"
	"slices"
	"testing"
)

// setGroupMembers rewrites one group's member list over the API, returning the
// response so a caller can inspect which members were moved off other groups.
// The save endpoint replaces the whole group, so the existing controllers are
// sent back unchanged -- otherwise editing members would silently clear them.
func setGroupMembers(t *testing.T, s *Server, token, id, name string, members ...string) map[string]any {
	t.Helper()
	controllers := groupByID(t, s, id).Controllers
	if controllers == nil {
		controllers = []string{}
	}
	body, _ := json.Marshal(map[string]any{
		"id": id, "name": name, "members": members, "controllers": controllers,
	})
	w := doAPI(t, s, "PUT", "/api/v2/admin/groups", token, string(body))
	if w.Code != 200 {
		t.Fatalf("save group %q: %d %s", id, w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode save response: %v", err)
	}
	return out
}

// Adding somebody to a group takes them out of the one they were in. The admin
// edits a single group at a time, so this has to happen as a side effect --
// otherwise the invariant could only ever be maintained by a two-step dance.
func TestAddingAMemberMovesThemOutOfTheirOldGroup(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	mkPasswordUser(t, s, "user@x.com", "secret")
	a := mkGroup(t, s, token, "Alpha")
	b := mkGroup(t, s, token, "Beta")

	setGroupMembers(t, s, token, a, "Alpha", "user@x.com")
	if !slices.Contains(groupByID(t, s, a).Members, "user@x.com") {
		t.Fatal("member was not added to Alpha")
	}

	out := setGroupMembers(t, s, token, b, "Beta", "user@x.com")
	if got := groupByID(t, s, a).Members; slices.Contains(got, "user@x.com") {
		t.Errorf("Alpha still has the member after the move: %v", got)
	}
	if !slices.Contains(groupByID(t, s, b).Members, "user@x.com") {
		t.Error("Beta did not gain the member")
	}

	// The move must be reported: silently pulling somebody off another team is
	// exactly the side effect an admin needs told about.
	moved, _ := out["moved"].([]any)
	if len(moved) != 1 {
		t.Fatalf("moved = %v, want one entry", out["moved"])
	}
	m, _ := moved[0].(map[string]any)
	if m["username"] != "user@x.com" || m["from"] != a {
		t.Errorf("moved entry = %v, want user@x.com from %q", m, a)
	}
}

// Re-saving a group the member is already in must not report a spurious move.
func TestResavingAGroupReportsNoMove(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	mkPasswordUser(t, s, "user@x.com", "secret")
	a := mkGroup(t, s, token, "Alpha")

	setGroupMembers(t, s, token, a, "Alpha", "user@x.com")
	out := setGroupMembers(t, s, token, a, "Alpha", "user@x.com")
	if moved, _ := out["moved"].([]any); len(moved) != 0 {
		t.Errorf("moved = %v, want none", out["moved"])
	}
	if !slices.Contains(groupByID(t, s, a).Members, "user@x.com") {
		t.Error("re-saving the group dropped its own member")
	}
}

// A controller on several groups must survive a member edit untouched: the
// exclusivity rule applies to the member list only.
func TestMovingMembersLeavesControllersAlone(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	mkPasswordUser(t, s, "ctrl@x.com", "secret")
	if err := s.setStoredController("ctrl@x.com", true); err != nil {
		t.Fatalf("setStoredController: %v", err)
	}
	mkPasswordUser(t, s, "user@x.com", "secret")
	a := mkGroup(t, s, token, "Alpha")
	b := mkGroup(t, s, token, "Beta")

	for _, id := range []string{a, b} {
		body, _ := json.Marshal(map[string]any{
			"id": id, "name": groupByID(t, s, id).Name,
			"members": []string{}, "controllers": []string{"ctrl@x.com"},
		})
		if w := doAPI(t, s, "PUT", "/api/v2/admin/groups", token, string(body)); w.Code != 200 {
			t.Fatalf("set controller on %q: %d %s", id, w.Code, w.Body.String())
		}
	}
	// Now move a member between the two groups.
	setGroupMembers(t, s, token, a, "Alpha", "user@x.com")

	for _, id := range []string{a, b} {
		if !slices.Contains(groupByID(t, s, id).Controllers, "ctrl@x.com") {
			t.Errorf("controller lost from %q after a member edit", id)
		}
	}
}

// A setup.json written before membership became exclusive (or edited by hand)
// can put somebody in two groups. Booting must repair it rather than carry the
// broken state forward.
func TestLoadRepairsMultiGroupMembership(t *testing.T) {
	groups := []group{
		{ID: "alpha", Name: "Alpha", Members: []string{"user@x.com", "other@x.com"}},
		{ID: "beta", Name: "Beta", Members: []string{"user@x.com"}},
		{ID: "gamma", Name: "Gamma", Members: []string{"user@x.com", "third@x.com"}},
	}
	trimmed := normalizeGroupMembership(groups)

	if want := []string{"user@x.com", "user@x.com"}; !slices.Equal(trimmed, want) {
		t.Errorf("trimmed = %v, want %v", trimmed, want)
	}
	// First membership in list order wins; everyone else is untouched.
	for _, tc := range []struct {
		id   string
		want []string
	}{
		{"alpha", []string{"user@x.com", "other@x.com"}},
		{"beta", []string{}},
		{"gamma", []string{"third@x.com"}},
	} {
		got := groupByIDIn(groups, tc.id).Members
		if !slices.Equal(got, tc.want) {
			t.Errorf("%s members = %v, want %v", tc.id, got, tc.want)
		}
	}
}

// groupByIDIn looks a group up in a plain slice, for tests that build one by
// hand rather than going through a server.
func groupByIDIn(groups []group, id string) group {
	for _, g := range groups {
		if g.ID == id {
			return g
		}
	}
	return group{}
}

// memberGroupOf is what the features on top of groups will ask: which single
// team is this person on?
func TestMemberGroupOf(t *testing.T) {
	groups := []group{
		{ID: "alpha", Members: []string{"a@x.com"}},
		{ID: "beta", Members: []string{"b@x.com", "c@x.com"}},
	}
	for _, tc := range []struct{ user, want string }{
		{"a@x.com", "alpha"},
		{"c@x.com", "beta"},
		{"nobody@x.com", ""},
	} {
		if got := memberGroupOf(groups, tc.user); got != tc.want {
			t.Errorf("memberGroupOf(%q) = %q, want %q", tc.user, got, tc.want)
		}
	}
}

// A group can carry a Font Awesome icon, validated the same way a skill's is.
func TestGroupIconIsStoredAndValidated(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)

	body, _ := json.Marshal(map[string]any{
		"name": "Warehouse", "icon": "people-group", "icon_style": "solid",
		"members": []string{}, "controllers": []string{},
	})
	w := doAPI(t, s, "PUT", "/api/v2/admin/groups", token, string(body))
	if w.Code != 200 {
		t.Fatalf("create group: %d %s", w.Code, w.Body.String())
	}
	g := groupByID(t, s, "warehouse")
	if g.Icon != "people-group" || g.IconStyle != "solid" {
		t.Errorf("icon = %q/%q, want people-group/solid", g.Icon, g.IconStyle)
	}

	// A malformed icon is refused rather than stored.
	body, _ = json.Marshal(map[string]any{
		"id": "warehouse", "name": "Warehouse", "icon": "bad name",
		"members": []string{}, "controllers": []string{},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/groups", token, string(body)); w.Code != 400 {
		t.Errorf("bad icon: got %d, want 400", w.Code)
	}

	// An unknown style falls back to solid rather than erroring.
	body, _ = json.Marshal(map[string]any{
		"id": "warehouse", "name": "Warehouse", "icon": "boxes-stacked", "icon_style": "duotone",
		"members": []string{}, "controllers": []string{},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/groups", token, string(body)); w.Code != 200 {
		t.Fatalf("style fallback: %d %s", w.Code, w.Body.String())
	}
	if got := groupByID(t, s, "warehouse").IconStyle; got != "solid" {
		t.Errorf("icon_style = %q, want solid fallback", got)
	}
}
