package server

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/TaggedHQ/server/internal/store"
)

// The shift planner: who is working, where, and when.
//
// A shift is owned by a group, not by a person. That is the whole design. A
// manager plans a week for the group they control, and a slot that nobody is
// assigned to yet is still a real shift -- it is the group's, waiting for a
// taker. Which is why shifts are the one thing here that does not live in a
// user's own store (see store.SharedDB): an open shift has no user to live in.
//
// Two people act on a shift, with different powers:
//
//   - A manager (a controller of the owning group) creates shifts, edits them,
//     deletes them, and puts people on and takes people off. This reuses the
//     group-control rule the skills module already uses for "who is responsible
//     for whom" -- see canManage. Controlling a group is what makes you that
//     group's planner; there is no separate shift-manager list to drift.
//   - A member of the group picks up shifts that still have room. They cannot
//     put anybody else on a shift, and they cannot take themselves off one a
//     manager assigned them -- see releaseShift for why.
//
// Coverage is expressed with Slots and Assignees rather than an "open" flag.
// A shift needing two people is Slots:2; it shows as open while it has fewer
// than two takers, and stops being open when it fills, without anything having
// to be restated. A manager assigning somebody directly is just the same shift
// created with Slots:1 and one assignee already on it, so the grid has one
// concept to draw and the API has one thing to validate.

// ---- the catalog -------------------------------------------------------------
//
// What a shift refers to -- locations, working areas, roles -- is admin-owned
// config and lives in setup.json next to the groups and the skill axes. It is
// small, changes rarely, and is read on nearly every request, so the file is the
// right home for it; only the shifts themselves are volume data in the store.

// shiftLocation is a place shifts happen: a site, a branch, a venue.
type shiftLocation struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Archived keeps a location out of the pickers without disturbing the
	// shifts already filed against it, the same retirement the skill categories
	// use instead of deletion.
	Archived bool `json:"archived,omitempty"`
}

// shiftArea is a working area: the part of the operation somebody is rostered
// to, like a kitchen or a service desk. Location is the site it sits in, or ""
// for an area that exists at every site.
type shiftArea struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Location string `json:"location,omitempty"`
	Archived bool   `json:"archived,omitempty"`
}

// shiftRole is the position worked. It carries the colour the planner draws the
// shift in, so a week reads as blocks of role rather than a wall of one hue.
type shiftRole struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Color    string `json:"color"`
	Archived bool   `json:"archived,omitempty"`
}

// defaultShiftRoles seeds a server that has not customised the catalog, so the
// planner is usable the first time it is opened. They are deliberately generic:
// a real roster renames them to whatever the operation actually calls its
// positions, which is why they are editable config and not constants.
func defaultShiftRoles() []shiftRole {
	return []shiftRole{
		{ID: "support", Name: "Support", Color: "#3BA55D"},
		{ID: "service", Name: "Service", Color: "#4C82F7"},
		{ID: "kitchen", Name: "Kitchen", Color: "#E9913C"},
		{ID: "logistics", Name: "Logistics", Color: "#A66CFF"},
		{ID: "admin", Name: "Admin", Color: "#2FB79E"},
	}
}

// listShiftRoles / listShiftLocations / listShiftAreas return copies of the
// configured catalog.
func (s *Server) listShiftRoles() []shiftRole {
	s.shiftsMu.RLock()
	defer s.shiftsMu.RUnlock()
	return append([]shiftRole(nil), s.shiftRoles...)
}

func (s *Server) listShiftLocations() []shiftLocation {
	s.shiftsMu.RLock()
	defer s.shiftsMu.RUnlock()
	return append([]shiftLocation(nil), s.shiftLocations...)
}

func (s *Server) listShiftAreas() []shiftArea {
	s.shiftsMu.RLock()
	defer s.shiftsMu.RUnlock()
	return append([]shiftArea(nil), s.shiftAreas...)
}

