package server

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/TaggedHQ/server/internal/store"
)

// mkSkill creates a catalog entry with the given options and returns its id.
func mkSkill(t *testing.T, s *Server, token, name string, opts map[string]any) string {
	t.Helper()
	body := map[string]any{"name": name, "cat": "development"}
	for k, v := range opts {
		body[k] = v
	}
	raw, _ := json.Marshal(body)
	w := doAPI(t, s, "POST", "/api/v2/skills", token, string(raw))
	if w.Code != 200 {
		t.Fatalf("create skill %q: %d %s", name, w.Code, w.Body.String())
	}
	var out struct {
		Skill skill `json:"skill"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode skill: %v", err)
	}
	return out.Skill.ID
}

// holderOf returns one account's entry in the open list for a skill.
func holderOf(t *testing.T, s *Server, token, skillID, username string) map[string]any {
	t.Helper()
	w := doAPI(t, s, "GET", "/api/v2/skills", token, "")
	if w.Code != 200 {
		t.Fatalf("get skills: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Ratings map[string][]map[string]any `json:"ratings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode ratings: %v", err)
	}
	for _, h := range out.Ratings[skillID] {
		if h["username"] == username {
			return h
		}
	}
	return nil
}

// mkTeam sets up a manager controlling a group that holds one member.
func mkTeam(t *testing.T, s *Server, adminTok string) (mgrTok, memberTok string) {
	t.Helper()
	mgrTok = mkPasswordUser(t, s, "mgr@x.com", "secret")
	if err := s.setStoredController("mgr@x.com", true); err != nil {
		t.Fatalf("setStoredController: %v", err)
	}
	memberTok = mkPasswordUser(t, s, "member@x.com", "secret")
	body, _ := json.Marshal(map[string]any{
		"name": "Ops", "members": []string{"member@x.com"}, "controllers": []string{"mgr@x.com"},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/groups", adminTok, string(body)); w.Code != 200 {
		t.Fatalf("create group: %d %s", w.Code, w.Body.String())
	}
	return mgrTok, memberTok
}

// A skill that needs approval must not count until somebody signs it off.
func TestSelfClaimPendsWhenApprovalIsRequired(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	_, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_approval": true})

	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 3})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 200 {
		t.Fatalf("self-claim: %d %s", w.Code, w.Body.String())
	}
	h := holderOf(t, s, member, id, "member@x.com")
	if h == nil || h["status"] != statusPending {
		t.Fatalf("status = %v, want pending", h)
	}
}

// A manager assigning the skill is the approval: no second step.
func TestManagerAssignmentIsAlreadyApproved(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, _ := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_approval": true})

	body, _ := json.Marshal(map[string]any{"username": "member@x.com", "skill_id": id, "level": 2})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/assign", mgr, string(body)); w.Code != 200 {
		t.Fatalf("assign: %d %s", w.Code, w.Body.String())
	}
	h := holderOf(t, s, mgr, id, "member@x.com")
	if h["status"] != statusActive {
		t.Errorf("status = %v, want active", h["status"])
	}
	if h["approved_by"] != "mgr@x.com" || h["assigned_by"] != "mgr@x.com" {
		t.Errorf("audit trail = %v, want assigned and approved by the manager", h)
	}
}

// Approval clears the pending state and records who stands behind it.
func TestManagerApprovesAPendingClaim(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_approval": true})

	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 3})
	doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body))

	body, _ = json.Marshal(map[string]any{"username": "member@x.com", "skill_id": id})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/approve", mgr, string(body)); w.Code != 200 {
		t.Fatalf("approve: %d %s", w.Code, w.Body.String())
	}
	h := holderOf(t, s, mgr, id, "member@x.com")
	if h["status"] != statusActive || h["approved_by"] != "mgr@x.com" {
		t.Errorf("after approval = %v, want active and approved by the manager", h)
	}
}

