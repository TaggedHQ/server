// Package server ports the timetagger HTTP server: the routing/main handler from
// timetagger/__main__.py and the API + auth from timetagger/server/*.py.
//
// The web/app asset handlers are intentionally stubbed: the UI is being replaced,
// so this port focuses on the JSON API and authentication. The routing that
// dispatches to the (future) UI is preserved so it can be filled in later.
package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/TaggedHQ/server/internal/config"
	"github.com/TaggedHQ/server/internal/store"
	"github.com/TaggedHQ/server/internal/webui"
)

// Version is Tagged's own version. It can be overridden at build time via
// -ldflags "-X github.com/TaggedHQ/server/internal/server.Version=..."; the
// release workflow stamps it with the git tag.
var Version = "0.2.2"

// Server holds all shared state, replacing the module-level globals of the
// Python server (CREDENTIALS, TRUSTED_PROXIES, JWT_KEY, config).
type Server struct {
	cfg         *config.Config
	rootTTDir   string
	rootUserDir string
	jwtKey      string
	credentials map[string]string // username -> bcrypt hash
	trusted     *ipRangeList
	admins      map[string]bool // usernames with admin rights

	// storeMu guards store/backendKind/backendURL, which the setup wizard can swap
	// at runtime when the backend is not operator-pinned.
	storeMu       sync.RWMutex
	store         store.Backend
	backendKind   string
	backendURL    string // active Postgres DSN (empty for sqlite); kept for setup.json
	backendLocked bool   // db_backend/db_url pinned via CLI/env: wizard can't switch

	// regMu guards registrationOpen, the server-wide self-registration switch.
	regMu            sync.RWMutex
	registrationOpen bool

	// oauthMu guards oauthProviders, the configured external identity providers.
	oauthMu        sync.RWMutex
	oauthProviders []oauthProvider

	// rolesMu guards roles, the role -> capabilities permission matrix.
	rolesMu sync.RWMutex
	roles   map[string][]string

	// groupsMu guards groups, the user groups and their controllers.
	groupsMu sync.RWMutex
	groups   []group

	// modulesMu guards modules, the optional feature modules that are switched on.
	modulesMu sync.RWMutex
	modules   map[string]bool
}

// New constructs a Server, creating the data directory and loading (or creating)
// the JWT key, matching the import-time side effects of _utils.py and __main__.py.
func New(cfg *config.Config) (*Server, error) {
	rootTTDir := config.ExpandUser(cfg.Datadir)
	rootUserDir := filepath.Join(rootTTDir, "users")
	if err := os.MkdirAll(rootUserDir, 0o755); err != nil {
		return nil, fmt.Errorf("could not create data dir: %w", err)
	}
	jwtKey, err := loadJWTKey(rootTTDir)
	if err != nil {
		return nil, err
	}
	trusted, err := parseIPRangeList(cfg.ProxyAuthTrusted)
	if err != nil {
		return nil, err
	}
	// Effective backend: an operator-pinned choice (CLI/env) wins and locks the
	// wizard; otherwise a persisted setup.json wins; otherwise the sqlite default.
	locked := cfg.IsExplicit("db_backend") || cfg.IsExplicit("db_url")
	kind, dbURL := cfg.DBBackend, cfg.DBURL
	// setup.json holds persisted operator choices: the backend (used only when not
	// operator-pinned) and the self-registration switch (always honored).
	saved, err := loadSetup(rootTTDir)
	if err != nil {
		return nil, fmt.Errorf("could not read %s: %w", setupFile, err)
	}
	if !locked && saved != nil {
		kind, dbURL = saved.Backend, saved.DBURL
	}
	registrationOpen := true // default: open, matching prior behavior
	if saved != nil && saved.RegistrationOpen != nil {
		registrationOpen = *saved.RegistrationOpen
	}
	var oauthProviders []oauthProvider
	var groups []group
	roles := defaultRoleCaps()
	// Optional modules default to off, so a server that never opted in (or a
	// setup.json written before they existed) does not gain pages on upgrade.
	modules := map[string]bool{}
	if saved != nil {
		oauthProviders = saved.OAuth
		groups = saved.Groups
		for key, on := range saved.Modules {
			if validModule(key) {
				modules[key] = on
			}
		}
		// Merge over the defaults, so a role key added in a later version still
		// gets its default capabilities on an older setup.json.
		for key, caps := range saved.Roles {
			if _, known := roleMeta[key]; known {
				roles[key] = caps
			}
		}
	}
	backend, err := store.NewBackend(kind, rootUserDir, dbURL)
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:              cfg,
		rootTTDir:        rootTTDir,
		rootUserDir:      rootUserDir,
		store:            backend,
		backendKind:      kind,
		backendURL:       dbURL,
		backendLocked:    locked,
		jwtKey:           jwtKey,
		credentials:      loadCredentials(cfg.Credentials),
		trusted:          trusted,
		admins:           loadAdmins(cfg.Admins),
		registrationOpen: registrationOpen,
		oauthProviders:   oauthProviders,
		roles:            roles,
		groups:           groups,
		modules:          modules,
	}, nil
}

