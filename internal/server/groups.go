package server

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Groups collect regular users under one or more controllers. A controller may
// only "switch to" (act as) users who are members of a group they control --
// see controllerTargets. Groups are server-wide state and live in setup.json,
// alongside the OAuth providers and the self-registration switch.

// group is one group as stored and as sent to the Admin - Groups page.
type group struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Members     []string `json:"members"`     // usernames of regular users
	Controllers []string `json:"controllers"` // usernames holding the controller role
}

// groupSlugRe validates generated/stored group ids.
var groupSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// nonSlug matches every run of characters that cannot appear in a slug.
var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// slugify derives a URL-safe id from a group name.
func slugify(name string) string {
	s := nonSlug.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-")
	return strings.Trim(s, "-")
}

// listGroups returns a deep copy of the configured groups. The member and
// controller lists are never nil, so an emptied group marshals to [] rather than
// null and the UI can treat them as arrays unconditionally.
func (s *Server) listGroups() []group {
	s.groupsMu.RLock()
	defer s.groupsMu.RUnlock()
	out := make([]group, len(s.groups))
	copyList := func(in []string) []string {
		if len(in) == 0 {
			return []string{}
		}
		return append([]string(nil), in...)
	}
	for i, g := range s.groups {
		out[i] = g
		out[i].Members = copyList(g.Members)
		out[i].Controllers = copyList(g.Controllers)
	}
	return out
}

// controllerTargets returns the usernames a controller may act as: the members
// of every group they control. A controller who controls no group gets an empty
// set and can act as nobody.
func (s *Server) controllerTargets(controller string) map[string]bool {
	out := map[string]bool{}
	for _, g := range s.listGroups() {
		controls := false
		for _, c := range g.Controllers {
			if c == controller {
				controls = true
				break
			}
		}
		if !controls {
			continue
		}
		for _, m := range g.Members {
			out[m] = true
		}
	}
	return out
}

// uniqueGroupID returns a slug derived from name that no other group uses.
// `self` is the id of the group being renamed (excluded from the check), or "".
func (s *Server) uniqueGroupID(name, self string) (string, error) {
	base := slugify(name)
	if base == "" {
		return "", fmt.Errorf("group name must contain at least one letter or digit")
	}
	if len(base) > 64 {
		base = base[:64]
	}
	taken := map[string]bool{}
	for _, g := range s.listGroups() {
		if g.ID != self {
			taken[g.ID] = true
		}
	}
	id := base
	for i := 2; taken[id]; i++ {
		id = fmt.Sprintf("%s-%d", base, i)
	}
	return id, nil
}