// Rejecting clears the claim so the holder can try again with better evidence.
func TestRejectingClearsTheClaim(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_approval": true})

	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 3})
	doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body))

	body, _ = json.Marshal(map[string]any{"username": "member@x.com", "skill_id": id, "reject": true})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/approve", mgr, string(body)); w.Code != 200 {
		t.Fatalf("reject: %d %s", w.Code, w.Body.String())
	}
	if h := holderOf(t, s, mgr, id, "member@x.com"); h != nil {
		t.Errorf("holder still listed after rejection: %v", h)
	}
}

// Management follows the group. A controller of some other group is a stranger.
func TestOnlyTheHoldersOwnManagerCanAssign(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	_, _ = mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", nil)

	// A controller who controls no group containing member@x.com.
	outsider := mkPasswordUser(t, s, "other@x.com", "secret")
	if err := s.setStoredController("other@x.com", true); err != nil {
		t.Fatalf("setStoredController: %v", err)
	}
	body, _ := json.Marshal(map[string]any{"username": "member@x.com", "skill_id": id, "level": 2})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/assign", outsider, string(body)); w.Code != 403 {
		t.Errorf("outsider assign: got %d, want 403", w.Code)
	}
}

// The pending state exists so somebody else looks at the claim; approving your
// own would defeat it entirely.
func TestSelfApprovalIsRefused(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, _ := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_approval": true})

	// The manager claims the skill for themselves, then tries to sign it off.
	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 3})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", mgr, string(body)); w.Code != 200 {
		t.Fatalf("self-claim: %d %s", w.Code, w.Body.String())
	}
	body, _ = json.Marshal(map[string]any{"username": "mgr@x.com", "skill_id": id})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/approve", mgr, string(body)); w.Code != 403 {
		t.Errorf("self-approval: got %d, want 403", w.Code)
	}
}

// A user in no group would otherwise pend forever, so skills.manage can act
// anywhere as the backstop.
func TestAdminCanApproveAUserWithNoGroup(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	loner := mkPasswordUser(t, s, "loner@x.com", "secret")
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_approval": true})

	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 2})
	doAPI(t, s, "PUT", "/api/v2/skills/mine", loner, string(body))

	body, _ = json.Marshal(map[string]any{"username": "loner@x.com", "skill_id": id})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/approve", admin, string(body)); w.Code != 200 {
		t.Fatalf("admin approve: %d %s", w.Code, w.Body.String())
	}
	if h := holderOf(t, s, admin, id, "loner@x.com"); h["status"] != statusActive {
		t.Errorf("status = %v, want active", h["status"])
	}
}