// getStore returns the current backend under a read lock, so the setup wizard can
// swap it without racing in-flight requests.
func (s *Server) getStore() store.Backend {
	s.storeMu.RLock()
	defer s.storeMu.RUnlock()
	return s.store
}

// currentBackend reports the active backend kind ("sqlite"/"postgres").
func (s *Server) currentBackend() string {
	s.storeMu.RLock()
	defer s.storeMu.RUnlock()
	return s.backendKind
}

// BackendLabel is a human-readable name for the active backend, for startup logs.
func (s *Server) BackendLabel() string {
	if s.currentBackend() == "postgres" {
		return "Performance Server (Postgres)"
	}
	return "Simple Server (SQLite)"
}

// reconfigureBackend builds a new backend (validating the connection for
// Postgres), persists the choice, and swaps it in atomically. It is a no-op-safe
// error if the backend is operator-pinned.
func (s *Server) reconfigureBackend(kind, dbURL string) error {
	if s.backendLocked {
		return fmt.Errorf("the storage backend is fixed by server configuration")
	}
	backend, err := store.NewBackend(kind, s.rootUserDir, dbURL)
	if err != nil {
		return err
	}
	if err := saveSetup(s.rootTTDir, s.setupSnapshot(kind, dbURL)); err != nil {
		backend.Close()
		return err
	}
	s.storeMu.Lock()
	old := s.store
	s.store = backend
	s.backendKind = kind
	s.backendURL = dbURL
	s.storeMu.Unlock()
	if old != nil {
		old.Close()
	}
	return nil
}

// setupSnapshot builds the setupState to persist, pairing the given backend
// choice with every other piece of server-wide state so no writer clobbers
// another's field.
func (s *Server) setupSnapshot(kind, dbURL string) setupState {
	s.regMu.RLock()
	open := s.registrationOpen
	s.regMu.RUnlock()
	s.oauthMu.RLock()
	providers := s.oauthProviders
	s.oauthMu.RUnlock()
	s.rolesMu.RLock()
	roles := map[string][]string{}
	for k, v := range s.roles {
		roles[k] = v
	}
	s.rolesMu.RUnlock()
	s.groupsMu.RLock()
	groups := s.groups
	s.groupsMu.RUnlock()
	s.modulesMu.RLock()
	modules := map[string]bool{}
	for k, v := range s.modules {
		modules[k] = v
	}
	s.modulesMu.RUnlock()
	return setupState{
		Backend: kind, DBURL: dbURL, RegistrationOpen: &open,
		OAuth: providers, Roles: roles, Groups: groups, Modules: modules,
	}
}

// persistSetup writes the current server-wide state to setup.json, preserving
// the active backend choice.
func (s *Server) persistSetup() error {
	s.storeMu.RLock()
	kind, dbURL := s.backendKind, s.backendURL
	s.storeMu.RUnlock()
	return saveSetup(s.rootTTDir, s.setupSnapshot(kind, dbURL))
}

// registrationEnabled reports whether self-registration via /register is allowed.
func (s *Server) registrationEnabled() bool {
	s.regMu.RLock()
	defer s.regMu.RUnlock()
	return s.registrationOpen
}

// setRegistrationEnabled flips the self-registration switch and persists it to
// setup.json (preserving the active backend choice).
func (s *Server) setRegistrationEnabled(open bool) error {
	s.regMu.Lock()
	s.registrationOpen = open
	s.regMu.Unlock()
	return s.persistSetup()
}

// loadAdmins parses "user1,user2" (';' also allowed) into a set of admin usernames.
func loadAdmins(raw string) map[string]bool {
	admins := map[string]bool{}
	raw = strings.ReplaceAll(raw, ";", ",")
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s != "" {
			admins[s] = true
		}
	}
	return admins
}

// isConfigAdmin reports whether the user is an admin via the `admins` config
// (a "root" admin whose rights cannot be revoked through the UI).
func (s *Server) isConfigAdmin(username string) bool { return s.admins[username] }

// loadJWTKey loads the secret key from <datadir>/jwt.key, creating it if absent.
// Mirrors _utils._load_jwt_key.
func loadJWTKey(rootTTDir string) (string, error) {
	filename := filepath.Join(rootTTDir, "jwt.key")
	if b, err := os.ReadFile(filename); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s, nil
		}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(buf)
	if err := os.WriteFile(filename, []byte(secret), 0o600); err != nil {
		return "", err
	}
	return secret, nil
}

// loadCredentials parses "user1:hash1,user2:hash2" (';' also allowed) into a map.
// Mirrors __main__.load_credentials.
func loadCredentials(raw string) map[string]string {
	d := map[string]string{}
	raw = strings.ReplaceAll(raw, ";", ",")
	for _, s := range strings.Split(raw, ",") {
		name, hash, _ := strings.Cut(s, ":")
		d[name] = hash
	}
	return d
}

