package server

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

// newSkillsServer returns a server with the skills module switched on, since
// every route below 404s while it is off.
func newSkillsServer(t *testing.T) *Server {
	t.Helper()
	s := newTestServer(t)
	if err := s.setModuleEnabled(moduleSkills, true); err != nil {
		t.Fatalf("enable skills module: %v", err)
	}
	return s
}

// addSkill defines a catalog entry and returns its id. The token must hold
// skills.manage: defining skills is curated, not open.
func addSkill(t *testing.T, s *Server, token, name, cat string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"name": name, "cat": cat})
	w := doAPI(t, s, "POST", "/api/v2/skills", token, string(body))
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

// getSkillsAs reads the open list as the given account.
func getSkillsAs(t *testing.T, s *Server, token string) map[string]any {
	t.Helper()
	w := doAPI(t, s, "GET", "/api/v2/skills", token, "")
	if w.Code != 200 {
		t.Fatalf("get skills: %d %s", w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode skills: %v", err)
	}
	return out
}

// The catalog is curated: users pick from it, they do not add to it.
func TestDefiningASkillRequiresTheCapability(t *testing.T) {
	s := newSkillsServer(t)
	user := mkPasswordUser(t, s, "dev@x.com", "secret")
	admin := mkAdminToken(t, s)

	body, _ := json.Marshal(map[string]any{"name": "Go (Golang)", "cat": "development"})
	if w := doAPI(t, s, "POST", "/api/v2/skills", user, string(body)); w.Code != 403 {
		t.Errorf("plain user defining a skill: got %d, want 403", w.Code)
	}
	if got := addSkill(t, s, admin, "Go (Golang)", "development"); got != "go-golang" {
		t.Errorf("id = %q, want %q", got, "go-golang")
	}
	// A second entry by the same name would split assignments between two rows
	// for the same thing, which is what a curated catalog exists to prevent.
	if w := doAPI(t, s, "POST", "/api/v2/skills", admin, string(body)); w.Code != 409 {
		t.Errorf("duplicate name: got %d, want 409", w.Code)
	}
}

// The icon lands in a class attribute, so only the shape Font Awesome uses is
// accepted. A "fa-" prefix is tolerated because that is how the name appears in
// FA's own docs.
func TestIconIsNormalizedAndValidated(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"truck-ramp-box", "truck-ramp-box"},
		{"fa-truck-ramp-box", "truck-ramp-box"},
		{"  Helmet-Safety ", "helmet-safety"},
		{"", ""},
		{"truck ramp box", ""},          // spaces
		{"truck\" onload=x", ""},        // attribute break-out
		{"-leading", ""},                // not FA's shape
		{"trailing-", ""},
	} {
		if got := normalizeIcon(tc.in); got != tc.want {
			t.Errorf("normalizeIcon(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// A skill keeps its lettered mark as the fallback for when no icon is chosen,
// so every entry always has something to render.
func TestSkillKeepsAMarkAlongsideItsIcon(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)

	body, _ := json.Marshal(map[string]any{
		"name": "Forklift", "cat": "development", "icon": "truck-ramp-box",
	})
	w := doAPI(t, s, "POST", "/api/v2/skills", admin, string(body))
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Skill skill `json:"skill"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	if out.Skill.Icon != "truck-ramp-box" {
		t.Errorf("icon = %q, want truck-ramp-box", out.Skill.Icon)
	}
	if out.Skill.Mark != "FO" {
		t.Errorf("mark = %q, want the derived fallback FO", out.Skill.Mark)
	}

	// Clearing the icon returns the skill to lettering rather than erroring.
	body, _ = json.Marshal(map[string]any{"id": out.Skill.ID, "icon": ""})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/skill", admin, string(body)); w.Code != 200 {
		t.Fatalf("clear icon: %d %s", w.Code, w.Body.String())
	}
	if got := s.listSkills()[0].Icon; got != "" {
		t.Errorf("icon after clearing = %q, want empty", got)
	}

	// A malformed icon is refused rather than stored.
	body, _ = json.Marshal(map[string]any{"id": out.Skill.ID, "icon": "bad name"})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/skill", admin, string(body)); w.Code != 400 {
		t.Errorf("bad icon: got %d, want 400", w.Code)
	}
}

// Reading stays open: you cannot pick from a catalog you cannot see.
func TestAnyUserCanReadTheCatalog(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	user := mkPasswordUser(t, s, "dev@x.com", "secret")
	addSkill(t, s, admin, "Kubernetes", "devops")

	out := getSkillsAs(t, s, user)
	skills, _ := out["skills"].([]any)
	if len(skills) != 1 {
		t.Errorf("catalog as a plain user = %v, want the one entry", out["skills"])
	}
}

// The badge is derived from the name's words, not its punctuation.
func TestBadgeIgnoresPunctuation(t *testing.T) {
	for _, tc := range []struct{ name, want string }{
		{"Go (Golang)", "GG"},
		{"Kubernetes", "KU"},
		{"CI/CD", "CC"},
		{"R", "RR"},
	} {
		if got := deriveMark(tc.name); got != tc.want {
			t.Errorf("deriveMark(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// The point of the feature: everyone sees who holds which skill.
func TestSkillListShowsEveryUsersRatings(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	alice := mkPasswordUser(t, s, "alice@x.com", "secret")
	bob := mkPasswordUser(t, s, "bob@x.com", "secret")
	id := addSkill(t, s, admin, "Kubernetes", "devops")

	for _, tc := range []struct {
		token string
		level int
	}{{alice, 4}, {bob, 2}} {
		body, _ := json.Marshal(map[string]any{"skill_id": id, "level": tc.level})
		if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", tc.token, string(body)); w.Code != 200 {
			t.Fatalf("rate: %d %s", w.Code, w.Body.String())
		}
	}

	// Bob sees Alice's rating, not just his own.
	out := getSkillsAs(t, s, bob)
	ratings, _ := out["ratings"].(map[string]any)
	holders, _ := ratings[id].([]any)
	if len(holders) != 2 {
		t.Fatalf("holders = %d, want 2 (%v)", len(holders), ratings[id])
	}
	// Strongest first, so the top of the list is who to ask.
	first, _ := holders[0].(map[string]any)
	if first["username"] != "alice@x.com" || first["level"].(float64) != 4 {
		t.Errorf("first holder = %v, want alice@x.com at level 4", first)
	}
}

// Ratings are self-service, and clearing one removes the holder from the list.
func TestLevelZeroClearsTheClaim(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	token := mkPasswordUser(t, s, "dev@x.com", "secret")
	id := addSkill(t, s, admin, "Redis", "database")

	set := func(level int) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"skill_id": id, "level": level})
		if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", token, string(body)); w.Code != 200 {
			t.Fatalf("set level %d: %d %s", level, w.Code, w.Body.String())
		}
	}
	set(3)
	set(0)

	out := getSkillsAs(t, s, token)
	ratings, _ := out["ratings"].(map[string]any)
	if holders, ok := ratings[id].([]any); ok && len(holders) != 0 {
		t.Errorf("holders after clearing = %v, want none", holders)
	}
}

// A rating above the skill's scale is a client bug, not something to store.
func TestRatingAboveTheScaleIsRejected(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	token := mkPasswordUser(t, s, "dev@x.com", "secret")
	id := addSkill(t, s, admin, "Terraform", "cloud")

	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 99})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", token, string(body)); w.Code != 400 {
		t.Errorf("level 99: got %d, want 400", w.Code)
	}
}

// Editing the catalog takes the same capability as defining it: a curated
// catalog is only curated if the same people maintain the whole of it.
func TestEditingASkillRequiresTheCapability(t *testing.T) {
	s := newSkillsServer(t)
	user := mkPasswordUser(t, s, "dev@x.com", "secret")
	admin := mkAdminToken(t, s)
	id := addSkill(t, s, admin, "Figma", "design")

	rename := func(token, name string) int {
		body, _ := json.Marshal(map[string]any{"id": id, "name": name})
		return doAPI(t, s, "PUT", "/api/v2/skills/skill", token, string(body)).Code
	}
	if got := rename(user, "My Figma"); got != 403 {
		t.Errorf("plain user rename: got %d, want 403", got)
	}
	if got := rename(admin, "Figma Design"); got != 200 {
		t.Errorf("manager rename: got %d, want 200", got)
	}
}

// Deleting is the same gate as editing.
func TestDeletingASkillRequiresTheCapability(t *testing.T) {
	s := newSkillsServer(t)
	user := mkPasswordUser(t, s, "dev@x.com", "secret")
	admin := mkAdminToken(t, s)
	id := addSkill(t, s, admin, "AngularJS", "development")

	del := func(token string) int {
		body, _ := json.Marshal(map[string]any{"id": id})
		return doAPI(t, s, "DELETE", "/api/v2/skills/skill", token, string(body)).Code
	}
	if got := del(user); got != 403 {
		t.Errorf("plain user delete: got %d, want 403", got)
	}
	if got := del(admin); got != 200 {
		t.Errorf("manager delete: got %d, want 200", got)
	}
}

// The two axes are admin-owned: they are the vocabulary every rating is
// expressed in, so a plain account must not be able to reshape them.
func TestSkillAxesRequireTheCapability(t *testing.T) {
	s := newSkillsServer(t)
	user := mkPasswordUser(t, s, "dev@x.com", "secret")

	body, _ := json.Marshal(map[string]any{
		"levels": []map[string]any{{"label": "Novice"}, {"label": "Pro"}},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/skill-levels", user, string(body)); w.Code != 403 {
		t.Errorf("plain user setting levels: got %d, want 403", w.Code)
	}
}

// Rung numbers come from position, so a client that sends nonsense still
// produces a contiguous 1-based scale.
func TestLevelNumbersAreAssignedFromPosition(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)

	body, _ := json.Marshal(map[string]any{"levels": []map[string]any{
		{"n": 9, "label": "Novice"}, {"n": 9, "label": "Capable"}, {"n": 2, "label": "Pro"},
	}})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/skill-levels", admin, string(body)); w.Code != 200 {
		t.Fatalf("set levels: %d %s", w.Code, w.Body.String())
	}
	for i, l := range s.listSkillLevels() {
		if l.N != i+1 {
			t.Errorf("level %d has n=%d, want %d", i, l.N, i+1)
		}
	}
}

// Shrinking the scale must not strand skills configured for a longer one, or
// leave stored ratings pointing above the top rung.
func TestShrinkingTheScaleClampsSkillsAndRatings(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	id := addSkill(t, s, admin, "Python", "development")

	body, _ := json.Marshal(map[string]any{"skill_id": id, "level": 5})
	if w := doAPI(t, s, "PUT", "/api/v2/skills/mine", admin, string(body)); w.Code != 200 {
		t.Fatalf("rate: %d %s", w.Code, w.Body.String())
	}
	// Down from five rungs to two.
	body, _ = json.Marshal(map[string]any{
		"levels": []map[string]any{{"label": "Novice"}, {"label": "Pro"}},
	})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/skill-levels", admin, string(body)); w.Code != 200 {
		t.Fatalf("set levels: %d %s", w.Code, w.Body.String())
	}

	out := getSkillsAs(t, s, admin)
	skills, _ := out["skills"].([]any)
	first, _ := skills[0].(map[string]any)
	if got := first["scale"].(float64); got != 2 {
		t.Errorf("scale = %v, want 2", got)
	}
	ratings, _ := out["ratings"].(map[string]any)
	holders, _ := ratings[id].([]any)
	holder, _ := holders[0].(map[string]any)
	if got := holder["level"].(float64); got != 2 {
		t.Errorf("clamped level = %v, want 2", got)
	}
}

// Removing a category still in use would leave those skills unfilterable.
func TestCategoryInUseCannotBeRemoved(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	addSkill(t, s, admin, "Docker", "devops")

	body, _ := json.Marshal(map[string]any{"categories": []map[string]any{
		{"key": "development", "label": "Development", "color": "#4C82F7"},
	}})
	w := doAPI(t, s, "PUT", "/api/v2/admin/skill-cats", admin, string(body))
	if w.Code != 409 {
		t.Errorf("dropping a used category: got %d, want 409", w.Code)
	}
}

// A disabled module is a real gate, not a hidden nav entry.
func TestSkillsRoutes404WhileTheModuleIsOff(t *testing.T) {
	s := newTestServer(t) // module left off
	token := mkPasswordUser(t, s, "dev@x.com", "secret")

	if w := doAPI(t, s, "GET", "/api/v2/skills", token, ""); w.Code != 404 {
		t.Errorf("got %d, want 404", w.Code)
	}
}

// The catalog is open, so simultaneous creates are reachable in normal use.
// Without serialising the read-modify-write, both writers start from the same
// list and the last save silently drops the other's skill.
func TestConcurrentCreatesDoNotLoseSkills(t *testing.T) {
	s := newSkillsServer(t)
	token := mkAdminToken(t, s)

	const n = 8
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, _ := json.Marshal(map[string]any{
				"name": fmt.Sprintf("Skill %d", i), "cat": "development",
			})
			doAPI(t, s, "POST", "/api/v2/skills", token, string(body))
		}(i)
	}
	wg.Wait()

	if got := len(s.listSkills()); got != n {
		t.Errorf("catalog has %d skills, want %d — a concurrent create was lost", got, n)
	}
}

// Catalog and axes must survive a restart: they are persisted in setup.json.
func TestSkillCatalogSurvivesARestart(t *testing.T) {
	s := newSkillsServer(t)
	token := mkAdminToken(t, s)
	addSkill(t, s, token, "Rust", "development")

	reloaded, err := New(s.cfg)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	got := reloaded.listSkills()
	if len(got) != 1 || got[0].Name != "Rust" {
		t.Fatalf("skills after reload = %v, want the Rust entry", got)
	}
	// Creator is provenance, not permission: it records who defined the entry.
	if got[0].Creator != "admin@x.com" {
		t.Errorf("creator = %q, want admin@x.com", got[0].Creator)
	}
}

// catKeyFor finds a category's key from its label in the axes response.
func catKeyFor(t *testing.T, s *Server, token, label string) string {
	t.Helper()
	w := doAPI(t, s, "GET", "/api/v2/admin/skill-axes", token, "")
	if w.Code != 200 {
		t.Fatalf("axes: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Categories []skillCategory `json:"categories"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	for _, c := range out.Categories {
		if c.Label == label {
			return c.Key
		}
	}
	return ""
}

// A category can be added, edited and removed one at a time through the
// per-item endpoint the categories page drives.
func TestCategoryCanBeSavedAndDeletedIndividually(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)

	body, _ := json.Marshal(map[string]any{"label": "Equipment", "color": "#E9913C"})
	w := doAPI(t, s, "POST", "/api/v2/admin/skill-cat", admin, string(body))
	if w.Code != 200 {
		t.Fatalf("create category: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Key string `json:"key"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)
	if created.Key != "equipment" {
		t.Errorf("key = %q, want equipment", created.Key)
	}

	// Rename it, keeping the key so any skills stay attached.
	body, _ = json.Marshal(map[string]any{"key": "equipment", "label": "Machinery", "color": "#E9913C"})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/skill-cat", admin, string(body)); w.Code != 200 {
		t.Fatalf("rename: %d %s", w.Code, w.Body.String())
	}
	if catKeyFor(t, s, admin, "Machinery") != "equipment" {
		t.Error("rename did not keep the key")
	}

	// Delete it (nothing uses it).
	body, _ = json.Marshal(map[string]any{"key": "equipment"})
	if w := doAPI(t, s, "DELETE", "/api/v2/admin/skill-cat", admin, string(body)); w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if catKeyFor(t, s, admin, "Machinery") != "" {
		t.Error("category still present after delete")
	}
}

// Deleting a category still in use is refused; archiving is the way to retire it.
func TestCategoryInUseCannotBeDeletedOnlyArchived(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	addSkill(t, s, admin, "Docker", "devops")

	body, _ := json.Marshal(map[string]any{"key": "devops"})
	if w := doAPI(t, s, "DELETE", "/api/v2/admin/skill-cat", admin, string(body)); w.Code != 409 {
		t.Errorf("delete used category: got %d, want 409", w.Code)
	}
	// Archiving it is allowed and leaves the skill's category untouched.
	body, _ = json.Marshal(map[string]any{"key": "devops", "label": "DevOps", "color": "#2FB79E", "archived": true})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/skill-cat", admin, string(body)); w.Code != 200 {
		t.Fatalf("archive: %d %s", w.Code, w.Body.String())
	}
}

// A new skill cannot be filed under an archived category, but the skills already
// there keep it.
func TestArchivedCategoryRejectsNewSkills(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)
	addSkill(t, s, admin, "Docker", "devops") // devops now in use

	body, _ := json.Marshal(map[string]any{"key": "development", "label": "Development", "color": "#4C82F7", "archived": true})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/skill-cat", admin, string(body)); w.Code != 200 {
		t.Fatalf("archive development: %d %s", w.Code, w.Body.String())
	}
	body, _ = json.Marshal(map[string]any{"name": "Go", "cat": "development"})
	if w := doAPI(t, s, "POST", "/api/v2/skills", admin, string(body)); w.Code != 400 {
		t.Errorf("new skill in archived category: got %d, want 400", w.Code)
	}
}

// The last category cannot be deleted: every skill needs one to be filed under.
func TestLastCategoryCannotBeDeleted(t *testing.T) {
	s := newSkillsServer(t)
	admin := mkAdminToken(t, s)

	// Collapse to a single category by replacing the whole list.
	body, _ := json.Marshal(map[string]any{"categories": []map[string]any{
		{"key": "development", "label": "Development", "color": "#4C82F7"},
	}})
	if w := doAPI(t, s, "PUT", "/api/v2/admin/skill-cats", admin, string(body)); w.Code != 200 {
		t.Fatalf("collapse: %d %s", w.Code, w.Body.String())
	}
	body, _ = json.Marshal(map[string]any{"key": "development"})
	if w := doAPI(t, s, "DELETE", "/api/v2/admin/skill-cat", admin, string(body)); w.Code != 400 {
		t.Errorf("delete last category: got %d, want 400", w.Code)
	}
}
