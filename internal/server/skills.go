package server

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/TaggedHQ/server/internal/store"
)

// The skill catalog separates defining a skill from holding one.
//
// Defining is curated. The catalog, the categories and the proficiency scale are
// all gated on capSkillsManage, which an operator grants to whichever role they
// call "manager" on the Roles page. They are the shared vocabulary the whole
// feature is expressed in: if anyone could add "Forklift" a second time, or
// reshape the scale mid-flight, every existing assignment would quietly mean
// something else. This state lives in setup.json next to groups and roles.
//
// Holding is self-service, but only from the catalog. A user picks a category,
// then a skill defined in it -- they never invent one. What a skill requires
// (a certificate, a manager's approval, renewal after a year or three) is part
// of its definition, so those rules are set once by whoever defines it rather
// than being negotiated at each assignment.
//
// Reading stays open to every account: you cannot pick from a catalog you
// cannot see, and knowing who holds which skill is the point of the feature.
//
// Assignments do not live here. Each user's are rows in their own store
// (store.TableSkills), which keeps them user data: they travel with the account
// and are deleted with it. The open list is assembled by reading every user's
// store, which is why it is a single endpoint rather than a per-skill query.

// skillCategory files a skill under a colored heading.
type skillCategory struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Color string `json:"color"`
	// Archived hides a category from the skill-create picker while leaving the
	// skills already filed under it untouched. It is retirement, not deletion:
	// deletion is refused while any skill still uses a category, so archiving is
	// how an operator winds one down without stranding its skills.
	Archived bool `json:"archived,omitempty"`
}

// skillLevel is one rung of the proficiency scale. N is the rung's position,
// always 1-based and contiguous: the UI renders the scale as a bar, and a gap
// would make a rating ambiguous.
type skillLevel struct {
	N     int    `json:"n"`
	Label string `json:"label"`
}

// skill is one entry in the shared catalog.
type skill struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cat  string `json:"cat"` // skillCategory.Key
	Desc string `json:"desc,omitempty"`
	// Icon is a Font Awesome name without its prefix ("truck-ramp-box"), chosen
	// from the picker. Stored bare rather than as a full class string so the
	// stored value says what the icon *is*, leaving sizing to the page.
	Icon string `json:"icon,omitempty"`
	// IconStyle is which Font Awesome face the icon comes from. The bundled Free
	// build ships solid, regular and brands; the same name often exists in more
	// than one, and they are visually different, so the choice is stored rather
	// than assumed. Empty means solid, which is where most icons live.
	IconStyle string `json:"icon_style,omitempty"`
	// Mark is the two-letter badge shown when a skill has no icon: entries that
	// predate the picker, and anything created without choosing one. Derived
	// from the name, so a skill always has something to display.
	Mark string `json:"mark"`
	// Color overrides the category's colour for this skill's badge. Empty means
	// inherit the category, which is what most skills want: the colour carries
	// "which family is this", and only a skill that needs to stand out inside its
	// family sets its own.
	Color string `json:"color,omitempty"`
	// Scale caps how many levels this skill defines. A skill may use a shorter
	// scale than the server's, never a longer one -- clampScale enforces that on
	// read, so shrinking the global scale cannot leave a skill dangling.
	Scale int `json:"scale"`
	// ValidityMonths is how long a holder's assignment stays valid: 0 never
	// expires, 12 is a year, 36 is three years. Stored as months rather than as
	// the three labels the UI offers, so adding a period later is a UI change
	// rather than a data migration.
	ValidityMonths int `json:"validity_months,omitempty"`
	// RequiresProof means an assignment must carry certificate details.
	RequiresProof bool `json:"requires_proof,omitempty"`
	// RequiresApproval means a self-claimed assignment starts pending until a
	// manager approves it. A manager assigning it directly is already the
	// approval -- see assignmentStatus.
	RequiresApproval bool `json:"requires_approval,omitempty"`
	// Creator is the username that added the skill; empty for entries that
	// predate the field, which then only admins can edit.
	Creator  string `json:"creator,omitempty"`
	Added    string `json:"added"` // YYYY-MM-DD
	Archived bool   `json:"archived,omitempty"`
}

// Assignment states. An assignment is a row in the holder's own store.
const (
	statusActive  = "active"  // counts towards coverage; the holder has the skill
	statusPending = "pending" // self-claimed, waiting on a manager
)

// validityChoices are the periods the UI offers, in months. Kept here so the
// server validates exactly what the picker can produce.
var validityChoices = []int{0, 12, 36}

// certificate is the proof captured for a skill that requires it. Deliberately
// a reference rather than an uploaded file: it gives the audit trail (what was
// issued, by whom, when) without a blob store, and it is a nested object so an
// attachment can be added later without reshaping existing assignments.
type certificate struct {
	Number    string `json:"number,omitempty"`
	Issuer    string `json:"issuer,omitempty"`
	IssueDate string `json:"issue_date,omitempty"` // YYYY-MM-DD
}

func (c certificate) empty() bool {
	return c.Number == "" && c.Issuer == "" && c.IssueDate == ""
}

// userSkill is one account's assignment of one skill, as stored in that user's
// own store and as returned in the open list.
type userSkill struct {
	SkillID string `json:"skill_id"`
	Level   int    `json:"level"`
	Note    string `json:"note,omitempty"`
	Status  string `json:"status"`
	// AssignedBy is who put the skill on this account: the holder themselves for
	// a self-claim, or the manager who assigned it.
	AssignedBy string `json:"assigned_by,omitempty"`
	AssignedAt string `json:"assigned_at,omitempty"` // YYYY-MM-DD
	// ExpiresAt is derived when the assignment is written, from the skill's
	// validity and the certificate's issue date (or the assignment date when
	// there is no certificate). Stored rather than computed on read so that
	// changing a skill's validity does not silently re-date every existing
	// holder -- an assignment's expiry is a fact about that assignment.
	ExpiresAt  string      `json:"expires_at,omitempty"` // YYYY-MM-DD, "" = never
	Cert       certificate `json:"cert,omitempty"`
	ApprovedBy string      `json:"approved_by,omitempty"`
	ApprovedAt string      `json:"approved_at,omitempty"` // YYYY-MM-DD
}

