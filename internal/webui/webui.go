// Package webui serves a minimal embedded web UI (login, register, dashboard)
// for the Go TimeTagger server. Pages talk to the JSON API at
// <path_prefix>api/v2/. The path prefix is injected into HTML at serve time via
// the {{PREFIX}} placeholder so the UI works under any configured prefix.
//
// Caching. HTML is served no-cache and carries a ?v=<Version> on every asset it
// references; the assets themselves are then immutable for a year (see the
// server's webUI handler). Version is derived from the embedded bytes, so a new
// build serves new URLs and browsers fetch them instead of reusing a stale copy
// -- without anyone having to clear their cache.
package webui

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"path"
	"strings"
)

//go:generate go run ./gen

//go:embed static/*
var files embed.FS

// Version identifies this build's assets: the first 12 hex digits of a hash over
// every embedded file's path and contents. Any change to any asset changes it.
var Version = computeVersion()

// computeVersion hashes the embedded tree. fs.WalkDir yields entries in
// lexical order, so the result depends only on the contents, not on the walk.
func computeVersion() string {
	h := sha256.New()
	err := fs.WalkDir(files, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		b, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		h.Write([]byte(p))
		h.Write(b)
		return nil
	})
	if err != nil {
		// A build with unreadable embedded assets is broken anyway; fall back to
		// a constant rather than panicking at init.
		return "dev"
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

// route maps a request path (the part after the path prefix) to a file in the
// embedded static dir.
func route(reqPath string) string {
	switch reqPath {
	case "":
		return "index.html"
	case "login":
		return "login.html"
	case "register":
		return "register.html"
	case "setup":
		return "setup.html"
	case "account":
		return "account.html"
	case "entries":
		return "entries.html"
	case "users":
		return "users.html"
	case "roles":
		return "roles.html"
	case "groups":
		return "groups.html"
	case "shifts":
		return "shifts.html"
	case "skills":
		return "skills.html"
	case "myskills":
		return "myskills.html"
	case "skillcats":
		return "skillcats.html"
	case "skilllevels":
		return "skilllevels.html"
	case "settings":
		return "settings.html"
	case "oauth":
		return "oauth.html"
	case "translations":
		return "translations.html"
	case "tags":
		return "tags.html"
	case "about":
		return "about.html"
	case "impexp":
		return "impexp.html"
	default:
		return reqPath
	}
}

// navKey maps a request path to the data-nav value of the sidebar entry that
// leads to it, so Get can mark that entry active. It is deliberately the same
// switch shape as route(): both answer "which page is this?", and a new page
// that forgets one of them is easier to spot when they sit together.
func navKey(reqPath string) string {
	switch reqPath {
	case "":
		return "dashboard"
	default:
		return reqPath
	}
}

// sidebarPartial is the shared sidebar markup, injected at the {{SIDEBAR}}
// marker. Read once at init: it never changes for the life of the process, and
// every signed-in page needs it.
var sidebarPartial = mustReadPartial("static/_sidebar.html")

func mustReadPartial(name string) string {
	b, err := files.ReadFile(name)
	if err != nil {
		// The partial is embedded, so a failure here is a broken build rather
		// than a runtime condition. Serving pages with no navigation would be a
		// stranger failure than an empty string, but there is nothing to
		// recover to, so keep it simple and let the pages render bare.
		return ""
	}
	// Strip the leading explanatory comment: it is for whoever edits the file,
	// not for every page's wire bytes.
	s := string(b)
	if i := strings.Index(s, "-->"); i >= 0 && strings.HasPrefix(strings.TrimSpace(s), "<!--") {
		s = s[i+3:]
	}
	return strings.TrimLeft(s, "\n")
}

// injectSidebar replaces the {{SIDEBAR}} marker with the shared nav, marking
// the entry for reqPath active. Pages that do not carry the marker (login,
// register, setup) are returned untouched.
func injectSidebar(body, reqPath string) string {
	if !strings.Contains(body, "{{SIDEBAR}}") {
		return body
	}
	nav := sidebarPartial
	if key := navKey(reqPath); key != "" {
		// Only ever one entry matches, and adding the class next to the
		// attribute keeps the partial free of per-page state.
		nav = strings.Replace(nav,
			`data-nav="`+key+`"`,
			`data-nav="`+key+`" class="active"`, 1)
	}
	return strings.ReplaceAll(body, "{{SIDEBAR}}", nav)
}

// Asset is a resolved static file ready to serve.
type Asset struct {
	Body        []byte
	ContentType string
	Found       bool
	IsHTML      bool // HTML is never cached; it carries the ?v= links
}

// Get resolves reqPath to an embedded asset, injecting the path prefix and the
// build version into HTML files.
func Get(reqPath, prefix string) Asset {
	name := route(reqPath)
	// Guard against path traversal.
	if strings.Contains(name, "..") {
		return Asset{Found: false}
	}
	body, err := files.ReadFile("static/" + name)
	if err != nil {
		return Asset{Found: false}
	}
	ct := contentType(name)
	isHTML := strings.HasSuffix(name, ".html")
	switch {
	case isHTML:
		// Sidebar first: it carries {{PREFIX}} and {{V}} of its own, so it has
		// to be in place before those are substituted.
		s := injectSidebar(string(body), reqPath)
		s = strings.ReplaceAll(s, "{{PREFIX}}", prefix)
		body = []byte(strings.ReplaceAll(s, "{{V}}", Version))
	case strings.HasSuffix(name, ".css"):
		// The stylesheet references the fonts itself, so it needs the version
		// too -- otherwise they are the one thing left on a short cache.
		body = []byte(strings.ReplaceAll(string(body), "{{V}}", Version))
	}
	return Asset{Body: body, ContentType: ct, Found: true, IsHTML: isHTML}
}

func contentType(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js":
		return "application/javascript; charset=utf-8"
	case ".json":
		return "application/json"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".ico":
		return "image/x-icon"
	case ".webmanifest":
		return "application/manifest+json"
	case ".ttf":
		return "font/ttf"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	default:
		return "application/octet-stream"
	}
}
