// Package config ports timetagger/_config.py. It holds server configuration
// with the same defaults, and reads overrides from CLI args and environment
// variables using the same rules as the Python version.
package config

import (
	"fmt"
	"os"
	"strings"
)

// Config mirrors timetagger._config.Config.
type Config struct {
	Bind             string
	Datadir          string
	LogLevel         string
	Credentials      string
	ProxyAuthEnabled bool
	ProxyAuthTrusted string
	ProxyAuthHeader  string
	PathPrefix       string
	AppRedirect      bool
	TLSCert          string
	TLSKey           string
	Admins           string
	DBBackend        string // "sqlite" (Simple Server) or "postgres" (Performance Server)
	DBURL            string // Postgres DSN, used when DBBackend == "postgres"

	// explicit records which config items were provided via CLI/env (vs. left at
	// their default), so the setup wizard knows when the backend is operator-pinned.
	explicit map[string]bool
}

// IsExplicit reports whether the named config item (snake_case, e.g. "db_backend")
// was set via a CLI flag or environment variable rather than left at its default.
func (c *Config) IsExplicit(name string) bool { return c.explicit[name] }

// item describes a single config field: its struct pointer resolver, the env/CLI
// name (snake_case, matching Python attribute names), and how to convert a raw
// string value.
type item struct {
	name    string
	set     func(c *Config, raw string) error
	setDflt func(c *Config)
}

func toBool(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "yes", "on", "1":
		return true
	}
	return false
}

// toPathPrefix ensures the prefix starts and ends with '/'. Mirrors
// _config.to_path_prefix.
func toPathPrefix(value string) string {
	p := strings.TrimSpace(value)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if !strings.HasSuffix(p, "/") && p != "/" {
		p = p + "/"
	}
	return p
}

func items() []item {
	return []item{
		{"bind", func(c *Config, v string) error { c.Bind = v; return nil }, func(c *Config) { c.Bind = "127.0.0.1:8080" }},
		{"datadir", func(c *Config, v string) error { c.Datadir = v; return nil }, func(c *Config) { c.Datadir = "~/.tagged" }},
		{"log_level", func(c *Config, v string) error { c.LogLevel = v; return nil }, func(c *Config) { c.LogLevel = "info" }},
		{"credentials", func(c *Config, v string) error { c.Credentials = v; return nil }, func(c *Config) { c.Credentials = "" }},
		{"proxy_auth_enabled", func(c *Config, v string) error { c.ProxyAuthEnabled = toBool(v); return nil }, func(c *Config) { c.ProxyAuthEnabled = false }},
		{"proxy_auth_trusted", func(c *Config, v string) error { c.ProxyAuthTrusted = v; return nil }, func(c *Config) { c.ProxyAuthTrusted = "127.0.0.1" }},
		{"proxy_auth_header", func(c *Config, v string) error { c.ProxyAuthHeader = v; return nil }, func(c *Config) { c.ProxyAuthHeader = "X-Remote-User" }},
		{"path_prefix", func(c *Config, v string) error { c.PathPrefix = toPathPrefix(v); return nil }, func(c *Config) { c.PathPrefix = "/" }},
		{"app_redirect", func(c *Config, v string) error { c.AppRedirect = toBool(v); return nil }, func(c *Config) { c.AppRedirect = false }},
		{"tls_cert", func(c *Config, v string) error { c.TLSCert = v; return nil }, func(c *Config) { c.TLSCert = "" }},
		{"tls_key", func(c *Config, v string) error { c.TLSKey = v; return nil }, func(c *Config) { c.TLSKey = "" }},
		{"admins", func(c *Config, v string) error { c.Admins = v; return nil }, func(c *Config) { c.Admins = "" }},
		{"db_backend", func(c *Config, v string) error { c.DBBackend = strings.ToLower(strings.TrimSpace(v)); return nil }, func(c *Config) { c.DBBackend = "sqlite" }},
		{"db_url", func(c *Config, v string) error { c.DBURL = v; return nil }, func(c *Config) { c.DBURL = "" }},
	}
}

// New builds a Config from defaults, then CLI args, then environment variables,
// in that order (matching set_config in _config.py).
func New(argv []string, env []string) (*Config, error) {
	c := &Config{explicit: map[string]bool{}}
	its := items()
	for _, it := range its {
		it.setDflt(c)
	}
	if err := updateFromArgv(c, its, argv); err != nil {
		return nil, err
	}
	if err := updateFromEnv(c, its, env); err != nil {
		return nil, err
	}
	return c, nil
}

func updateFromArgv(c *Config, its []item, argv []string) error {
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		for _, it := range its {
			names := []string{it.name, strings.ReplaceAll(it.name, "_", "-")}
			var raw string
			matched := false
			for _, name := range names {
				if strings.HasPrefix(arg, "--"+name+"=") {
					raw = arg[len("--"+name+"="):]
					matched = true
				} else if arg == "--"+name {
					if i+1 < len(argv) {
						raw = argv[i+1]
					} else {
						return fmt.Errorf("value for %s not given", arg)
					}
					matched = true
				}
				if matched {
					break
				}
			}
			if !matched {
				continue
			}
			if err := it.set(c, raw); err != nil {
				return fmt.Errorf("could not set config.%s: %w", it.name, err)
			}
			c.explicit[it.name] = true
			break
		}
	}
	return nil
}

func updateFromEnv(c *Config, its []item, env []string) error {
	lookup := map[string]string{}
	for _, e := range env {
		if k, v, ok := strings.Cut(e, "="); ok {
			lookup[k] = v
		}
	}
	for _, it := range its {
		up := strings.ToUpper(it.name)
		// Prefer TAGGED_*, fall back to the legacy TIMETAGGER_* prefix.
		raw := lookup["TAGGED_"+up]
		if raw == "" {
			raw = lookup["TIMETAGGER_"+up]
		}
		if raw != "" {
			if err := it.set(c, raw); err != nil {
				return fmt.Errorf("could not set config.%s: %w", it.name, err)
			}
			c.explicit[it.name] = true
		}
	}
	return nil
}

// ExpandUser expands a leading "~" to the user's home directory, mirroring
// os.path.expanduser as used for datadir.
func ExpandUser(path string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
		return path
	}
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return home + path[1:]
		}
	}
	return path
}