// skillSlugRe validates stored skill and category ids.
var skillSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// markWordRe matches the alphanumeric runs deriveMark takes its initials from.
var markWordRe = regexp.MustCompile(`[A-Z0-9]+`)

// iconNameRe validates a Font Awesome icon name. The value lands in a class
// attribute, so it is restricted to the shape FA actually uses rather than
// being escaped at each render site.
var iconNameRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// defaultSkillCats is what a fresh server starts with. Operators are expected to
// replace these; they exist so the page is never empty on first open.
func defaultSkillCats() []skillCategory {
	return []skillCategory{
		{Key: "development", Label: "Development", Color: "#4C82F7"},
		{Key: "devops", Label: "DevOps", Color: "#2FB79E"},
		{Key: "database", Label: "Database", Color: "#A66CFF"},
		{Key: "cloud", Label: "Cloud", Color: "#E9913C"},
		{Key: "design", Label: "Design", Color: "#EB459E"},
		{Key: "security", Label: "Security", Color: "#E5484D"},
		{Key: "data", Label: "Data", Color: "#3BA55D"},
	}
}

// defaultSkillLevels is the shipped 5-rung proficiency scale.
func defaultSkillLevels() []skillLevel {
	return []skillLevel{
		{1, "Basic"}, {2, "Intermediate"}, {3, "Advanced"}, {4, "Expert"}, {5, "Master"},
	}
}

// listSkillCats returns a copy of the configured categories.
func (s *Server) listSkillCats() []skillCategory {
	s.skillsMu.RLock()
	defer s.skillsMu.RUnlock()
	return append([]skillCategory(nil), s.skillCats...)
}

// listSkillLevels returns a copy of the configured proficiency scale.
func (s *Server) listSkillLevels() []skillLevel {
	s.skillsMu.RLock()
	defer s.skillsMu.RUnlock()
	return append([]skillLevel(nil), s.skillLevels...)
}

// listSkills returns a copy of the shared catalog.
func (s *Server) listSkills() []skill {
	s.skillsMu.RLock()
	defer s.skillsMu.RUnlock()
	return append([]skill(nil), s.skills...)
}

// saveSkillCats swaps in a new category list and persists it, rolling back on
// error so memory never diverges from the file.
func (s *Server) saveSkillCats(cats []skillCategory) error {
	s.skillsMu.Lock()
	prev := s.skillCats
	s.skillCats = cats
	s.skillsMu.Unlock()
	if err := s.persistSetup(); err != nil {
		s.skillsMu.Lock()
		s.skillCats = prev
		s.skillsMu.Unlock()
		return err
	}
	return nil
}

// saveSkillLevels swaps in a new proficiency scale and persists it.
func (s *Server) saveSkillLevels(levels []skillLevel) error {
	s.skillsMu.Lock()
	prev := s.skillLevels
	s.skillLevels = levels
	s.skillsMu.Unlock()
	if err := s.persistSetup(); err != nil {
		s.skillsMu.Lock()
		s.skillLevels = prev
		s.skillsMu.Unlock()
		return err
	}
	return nil
}

// saveSkills swaps in a new catalog and persists it.
func (s *Server) saveSkills(skills []skill) error {
	s.skillsMu.Lock()
	prev := s.skills
	s.skills = skills
	s.skillsMu.Unlock()
	if err := s.persistSetup(); err != nil {
		s.skillsMu.Lock()
		s.skills = prev
		s.skillsMu.Unlock()
		return err
	}
	return nil
}

// clampScale holds a skill's scale inside the server's current one. Shrinking
// the global scale is allowed (an admin may decide 3 rungs is enough), so this
// runs on read rather than only on write: a skill configured for 5 rungs against
// a 3-rung scale reports 3, and any stored rating above it is clamped to match.
func (s *Server) clampScale(n int) int {
	max := len(s.listSkillLevels())
	if max == 0 {
		max = len(defaultSkillLevels())
	}
	if n < 1 || n > max {
		return max
	}
	return n
}

// canEditSkill reports whether the caller may define or change a catalog entry.
// One capability decides it, for everyone: a curated catalog is only curated if
// the same people maintain the whole of it. Creator is still recorded, but as
// provenance rather than as a permission.
func canEditSkill(caps map[string]bool) bool {
	return caps[capSkillsManage]
}

// uniqueSkillID returns a slug derived from name that no other skill uses.
func (s *Server) uniqueSkillID(name string) (string, error) {
	base := slugify(name)
	if base == "" {
		return "", fmt.Errorf("skill name must contain at least one letter or digit")
	}
	if len(base) > 64 {
		base = base[:64]
	}
	taken := map[string]bool{}
	for _, sk := range s.listSkills() {
		taken[sk.ID] = true
	}
	id := base
	for i := 2; taken[id]; i++ {
		id = fmt.Sprintf("%s-%d", base, i)
	}
	return id, nil
}

// deriveMark builds the 2-character badge text from a skill name: the initials
// of the first two words, or the first two letters of a single-word name. Words
// are split on non-alphanumerics rather than whitespace, so "Go (Golang)" reads
// "GG" rather than taking the bracket as a word's initial.
func deriveMark(name string) string {
	fields := markWordRe.FindAllString(strings.ToUpper(name), -1)
	switch {
	case len(fields) == 0:
		return "??"
	case len(fields) == 1:
		r := []rune(fields[0])
		if len(r) == 1 {
			return string(r[0]) + string(r[0])
		}
		return string(r[0:2])
	default:
		a, b := []rune(fields[0]), []rune(fields[1])
		return string(a[0]) + string(b[0])
	}
}

// ---- assignments ------------------------------------------------------------