// saveShiftAxes swaps in a new catalog and persists it, rolling back on error so
// memory never diverges from the file.
func (s *Server) saveShiftAxes(roles []shiftRole, locs []shiftLocation, areas []shiftArea) error {
	s.shiftsMu.Lock()
	prevR, prevL, prevA := s.shiftRoles, s.shiftLocations, s.shiftAreas
	s.shiftRoles, s.shiftLocations, s.shiftAreas = roles, locs, areas
	s.shiftsMu.Unlock()
	if err := s.persistSetup(); err != nil {
		s.shiftsMu.Lock()
		s.shiftRoles, s.shiftLocations, s.shiftAreas = prevR, prevL, prevA
		s.shiftsMu.Unlock()
		return err
	}
	return nil
}

// ---- the shift record --------------------------------------------------------

// shift is one planned block of work, as stored and as sent to the planner.
type shift struct {
	ID    string `json:"id"`
	Group string `json:"group"`
	Date  string `json:"date"`  // "YYYY-MM-DD"
	Start string `json:"start"` // "HH:MM"
	End   string `json:"end"`   // "HH:MM"; at or before Start means it runs past midnight

	Role     string   `json:"role,omitempty"`
	Location string   `json:"location,omitempty"`
	Area     string   `json:"area,omitempty"`
	Tags     []string `json:"tags,omitempty"`

	// Type is "shift" for work and "absence" for time somebody is away. An
	// absence is still a row on the group's roster -- it is the reason a person
	// is missing from it, and the planner needs it to explain a gap in cover.
	Type string `json:"type"`

	// Slots is how many people the shift needs, at least 1. Assignees are the
	// people on it; the shift is open while there are fewer of them than Slots.
	Slots     int             `json:"slots"`
	Assignees []shiftAssignee `json:"assignees"`

	Note string `json:"note,omitempty"`

	// Deleted is a tombstone. The store has no delete -- every table is
	// upsert-only, the way the sync protocol requires -- so removal is a flag
	// and every read filters on it, exactly as a cleared skill rating does.
	Deleted bool `json:"deleted,omitempty"`

	CreatedBy string `json:"created_by,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedBy string `json:"updated_by,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// shiftAssignee is one person on a shift, and how they got there. By is who put
// them on it: equal to User when they picked it up themselves, the manager's
// username when they were assigned. That distinction is not bookkeeping -- it is
// what releaseShift enforces on.
type shiftAssignee struct {
	User string `json:"user"`
	By   string `json:"by"`
	At   string `json:"at"`
}

const (
	shiftTypeWork    = "shift"
	shiftTypeAbsence = "absence"
)

// open reports whether the shift still has room for another taker. An absence is
// never open: it is one person's time away, not a slot to be filled.
func (sh shift) open() bool {
	return sh.Type == shiftTypeWork && len(sh.Assignees) < sh.Slots
}

// hasUser reports whether username is already on the shift.
func (sh shift) hasUser(username string) bool {
	for _, a := range sh.Assignees {
		if a.User == username {
			return true
		}
	}
	return false
}

// shiftToItem encodes a shift for the shared store. `gid` and `date` are
// duplicated out of the blob into their own indexed columns, which is what makes
// a week for one group a single range scan.
func shiftToItem(sh shift) store.Item {
	blob, _ := json.Marshal(sh)
	var m map[string]any
	_ = json.Unmarshal(blob, &m)
	m["key"] = sh.ID
	m["gid"] = sh.Group
	m["date"] = sh.Date
	m["st"] = now()
	return store.Item(m)
}

// itemToShift decodes one stored row back into a shift.
func itemToShift(it store.Item) (shift, bool) {
	raw, err := json.Marshal(it)
	if err != nil {
		return shift{}, false
	}
	var sh shift
	if err := json.Unmarshal(raw, &sh); err != nil {
		return shift{}, false
	}
	if sh.ID == "" {
		return shift{}, false
	}
	// Defend the invariants a hand-edited or older row might not hold, so the
	// rest of the code can rely on them.
	if sh.Type != shiftTypeAbsence {
		sh.Type = shiftTypeWork
	}
	if sh.Slots < 1 {
		sh.Slots = 1
	}
	return sh, true
}

// ---- validation --------------------------------------------------------------

var (
	shiftDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	shiftTimeRe = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

const (
	maxShiftSlots = 99
	maxShiftTags  = 8
	maxShiftNote  = 500
	maxShiftTag   = 40
	// maxShiftRange caps how wide a window one request may ask for. The planner
	// reads a week; a year is a mistake or a scrape, and either way it should
	// not turn into an unbounded scan.
	maxShiftRange = 400 * 24 * time.Hour
)

// validate checks a shift's own fields. Whether the group, role, location and
// area actually exist is checked by the caller, which holds the catalog.
func (sh shift) validate() error {
	if !shiftDateRe.MatchString(sh.Date) {
		return fmt.Errorf("date must be YYYY-MM-DD")
	}
	if _, err := time.Parse("2006-01-02", sh.Date); err != nil {
		return fmt.Errorf("%s is not a real date", sh.Date)
	}
	if sh.Type == shiftTypeWork {
		if !shiftTimeRe.MatchString(sh.Start) || !shiftTimeRe.MatchString(sh.End) {
			return fmt.Errorf("start and end must be HH:MM")
		}
		if sh.Start == sh.End {
			return fmt.Errorf("start and end cannot be the same")
		}
	}
	if sh.Slots < 1 || sh.Slots > maxShiftSlots {
		return fmt.Errorf("slots must be between 1 and %d", maxShiftSlots)
	}
	if len(sh.Assignees) > sh.Slots {
		return fmt.Errorf("the shift has more people on it than it has slots")
	}
	// An absence is one person being away, so it cannot be a multi-slot block
	// and cannot be open for others to join.
	if sh.Type == shiftTypeAbsence {
		if sh.Slots != 1 {
			return fmt.Errorf("an absence covers one person, so it has one slot")
		}
		if len(sh.Assignees) != 1 {
			return fmt.Errorf("an absence must name the person who is away")
		}
	}
	if len(sh.Tags) > maxShiftTags {
		return fmt.Errorf("a shift can carry at most %d tags", maxShiftTags)
	}
	for _, t := range sh.Tags {
		if len(t) > maxShiftTag {
			return fmt.Errorf("tag %q is too long", t)
		}
	}
	if len(sh.Note) > maxShiftNote {
		return fmt.Errorf("the note is too long (max %d characters)", maxShiftNote)
	}
	seen := map[string]bool{}
	for _, a := range sh.Assignees {
		if a.User == "" {
			return fmt.Errorf("an assignee must name a user")
		}
		if seen[a.User] {
			return fmt.Errorf("%s is on this shift twice", a.User)
		}
		seen[a.User] = true
	}
	return nil
}

// normalizeTags trims, de-duplicates and orders the tag list so two shifts
// tagged the same way compare and render the same way.
func normalizeTags(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		if t == "" || seen[strings.ToLower(t)] {
			continue
		}
		seen[strings.ToLower(t)] = true
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// ---- who may do what ---------------------------------------------------------

// controlsGroup reports whether username is a controller of gid, which is what
// makes them that group's planner.
func (s *Server) controlsGroup(username, gid string) bool {
	if gid == "" {
		return false
	}
	for _, g := range s.listGroups() {
		if g.ID == gid {
			for _, c := range g.Controllers {
				if c == username {
					return true
				}
			}
			return false
		}
	}
	return false
}

// visibleGroups is every group username may see a roster for: the ones they
// control, plus the one they are a member of. Membership is exclusive, so that
// second part is at most one group.
//
// A member seeing their own group's whole roster is the point of the feature --
// you cannot pick up a colleague's spare shift without seeing it, and knowing
// who else is on tonight is ordinary rostering, not a disclosure.
func (s *Server) visibleGroups(username string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(gid string) {
		if gid != "" && !seen[gid] {
			seen[gid] = true
			out = append(out, gid)
		}
	}
	for _, g := range s.listGroups() {
		for _, c := range g.Controllers {
			if c == username {
				add(g.ID)
			}
		}
	}
	add(memberGroupOf(s.listGroups(), username))
	sort.Strings(out)
	return out
}

// memberOfGroup reports whether username is a member (not a controller) of gid.
func (s *Server) memberOfGroup(username, gid string) bool {
	return gid != "" && memberGroupOf(s.listGroups(), username) == gid
}

// ---- reading -----------------------------------------------------------------

// loadShift reads one shift by id. A tombstoned row reads as absent.
func (s *Server) loadShift(id string) (shift, error) {
	sdb, err := s.getStore().SharedDB()
	if err != nil {
		return shift{}, err
	}
	defer sdb.Close()
	it, err := sdb.Get(store.TableShifts, id)
	if err != nil || it == nil {
		return shift{}, err
	}
	sh, ok := itemToShift(it)
	if !ok || sh.Deleted {
		return shift{}, nil
	}
	return sh, nil
}

// putShift writes one shift.
func (s *Server) putShift(sh shift) error {
	sdb, err := s.getStore().SharedDB()
	if err != nil {
		return err
	}
	defer sdb.Close()
	return sdb.Write(func(tx store.WTx) error {
		return tx.Upsert(store.TableShifts, shiftToItem(sh))
	})
}

// getShifts serves the planner: every shift in [from, to] for the groups the
// caller may see, plus the catalog and the directory needed to render them.
//
// It is one endpoint rather than several because the grid cannot draw anything
// useful from a subset -- it needs the shifts, the people they name, and the
// roles they are coloured by, all for the same week.
func (s *Server) getShifts(req *request, username string) response {
	from := req.query.Get("from")
	to := req.query.Get("to")
	if !shiftDateRe.MatchString(from) || !shiftDateRe.MatchString(to) {
		return textResp(400, "bad request: from and to must be YYYY-MM-DD dates")
	}
	t1, err1 := time.Parse("2006-01-02", from)
	t2, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil {
		return textResp(400, "bad request: from and to must be real dates")
	}
	if t2.Before(t1) {
		return textResp(400, "bad request: to is before from")
	}
	if t2.Sub(t1) > maxShiftRange {
		return textResp(400, "bad request: that date range is too wide")
	}

	gids := s.visibleGroups(username)

	// groups carries the roster the grid draws its rows from: the members of
	// each visible group, with the profile bits needed to show a name and a
	// face. It is assembled here rather than reused from the groups endpoint
	// because that one needs groups.manage, which a controller does not hold.
	groups := []map[string]any{}
	for _, g := range s.listGroups() {
		if !contains(gids, g.ID) {
			continue
		}
		members := []map[string]any{}
		for _, m := range g.Members {
			snap := s.userSnapshot(m)
			members = append(members, map[string]any{
				"username": m,
				"profile":  snap.Profile,
				"avatar":   snap.Avatar,
			})
		}
		groups = append(groups, map[string]any{
			"id":      g.ID,
			"name":    g.Name,
			"members": members,
			// manage tells the page which groups this account may plan, so it
			// can show the editing affordances only where they would work.
			"manage": s.controlsGroup(username, g.ID),
			"member": s.memberOfGroup(username, g.ID),
		})
	}

	shifts := []shift{}
	if len(gids) > 0 {
		sdb, err := s.getStore().SharedDB()
		if err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		defer sdb.Close()
		items, err := sdb.InRange(store.TableShifts, from, to, gids)
		if err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		for _, it := range items {
			if sh, ok := itemToShift(it); ok && !sh.Deleted {
				shifts = append(shifts, sh)
			}
		}
		sort.Slice(shifts, func(i, j int) bool {
			if shifts[i].Date != shifts[j].Date {
				return shifts[i].Date < shifts[j].Date
			}
			if shifts[i].Start != shifts[j].Start {
				return shifts[i].Start < shifts[j].Start
			}
			return shifts[i].ID < shifts[j].ID
		})
	}

	// The list fields are always arrays, never null: the client indexes into
	// them without a guard and a nil slice marshals as JSON null, which would
	// blow up on the first read. Cheaper to normalise once here.
	roles := s.listShiftRoles()
	if roles == nil {
		roles = []shiftRole{}
	}
	locations := s.listShiftLocations()
	if locations == nil {
		locations = []shiftLocation{}
	}
	areas := s.listShiftAreas()
	if areas == nil {
		areas = []shiftArea{}
	}
	return jsonResp(200, map[string]any{
		"me":        username,
		"from":      from,
		"to":        to,
		"shifts":    shifts,
		"groups":    groups,
		"roles":     roles,
		"locations": locations,
		"areas":     areas,
	})
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ---- writing -----------------------------------------------------------------

// shiftBody is the create/update payload. Slots is a pointer so an absent field
// keeps the stored value on an edit rather than resetting it to zero.
type shiftBody struct {
	ID       string   `json:"id"`
	Group    string   `json:"group"`
	Date     string   `json:"date"`
	Start    string   `json:"start"`
	End      string   `json:"end"`
	Role     string   `json:"role"`
	Location string   `json:"location"`
	Area     string   `json:"area"`
	Tags     []string `json:"tags"`
	Type     string   `json:"type"`
	Slots    *int     `json:"slots"`
	Note     string   `json:"note"`
	// Assign is who the manager is putting on the shift as they save it, which
	// is the common case: planning a week is mostly "this person, this day".
	// Absent leaves the assignees alone; an empty array clears them.
	Assign []string `json:"assign"`
}

// knownRole / knownLocation / knownArea check a reference against the catalog.
// An empty reference is always fine: role, location and area are all optional.
func (s *Server) knownRole(id string) bool {
	if id == "" {
		return true
	}
	for _, r := range s.listShiftRoles() {
		if r.ID == id {
			return true
		}
	}
	return false
}

func (s *Server) knownLocation(id string) bool {
	if id == "" {
		return true
	}
	for _, l := range s.listShiftLocations() {
		if l.ID == id {
			return true
		}
	}
	return false
}

func (s *Server) knownArea(id string) bool {
	if id == "" {
		return true
	}
	for _, a := range s.listShiftAreas() {
		if a.ID == id {
			return true
		}
	}
	return false
}

// saveShift creates or updates a shift. Only a controller of the owning group
// may do either, and the group cannot be changed by an edit: moving a shift
// between groups would move it out from under the manager who owns it, so it is
// a delete and a create, done deliberately.
func (s *Server) saveShift(req *request, username string) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body shiftBody
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}

	var sh shift
	if body.ID != "" {
		existing, err := s.loadShift(body.ID)
		if err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		if existing.ID == "" {
			return textResp(404, "not found: no such shift")
		}
		sh = existing
		if body.Group != "" && body.Group != sh.Group {
			return textResp(400, "bad request: a shift cannot be moved to another group")
		}
	} else {
		sh = shift{
			ID:        "sh" + randSeed(12),
			Group:     body.Group,
			CreatedBy: username,
			CreatedAt: time.Now().UTC().Format(time.RFC3339),
		}
	}

	if !s.controlsGroup(username, sh.Group) {
		return textResp(403, "forbidden: you do not manage that group's roster")
	}

	sh.Date = body.Date
	sh.Start = body.Start
	sh.End = body.End
	sh.Role = body.Role
	sh.Location = body.Location
	sh.Area = body.Area
	sh.Tags = normalizeTags(body.Tags)
	sh.Note = strings.TrimSpace(body.Note)
	sh.Type = shiftTypeWork
	if body.Type == shiftTypeAbsence {
		sh.Type = shiftTypeAbsence
	}
	sh.Slots = 1
	if body.Slots != nil {
		sh.Slots = *body.Slots
	} else if body.ID != "" {
		sh.Slots = maxInt(1, len(sh.Assignees))
	}

	if body.Assign != nil {
		assignees := []shiftAssignee{}
		stamp := time.Now().UTC().Format(time.RFC3339)
		for _, u := range body.Assign {
			if u == "" {
				continue
			}
			if !s.memberOfGroup(u, sh.Group) {
				return textResp(400, "bad request: "+u+" is not a member of that group")
			}
			// Keep the original provenance for somebody already on the shift, so
			// re-saving a shift does not silently convert a self-claim into a
			// manager assignment (and with it their right to hand it back).
			prev := shiftAssignee{User: u, By: username, At: stamp}
			for _, a := range sh.Assignees {
				if a.User == u {
					prev = a
				}
			}
			assignees = append(assignees, prev)
		}
		sh.Assignees = assignees
	}
	if sh.Assignees == nil {
		sh.Assignees = []shiftAssignee{}
	}
	// An absence is one named person, so its slot count follows its assignee
	// rather than being asked for separately.
	if sh.Type == shiftTypeAbsence {
		sh.Slots = 1
	}

	if err := sh.validate(); err != nil {
		return textResp(400, "bad request: "+err.Error())
	}
	if !s.knownRole(sh.Role) {
		return textResp(400, "bad request: unknown role "+sh.Role)
	}
	if !s.knownLocation(sh.Location) {
		return textResp(400, "bad request: unknown location "+sh.Location)
	}
	if !s.knownArea(sh.Area) {
		return textResp(400, "bad request: unknown working area "+sh.Area)
	}

	sh.UpdatedBy = username
	sh.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := s.putShift(sh); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "shift": sh})
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// deleteShift tombstones a shift. Manager only: a member who could delete the
// shift they did not want would be doing by deletion what releaseShift refuses
// to let them do directly.
func (s *Server) deleteShift(req *request, username string) response {
	raw, err := req.getBody(4 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}
	sh, err := s.loadShift(body.ID)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	if sh.ID == "" {
		return textResp(404, "not found: no such shift")
	}
	if !s.controlsGroup(username, sh.Group) {
		return textResp(403, "forbidden: you do not manage that group's roster")
	}
	sh.Deleted = true
	sh.UpdatedBy = username
	sh.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := s.putShift(sh); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// claimShift is a team member picking up an open shift.
//
// The check that matters is the one against the caller's own membership: you may
// only take a shift in the group you are actually in. A manager taking a shift
// on their own group's roster goes through here too -- putting yourself on a
// shift is the same act whoever you are, and it keeps the provenance honest
// (By == User), so they can hand it back the same way anyone else can.
func (s *Server) claimShift(req *request, username string) response {
	raw, err := req.getBody(4 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}
	sh, err := s.loadShift(body.ID)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	if sh.ID == "" {
		return textResp(404, "not found: no such shift")
	}
	if !s.memberOfGroup(username, sh.Group) {
		return textResp(403, "forbidden: that shift belongs to a group you are not in")
	}
	if sh.Type != shiftTypeWork {
		return textResp(400, "bad request: an absence cannot be picked up")
	}
	if sh.hasUser(username) {
		return textResp(409, "conflict: you are already on that shift")
	}
	if !sh.open() {
		return textResp(409, "conflict: that shift is already fully covered")
	}
	// Two shifts at once is a rostering mistake, and the person picking one up
	// is the least likely to notice. Catching it here rather than letting it
	// through is the difference between the feature helping and just recording.
	if clash, err := s.shiftClash(username, sh); err != nil {
		return textResp(500, "internal error: "+err.Error())
	} else if clash != "" {
		return textResp(409, "conflict: you already have a shift on "+clash)
	}

	stamp := time.Now().UTC().Format(time.RFC3339)
	sh.Assignees = append(sh.Assignees, shiftAssignee{User: username, By: username, At: stamp})
	sh.UpdatedBy = username
	sh.UpdatedAt = stamp
	if err := s.putShift(sh); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "shift": sh})
}