// The page cannot work out who it may assign for: a controller holds
// users.actas but not groups.manage, so the group list is closed to them. The
// server answers instead, from the same rule the write paths use.
func TestManageableUsersMatchesWhoYouCanActuallyAssign(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, member := mkTeam(t, s, admin)
	// Somebody outside the manager's group.
	mkPasswordUser(t, s, "stranger@x.com", "secret")

	list := func(token string) []string {
		t.Helper()
		w := doAPI(t, s, "GET", "/api/v2/skills/manageable", token, "")
		if w.Code != 200 {
			t.Fatalf("manageable: %d %s", w.Code, w.Body.String())
		}
		var out struct {
			Users []string `json:"users"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out.Users
	}

	if got := list(mgr); len(got) != 1 || got[0] != "member@x.com" {
		t.Errorf("manager's list = %v, want just their own group's member", got)
	}
	// A plain user manages nobody, so their page shows no team panel.
	if got := list(member); len(got) != 0 {
		t.Errorf("plain user's list = %v, want empty", got)
	}
	// The admin backstop covers only people with no group of their own: someone
	// else's group member is their manager's business, not the admin's.
	got := list(admin)
	if slices.Contains(got, "member@x.com") {
		t.Errorf("admin's list = %v, want it to exclude another manager's group member", got)
	}
	if !slices.Contains(got, "stranger@x.com") {
		t.Errorf("admin's list = %v, want the ungrouped account included", got)
	}
}

// Certificate details are the whole point of "requires proof".
func TestProofIsRequiredWhenTheSkillSaysSo(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	_, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_proof": true})

	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 2})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 400 {
		t.Errorf("claim without proof: got %d, want 400", w.Code)
	}
	body, _ = json.Marshal(map[string]any{
		"skill_id": id, "level": 2,
		"cert": map[string]any{"number": "FL-991", "issuer": "SafetyCo", "issue_date": "2026-01-15"},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 200 {
		t.Fatalf("claim with proof: %d %s", w.Code, w.Body.String())
	}
	h := holderOf(t, s, member, id, "member@x.com")
	cert, _ := h["cert"].(map[string]any)
	if cert["number"] != "FL-991" {
		t.Errorf("cert = %v, want the submitted details", cert)
	}
}

// Expiry runs from the certificate's issue date, so a backdated ticket does not
// silently gain a full fresh term.
func TestExpiryRunsFromTheIssueDate(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	_, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{
		"validity_months": 36, "requires_proof": true,
	})

	issued := time.Now().AddDate(-1, 0, 0).Format("2006-01-02")
	body, _ := json.Marshal(map[string]any{
		"skill_id": id, "level": 2,
		"cert": map[string]any{"number": "FL-1", "issuer": "SafetyCo", "issue_date": issued},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 200 {
		t.Fatalf("claim: %d %s", w.Code, w.Body.String())
	}
	h := holderOf(t, s, member, id, "member@x.com")
	// Issued a year ago on a three-year ticket: two years left, not three.
	want := time.Now().AddDate(2, 0, 0).Format("2006-01-02")
	if h["expires_at"] != want {
		t.Errorf("expires_at = %v, want %v", h["expires_at"], want)
	}
	if h["expired"] != false {
		t.Errorf("expired = %v, want false", h["expired"])
	}
}

// A lapsed assignment is still listed -- you need to see that it ran out -- but
// it must not read as current.
func TestLapsedAssignmentIsFlaggedExpired(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	_, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{
		"validity_months": 12, "requires_proof": true,
	})

	issued := time.Now().AddDate(-2, 0, 0).Format("2006-01-02")
	body, _ := json.Marshal(map[string]any{
		"skill_id": id, "level": 2,
		"cert": map[string]any{"number": "FL-2", "issuer": "SafetyCo", "issue_date": issued},
	})
	doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body))

	h := holderOf(t, s, member, id, "member@x.com")
	if h["expired"] != true {
		t.Errorf("expired = %v, want true for a one-year ticket issued two years ago", h["expired"])
	}
}

// A skill with no validity never lapses.
func TestNeverExpiringSkillHasNoExpiry(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	_, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Go", map[string]any{"validity_months": 0})

	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 2})
	doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body))

	h := holderOf(t, s, member, id, "member@x.com")
	if h["expires_at"] != "" || h["expired"] != false {
		t.Errorf("expiry = %v / %v, want none", h["expires_at"], h["expired"])
	}
}

// Only the three offered periods are accepted; anything else is a client bug.
func TestValidityMustBeAnOfferedPeriod(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)

	body, _ := json.Marshal(map[string]any{
		"name": "Odd", "cat": "development", "validity_months": 7,
	})
	if w := doAPI(t, s, "POST", "/api/v2/skills", admin, string(body)); w.Code != 400 {
		t.Errorf("validity 7 months: got %d, want 400", w.Code)
	}
}

// Clearing a skill must never be blocked by the rules for gaining one: someone
// who no longer does the job has to be able to drop it.
func TestClearingIgnoresProofRequirements(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	_, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_proof": true})

	body, _ := json.Marshal(map[string]any{
		"skill_id": id, "level": 2,
		"cert": map[string]any{"number": "FL-3", "issuer": "SafetyCo", "issue_date": "2026-02-01"},
	})
	doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body))

	body, _ = json.Marshal(map[string]any{"skill_id": id, "level": 0})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 200 {
		t.Fatalf("clear: %d %s", w.Code, w.Body.String())
	}
	if h := holderOf(t, s, member, id, "member@x.com"); h != nil {
		t.Errorf("still listed after clearing: %v", h)
	}
}

// An archived skill is retired: it must not be handed to anybody new.
func TestArchivedSkillCannotBeAssigned(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	_, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "AngularJS", nil)

	body, _ := json.Marshal(map[string]any{"id": id, "archived": true})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/skill", admin, string(body)); w.Code != 200 {
		t.Fatalf("archive: %d %s", w.Code, w.Body.String())
	}
	body, _ = json.Marshal(map[string]any{"skill_id": id, "level": 2})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 400 {
		t.Errorf("claim archived: got %d, want 400", w.Code)
	}
}

// Rows written before the workflow existed carry only a level. They must keep
// counting: those skills were granted under rules that had no pending state.
func TestLegacyRowsReadAsActive(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	id := mkSkill(t, s, admin, "Go", nil)

	db, err := s.getStore().UserDB("admin@x.com")
	if err != nil {
		t.Fatalf("UserDB: %v", err)
	}
	err = db.Write(func(tx store.WTx) error {
		return tx.Upsert(store.TableSkills, store.Item{"key": id, "st": 1.0, "level": 4})
	})
	db.Close()
	if err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}

	h := holderOf(t, s, admin, id, "admin@x.com")
	if h == nil {
		t.Fatal("legacy row vanished from the open list")
	}
	if h["status"] != statusActive {
		t.Errorf("status = %v, want active", h["status"])
	}
}

// The strongest *usable* holder leads the list: a pending or expired assignment
// must not outrank somebody who can actually do the job today.
func TestUsableHoldersSortAboveTheRest(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_approval": true})

	// member self-claims at the top level, so stays pending.
	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 5})
	doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body))
	// The manager is assigned a lower level, but it is active.
	body, _ = json.Marshal(map[string]any{"username": "mgr@x.com", "skill_id": id, "level": 1})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/assign", admin, string(body)); w.Code != 200 {
		t.Fatalf("assign: %d %s", w.Code, w.Body.String())
	}

	w := doAPI(t, s, "GET", "/api/v2/skills", mgr, "")
	var out struct {
		Ratings map[string][]map[string]any `json:"ratings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	first := out.Ratings[id][0]
	if first["username"] != "mgr@x.com" {
		t.Errorf("first holder = %v, want the active one despite its lower level",
			fmt.Sprintf("%v (%v)", first["username"], first["status"]))
	}
}

// A manager grants a skill somebody lacks; they do not rewrite one already
// held. Editing an existing entry would make the record say something the
// holder never claimed, so it is refused -- approve or reject instead.
func TestManagerCannotOverwriteAnExistingAssignment(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{"requires_approval": true})

	// The member claims it themselves, so it is pending.
	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 2})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 200 {
		t.Fatalf("self-claim: %d %s", w.Code, w.Body.String())
	}

	// The manager tries to re-assign it at a different level.
	body, _ = json.Marshal(map[string]any{"username": "member@x.com", "skill_id": id, "level": 5})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/assign", mgr, string(body)); w.Code != 409 {
		t.Errorf("manager overwriting a held skill: got %d, want 409", w.Code)
	}
	// The stored level is untouched by the refused write.
	h := holderOf(t, s, mgr, id, "member@x.com")
	if got := h["level"].(float64); got != 2 {
		t.Errorf("level = %v, want the holder's own 2", got)
	}
	// Approving it still works: that is the manager's actual lever.
	body, _ = json.Marshal(map[string]any{"username": "member@x.com", "skill_id": id})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/approve", mgr, string(body)); w.Code != 200 {
		t.Fatalf("approve: %d %s", w.Code, w.Body.String())
	}

	// And assigning a skill they do NOT hold is still allowed.
	other := mkSkill(t, s, admin, "Pallet Truck", nil)
	body, _ = json.Marshal(map[string]any{"username": "member@x.com", "skill_id": other, "level": 3})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/assign", mgr, string(body)); w.Code != 200 {
		t.Errorf("assigning a new skill: got %d, want 200", w.Code)
	}
}