// readUserSkills loads one account's assignments from its own store. A user with
// none (or no store yet) yields an empty slice, not an error: the open list must
// not fail because one account has never opened the page.
func (s *Server) readUserSkills(username string) []userSkill {
	db, err := s.getStore().UserDB(username)
	if err != nil {
		return nil
	}
	defer db.Close()
	items, err := db.All(store.TableSkills)
	if err != nil {
		return nil
	}
	out := make([]userSkill, 0, len(items))
	for _, it := range items {
		if us, ok := itemToUserSkill(it); ok {
			out = append(out, us)
		}
	}
	return out
}

// itemToUserSkill decodes one stored row. Rows written before the workflow
// existed carry only a level, so an absent status reads as active: those
// assignments were granted under rules that had no pending state, and silently
// re-opening them for approval would strip skills people already hold.
func itemToUserSkill(it store.Item) (userSkill, bool) {
	key, _ := it["key"].(string)
	if key == "" {
		return userSkill{}, false
	}
	lvl, _ := it["level"].(float64)
	note, _ := it["note"].(string)
	status, _ := it["status"].(string)
	if status != statusPending {
		status = statusActive
	}
	assignedBy, _ := it["assigned_by"].(string)
	assignedAt, _ := it["assigned_at"].(string)
	expiresAt, _ := it["expires_at"].(string)
	approvedBy, _ := it["approved_by"].(string)
	approvedAt, _ := it["approved_at"].(string)
	var cert certificate
	if raw, ok := it["cert"].(map[string]any); ok {
		cert.Number, _ = raw["number"].(string)
		cert.Issuer, _ = raw["issuer"].(string)
		cert.IssueDate, _ = raw["issue_date"].(string)
	}
	return userSkill{
		SkillID: key, Level: int(lvl), Note: note, Status: status,
		AssignedBy: assignedBy, AssignedAt: assignedAt, ExpiresAt: expiresAt,
		Cert: cert, ApprovedBy: approvedBy, ApprovedAt: approvedAt,
	}, true
}

// writeUserSkill upserts one assignment into the holder's own store. A level of
// 0 clears it: the row stays (the store has no delete) but drops out of every
// read, since getSkills skips levels below 1.
func writeUserSkill(db store.UserDB, us userSkill) error {
	return db.Write(func(tx store.WTx) error {
		return tx.Upsert(store.TableSkills, store.Item{
			"key":         us.SkillID,
			"st":          float64(time.Now().UnixNano()) / 1e9,
			"level":       us.Level,
			"note":        us.Note,
			"status":      us.Status,
			"assigned_by": us.AssignedBy,
			"assigned_at": us.AssignedAt,
			"expires_at":  us.ExpiresAt,
			"approved_by": us.ApprovedBy,
			"approved_at": us.ApprovedAt,
			"cert": map[string]any{
				"number":     us.Cert.Number,
				"issuer":     us.Cert.Issuer,
				"issue_date": us.Cert.IssueDate,
			},
		})
	})
}

// expiryFor computes when an assignment lapses: the skill's validity added to
// the certificate's issue date where there is one, otherwise to the assignment
// date. A skill that never expires returns "".
//
// Anchoring on the issue date matters: a three-year ticket issued last year has
// two years left, not three, and dating it from the day it was entered would
// quietly extend every backdated certificate.
func expiryFor(sk skill, cert certificate, assignedAt time.Time) string {
	if sk.ValidityMonths <= 0 {
		return ""
	}
	from := assignedAt
	if cert.IssueDate != "" {
		if d, err := time.Parse("2006-01-02", cert.IssueDate); err == nil {
			from = d
		}
	}
	return from.AddDate(0, sk.ValidityMonths, 0).Format("2006-01-02")
}

// expired reports whether an assignment has lapsed as of now. Expiry is a
// display concern rather than a stored state: nothing rewrites the row when the
// date passes, so this is evaluated on every read.
func (us userSkill) expired(now time.Time) bool {
	if us.ExpiresAt == "" {
		return false
	}
	d, err := time.Parse("2006-01-02", us.ExpiresAt)
	if err != nil {
		return false
	}
	return now.After(d)
}

// ---- open (any authenticated account) routes --------------------------------

// skillsHandler serves the open skill list at api/v2/skills. Every authenticated
// account may read the whole catalog including who holds what, and may add a
// skill or set its own ratings; editing an existing skill is gated by
// canEditSkill.
func (s *Server) skillsHandler(req *request, sub, username string, caps map[string]bool) response {
	switch sub {
	case "", "/":
		switch req.method() {
		case "GET":
			return s.getSkills()
		case "POST", "PUT":
			return s.createSkill(req, username, caps)
		}
		return textResp(405, "method not allowed: /skills can only be used with GET, POST and PUT")
	case "/skill":
		switch req.method() {
		case "PUT", "POST":
			return s.updateSkill(req, username, caps)
		case "DELETE":
			return s.deleteSkill(req, username, caps)
		}
		return textResp(405, "method not allowed: /skills/skill can only be used with PUT and DELETE")
	case "/mine":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.setMySkill(req, username)
		}
		return textResp(405, "method not allowed: /skills/mine can only be used with PUT")
	case "/assign":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.assignSkill(req, username, caps)
		}
		return textResp(405, "method not allowed: /skills/assign can only be used with PUT")
	case "/manageable":
		if req.method() == "GET" {
			return s.manageableUsers(username, caps)
		}
		return textResp(405, "method not allowed: /skills/manageable can only be used with GET")
	case "/approve":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.approveSkill(req, username, caps)
		}
		return textResp(405, "method not allowed: /skills/approve can only be used with PUT")
	}
	return textResp(404, "not found: /skills"+sub+" is not a valid path")
}

// manageableUsers lists the accounts the caller may assign and approve for.
//
// The page needs this to draw its team panel, and it cannot work the answer out
// for itself: a controller holds users.actas but not groups.manage, so the group
// list is closed to them. Deriving it here from the same canManage rule the
// write paths use also means the two can never drift apart.
func (s *Server) manageableUsers(username string, caps map[string]bool) response {
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	out := []string{}
	for _, m := range metas {
		if m.Username == username {
			continue // you are not your own manager
		}
		if s.canManage(username, m.Username, caps) {
			out = append(out, m.Username)
		}
	}
	sort.Strings(out)
	return jsonResp(200, map[string]any{"users": out})
}

