package server

import (
	"runtime"
	"runtime/debug"
)

// BuildDate and BuildCommit can be injected at build time via
// -ldflags "-X github.com/TaggedHQ/server/internal/server.BuildDate=...".
// When empty, they fall back to the VCS info Go embeds in the binary.
var (
	BuildDate   string
	BuildCommit string
)

// repoURL is the public source repository, shown on the About page.
const repoURL = "https://github.com/TaggedHQ/server"

// aboutDep is one curated backend dependency shown on the About page.
type aboutDep struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Version     string `json:"version"`
	License     string `json:"license"`
	Description string `json:"description"`
}

// curatedDeps lists the notable direct dependencies with their license and a
// short description. Versions are filled in from the build info at runtime so
// they never drift from go.mod.
var curatedDeps = []aboutDep{
	{Name: "SQLite (pure Go)", Path: "modernc.org/sqlite", License: "BSD-3-Clause", Description: "Simple Server storage backend"},
	{Name: "pgx", Path: "github.com/jackc/pgx/v5", License: "MIT", Description: "PostgreSQL driver (Performance Server)"},
	{Name: "Go Crypto (bcrypt)", Path: "golang.org/x/crypto", License: "BSD-3-Clause", Description: "Password hashing"},
	{Name: "go-qrcode", Path: "github.com/skip2/go-qrcode", License: "MIT", Description: "TOTP QR-code generation"},
}

// aboutInfo is the payload returned by GET api/v2/about.
type aboutInfo struct {
	Version      string     `json:"version"`
	BuildDate    string     `json:"build_date"`
	GoVersion    string     `json:"go_version"`
	Revision     string     `json:"revision"`
	RepoURL      string     `json:"repo_url"`
	Dependencies []aboutDep `json:"dependencies"`
}

// aboutHandler reports version, build, and dependency information for the About
// page. Available to any authenticated user.
func (s *Server) aboutHandler() response {
	info := aboutInfo{
		Version:   Version,
		BuildDate: BuildDate,
		GoVersion: runtime.Version(),
		Revision:  BuildCommit,
		RepoURL:   repoURL,
	}

	// Pull module versions (and VCS fallbacks) from the embedded build info.
	versions := map[string]string{}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			versions[d.Path] = d.Version
		}
		if info.BuildDate == "" || info.Revision == "" {
			for _, set := range bi.Settings {
				switch set.Key {
				case "vcs.time":
					if info.BuildDate == "" {
						info.BuildDate = set.Value
					}
				case "vcs.revision":
					if info.Revision == "" {
						info.Revision = set.Value
					}
				}
			}
		}
	}

	deps := make([]aboutDep, 0, len(curatedDeps))
	for _, d := range curatedDeps {
		if v, ok := versions[d.Path]; ok && v != "" {
			d.Version = v
		}
		deps = append(deps, d)
	}
	info.Dependencies = deps

	return jsonResp(200, info)
}
