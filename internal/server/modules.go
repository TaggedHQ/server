package server

import "sort"

// Optional feature modules. Each one adds a page to the web UI that an operator
// can switch on from the Admin · Settings page. Modules are opt-in: a fresh
// server, and any setup.json written before they existed, has them all off, so
// upgrading never surfaces a page nobody asked for.
//
// A disabled module is not merely hidden -- its page 404s (see webUI), so the
// switch is a real gate rather than a cosmetic one.

// Module keys. Keep these stable: they are persisted in setup.json.
const (
	moduleShifts = "shifts"
	moduleSkills = "skills"
)

// moduleDef describes one module for the Settings page.
type moduleDef struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	Desc    string `json:"desc"`
	Enabled bool   `json:"enabled"`
}

// moduleMeta is the fixed presentation for each module, in display order.
var moduleMeta = []moduleDef{
	{Key: moduleShifts, Label: "Shifts", Desc: "Plan the working week for the groups you control, with open shifts and absences."},
	{Key: moduleSkills, Label: "Skills", Desc: "Track skills, proficiency levels and how well the team covers them."},
}

// validModule reports whether key names a known module.
func validModule(key string) bool {
	for _, m := range moduleMeta {
		if m.Key == key {
			return true
		}
	}
	return false
}

// moduleEnabled reports whether a module is switched on. Unknown or unset keys
// are off.
func (s *Server) moduleEnabled(key string) bool {
	s.modulesMu.RLock()
	defer s.modulesMu.RUnlock()
	return s.modules[key]
}

// listModules returns the catalog with each module's current state, for the
// Settings page.
func (s *Server) listModules() []moduleDef {
	out := make([]moduleDef, 0, len(moduleMeta))
	for _, m := range moduleMeta {
		m.Enabled = s.moduleEnabled(m.Key)
		out = append(out, m)
	}
	return out
}

// enabledModules returns just the keys that are on, sorted. The web UI uses it
// to decide which nav entries to reveal.
func (s *Server) enabledModules() []string {
	out := []string{}
	for _, m := range moduleMeta {
		if s.moduleEnabled(m.Key) {
			out = append(out, m.Key)
		}
	}
	sort.Strings(out)
	return out
}

// setModuleEnabled flips one module and persists it, rolling back on error.
func (s *Server) setModuleEnabled(key string, on bool) error {
	s.modulesMu.Lock()
	if s.modules == nil {
		s.modules = map[string]bool{}
	}
	prev, had := s.modules[key]
	s.modules[key] = on
	s.modulesMu.Unlock()
	if err := s.persistSetup(); err != nil {
		s.modulesMu.Lock()
		if had {
			s.modules[key] = prev
		} else {
			delete(s.modules, key)
		}
		s.modulesMu.Unlock()
		return err
	}
	return nil
}

// moduleForPage maps a web UI page to the module that must be on for it to be
// served. Pages absent from the map are always available.
var moduleForPage = map[string]string{
	"shifts": moduleShifts,
	"skills": moduleSkills,
}