// canManage reports whether manager may assign and approve skills for holder.
//
// The rule is group control: the manager is a controller of the group the holder
// belongs to. Membership is exclusive, so there is exactly one group to check
// and no ambiguity about who is responsible for whom.
//
// capSkillsManage is deliberately NOT a global override here, even though it
// governs the catalogue. Defining what "Forklift" means is a server-wide job;
// vouching for a particular person's forklift certificate is a local one, and
// the people who curate the catalogue are not automatically the right people to
// sign off another team's evidence.
//
// The one exception is a holder who belongs to no group. They have no
// controller, so a skill requiring approval would pend forever with nobody able
// to clear it. capSkillsManage covers exactly that case and no other.
func (s *Server) canManage(manager, holder string, caps map[string]bool) bool {
	if manager == holder {
		return false // self-approval is not management
	}
	gid := memberGroupOf(s.listGroups(), holder)
	if gid == "" {
		return caps[capSkillsManage]
	}
	for _, g := range s.listGroups() {
		if g.ID != gid {
			continue
		}
		for _, c := range g.Controllers {
			if c == manager {
				return true
			}
		}
	}
	return false
}

// getSkills returns the catalog, the two admin-owned axes, and every account's
// ratings. Assembling the ratings means opening each user's store in turn, which
// is why this is one endpoint: the page needs the whole picture to render
// coverage, and doing it per skill would multiply the same walk.
func (s *Server) getSkills() response {
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	levels := s.listSkillLevels()
	cats := s.listSkillCats()
	skills := s.listSkills()
	for i := range skills {
		skills[i].Scale = s.clampScale(skills[i].Scale)
	}
	// known lets a rating for a deleted skill be dropped rather than rendered as
	// a dangling row.
	known := map[string]int{}
	for _, sk := range skills {
		known[sk.ID] = sk.Scale
	}

	// directory carries the profile bits the page needs to show a face and a
	// real name next to each holder. It is served from here rather than reused
	// from the groups endpoint because that one needs groups.manage, which the
	// people who curate the catalogue do not necessarily hold.
	directory := map[string]any{}

	// ratings maps skill id -> the accounts holding it, which is the shape the
	// page renders. Levels are clamped to the skill's scale on the way out.
	now := time.Now()
	ratings := map[string][]map[string]any{}
	for _, m := range metas {
		rows := s.readUserSkills(m.Username)
		if len(rows) > 0 {
			// Only holders are described: a directory of every account on the
			// server would be a bigger payload and a wider disclosure than the
			// page has any use for.
			snap := s.userSnapshot(m.Username)
			directory[m.Username] = map[string]any{
				"profile": snap.Profile,
				"avatar":  snap.Avatar,
			}
		}
		for _, us := range rows {
			scale, ok := known[us.SkillID]
			if !ok || us.Level < 1 {
				continue
			}
			lvl := us.Level
			if lvl > scale {
				lvl = scale
			}
			ratings[us.SkillID] = append(ratings[us.SkillID], map[string]any{
				"username":    m.Username,
				"level":       lvl,
				"note":        us.Note,
				"status":      us.Status,
				"assigned_by": us.AssignedBy,
				"assigned_at": us.AssignedAt,
				"expires_at":  us.ExpiresAt,
				"expired":     us.expired(now),
				"cert":        us.Cert,
				"approved_by": us.ApprovedBy,
				"approved_at": us.ApprovedAt,
			})
		}
	}
	for id := range ratings {
		sort.Slice(ratings[id], func(a, b int) bool {
			x, y := ratings[id][a], ratings[id][b]
			// Everything currently counting comes before everything that does
			// not, so the top of the list is always someone you can actually
			// call on. Pending and expired both fail that test.
			xr, yr := ratingCounts(x), ratingCounts(y)
			if xr != yr {
				return xr
			}
			if x["level"].(int) != y["level"].(int) {
				return x["level"].(int) > y["level"].(int) // strongest first
			}
			return x["username"].(string) < y["username"].(string)
		})
	}
	if skills == nil {
		skills = []skill{}
	}
	return jsonResp(200, map[string]any{
		"skills":     skills,
		"categories": cats,
		"levels":     levels,
		"ratings":    ratings,
		"directory":  directory,
		"users":      len(metas),
	})
}

// ratingCounts reports whether an assignment currently counts: active, and not
// past its expiry. Coverage and the "who can do this" ordering both key off it.
func ratingCounts(r map[string]any) bool {
	status, _ := r["status"].(string)
	expired, _ := r["expired"].(bool)
	return status == statusActive && !expired
}