// mkExpiredHolding gives member an expired assignment and returns the skill id.
func mkExpiredHolding(t *testing.T, s *Server, admin, member string, level int) string {
	t.Helper()
	id := mkSkill(t, s, admin, "Forklift", map[string]any{
		"validity_months": 12, "requires_proof": true,
	})
	issued := time.Now().AddDate(-2, 0, 0).Format("2006-01-02")
	body, _ := json.Marshal(map[string]any{
		"skill_id": id, "level": level,
		"cert": map[string]any{"number": "OLD-1", "issuer": "SafetyCo", "issue_date": issued},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 200 {
		t.Fatalf("seed holding: %d %s", w.Code, w.Body.String())
	}
	return id
}

// A lapsed ticket that has been re-earned is a renewal, not an edit: the manager
// may record the fresh certificate on the holder's behalf.
func TestManagerCanRenewAnExpiredCertificate(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, member := mkTeam(t, s, admin)
	id := mkExpiredHolding(t, s, admin, member, 4)

	if h := holderOf(t, s, mgr, id, "member@x.com"); h["expired"] != true {
		t.Fatalf("seed should be expired, got %v", h["expired"])
	}

	issued := time.Now().Format("2006-01-02")
	body, _ := json.Marshal(map[string]any{
		"username": "member@x.com", "skill_id": id, "level": 1, // level here must be ignored
		"cert": map[string]any{"number": "NEW-9", "issuer": "SafetyCo", "issue_date": issued},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/assign", mgr, string(body)); w.Code != 200 {
		t.Fatalf("renew: %d %s", w.Code, w.Body.String())
	}

	h := holderOf(t, s, mgr, id, "member@x.com")
	// The holder's own level stands: a renewal re-proves the claim, it does not
	// restate it -- so the manager's level in the request is not honoured.
	if got := h["level"].(float64); got != 4 {
		t.Errorf("level = %v, want the holder's own 4", got)
	}
	if cert, _ := h["cert"].(map[string]any); cert["number"] != "NEW-9" {
		t.Errorf("cert = %v, want the new one", cert)
	}
	if h["expired"] != false {
		t.Errorf("expired = %v, want false after renewal", h["expired"])
	}
	if h["approved_by"] != "mgr@x.com" {
		t.Errorf("approved_by = %v, want the renewing manager", h["approved_by"])
	}
}

// Renewing without evidence is just re-dating somebody else's record, so it
// stays refused -- the carve-out is for certificates, not for expiry alone.
func TestRenewalWithoutACertificateIsRefused(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, member := mkTeam(t, s, admin)
	id := mkExpiredHolding(t, s, admin, member, 4)

	body, _ := json.Marshal(map[string]any{"username": "member@x.com", "skill_id": id, "level": 2})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/assign", mgr, string(body)); w.Code != 409 {
		t.Errorf("renew with no cert: got %d, want 409", w.Code)
	}
	if got := holderOf(t, s, mgr, id, "member@x.com")["level"].(float64); got != 4 {
		t.Errorf("level = %v, want the holder's own 4 untouched", got)
	}
}

// The carve-out is scoped to expired entries. A current one is still off limits,
// certificate or not.
func TestManagerStillCannotEditACurrentCertificate(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	mgr, member := mkTeam(t, s, admin)
	id := mkSkill(t, s, admin, "Forklift", map[string]any{
		"validity_months": 36, "requires_proof": true,
	})
	body, _ := json.Marshal(map[string]any{
		"skill_id": id, "level": 3,
		"cert": map[string]any{"number": "CUR-1", "issuer": "SafetyCo", "issue_date": time.Now().Format("2006-01-02")},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", member, string(body)); w.Code != 200 {
		t.Fatalf("seed: %d %s", w.Code, w.Body.String())
	}

	body, _ = json.Marshal(map[string]any{
		"username": "member@x.com", "skill_id": id, "level": 5,
		"cert": map[string]any{"number": "SNEAK-2", "issuer": "Elsewhere", "issue_date": time.Now().Format("2006-01-02")},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/assign", mgr, string(body)); w.Code != 409 {
		t.Errorf("editing a current cert: got %d, want 409", w.Code)
	}
	if cert, _ := holderOf(t, s, mgr, id, "member@x.com")["cert"].(map[string]any); cert["number"] != "CUR-1" {
		t.Errorf("cert = %v, want the holder's own untouched", cert)
	}
}