// shiftClash reports the date of an existing shift username already works that
// overlaps the one they are picking up, or "" if there is none. It only looks at
// the same day: a shift running past midnight is still planned against the day
// it starts, which is how the grid lays them out.
func (s *Server) shiftClash(username string, sh shift) (string, error) {
	sdb, err := s.getStore().SharedDB()
	if err != nil {
		return "", err
	}
	defer sdb.Close()
	items, err := sdb.InRange(store.TableShifts, sh.Date, sh.Date, nil)
	if err != nil {
		return "", err
	}
	for _, it := range items {
		other, ok := itemToShift(it)
		if !ok || other.Deleted || other.ID == sh.ID {
			continue
		}
		if !other.hasUser(username) {
			continue
		}
		if other.Type == shiftTypeAbsence || overlaps(sh, other) {
			return sh.Date, nil
		}
	}
	return "", nil
}

// overlaps reports whether two shifts on the same day cover any of the same
// time. Both are normalised to minutes from midnight, with an end at or before
// the start meaning the shift runs into the next day.
func overlaps(a, b shift) bool {
	a1, a2 := shiftSpan(a)
	b1, b2 := shiftSpan(b)
	return a1 < b2 && b1 < a2
}

func shiftSpan(sh shift) (int, int) {
	start := minutesOfDay(sh.Start)
	end := minutesOfDay(sh.End)
	if end <= start {
		end += 24 * 60
	}
	return start, end
}