// createSkill adds an entry to the catalog. Defining what skills exist is a
// curated act, so it takes the capability rather than being open to everyone.
func (s *Server) createSkill(req *request, username string, caps map[string]bool) response {
	if !canEditSkill(caps) {
		return textResp(403, "forbidden: defining skills requires the "+capSkillsManage+" permission")
	}
	// Held across the duplicate check, the id allocation and the save: all three
	// read the same list, and two simultaneous creates must not both pass the
	// check and then race to write it.
	s.skillWriteMu.Lock()
	defer s.skillWriteMu.Unlock()

	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Name             string `json:"name"`
		Cat              string `json:"cat"`
		Desc             string `json:"desc"`
		Mark             string `json:"mark"`
		Icon             string `json:"icon"`
		IconStyle        string `json:"icon_style"`
		Color            string `json:"color"`
		Scale            int    `json:"scale"`
		ValidityMonths   int    `json:"validity_months"`
		RequiresProof    bool   `json:"requires_proof"`
		RequiresApproval bool   `json:"requires_approval"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with name and cat")
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		return textResp(400, "skill name is required")
	}
	if len(name) > 80 {
		return textResp(400, "skill name must be at most 80 characters")
	}
	cat := strings.TrimSpace(body.Cat)
	if !s.validSkillCat(cat) {
		return textResp(400, "unknown skill category: "+cat)
	}
	if s.catArchived(cat) {
		return textResp(400, "that category is archived — pick an active one")
	}
	// A duplicate name would split ratings across two entries for the same
	// thing, which is exactly what a shared catalog exists to prevent.
	for _, sk := range s.listSkills() {
		if strings.EqualFold(sk.Name, name) {
			return textResp(409, "a skill named "+sk.Name+" already exists")
		}
	}
	id, err := s.uniqueSkillID(name)
	if err != nil {
		return textResp(400, err.Error())
	}
	mark := strings.TrimSpace(body.Mark)
	if mark == "" {
		mark = deriveMark(name)
	}
	if len([]rune(mark)) > 2 {
		mark = string([]rune(mark)[0:2])
	}
	color := strings.TrimSpace(body.Color)
	if color != "" && !hexColorRe.MatchString(color) {
		return textResp(400, "skill colour must be a hex value like #4C82F7")
	}
	if !validValidity(body.ValidityMonths) {
		return textResp(400, "validity must be never, 1 year or 3 years")
	}
	icon := normalizeIcon(body.Icon)
	if body.Icon != "" && icon == "" {
		return textResp(400, "icon must be a Font Awesome name like truck-ramp-box")
	}
	iconStyle := ""
	if icon != "" {
		iconStyle = normalizeIconStyle(body.IconStyle)
	}
	sk := skill{
		ID: id, Name: name, Mark: strings.ToUpper(mark), Icon: icon, IconStyle: iconStyle, Cat: cat,
		Desc:             strings.TrimSpace(body.Desc),
		Color:            color,
		Scale:            s.clampScale(body.Scale),
		ValidityMonths:   body.ValidityMonths,
		RequiresProof:    body.RequiresProof,
		RequiresApproval: body.RequiresApproval,
		Creator:          username,
		Added:            time.Now().Format("2006-01-02"),
	}
	if err := s.saveSkills(append(s.listSkills(), sk)); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "skill": sk})
}

// updateSkill edits one catalog entry, including archiving it. Gated on
// canEditSkill: the creator or capSkillsManage.
func (s *Server) updateSkill(req *request, username string, caps map[string]bool) response {
	s.skillWriteMu.Lock()
	defer s.skillWriteMu.Unlock()

	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		ID               string  `json:"id"`
		Name             *string `json:"name"`
		Cat              *string `json:"cat"`
		Desc             *string `json:"desc"`
		Mark             *string `json:"mark"`
		Icon             *string `json:"icon"`
		IconStyle        *string `json:"icon_style"`
		Color            *string `json:"color"`
		Scale            *int    `json:"scale"`
		ValidityMonths   *int    `json:"validity_months"`
		RequiresProof    *bool   `json:"requires_proof"`
		RequiresApproval *bool   `json:"requires_approval"`
		Archived         *bool   `json:"archived"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with id")
	}
	id := strings.TrimSpace(body.ID)
	if !skillSlugRe.MatchString(id) {
		return textResp(400, "bad request: invalid skill id")
	}
	skills := s.listSkills()
	idx := -1
	for i, sk := range skills {
		if sk.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return textResp(404, "skill not found")
	}
	if !canEditSkill(caps) {
		return textResp(403, "forbidden: changing skills requires the "+capSkillsManage+" permission")
	}
	if body.Name != nil {
		name := strings.TrimSpace(*body.Name)
		if name == "" {
			return textResp(400, "skill name is required")
		}
		if len(name) > 80 {
			return textResp(400, "skill name must be at most 80 characters")
		}
		for i, sk := range skills {
			if i != idx && strings.EqualFold(sk.Name, name) {
				return textResp(409, "a skill named "+sk.Name+" already exists")
			}
		}
		skills[idx].Name = name
	}
	if body.Cat != nil {
		cat := strings.TrimSpace(*body.Cat)
		if !s.validSkillCat(cat) {
			return textResp(400, "unknown skill category: "+cat)
		}
		// Moving *into* an archived category is refused, but a skill already in
		// one keeps it when other fields are edited (cat re-sent unchanged).
		if cat != skills[idx].Cat && s.catArchived(cat) {
			return textResp(400, "that category is archived — pick an active one")
		}
		skills[idx].Cat = cat
	}
	if body.Desc != nil {
		skills[idx].Desc = strings.TrimSpace(*body.Desc)
	}
	if body.Mark != nil {
		mark := strings.TrimSpace(*body.Mark)
		if mark == "" {
			mark = deriveMark(skills[idx].Name)
		}
		if len([]rune(mark)) > 2 {
			mark = string([]rune(mark)[0:2])
		}
		skills[idx].Mark = strings.ToUpper(mark)
	}
	if body.Icon != nil {
		// An explicit empty string clears the icon and falls back to the mark,
		// so a skill can be returned to lettering without deleting it.
		icon := normalizeIcon(*body.Icon)
		if strings.TrimSpace(*body.Icon) != "" && icon == "" {
			return textResp(400, "icon must be a Font Awesome name like truck-ramp-box")
		}
		skills[idx].Icon = icon
		if icon == "" {
			skills[idx].IconStyle = ""
		} else if body.IconStyle == nil {
			skills[idx].IconStyle = normalizeIconStyle(skills[idx].IconStyle)
		}
	}
	if body.IconStyle != nil && skills[idx].Icon != "" {
		skills[idx].IconStyle = normalizeIconStyle(*body.IconStyle)
	}
	if body.Color != nil {
		color := strings.TrimSpace(*body.Color)
		if color != "" && !hexColorRe.MatchString(color) {
			return textResp(400, "skill colour must be a hex value like #4C82F7")
		}
		skills[idx].Color = color
	}
	if body.Scale != nil {
		skills[idx].Scale = s.clampScale(*body.Scale)
	}
	if body.ValidityMonths != nil {
		if !validValidity(*body.ValidityMonths) {
			return textResp(400, "validity must be never, 1 year or 3 years")
		}
		// Existing holders keep the expiry they were given: expiry is a fact
		// about an assignment, not a live lookup, so changing the rule applies
		// from here on rather than re-dating everyone retroactively.
		skills[idx].ValidityMonths = *body.ValidityMonths
	}
	if body.RequiresProof != nil {
		skills[idx].RequiresProof = *body.RequiresProof
	}
	if body.RequiresApproval != nil {
		skills[idx].RequiresApproval = *body.RequiresApproval
	}
	if body.Archived != nil {
		skills[idx].Archived = *body.Archived
	}
	if err := s.saveSkills(skills); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "skill": skills[idx]})
}

