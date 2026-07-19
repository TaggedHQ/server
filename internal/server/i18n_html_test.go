package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/TaggedHQ/server/internal/webui"
)

// The most important test in the feature: a server with no translations, or a
// visitor with no cookie, must receive exactly the bytes it would have before
// any of this existed. That is what makes the retrofit safe to ship.
func TestUntranslatedOutputIsUnchanged(t *testing.T) {
	s := newTestServer(t)
	// A configured language must not change anything for a visitor who has not
	// asked for it.
	if err := s.putTranslation(&langCatalog{
		Code: "de", Label: "Deutsch", Enabled: true,
		Strings: map[string]message{"Dashboard": {One: "Übersicht"}, "Tags": {One: "Schlagworte"}},
	}); err != nil {
		t.Fatal(err)
	}

	for _, page := range []string{"", "entries", "account", "settings", "login", "users"} {
		want := webui.Get(page, s.cfg.PathPrefix)
		if !want.Found {
			t.Fatalf("page %q not found", page)
		}
		r := httptest.NewRequest("GET", "/timetagger/"+page, nil)
		got := s.webUI(r, page)
		body, _ := got.body.([]byte)
		if string(body) != string(want.Body) {
			t.Errorf("page %q changed without a language cookie", page)
		}
	}
}

func TestTranslatedPageUsesCookie(t *testing.T) {
	s := newTestServer(t)
	if err := s.putTranslation(&langCatalog{
		Code: "de", Label: "Deutsch", Enabled: true,
		Strings: map[string]message{
			"Dashboard": {One: "Übersicht"},
			"Log out":   {One: "Abmelden"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest("GET", "/timetagger/", nil)
	r.AddCookie(&http.Cookie{Name: langCookie, Value: "de"})
	resp := s.webUI(r, "")
	body, _ := resp.body.([]byte)
	got := string(body)

	if !strings.Contains(got, `<span data-i18n="Dashboard">Übersicht</span>`) {
		t.Error("element text was not translated")
	}
	if !strings.Contains(got, `title="Abmelden"`) {
		t.Error("title attribute was not translated")
	}
	if !strings.Contains(got, `data-i18n-title="Log out"`) {
		t.Error("the data-i18n-title key must survive, so the client can re-translate")
	}
	// An untranslated key keeps its English.
	if !strings.Contains(got, `<span data-i18n="Tags">Tags</span>`) {
		t.Error("an untranslated key should keep its English text")
	}
	if resp.headers["Vary"] != "Cookie" {
		t.Errorf("Vary = %q, want Cookie -- a proxy could otherwise cross users' languages", resp.headers["Vary"])
	}
}

// A disabled or unknown language must fall back to English rather than 500 or
// render half-translated.
func TestTranslatedPageIgnoresUnknownLanguage(t *testing.T) {
	s := newTestServer(t)
	if err := s.putTranslation(&langCatalog{
		Code: "de", Label: "Deutsch", Enabled: false,
		Strings: map[string]message{"Dashboard": {One: "Übersicht"}},
	}); err != nil {
		t.Fatal(err)
	}
	plain := webui.Get("", s.cfg.PathPrefix)

	for _, code := range []string{"de", "zz", "../etc/passwd", ""} {
		r := httptest.NewRequest("GET", "/timetagger/", nil)
		if code != "" {
			r.AddCookie(&http.Cookie{Name: langCookie, Value: code})
		}
		body, _ := s.webUI(r, "").body.([]byte)
		if string(body) != string(plain.Body) {
			t.Errorf("cookie %q should have fallen back to English", code)
		}
	}
}

// Translations are admin-authored text spliced into markup. The CSP blocks
// inline script, but the escaping is what actually keeps it inert.
func TestTranslationsAreEscaped(t *testing.T) {
	s := newTestServer(t)
	if err := s.putTranslation(&langCatalog{
		Code: "de", Label: "Deutsch", Enabled: true,
		Strings: map[string]message{
			"Dashboard": {One: `<script>alert(1)</script>`},
			"Log out":   {One: `" onmouseover="alert(1)`},
		},
	}); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/timetagger/", nil)
	r.AddCookie(&http.Cookie{Name: langCookie, Value: "de"})
	body, _ := s.webUI(r, "").body.([]byte)
	got := string(body)

	if strings.Contains(got, "<script>alert(1)</script>") {
		t.Error("a translation injected raw markup into the page")
	}
	if !strings.Contains(got, "&lt;script&gt;") {
		t.Error("expected the injected markup to be escaped")
	}
	if strings.Contains(got, `onmouseover="alert(1)`) {
		t.Error("a translation broke out of an attribute value")
	}
}

// Repeat views must come from the cache, and an edit must invalidate it --
// otherwise admins change a string and see nothing.
func TestRenderedPageCacheInvalidatesOnEdit(t *testing.T) {
	s := newTestServer(t)
	put := func(v string) {
		if err := s.putTranslation(&langCatalog{
			Code: "de", Label: "Deutsch", Enabled: true,
			Strings: map[string]message{"Dashboard": {One: v}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	get := func() string {
		r := httptest.NewRequest("GET", "/timetagger/", nil)
		r.AddCookie(&http.Cookie{Name: langCookie, Value: "de"})
		body, _ := s.webUI(r, "").body.([]byte)
		return string(body)
	}

	put("Übersicht")
	first := get()
	if !strings.Contains(first, "Übersicht") {
		t.Fatal("first render missing the translation")
	}
	if second := get(); second != first {
		t.Error("cached render differs from the first")
	}
	put("Startseite")
	if third := get(); !strings.Contains(third, "Startseite") || strings.Contains(third, "Übersicht") {
		t.Error("an edited translation did not invalidate the rendered-page cache")
	}
}

func TestTranslateHTMLPreservesStructure(t *testing.T) {
	c := &langCatalog{Strings: map[string]message{
		"Save":   {One: "Speichern"},
		"Search": {One: "Suchen"},
	}}
	in := `<button data-i18n="Save">Save</button>` +
		`<input placeholder="Search" data-i18n-placeholder="Search">` +
		`<span data-i18n="Untouched">Untouched</span>`
	got := string(translateHTML([]byte(in), c))

	for _, want := range []string{
		`<button data-i18n="Save">Speichern</button>`,
		`placeholder="Suchen"`,
		`<span data-i18n="Untouched">Untouched</span>`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
}

// Whitespace and entities are where extractor and runtime most easily drift.
func TestTranslateHTMLNormalisesKeys(t *testing.T) {
	c := &langCatalog{Strings: map[string]message{
		"Region & language": {One: "Region und Sprache"},
		"Time entries":      {One: "Zeiteinträge"},
	}}
	// Entity in the source, and text wrapped across lines with indentation.
	in := "<h3 data-i18n=\"Region &amp; language\">Region &amp; language</h3>" +
		"<span data-i18n=\"Time entries\">\n      Time entries\n    </span>"
	got := string(translateHTML([]byte(in), c))

	if !strings.Contains(got, "Region und Sprache") {
		t.Errorf("entity-bearing key was not matched: %q", got)
	}
	if !strings.Contains(got, "Zeiteinträge") {
		t.Errorf("key with wrapped whitespace was not matched: %q", got)
	}
	// The surrounding indentation should survive so the markup stays readable.
	if !strings.Contains(got, "\n      Zeiteinträge\n    ") {
		t.Errorf("indentation was not preserved: %q", got)
	}
}
