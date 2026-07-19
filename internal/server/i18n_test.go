package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateLangCode(t *testing.T) {
	ok := []string{"de", "fr", "nld", "pt-BR", "zh-Hans-CN"}
	for _, c := range ok {
		if err := validateLangCode(c); err != nil {
			t.Errorf("validateLangCode(%q) = %v, want nil", c, err)
		}
	}
	// Path traversal is the reason this function exists: the code becomes a
	// filename, so anything that could escape the i18n directory must be
	// rejected before the join, not after.
	bad := []string{
		"", "en", "..", "../../etc/passwd", "de/../../x", "de.json",
		"DE", "d", "toolongsubtag-x", "de_DE", "de ", " de", "de-",
	}
	for _, c := range bad {
		if err := validateLangCode(c); err == nil {
			t.Errorf("validateLangCode(%q) = nil, want an error", c)
		}
	}
}

func TestTranslationRoundTrip(t *testing.T) {
	dir := t.TempDir()
	in := &langCatalog{
		Code: "de", Label: "Deutsch", Enabled: true, Updated: 1700000000,
		Strings: map[string]message{
			"Time entries": {One: "Zeiteinträge"},
			"{n} entry":    {One: "{n} Eintrag", Other: "{n} Einträge"},
			"Untranslated": {One: ""},
		},
	}
	if err := saveTranslation(dir, in); err != nil {
		t.Fatalf("saveTranslation: %v", err)
	}

	got := loadTranslations(dir)
	c := got["de"]
	if c == nil {
		t.Fatal("de catalog missing after save")
	}
	if c.Label != "Deutsch" || !c.Enabled || c.Updated != 1700000000 {
		t.Errorf("metadata not round-tripped: %+v", c)
	}
	if c.Strings["Time entries"].One != "Zeiteinträge" {
		t.Errorf("plain string not round-tripped: %+v", c.Strings["Time entries"])
	}
	if m := c.Strings["{n} entry"]; m.One != "{n} Eintrag" || m.Other != "{n} Einträge" {
		t.Errorf("plural forms not round-tripped: %+v", m)
	}
	if n := c.translated(); n != 2 {
		t.Errorf("translated() = %d, want 2 (the empty one does not count)", n)
	}
}