// deleteSkill removes a catalog entry. Existing ratings are left in place in
// each user's store: they are harmless (getSkills drops ratings for unknown
// skills) and keeping them means an accidental delete can be undone by
// re-creating the skill under the same id.
func (s *Server) deleteSkill(req *request, username string, caps map[string]bool) response {
	s.skillWriteMu.Lock()
	defer s.skillWriteMu.Unlock()

	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with id")
	}
	id := strings.TrimSpace(body.ID)
	skills := s.listSkills()
	out := make([]skill, 0, len(skills))
	found := false
	if !canEditSkill(caps) {
		return textResp(403, "forbidden: deleting skills requires the "+capSkillsManage+" permission")
	}
	for _, sk := range skills {
		if sk.ID == id {
			found = true
			continue
		}
		out = append(out, sk)
	}
	if !found {
		return textResp(404, "skill not found")
	}
	if err := s.saveSkills(out); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// assignBody is the shared shape of a self-claim and a manager assignment. Both
// write the same row; they differ only in who the holder is and whether the
// result needs approving.
type assignBody struct {
	Username string `json:"username"` // manager assignment only; ignored for a self-claim
	SkillID  string `json:"skill_id"`
	Level    int    `json:"level"`
	Note     string `json:"note"`
	Cert     struct {
		Number    string `json:"number"`
		Issuer    string `json:"issuer"`
		IssueDate string `json:"issue_date"`
	} `json:"cert"`
}

// setMySkill records the caller's own proficiency. A skill that requires
// approval lands pending; everything else is active immediately.
func (s *Server) setMySkill(req *request, username string) response {
	var body assignBody
	if err := readAssignBody(req, &body); err != nil {
		return textResp(400, err.Error())
	}
	return s.writeAssignment(body, username, username, false)
}

// assignSkill lets a manager put a skill on one of their people. Assigning is
// itself the approval: a manager who grants the skill has already made the
// judgement that approval exists to capture.
func (s *Server) assignSkill(req *request, manager string, caps map[string]bool) response {
	var body assignBody
	if err := readAssignBody(req, &body); err != nil {
		return textResp(400, err.Error())
	}
	holder := strings.TrimSpace(body.Username)
	if holder == "" {
		return textResp(400, "username is required")
	}
	if !s.canManage(manager, holder, caps) {
		return textResp(403, "forbidden: you do not manage "+holder)
	}
	switch ok, err := s.userExists(holder); {
	case err != nil:
		return textResp(500, "internal error: "+err.Error())
	case !ok:
		return textResp(404, "user not found")
	}
	// A manager grants a skill somebody does not have; they do not rewrite one
	// they already hold. Editing an existing entry would make the record say
	// something the holder never claimed, and erase the line between what was
	// submitted and what was merely approved. Approve, reject or leave it alone.
	//
	// The one exception is a renewal: a lapsed ticket that has been re-earned.
	// Recording fresh evidence for it is not authoring a claim, it is refreshing
	// the proof behind one that already existed -- so the level carries over
	// untouched and only the certificate (and the expiry it implies) changes.
	id := strings.TrimSpace(body.SkillID)
	for _, us := range s.readUserSkills(holder) {
		if us.SkillID != id || us.Level < 1 {
			continue
		}
		if !us.expired(time.Now()) {
			return textResp(409, holder+" already has this skill — approve or reject it instead of editing it")
		}
		if !certFromBody(body).empty() {
			// The holder's own level stands: a renewal re-proves the claim, it
			// does not restate it.
			body.Level = us.Level
			return s.writeAssignment(body, holder, manager, true)
		}
		return textResp(409, holder+"'s "+id+" has expired — add the new certificate details to renew it")
	}
	return s.writeAssignment(body, holder, manager, true)
}

// certFromBody reads the certificate an assign/claim request carries.
func certFromBody(b assignBody) certificate {
	return certificate{
		Number:    strings.TrimSpace(b.Cert.Number),
		Issuer:    strings.TrimSpace(b.Cert.Issuer),
		IssueDate: strings.TrimSpace(b.Cert.IssueDate),
	}
}

func readAssignBody(req *request, out *assignBody) error {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return fmt.Errorf("internal error: %w", err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("bad request: body must be JSON with skill_id and level")
	}
	return nil
}

// writeAssignment validates and stores one assignment. `byManager` says whether
// the writer is managing someone else, which is what decides approval: a
// manager's assignment is already approved, a self-claim on a skill that
// requires approval is not.
func (s *Server) writeAssignment(body assignBody, holder, actor string, byManager bool) response {
	id := strings.TrimSpace(body.SkillID)
	var target *skill
	for _, sk := range s.listSkills() {
		if sk.ID == id {
			t := sk
			target = &t
			break
		}
	}
	if target == nil {
		return textResp(404, "skill not found")
	}
	scale := s.clampScale(target.Scale)
	if body.Level < 0 || body.Level > scale {
		return textResp(400, fmt.Sprintf("level must be between 0 and %d for this skill", scale))
	}
	note := strings.TrimSpace(body.Note)
	if len(note) > 280 {
		return textResp(400, "note must be at most 280 characters")
	}
	if target.Archived && body.Level > 0 {
		return textResp(400, "this skill is archived and cannot be assigned")
	}

	db, err := s.getStore().UserDB(holder)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()

	// Clearing needs none of the validation below: dropping a skill you no
	// longer hold must never be blocked by the rules for gaining one.
	if body.Level == 0 {
		if err := writeUserSkill(db, userSkill{SkillID: id, Level: 0, Status: statusActive}); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		return jsonResp(200, map[string]any{"status": "ok", "cleared": true})
	}

	cert := certFromBody(body)
	if cert.IssueDate != "" {
		if _, err := time.Parse("2006-01-02", cert.IssueDate); err != nil {
			return textResp(400, "certificate issue date must be YYYY-MM-DD")
		}
	}
	if target.RequiresProof && cert.empty() {
		return textResp(400, "this skill requires certificate details")
	}
	for _, f := range []string{cert.Number, cert.Issuer} {
		if len(f) > 120 {
			return textResp(400, "certificate details must be at most 120 characters")
		}
	}

	now := time.Now()
	us := userSkill{
		SkillID:    id,
		Level:      body.Level,
		Note:       note,
		Status:     statusActive,
		AssignedBy: actor,
		AssignedAt: now.Format("2006-01-02"),
		ExpiresAt:  expiryFor(*target, cert, now),
		Cert:       cert,
	}
	if byManager {
		// The manager's act of assigning is the approval, recorded so the audit
		// trail shows who stands behind the skill.
		us.ApprovedBy, us.ApprovedAt = actor, us.AssignedAt
	} else if target.RequiresApproval {
		us.Status = statusPending
	}
	if err := writeUserSkill(db, us); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "assignment": us})
}