func minutesOfDay(hhmm string) int {
	var h, m int
	if _, err := fmt.Sscanf(hhmm, "%d:%d", &h, &m); err != nil {
		return 0
	}
	return h*60 + m
}

// releaseShift is a member handing back a shift they picked up.
//
// You may only release what you took yourself. A shift a manager rostered you
// onto is not yours to drop: the group is relying on the cover, and a silent
// self-removal is exactly the kind of gap a roster exists to prevent. Asking the
// manager to take you off is the intended path, and they can (saveShift).
func (s *Server) releaseShift(req *request, username string) response {
	raw, err := req.getBody(4 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}
	sh, err := s.loadShift(body.ID)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	if sh.ID == "" {
		return textResp(404, "not found: no such shift")
	}
	var mine *shiftAssignee
	for i := range sh.Assignees {
		if sh.Assignees[i].User == username {
			mine = &sh.Assignees[i]
			break
		}
	}
	if mine == nil {
		return textResp(409, "conflict: you are not on that shift")
	}
	if mine.By != username {
		return textResp(403, "forbidden: your manager assigned this shift, so only they can take you off it")
	}

	out := sh.Assignees[:0:0]
	for _, a := range sh.Assignees {
		if a.User != username {
			out = append(out, a)
		}
	}
	sh.Assignees = out
	sh.UpdatedBy = username
	sh.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := s.putShift(sh); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "shift": sh})
}

