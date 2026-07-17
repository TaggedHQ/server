package server

import (
	"sort"

	"github.com/TaggedHQ/server/internal/store"
)

// controllerFlagKey is the userinfo key holding a per-user stored controller
// role, parallel to adminFlagKey. A controller may "switch to" a regular user
// and act as them for the data plane (records/settings/updates); see the
// impersonation handling in api.go.
const controllerFlagKey = "is_controller"

// dbControllerFlag reads the stored controller role from an already-open user db.
func dbControllerFlag(db store.UserDB) bool {
	ob, err := db.Get("userinfo", controllerFlagKey)
	if err != nil || ob == nil {
		return false
	}
	b, _ := ob["value"].(bool)
	return b
}

// dbRegistered reports whether the user has a password set (vs. a token-only
// account). Mirrors the check in userFlags.
func dbRegistered(db store.UserDB) bool {
	ob, err := db.Get("userinfo", passwordHashKey)
	if err != nil || ob == nil {
		return false
	}
	v, _ := ob["value"].(string)
	return v != ""
}

// isController reports whether the user has the (stored) controller role. There
// is no config-defined controller: the role is granted only via the admin page.
func (s *Server) isController(username string, db store.UserDB) bool {
	return db != nil && dbControllerFlag(db)
}

// controllerHandler dispatches controller-only sub-routes. `sub` is the path
// after "controller" (e.g. "/users"). The caller has already been verified to
// hold the "switch to users" capability.
func (s *Server) controllerHandler(req *request, sub, username string) response {
	switch sub {
	case "/users", "/users/":
		if req.method() == "GET" {
			return s.controllerListUsers(username)
		}
		return textResp(405, "method not allowed")
	default:
		return textResp(404, "not found: /controller"+sub+" is not a valid controller path")
	}
}

// controllerListUsers returns the users the given controller may switch to: the
// registered regular members of the groups they control. Membership is the only
// way in, so a controller who controls no group gets an empty list.
func (s *Server) controllerListUsers(controller string) response {
	targets := s.controllerTargets(controller)
	usernames := []string{}
	for u := range targets {
		if s.isConfigAdmin(u) {
			continue
		}
		registered, storedAdmin, storedController := s.userFlags(u)
		if !registered || storedAdmin || storedController {
			continue
		}
		usernames = append(usernames, u)
	}
	sort.Strings(usernames)
	users := make([]map[string]any, 0, len(usernames))
	for _, u := range usernames {
		users = append(users, map[string]any{"username": u})
	}
	return jsonResp(200, map[string]any{"users": users})
}