// approveSkill clears a pending assignment. Only a manager of the holder may do
// it, and canManage already refuses self-approval -- the point of the pending
// state is that somebody else looked at it.
func (s *Server) approveSkill(req *request, manager string, caps map[string]bool) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
		SkillID  string `json:"skill_id"`
		Reject   bool   `json:"reject"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and skill_id")
	}
	holder := strings.TrimSpace(body.Username)
	id := strings.TrimSpace(body.SkillID)
	if holder == "" || id == "" {
		return textResp(400, "username and skill_id are required")
	}
	if !s.canManage(manager, holder, caps) {
		return textResp(403, "forbidden: you do not manage "+holder)
	}

	var found *userSkill
	for _, us := range s.readUserSkills(holder) {
		if us.SkillID == id {
			u := us
			found = &u
			break
		}
	}
	if found == nil || found.Level < 1 {
		return textResp(404, "no assignment to approve")
	}
	if found.Status != statusPending {
		return textResp(409, "this assignment is not waiting for approval")
	}

	db, err := s.getStore().UserDB(holder)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()

	// Rejecting clears the assignment rather than parking it in a third state:
	// the holder can re-claim it with better evidence, and a "rejected" row that
	// nothing reads would only be clutter.
	if body.Reject {
		if err := writeUserSkill(db, userSkill{SkillID: id, Level: 0, Status: statusActive}); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		return jsonResp(200, map[string]any{"status": "ok", "rejected": true})
	}
	found.Status = statusActive
	found.ApprovedBy = manager
	found.ApprovedAt = time.Now().Format("2006-01-02")
	if err := writeUserSkill(db, *found); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "assignment": found})
}

// normalizeIcon accepts what the picker sends and returns the bare FA name, or
// "" if it is not one. A leading "fa-" is tolerated because that is how the
// name appears in Font Awesome's own docs, so an operator pasting one in gets
// what they expect rather than a rejection.
func normalizeIcon(raw string) string {
	name := strings.ToLower(strings.TrimSpace(raw))
	name = strings.TrimPrefix(name, "fa-")
	if name == "" || !iconNameRe.MatchString(name) || len(name) > 60 {
		return ""
	}
	return name
}

// iconStyles are the Font Awesome faces the bundled Free build ships. Light and
// duotone are Pro-only and have no webfont here, so they are not offered.
var iconStyles = []string{"solid", "regular", "brands"}

// normalizeIconStyle returns the face to render an icon in, defaulting to solid
// -- both for an absent value and for a style this build cannot draw, since a
// missing face renders as an empty box rather than failing loudly.
func normalizeIconStyle(raw string) string {
	st := strings.ToLower(strings.TrimSpace(raw))
	st = strings.TrimPrefix(st, "fa-")
	if !slices.Contains(iconStyles, st) {
		return "solid"
	}
	return st
}

// validValidity reports whether months is one of the offered periods.
func validValidity(months int) bool {
	return slices.Contains(validityChoices, months)
}

// catArchived reports whether key names an archived category. An unknown key is
// not archived (validSkillCat rejects it first, so this only decides among
// categories that exist).
func (s *Server) catArchived(key string) bool {
	for _, c := range s.listSkillCats() {
		if c.Key == key {
			return c.Archived
		}
	}
	return false
}

// validSkillCat reports whether key names a configured category.
func (s *Server) validSkillCat(key string) bool {
	for _, c := range s.listSkillCats() {
		if c.Key == key {
			return true
		}
	}
	return false
}

// uniqueCatKey returns a slug for label that no other category uses. self is the
// key of the category being renamed (excluded from the check), or "".
func (s *Server) uniqueCatKey(label, self string) (string, error) {
	base := slugify(label)
	if base == "" {
		return "", fmt.Errorf("category name must contain at least one letter or digit")
	}
	if len(base) > 60 {
		base = base[:60]
	}
	taken := map[string]bool{}
	for _, c := range s.listSkillCats() {
		if c.Key != self {
			taken[c.Key] = true
		}
	}
	key := base
	for i := 2; taken[key]; i++ {
		key = fmt.Sprintf("%s-%d", base, i)
	}
	return key, nil
}

// ---- admin (capSkillsManage) routes -----------------------------------------

// adminGetSkillAxes returns the categories and proficiency scale for the
// Admin · Skills page, plus how many catalog entries use each category, so the
// UI can warn before a delete strands skills.
func (s *Server) adminGetSkillAxes() response {
	used := map[string]int{}
	for _, sk := range s.listSkills() {
		used[sk.Cat]++
	}
	cats := s.listSkillCats()
	if cats == nil {
		cats = []skillCategory{}
	}
	levels := s.listSkillLevels()
	if levels == nil {
		levels = []skillLevel{}
	}
	return jsonResp(200, map[string]any{
		"categories": cats,
		"levels":     levels,
		"used":       used,
	})
}

// adminSetSkillCats replaces the whole category list in one write. The page
// edits the list as a unit (add, rename, reorder, recolor), so a whole-list PUT
// avoids a partial-update protocol for what is always a small array.
func (s *Server) adminSetSkillCats(req *request) response {
	raw, err := req.getBody(256 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Categories []skillCategory `json:"categories"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with categories")
	}
	if len(body.Categories) == 0 {
		return textResp(400, "at least one category is required")
	}
	if len(body.Categories) > 64 {
		return textResp(400, "at most 64 categories are supported")
	}
	seen := map[string]bool{}
	out := make([]skillCategory, 0, len(body.Categories))
	for _, c := range body.Categories {
		label := strings.TrimSpace(c.Label)
		if label == "" {
			return textResp(400, "every category needs a label")
		}
		if len(label) > 60 {
			return textResp(400, "category labels must be at most 60 characters")
		}
		key := strings.TrimSpace(c.Key)
		if key == "" {
			key = slugify(label)
		}
		if !skillSlugRe.MatchString(key) {
			return textResp(400, "invalid category key: "+key)
		}
		if seen[key] {
			return textResp(400, "duplicate category key: "+key)
		}
		seen[key] = true
		color := strings.TrimSpace(c.Color)
		if !hexColorRe.MatchString(color) {
			return textResp(400, "category color must be a hex value like #4C82F7")
		}
		out = append(out, skillCategory{Key: key, Label: label, Color: color})
	}
	// Removing a category that skills still use would leave them unfilterable,
	// so refuse rather than silently reassigning somebody else's entries.
	for _, sk := range s.listSkills() {
		if !seen[sk.Cat] {
			return textResp(409, "cannot remove category "+sk.Cat+": the skill "+sk.Name+" still uses it")
		}
	}
	if err := s.saveSkillCats(out); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "categories": out})
}