// ---- routing -----------------------------------------------------------------

// shiftsHandler serves api/v2/shifts. Reading is open to any account, and
// returns only the groups they are in or control; the write routes each apply
// their own rule.
func (s *Server) shiftsHandler(req *request, sub, username string) response {
	switch sub {
	case "", "/":
		switch req.method() {
		case "GET":
			return s.getShifts(req, username)
		case "PUT", "POST":
			return s.saveShift(req, username)
		}
		return textResp(405, "method not allowed: /shifts can only be used with GET, POST and PUT")
	case "/shift":
		if req.method() == "DELETE" {
			return s.deleteShift(req, username)
		}
		return textResp(405, "method not allowed: /shifts/shift can only be used with DELETE")
	case "/claim":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.claimShift(req, username)
		}
		return textResp(405, "method not allowed: /shifts/claim can only be used with POST")
	case "/release":
		if req.method() == "PUT" || req.method() == "POST" {
			return s.releaseShift(req, username)
		}
		return textResp(405, "method not allowed: /shifts/release can only be used with POST")
	}
	return textResp(404, "not found: /shifts"+sub+" is not a valid path")
}

// ---- admin (capShiftsManage) routes ------------------------------------------

// adminGetShiftAxes returns the whole shift catalog for the admin page. Like
// getShifts, every list is an array even when empty.
func (s *Server) adminGetShiftAxes() response {
	roles := s.listShiftRoles()
	if roles == nil {
		roles = []shiftRole{}
	}
	locations := s.listShiftLocations()
	if locations == nil {
		locations = []shiftLocation{}
	}
	areas := s.listShiftAreas()
	if areas == nil {
		areas = []shiftArea{}
	}
	return jsonResp(200, map[string]any{
		"roles":     roles,
		"locations": locations,
		"areas":     areas,
	})
}

