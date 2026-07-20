package server

import (
	"encoding/json"
	"testing"
)

// newShiftsServer stands up a server with the shifts module already switched
// on. The module gate is asserted in its own tests; every test here starts from
// the point where a caller has cleared it.
func newShiftsServer(t *testing.T) *Server {
	t.Helper()
	s := newTestServer(t)
	if err := s.setModuleEnabled(moduleShifts, true); err != nil {
		t.Fatalf("enable shifts: %v", err)
	}
	return s
}

// mkShift creates a shift over the API and returns its id. It only takes what
// the tests actually vary; everything else is a sensible default so a test can
// say what it means and no more.
func mkShift(t *testing.T, s *Server, tok string, body map[string]any) map[string]any {
	t.Helper()
	if _, ok := body["date"]; !ok {
		body["date"] = "2026-07-15"
	}
	if _, ok := body["start"]; !ok {
		body["start"] = "09:00"
	}
	if _, ok := body["end"]; !ok {
		body["end"] = "17:00"
	}
	raw, _ := json.Marshal(body)
	w := doAPI(t, s, "PUT", "/api/v2/shifts", tok, string(raw))
	if w.Code != 200 {
		t.Fatalf("create shift: %d %s", w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode shift: %v", err)
	}
	return out["shift"].(map[string]any)
}

// Every list in the payload must be an array, never null. Locations and working
// areas have no shipped defaults, so on an uncustomised server they are nil
// slices -- and a nil slice marshals as JSON null, which the page walks into
// with .map on its first render.
func TestShiftListsAreNeverNull(t *testing.T) {
	s := newShiftsServer(t)
	admin := mkAdminToken(t, s)

	for _, path := range []string{
		"/api/v2/shifts?from=2026-07-13&to=2026-07-19",
		"/api/v2/admin/shift-axes",
	} {
		w := doAPI(t, s, "GET", path, admin, "")
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s: decode: %v", path, err)
		}
		for _, key := range []string{"roles", "locations", "areas", "shifts", "groups"} {
			v, present := out[key]
			if !present {
				continue // not every endpoint returns every key
			}
			if v == nil {
				t.Errorf("%s: %q is null, want an empty array", path, key)
			}
		}
	}
}

// A member cannot plan the roster: only a controller of the group may create,
// edit or delete shifts. This is the fence the whole feature relies on.
func TestOnlyManagersCanCreateShifts(t *testing.T) {
	s := newShiftsServer(t)
	admin := mkAdminToken(t, s)
	_, memberTok := mkTeam(t, s, admin)

	body, _ := json.Marshal(map[string]any{
		"group": "ops", "date": "2026-07-15", "start": "09:00", "end": "17:00",
	})
	w := doAPI(t, s, "PUT", "/api/v2/shifts", memberTok, string(body))
	if w.Code != 403 {
		t.Fatalf("member creating a shift = %d %s, want 403", w.Code, w.Body.String())
	}
}