// adminSaveSkillCat creates or updates one category. Body is JSON with an
// optional key (absent = create), a label, a colour and the archived flag. The
// categories page edits one row at a time through a side panel, so this is the
// per-item counterpart to adminSetSkillCats' whole-list PUT.
func (s *Server) adminSaveSkillCat(req *request) response {
	// Held across the read, the key allocation and the save, so two concurrent
	// creates cannot both derive the same key and race to write it.
	s.skillWriteMu.Lock()
	defer s.skillWriteMu.Unlock()

	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Key      string `json:"key"`
		Label    string `json:"label"`
		Color    string `json:"color"`
		Archived bool   `json:"archived"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with a label and colour")
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		return textResp(400, "category name is required")
	}
	if len(label) > 60 {
		return textResp(400, "category name must be at most 60 characters")
	}
	color := strings.TrimSpace(body.Color)
	if !hexColorRe.MatchString(color) {
		return textResp(400, "category colour must be a hex value like #4C82F7")
	}

	cats := s.listSkillCats()
	key := strings.TrimSpace(body.Key)
	if key == "" {
		newKey, err := s.uniqueCatKey(label, "")
		if err != nil {
			return textResp(400, err.Error())
		}
		cats = append(cats, skillCategory{Key: newKey, Label: label, Color: color, Archived: body.Archived})
		key = newKey
	} else {
		idx := -1
		for i, c := range cats {
			if c.Key == key {
				idx = i
				break
			}
		}
		if idx < 0 {
			return textResp(404, "category not found")
		}
		cats[idx].Label = label
		cats[idx].Color = color
		cats[idx].Archived = body.Archived
	}
	if len(cats) > 64 {
		return textResp(400, "at most 64 categories are supported")
	}
	if err := s.saveSkillCats(cats); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "key": key})
}

// adminDeleteSkillCat removes one category. Body is JSON {"key": "..."}.
// Deletion is refused while any skill still uses it: that is what archiving is
// for. The last category cannot be deleted either, since every skill needs one
// to be filed under.
func (s *Server) adminDeleteSkillCat(req *request) response {
	s.skillWriteMu.Lock()
	defer s.skillWriteMu.Unlock()

	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with a key")
	}
	key := strings.TrimSpace(body.Key)
	for _, sk := range s.listSkills() {
		if sk.Cat == key {
			return textResp(409, "cannot delete this category: the skill "+sk.Name+" still uses it — archive it instead")
		}
	}
	cats := s.listSkillCats()
	if len(cats) <= 1 {
		return textResp(400, "at least one category is required")
	}
	out := make([]skillCategory, 0, len(cats))
	found := false
	for _, c := range cats {
		if c.Key == key {
			found = true
			continue
		}
		out = append(out, c)
	}
	if !found {
		return textResp(404, "category not found")
	}
	if err := s.saveSkillCats(out); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// hexColorRe validates a category color.
var hexColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// adminSetSkillLevels replaces the proficiency scale. Rung numbers are assigned
// from position rather than trusted from the body, so the scale is always
// contiguous and 1-based no matter what the client sent.
func (s *Server) adminSetSkillLevels(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Levels []skillLevel `json:"levels"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with levels")
	}
	if len(body.Levels) < 2 {
		return textResp(400, "a proficiency scale needs at least two levels")
	}
	// The UI renders one bar segment per rung; beyond about ten the scale stops
	// meaning anything a rater can apply consistently.
	if len(body.Levels) > 10 {
		return textResp(400, "at most 10 proficiency levels are supported")
	}
	out := make([]skillLevel, 0, len(body.Levels))
	for i, l := range body.Levels {
		label := strings.TrimSpace(l.Label)
		if label == "" {
			return textResp(400, "every level needs a label")
		}
		if len(label) > 40 {
			return textResp(400, "level labels must be at most 40 characters")
		}
		out = append(out, skillLevel{N: i + 1, Label: label})
	}
	if err := s.saveSkillLevels(out); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	// Skills configured for a longer scale are clamped on read, so shrinking the
	// scale needs no rewrite of the catalog here.
	return jsonResp(200, map[string]any{"status": "ok", "levels": out})
}