// ---- response plumbing ------------------------------------------------------

// response models an asgineer-style (status, headers, body) return value. body
// may be a map/slice (encoded as JSON), a string (text/plain), or []byte.
type response struct {
	status  int
	headers map[string]string
	body    any
}

func jsonResp(status int, body any) response { return response{status, nil, body} }
func textResp(status int, body string) response {
	return response{status, nil, body}
}

func (s *Server) write(w http.ResponseWriter, r response) {
	for k, v := range r.headers {
		w.Header().Set(k, v)
	}
	status := r.status
	if status == 0 {
		status = 200
	}
	switch b := r.body.(type) {
	case string:
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(b))
	case []byte:
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		w.WriteHeader(status)
		_, _ = w.Write(b)
	case nil:
		w.WriteHeader(status)
	default:
		buf, err := json.Marshal(b)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("json encode error"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(buf)
	}
}

// ---- routing (ports __main__.main_handler) ----------------------------------

// Handler returns the root http.Handler.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.mainHandler)
}

func (s *Server) mainHandler(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg
	path := r.URL.Path

	// Redirects for the root path.
	if path == "/" {
		if cfg.AppRedirect {
			s.write(w, response{307, map[string]string{"Location": cfg.PathPrefix + "app/"}, []byte{}})
			return
		} else if cfg.PathPrefix != "/" {
			s.write(w, response{307, map[string]string{"Location": cfg.PathPrefix}, []byte{}})
			return
		}
	}

	if strings.HasPrefix(path, cfg.PathPrefix) {
		switch {
		case path == cfg.PathPrefix+"status":
			s.write(w, textResp(200, "ok"))
		case strings.HasPrefix(path, cfg.PathPrefix+"api/v2/"):
			apiPath := strings.Trim(strings.TrimPrefix(path, cfg.PathPrefix+"api/v2/"), "/")
			s.write(w, s.apiHandler(r, apiPath))
		case strings.HasPrefix(path, cfg.PathPrefix+"app/"):
			assetPath := strings.Trim(strings.TrimPrefix(path, cfg.PathPrefix+"app/"), "/")
			s.write(w, s.assetHandler(r, assetPath, "app"))
		default:
			assetPath := strings.Trim(strings.TrimPrefix(path, cfg.PathPrefix), "/")
			s.write(w, s.webUI(r, assetPath))
		}
		return
	}

	s.write(w, textResp(404, "only serving at "+cfg.PathPrefix))
}

// webUI serves the embedded web UI (login, register, dashboard) for the web
// asset group.
func (s *Server) webUI(r *http.Request, assetPath string) response {
	// A page belonging to a switched-off module does not exist. Hiding only the
	// nav entry would leave the page reachable by typing its URL.
	if mod, gated := moduleForPage[assetPath]; gated && !s.moduleEnabled(mod) {
		return textResp(404, "not found: the "+mod+" module is not enabled on this server")
	}
	asset := webui.Get(assetPath, s.cfg.PathPrefix)
	if !asset.Found {
		return textResp(404, "not found")
	}
	headers := map[string]string{
		"Content-Type":  asset.ContentType,
		"Cache-Control": cacheControl(r, asset),
	}
	// The version is a build id, not a secret; exposing it makes "which build is
	// this container actually running?" answerable from curl -I.
	headers["X-Tagged-Build"] = webui.Version
	return response{status: 200, headers: headers, body: asset.Body}
}

// cacheControl decides how long a UI asset may be reused.
//
// HTML must never be cached: it is what carries the ?v=<build> links, so a stale
// copy would keep pointing a browser at the previous build's assets forever --
// exactly the "I updated the container but Safari shows the old page" trap.
// Safari in particular caches aggressively when a response says nothing, which
// is what these responses used to do.
//
// Anything requested with a ?v= is safe to keep for a year: the URL changes
// whenever the bytes do, so a cached entry can never be stale. Assets fetched
// without one (a favicon a browser guesses at, say) get a short window.
func cacheControl(r *http.Request, asset webui.Asset) string {
	if asset.IsHTML {
		return "no-cache, no-store, must-revalidate"
	}
	if r.URL.Query().Get("v") != "" {
		return "public, max-age=31536000, immutable"
	}
	return "public, max-age=300"
}

// assetHandler is a placeholder for the original compiled app assets (PScript/
// SCSS/etc.), which are being replaced. It keeps the routing intact.
func (s *Server) assetHandler(r *http.Request, path, group string) response {
	return textResp(404, fmt.Sprintf(
		"UI asset serving is not implemented in the Go port yet (%s/%s). The JSON API at %sapi/v2/ is fully functional.",
		group, path, s.cfg.PathPrefix))
}

// clientIP returns the immediate peer IP, matching request.scope["client"][0].
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// requestHost returns the hostname portion of the Host header (no port),
// matching asgineer's request.host for the localhost check.
func requestHost(r *http.Request) string {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

// Log is a tiny helper so main can share the logger style.
func Log(format string, args ...any) { log.Printf(format, args...) }