// A plain string must serialize as a JSON string, not an object, so exported
// catalogs stay readable for whoever has to translate them.
func TestMessageMarshalsCompactly(t *testing.T) {
	raw, err := json.Marshal(map[string]message{
		"plain":  {One: "einfach"},
		"plural": {One: "ein", Other: "viele"},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	if !strings.Contains(s, `"plain":"einfach"`) {
		t.Errorf("plain message should marshal as a string, got %s", s)
	}
	if !strings.Contains(s, `"one":"ein"`) || !strings.Contains(s, `"other":"viele"`) {
		t.Errorf("plural message should marshal as an object, got %s", s)
	}
}

// A corrupt or unreadable catalog must be skipped, never fatal: the server has
// to boot even if someone hand-edits a translation file into nonsense.
func TestLoadTranslationsSkipsBadFiles(t *testing.T) {
	dir := t.TempDir()
	d := filepath.Join(dir, i18nDir)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(d, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("de.json", `{"code":"de","label":"Deutsch","enabled":true,"strings":{"Tags":"Schlagworte"}}`)
	write("fr.json", `{ this is not json`)
	write("notalang.json", `{"code":"x","label":"X"}`)
	write("README.txt", `ignore me`)

	got := loadTranslations(dir)
	if len(got) != 1 || got["de"] == nil {
		t.Fatalf("want only the valid de catalog, got %d entries", len(got))
	}
	if got["de"].Strings["Tags"].One != "Schlagworte" {
		t.Errorf("de catalog not loaded correctly: %+v", got["de"].Strings)
	}
}

func TestLoadTranslationsMissingDir(t *testing.T) {
	got := loadTranslations(t.TempDir())
	if len(got) != 0 {
		t.Fatalf("want empty map for a server with no translations, got %d", len(got))
	}
}

// The filename is authoritative, so a hand-edited file cannot claim to be a
// language it is not (which would otherwise let "de.json" shadow "fr").
func TestLoadTranslationsFilenameWins(t *testing.T) {
	dir := t.TempDir()
	d := filepath.Join(dir, i18nDir)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(d, "de.json"),
		[]byte(`{"code":"zz","label":"Deutsch","enabled":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got := loadTranslations(dir)
	if got["de"] == nil || got["de"].Code != "de" {
		t.Fatalf("filename should win over the code field, got %+v", got)
	}
}

// The write must be atomic and leave no temp file behind.
func TestSaveTranslationIsAtomic(t *testing.T) {
	dir := t.TempDir()
	c := &langCatalog{Code: "de", Label: "Deutsch", Strings: map[string]message{"a": {One: "b"}}}
	if err := saveTranslation(dir, c); err != nil {
		t.Fatalf("saveTranslation: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, i18nDir))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp file %s left behind", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("want exactly one file, got %d", len(entries))
	}
}

func TestSaveTranslationRejectsBadCode(t *testing.T) {
	dir := t.TempDir()
	c := &langCatalog{Code: "../escape", Label: "Nope"}
	if err := saveTranslation(dir, c); err == nil {
		t.Fatal("saveTranslation should reject a traversing code")
	}
	if _, err := os.Stat(filepath.Join(dir, "escape.json")); err == nil {
		t.Fatal("a file escaped the i18n directory")
	}
}

// The revision must change when anything changes and be stable otherwise --
// it is the cache key for both rendered HTML and the client-side catalog.
func TestI18nRevChangesWithContent(t *testing.T) {
	base := map[string]*langCatalog{
		"de": {Code: "de", Label: "Deutsch", Enabled: true, Strings: map[string]message{"a": {One: "A"}, "b": {One: "B"}}},
	}
	rev := i18nRevOf(base)

	// Stable across repeated calls despite Go's randomised map iteration.
	for i := 0; i < 20; i++ {
		if got := i18nRevOf(base); got != rev {
			t.Fatalf("revision is not stable: %s vs %s", got, rev)
		}
	}

	cases := map[string]func(m map[string]*langCatalog){
		"changed value":  func(m map[string]*langCatalog) { m["de"].Strings["a"] = message{One: "different"} },
		"added key":      func(m map[string]*langCatalog) { m["de"].Strings["c"] = message{One: "C"} },
		"changed label":  func(m map[string]*langCatalog) { m["de"].Label = "German" },
		"toggled enable": func(m map[string]*langCatalog) { m["de"].Enabled = false },
		"added language": func(m map[string]*langCatalog) { m["fr"] = &langCatalog{Code: "fr", Label: "Français"} },
	}
	for name, mutate := range cases {
		m := map[string]*langCatalog{
			"de": {Code: "de", Label: "Deutsch", Enabled: true, Strings: map[string]message{"a": {One: "A"}, "b": {One: "B"}}},
		}
		mutate(m)
		if got := i18nRevOf(m); got == rev {
			t.Errorf("%s: revision did not change", name)
		}
	}
}

func TestPutAndDropTranslation(t *testing.T) {
	s := newTestServer(t)

	if err := s.putTranslation(&langCatalog{
		Code: "de", Label: "Deutsch", Enabled: true,
		Strings: map[string]message{"Tags": {One: "Schlagworte"}},
	}); err != nil {
		t.Fatalf("putTranslation: %v", err)
	}
	rev := s.i18nRevision()
	if rev == "" {
		t.Fatal("revision should be set after a put")
	}
	if c := s.lookupLang("de"); c == nil || c.Strings["Tags"].One != "Schlagworte" {
		t.Fatalf("lookupLang(de) = %+v", c)
	}

	// It must survive a restart, i.e. actually be on disk.
	reloaded := loadTranslations(s.rootTTDir)
	if reloaded["de"] == nil {
		t.Fatal("catalog was not persisted")
	}

	// A disabled language must stop rendering even though it still exists.
	if err := s.putTranslation(&langCatalog{Code: "de", Label: "Deutsch", Enabled: false}); err != nil {
		t.Fatalf("putTranslation (disable): %v", err)
	}
	if c := s.lookupLang("de"); c != nil {
		t.Error("lookupLang should ignore a disabled language")
	}
	if len(s.listLangs()) != 1 {
		t.Error("listLangs should still include the disabled language for the admin page")
	}
	if s.i18nRevision() == rev {
		t.Error("revision should change when a language is disabled")
	}

	if err := s.dropTranslation("de"); err != nil {
		t.Fatalf("dropTranslation: %v", err)
	}
	if len(s.listLangs()) != 0 {
		t.Error("language still listed after delete")
	}
	if loadTranslations(s.rootTTDir)["de"] != nil {
		t.Error("file still on disk after delete")
	}
}

func TestPutTranslationValidates(t *testing.T) {
	s := newTestServer(t)
	if err := s.putTranslation(&langCatalog{Code: "de", Label: "  "}); err == nil {
		t.Error("a blank display name should be rejected")
	}
	if err := s.putTranslation(&langCatalog{Code: "en", Label: "English"}); err == nil {
		t.Error("English is the source language and should be rejected")
	}
}

// A fresh server has no translations and must behave exactly as before.
func TestNoTranslationsByDefault(t *testing.T) {
	s := newTestServer(t)
	if len(s.listLangs()) != 0 {
		t.Error("a fresh server should have no languages")
	}
	if s.lookupLang("de") != nil {
		t.Error("lookupLang should return nil for an unknown language")
	}
	if s.lookupLang("en") != nil {
		t.Error("English is the source language, never a catalog")
	}
}