// validateGroupUsers checks that every member is an existing regular user and
// every controller is an existing user holding the controller role, returning
// the cleaned, de-duplicated, sorted lists.
func (s *Server) validateGroupUsers(members, controllers []string) ([]string, []string, error) {
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return nil, nil, err
	}
	exists := map[string]bool{}
	for _, m := range metas {
		exists[m.Username] = true
	}

	clean := func(in []string, what string, check func(string) error) ([]string, error) {
		seen := map[string]bool{}
		out := []string{}
		for _, u := range in {
			u = strings.TrimSpace(u)
			if u == "" || seen[u] {
				continue
			}
			if !exists[u] {
				return nil, fmt.Errorf("%s %q does not exist", what, u)
			}
			if err := check(u); err != nil {
				return nil, err
			}
			seen[u] = true
			out = append(out, u)
		}
		sort.Strings(out)
		return out, nil
	}

	// Which side of a group a user belongs on follows one capability, not a role
	// name: a role that can switch to other users oversees groups, and any other
	// role belongs to them. That way a custom role behaves like the built-in
	// Controller purely by being granted "switch to users".
	cleanMembers, err := clean(members, "user", func(u string) error {
		if s.isConfigAdmin(u) {
			return fmt.Errorf("%q is a config-defined admin and oversees every group", u)
		}
		if s.userHoldsCap(u, capUsersActAs) {
			return fmt.Errorf("%q can switch to other users, so they control groups rather than belong to one", u)
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	cleanControllers, err := clean(controllers, "controller", func(u string) error {
		if s.isConfigAdmin(u) {
			return nil // root admins may oversee any group
		}
		if !s.userHoldsCap(u, capUsersActAs) {
			return fmt.Errorf("%q does not have a role with the %q permission", u, capUsersActAs)
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return cleanMembers, cleanControllers, nil
}

// saveGroups replaces the group list and persists it, rolling back on error.
func (s *Server) saveGroups(groups []group) error {
	s.groupsMu.Lock()
	prev := s.groups
	s.groups = groups
	s.groupsMu.Unlock()
	if err := s.persistSetup(); err != nil {
		s.groupsMu.Lock()
		s.groups = prev
		s.groupsMu.Unlock()
		return err
	}
	return nil
}

// pruneUserFromGroups drops a username from every group's member and controller
// lists. Called after the account is deleted, and after a role change makes the
// membership invalid.
func (s *Server) pruneUserFromGroups(username string) error {
	groups := s.listGroups()
	changed := false
	drop := func(list []string) []string {
		out := list[:0]
		for _, u := range list {
			if u == username {
				changed = true
				continue
			}
			out = append(out, u)
		}
		return out
	}
	for i := range groups {
		groups[i].Members = drop(groups[i].Members)
		groups[i].Controllers = drop(groups[i].Controllers)
	}
	if !changed {
		return nil
	}
	return s.saveGroups(groups)
}

// adminGetGroups returns the groups plus the candidate members/controllers the
// UI needs to populate its pickers.
func (s *Server) adminGetGroups() response {
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var users, controllers []string
	// directory carries the profile bits the page needs to show a face and a real
	// name next to each username, so it does not need the users.manage list too.
	directory := map[string]any{}
	for _, m := range metas {
		snap := s.userSnapshot(m.Username)
		directory[m.Username] = map[string]any{
			"profile": snap.Profile,
			"avatar":  snap.Avatar,
		}
		if s.isConfigAdmin(m.Username) {
			controllers = append(controllers, m.Username)
			continue
		}
		// Same split validateGroupUsers enforces: the "switch to users"
		// capability decides which side of a group someone can be on.
		if s.roleHasCap(snap.Role, capUsersActAs) {
			controllers = append(controllers, m.Username)
		} else {
			users = append(users, m.Username)
		}
	}
	sort.Strings(users)
	sort.Strings(controllers)
	if users == nil {
		users = []string{}
	}
	if controllers == nil {
		controllers = []string{}
	}
	groups := s.listGroups()
	if groups == nil {
		groups = []group{}
	}
	return jsonResp(200, map[string]any{
		"groups":                groups,
		"candidate_users":       users,
		"candidate_controllers": controllers,
		"directory":             directory,
	})
}

// adminSaveGroup creates or updates one group. Body is JSON with an optional id
// (absent = create), a name, and the member/controller lists.
func (s *Server) adminSaveGroup(req *request) response {
	raw, err := req.getBody(256 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Members     []string `json:"members"`
		Controllers []string `json:"controllers"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with name, members and controllers")
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		return textResp(400, "group name is required")
	}
	if len(name) > 80 {
		return textResp(400, "group name must be at most 80 characters")
	}
	members, controllers, err := s.validateGroupUsers(body.Members, body.Controllers)
	if err != nil {
		return textResp(400, err.Error())
	}

	groups := s.listGroups()
	id := strings.TrimSpace(body.ID)
	if id == "" {
		newID, err := s.uniqueGroupID(name, "")
		if err != nil {
			return textResp(400, err.Error())
		}
		groups = append(groups, group{
			ID: newID, Name: name, Description: strings.TrimSpace(body.Description),
			Members: members, Controllers: controllers,
		})
		id = newID
	} else {
		if !groupSlugRe.MatchString(id) {
			return textResp(400, "bad request: invalid group id")
		}
		idx := -1
		for i, g := range groups {
			if g.ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			return textResp(404, "group not found")
		}
		groups[idx].Name = name
		groups[idx].Description = strings.TrimSpace(body.Description)
		groups[idx].Members = members
		groups[idx].Controllers = controllers
	}
	if err := s.saveGroups(groups); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "id": id})
}

// adminSetUserGroups rewrites one user's group membership in a single save.
// Body is JSON {"username": ..., "groups": [id, ...]}. The groups page edits one
// group at a time; this is the same state seen from the other side, for the user
// details panel. Which list the name lands in follows the account's role, the
// same way validateGroupUsers enforces it: controllers oversee groups, regular
// users belong to them, and stored admins can do neither.
func (s *Server) adminSetUserGroups(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string   `json:"username"`
		Groups   []string `json:"groups"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and groups")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	found := false
	for _, m := range metas {
		if m.Username == username {
			found = true
			break
		}
	}
	if !found {
		return textResp(404, "user not found")
	}

	// Config admins oversee any group; otherwise the stored role decides.
	asController := s.isConfigAdmin(username)
	if !asController {
		_, storedAdmin, storedController := s.userFlags(username)
		if storedAdmin {
			return textResp(400, "admins are not part of groups — change the role first")
		}
		asController = storedController
	}

	want := map[string]bool{}
	for _, id := range body.Groups {
		id = strings.TrimSpace(id)
		if id != "" {
			want[id] = true
		}
	}
	groups := s.listGroups()
	known := map[string]bool{}
	for _, g := range groups {
		known[g.ID] = true
	}
	for id := range want {
		if !known[id] {
			return textResp(404, "group not found: "+id)
		}
	}

	// Rebuild the one list this user belongs in, leaving the other untouched.
	for i := range groups {
		list := &groups[i].Members
		if asController {
			list = &groups[i].Controllers
		}
		out := make([]string, 0, len(*list)+1)
		for _, u := range *list {
			if u != username {
				out = append(out, u)
			}
		}
		if want[groups[i].ID] {
			out = append(out, username)
		}
		sort.Strings(out)
		*list = out
	}
	if err := s.saveGroups(groups); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// adminDeleteGroup removes a group. Body is JSON {"id": "..."}.
func (s *Server) adminDeleteGroup(req *request) response {
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
	groups := s.listGroups()
	out := make([]group, 0, len(groups))
	found := false
	for _, g := range groups {
		if g.ID == id {
			found = true
			continue
		}
		out = append(out, g)
	}
	if !found {
		return textResp(404, "group not found")
	}
	if err := s.saveGroups(out); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}