// The manager path is the sunny day: the shift lands, GET returns it in range,
// and the assignee's provenance says "assigned" (By != User), which is what
// keeps them from silently handing it back later.
func TestManagerCanCreateAndAssign(t *testing.T) {
	s := newShiftsServer(t)
	admin := mkAdminToken(t, s)
	mgr, _ := mkTeam(t, s, admin)

	sh := mkShift(t, s, mgr, map[string]any{
		"group": "ops", "assign": []string{"member@x.com"}, "role": "support",
	})
	if sh["group"] != "ops" || sh["date"] != "2026-07-15" {
		t.Fatalf("shift = %v", sh)
	}
	assignees := sh["assignees"].([]any)
	if len(assignees) != 1 {
		t.Fatalf("assignees = %v, want one", assignees)
	}
	a := assignees[0].(map[string]any)
	if a["user"] != "member@x.com" || a["by"] != "mgr@x.com" {
		t.Errorf("assignee provenance = %v, want by mgr (assignment)", a)
	}

	w := doAPI(t, s, "GET", "/api/v2/shifts?from=2026-07-13&to=2026-07-19", mgr, "")
	if w.Code != 200 {
		t.Fatalf("get: %d %s", w.Code, w.Body.String())
	}
	var got struct {
		Shifts []map[string]any `json:"shifts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Shifts) != 1 || got.Shifts[0]["id"] != sh["id"] {
		t.Fatalf("shifts = %v, want [%s]", got.Shifts, sh["id"])
	}
}

// The whole point of open shifts: a member picks one up, and the provenance
// records that they took it themselves so they can hand it back.
func TestMemberCanClaimOpenShift(t *testing.T) {
	s := newShiftsServer(t)
	admin := mkAdminToken(t, s)
	mgr, memberTok := mkTeam(t, s, admin)

	sh := mkShift(t, s, mgr, map[string]any{"group": "ops", "slots": 2})
	body, _ := json.Marshal(map[string]any{"id": sh["id"]})

	w := doAPI(t, s, "POST", "/api/v2/shifts/claim", memberTok, string(body))
	if w.Code != 200 {
		t.Fatalf("claim: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Shift map[string]any `json:"shift"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	a := out.Shift["assignees"].([]any)[0].(map[string]any)
	if a["user"] != "member@x.com" || a["by"] != "member@x.com" {
		t.Errorf("assignee = %v, want a self-claim (by == user)", a)
	}

	// The second slot is still open.
	if slots, cov := int(out.Shift["slots"].(float64)), len(out.Shift["assignees"].([]any)); slots != 2 || cov != 1 {
		t.Errorf("coverage = %d/%d, want 1/2", cov, slots)
	}

	// Doing it a second time is a conflict, not an idempotent no-op: the shift
	// runs a person once and the API says so.
	w2 := doAPI(t, s, "POST", "/api/v2/shifts/claim", memberTok, string(body))
	if w2.Code != 409 {
		t.Errorf("second claim = %d, want 409", w2.Code)
	}
}

// A shift that is not open must not be pickable: filled cover cannot be quietly
// swapped by whoever refreshes the page next.
func TestClaimingAFilledShiftIsRejected(t *testing.T) {
	s := newShiftsServer(t)
	admin := mkAdminToken(t, s)
	mgr, memberTok := mkTeam(t, s, admin)

	sh := mkShift(t, s, mgr, map[string]any{"group": "ops", "slots": 1, "assign": []string{"member@x.com"}})
	body, _ := json.Marshal(map[string]any{"id": sh["id"]})
	w := doAPI(t, s, "POST", "/api/v2/shifts/claim", memberTok, string(body))
	if w.Code != 409 {
		t.Fatalf("claim of filled shift = %d, want 409", w.Code)
	}
}

// A member may only pick up in their own group -- an outsider taking somebody
// else's roster gap would be a leak the fence is there to stop.
func TestOutsideMembersCannotClaim(t *testing.T) {
	s := newShiftsServer(t)
	admin := mkAdminToken(t, s)
	mgr, _ := mkTeam(t, s, admin)
	outsider := mkPasswordUser(t, s, "outsider@x.com", "secret")

	sh := mkShift(t, s, mgr, map[string]any{"group": "ops", "slots": 1})
	body, _ := json.Marshal(map[string]any{"id": sh["id"]})
	w := doAPI(t, s, "POST", "/api/v2/shifts/claim", outsider, string(body))
	if w.Code != 403 {
		t.Errorf("outsider claim = %d, want 403", w.Code)
	}
}

// You may release what you took yourself. You may not release what a manager
// rostered you onto: the group is relying on the cover, and a silent drop-out
// is exactly what a roster exists to prevent.
func TestOnlySelfClaimsCanBeReleased(t *testing.T) {
	s := newShiftsServer(t)
	admin := mkAdminToken(t, s)
	mgr, memberTok := mkTeam(t, s, admin)

	// Assigned by the manager: release must be refused.
	sh := mkShift(t, s, mgr, map[string]any{"group": "ops", "assign": []string{"member@x.com"}})
	body, _ := json.Marshal(map[string]any{"id": sh["id"]})
	if w := doAPI(t, s, "POST", "/api/v2/shifts/release", memberTok, string(body)); w.Code != 403 {
		t.Errorf("release of an assigned shift = %d, want 403", w.Code)
	}

	// Self-claim: release goes through.
	sh2 := mkShift(t, s, mgr, map[string]any{"group": "ops", "slots": 1, "date": "2026-07-16"})
	claim, _ := json.Marshal(map[string]any{"id": sh2["id"]})
	if w := doAPI(t, s, "POST", "/api/v2/shifts/claim", memberTok, string(claim)); w.Code != 200 {
		t.Fatalf("claim self: %d %s", w.Code, w.Body.String())
	}
	if w := doAPI(t, s, "POST", "/api/v2/shifts/release", memberTok, string(claim)); w.Code != 200 {
		t.Fatalf("release self-claim: %d %s", w.Code, w.Body.String())
	}
}

// Reading the roster is scoped: getShifts returns only the shifts of the groups
// the caller may see. A shift in a group the caller neither manages nor belongs
// to must not leak into the response.
func TestReadingIsScopedToVisibleGroups(t *testing.T) {
	s := newShiftsServer(t)
	admin := mkAdminToken(t, s)
	mgr, _ := mkTeam(t, s, admin)
	// Second group the outsider is in, invisible to mgr.
	outsider := mkPasswordUser(t, s, "outsider@x.com", "secret")
	body, _ := json.Marshal(map[string]any{
		"name": "Kitchen", "members": []string{"outsider@x.com"}, "controllers": []string{},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/groups", admin, string(body)); w.Code != 200 {
		t.Fatalf("create kitchen: %d %s", w.Code, w.Body.String())
	}
	// The kitchen has no controller, so the outsider cannot create a shift for
	// it themselves. Make one via the admin over a raw store write.
	sh := shift{
		ID: "sh_kitchen", Group: "kitchen", Date: "2026-07-15", Start: "10:00", End: "18:00",
		Type: shiftTypeWork, Slots: 1,
	}
	if err := s.putShift(sh); err != nil {
		t.Fatalf("seed kitchen shift: %v", err)
	}
	_ = outsider

	// mgr manages ops, is not in kitchen; the kitchen shift must not appear.
	w := doAPI(t, s, "GET", "/api/v2/shifts?from=2026-07-13&to=2026-07-19", mgr, "")
	if w.Code != 200 {
		t.Fatalf("get: %d %s", w.Code, w.Body.String())
	}
	var got struct {
		Shifts []map[string]any `json:"shifts"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	for _, sh := range got.Shifts {
		if sh["group"] == "kitchen" {
			t.Errorf("kitchen shift leaked into mgr's response: %v", sh)
		}
	}
}
