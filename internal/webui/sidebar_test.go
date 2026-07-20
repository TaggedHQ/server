package webui

import (
	"io/fs"
	"path"
	"regexp"
	"strings"
	"testing"
)

// signedInPages are the pages that carry the shared sidebar. login, register
// and setup deliberately do not: they render before anyone is signed in.
var signedInPages = []string{
	"", "entries", "tags", "shifts", "myskills", "impexp", "account", "about",
	"skills", "skillcats", "skilllevels",
	"users", "roles", "groups", "settings", "oauth", "translations",
}

// Every signed-in page must end up with the nav, and none may still carry its
// own copy of the markup -- that duplication is what this partial removed.
func TestSidebarIsInjectedNotDuplicated(t *testing.T) {
	for _, page := range signedInPages {
		a := Get(page, "/")
		if !a.Found {
			t.Fatalf("page %q not found", page)
		}
		body := string(a.Body)
		if !strings.Contains(body, `<aside class="sidebar">`) {
			t.Errorf("page %q has no sidebar", page)
		}
		if n := strings.Count(body, `<aside class="sidebar">`); n != 1 {
			t.Errorf("page %q has %d sidebars, want 1", page, n)
		}
		if strings.Contains(body, "{{SIDEBAR}}") {
			t.Errorf("page %q still has an uninjected {{SIDEBAR}} marker", page)
		}
	}

	// The source files must hold the marker, not the markup. A page that grew
	// its own copy back would pass the checks above but reintroduce the drift.
	err := fs.WalkDir(files, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".html") || p == "static/_sidebar.html" {
			return err
		}
		b, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		if strings.Contains(string(b), `<aside class="sidebar">`) {
			t.Errorf("%s carries its own sidebar markup; it should use {{SIDEBAR}}", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// The active entry is decided by the page being served, so no page has to state
// which nav item is its own.
func TestSidebarMarksTheActiveEntry(t *testing.T) {
	cases := map[string]string{
		"":         "dashboard",
		"entries":  "entries",
		"shifts":   "shifts",
		"users":    "users",
		"settings": "settings",
	}
	for page, want := range cases {
		body := string(Get(page, "/").Body)
		marker := `data-nav="` + want + `" class="active"`
		if !strings.Contains(body, marker) {
			t.Errorf("page %q: no active entry for %q", page, want)
		}
		if n := strings.Count(body, `class="active"`); n != 1 {
			t.Errorf("page %q has %d active nav entries, want 1", page, n)
		}
	}
}

// Everything gated on a capability or a module starts hidden and is opened by
// revealChrome once whoami answers. This was the drift that prompted the
// partial: 11 of the 17 copies left the Admin section visible, so a non-admin
// saw the admin menu until the first API call came back.
func TestOptionalNavStartsHidden(t *testing.T) {
	for _, page := range signedInPages {
		body := string(Get(page, "/").Body)
		for _, id := range []string{"nav-admin", "nav-skills-section", "nav-shifts", "nav-my-skills"} {
			i := strings.Index(body, `id="`+id+`"`)
			if i < 0 {
				t.Errorf("page %q: %q missing from the nav", page, id)
				continue
			}
			// Look at the element's own tag, not the rest of the document.
			end := strings.Index(body[i:], ">")
			if end < 0 {
				t.Fatalf("page %q: unterminated tag for %q", page, id)
			}
			if !strings.Contains(body[i:i+end], "display:none") {
				t.Errorf("page %q: %q is visible before whoami answers", page, id)
			}
		}
	}
}

// Every script and stylesheet a page asks for must actually resolve. The assets
// are referenced by string, so moving one (they now live under static/js/) or
// renaming it breaks the page at runtime with nothing at build time to catch it
// -- the Go compiler never sees these paths.
func TestPagesReferenceAssetsThatExist(t *testing.T) {
	ref := regexp.MustCompile(`(?:src|href)="\{\{PREFIX\}\}([^"?]+)`)
	err := fs.WalkDir(files, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".html") {
			return err
		}
		b, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		for _, m := range ref.FindAllStringSubmatch(string(b), -1) {
			target := m[1]
			// Only asset references have an extension; the rest are page links,
			// which route() resolves rather than reading straight off disk.
			if !strings.Contains(path.Base(target), ".") {
				continue
			}
			if _, err := files.ReadFile("static/" + target); err != nil {
				t.Errorf("%s references %q, which does not exist", p, target)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A url() inside a stylesheet resolves against the stylesheet's own directory,
// not the page's, so moving a CSS file silently breaks every relative asset it
// points at -- the page still renders, just with the wrong font. Nothing else
// checks this: the reference is a string inside a string.
func TestStylesheetURLsResolve(t *testing.T) {
	urlRe := regexp.MustCompile(`url\("?([^")]+)"?\)`)
	err := fs.WalkDir(files, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".css") {
			return err
		}
		b, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		dir := path.Dir(p)
		for _, m := range urlRe.FindAllStringSubmatch(string(b), -1) {
			target := m[1]
			if strings.HasPrefix(target, "data:") {
				continue // inline SVG, nothing to resolve
			}
			if i := strings.IndexByte(target, '?'); i >= 0 {
				target = target[:i] // drop the ?v= cache buster
			}
			// path.Join collapses the ../ the same way a browser does before it
			// ever reaches the server.
			if _, err := files.ReadFile(path.Join(dir, target)); err != nil {
				t.Errorf("%s references %q, which does not resolve to a file", p, m[1])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Each signed-in page must pull core.js (the shared half) and, unless it is one
// of the pre-auth pages, exactly one page script. Two would mean a page is
// carrying code it does not need, which is what the split set out to stop.
func TestEachPageLoadsCoreAndOnePageScript(t *testing.T) {
	script := regexp.MustCompile(`src="\{\{PREFIX\}\}js/([a-z]+)\.js`)
	for _, page := range append([]string{"login", "register", "setup"}, signedInPages...) {
		name := page + ".html"
		if page == "" {
			name = "index.html"
		}
		b, err := files.ReadFile("static/" + name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		var got []string
		for _, m := range script.FindAllStringSubmatch(string(b), -1) {
			got = append(got, m[1])
		}
		if len(got) == 0 || got[0] != "core" {
			t.Errorf("%s: scripts %v, want core.js first", name, got)
			continue
		}
		preAuth := page == "login" || page == "register" || page == "setup"
		if preAuth && len(got) != 1 {
			t.Errorf("%s: scripts %v, want core.js only (it renders before sign-in)", name, got)
		}
		if !preAuth && len(got) != 2 {
			t.Errorf("%s: scripts %v, want core.js plus exactly one page script", name, got)
		}
	}
}

// The pre-auth pages must not gain a nav: there is nobody to navigate as, and
// the links would all bounce off the token check.
func TestPreAuthPagesHaveNoSidebar(t *testing.T) {
	for _, page := range []string{"login", "register", "setup"} {
		body := string(Get(page, "/").Body)
		if strings.Contains(body, `<aside class="sidebar">`) {
			t.Errorf("page %q should not carry the sidebar", page)
		}
	}
}