// adminSetShiftAxes replaces the catalog. It is a whole-list write, like the
// skill categories: the page edits the table and saves it back.
func (s *Server) adminSetShiftAxes(req *request) response {
	raw, err := req.getBody(256 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Roles     []shiftRole     `json:"roles"`
		Locations []shiftLocation `json:"locations"`
		Areas     []shiftArea     `json:"areas"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}

	roles, err := normalizeShiftRoles(body.Roles)
	if err != nil {
		return textResp(400, "bad request: "+err.Error())
	}
	locs, err := normalizeShiftLocations(body.Locations)
	if err != nil {
		return textResp(400, "bad request: "+err.Error())
	}
	areas, err := normalizeShiftAreas(body.Areas, locs)
	if err != nil {
		return textResp(400, "bad request: "+err.Error())
	}
	if err := s.saveShiftAxes(roles, locs, areas); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return s.adminGetShiftAxes()
}

// normalizeShiftRoles validates and de-duplicates the role list, filling in an
// id for any entry the page added without one.
func normalizeShiftRoles(in []shiftRole) ([]shiftRole, error) {
	seen := map[string]bool{}
	out := []shiftRole{}
	for _, r := range in {
		name := strings.TrimSpace(r.Name)
		if name == "" {
			return nil, fmt.Errorf("a role needs a name")
		}
		id := strings.TrimSpace(r.ID)
		if id == "" {
			id = slugify(name)
		}
		if !groupSlugRe.MatchString(id) {
			return nil, fmt.Errorf("%q is not a usable role id", id)
		}
		if seen[id] {
			return nil, fmt.Errorf("two roles share the id %q", id)
		}
		seen[id] = true
		color := strings.TrimSpace(r.Color)
		if color == "" {
			color = "#8A8F98"
		}
		out = append(out, shiftRole{ID: id, Name: name, Color: color, Archived: r.Archived})
	}
	return out, nil
}

func normalizeShiftLocations(in []shiftLocation) ([]shiftLocation, error) {
	seen := map[string]bool{}
	out := []shiftLocation{}
	for _, l := range in {
		name := strings.TrimSpace(l.Name)
		if name == "" {
			return nil, fmt.Errorf("a location needs a name")
		}
		id := strings.TrimSpace(l.ID)
		if id == "" {
			id = slugify(name)
		}
		if !groupSlugRe.MatchString(id) {
			return nil, fmt.Errorf("%q is not a usable location id", id)
		}
		if seen[id] {
			return nil, fmt.Errorf("two locations share the id %q", id)
		}
		seen[id] = true
		out = append(out, shiftLocation{ID: id, Name: name, Archived: l.Archived})
	}
	return out, nil
}

func normalizeShiftAreas(in []shiftArea, locs []shiftLocation) ([]shiftArea, error) {
	known := map[string]bool{}
	for _, l := range locs {
		known[l.ID] = true
	}
	seen := map[string]bool{}
	out := []shiftArea{}
	for _, a := range in {
		name := strings.TrimSpace(a.Name)
		if name == "" {
			return nil, fmt.Errorf("a working area needs a name")
		}
		id := strings.TrimSpace(a.ID)
		if id == "" {
			id = slugify(name)
		}
		if !groupSlugRe.MatchString(id) {
			return nil, fmt.Errorf("%q is not a usable working area id", id)
		}
		if seen[id] {
			return nil, fmt.Errorf("two working areas share the id %q", id)
		}
		seen[id] = true
		loc := strings.TrimSpace(a.Location)
		if loc != "" && !known[loc] {
			return nil, fmt.Errorf("working area %q points at a location that does not exist", name)
		}
		out = append(out, shiftArea{ID: id, Name: name, Location: loc, Archived: a.Archived})
	}
	return out, nil
}
