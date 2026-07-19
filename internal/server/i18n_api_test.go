package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// adminReq builds a *request for an admin translations call.
func adminReq(t *testing.T, method, query, body string) *request {
	t.Helper()
	var r = httptest.NewRequest(method, "/timetagger/api/v2/admin/translations"+query, strings.NewReader(body))
	return newRequest(r)
}

// decodeBody round-trips a handler's body through JSON, which is what the
// response writer does, so tests see exactly what a client would.
func decodeBody(t *testing.T, resp response) map[string]any {
	t.Helper()
	raw, err := json.Marshal(resp.body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return out
}

// The capability gate is the whole point of putting this behind /admin.
func TestTranslationsRequiresCapability(t *testing.T) {
	s := newTestServer(t)
	req := adminReq(t, "GET", "", "")

	resp := s.adminHandler(req, "/translations", "someone", map[string]bool{capUsersManage: true})
	if resp.status != 403 {
		t.Fatalf("without the capability: status = %d, want 403", resp.status)
	}
	resp = s.adminHandler(req, "/translations", "someone", map[string]bool{capI18nManage: true})
	if resp.status != 200 {
		t.Fatalf("with the capability: status = %d, want 200 (body %s)", resp.status, resp.body)
	}
}

// A new capability that is missing from hasAnyAdminCap gets a 403 one level up,
// before adminHandler ever runs -- so an admin holding only it sees nothing.
func TestI18nCapUnlocksAdminMenu(t *testing.T) {
	if !hasAnyAdminCap(map[string]bool{capI18nManage: true}) {
		t.Fatal("capI18nManage must unlock the admin menu, or the page 403s before dispatch")
	}
}

func TestTranslationsPutGetRoundTrip(t *testing.T) {
	s := newTestServer(t)
	caps := map[string]bool{capI18nManage: true}

	put := adminReq(t, "PUT", "", `{"code":"de","label":"Deutsch","enabled":true,
		"strings":{"Tags":"Schlagworte","Account":"Konto"}}`)
	resp := s.adminHandler(put, "/translations", "admin", caps)
	if resp.status != 200 {
		t.Fatalf("PUT: status = %d, body %s", resp.status, resp.body)
	}

	// The list view.
	resp = s.adminHandler(adminReq(t, "GET", "", ""), "/translations", "admin", caps)
	got := decodeBody(t, resp)
	langs, _ := got["languages"].([]any)
	if len(langs) != 1 {
		t.Fatalf("want 1 language, got %v", got["languages"])
	}
	row, _ := langs[0].(map[string]any)
	if row["code"] != "de" || row["label"] != "Deutsch" || row["enabled"] != true {
		t.Errorf("list row wrong: %v", row)
	}

	// The single-language view, which is also the export payload.
	resp = s.adminHandler(adminReq(t, "GET", "?code=de", ""), "/translations", "admin", caps)
	if resp.status != 200 {
		t.Fatalf("GET ?code=de: status = %d, body %s", resp.status, resp.body)
	}
	got = decodeBody(t, resp)
	if got["code"] != "de" || got["label"] != "Deutsch" {
		t.Errorf("export metadata wrong: %v", got)
	}
	if _, ok := got["keys"]; !ok {
		t.Error("export should carry the key list to translate against")
	}
}

// The default PUT merges, so the admin page can save only what changed.
func TestTranslationsPutMerges(t *testing.T) {
	s := newTestServer(t)
	if err := s.putTranslation(&langCatalog{
		Code: "de", Label: "Deutsch", Enabled: true,
		Strings: map[string]message{"Tags": {One: "Schlagworte"}, "Account": {One: "Konto"}},
	}); err != nil {
		t.Fatal(err)
	}
	caps := map[string]bool{capI18nManage: true}

	// Sending one key must not wipe the other.
	resp := s.adminHandler(adminReq(t, "PUT", "", `{"code":"de","strings":{"Tags":"Tags neu"}}`),
		"/translations", "admin", caps)
	if resp.status != 200 {
		t.Fatalf("merge PUT: %d %s", resp.status, resp.body)
	}
	c := s.lookupLang("de")
	if c.Strings["Tags"].One != "Tags neu" {
		t.Errorf("updated key not applied: %+v", c.Strings["Tags"])
	}
	if c.Strings["Account"].One != "Konto" {
		t.Errorf("merge dropped an untouched key: %+v", c.Strings)
	}
	if c.Label != "Deutsch" || !c.Enabled {
		t.Errorf("merge should preserve metadata, got label=%q enabled=%v", c.Label, c.Enabled)
	}

	// An empty value means "untranslated" and removes the key, rather than
	// storing an empty string that would render as blank UI.
	resp = s.adminHandler(adminReq(t, "PUT", "", `{"code":"de","strings":{"Tags":""}}`),
		"/translations", "admin", caps)
	if resp.status != 200 {
		t.Fatalf("clear PUT: %d %s", resp.status, resp.body)
	}
	if _, still := s.lookupLang("de").Strings["Tags"]; still {
		t.Error("an empty translation should remove the key, not blank the UI")
	}

	// replace:true is what an import uses.
	resp = s.adminHandler(adminReq(t, "PUT", "", `{"code":"de","replace":true,"strings":{"Account":"Benutzerkonto"}}`),
		"/translations", "admin", caps)
	if resp.status != 200 {
		t.Fatalf("replace PUT: %d %s", resp.status, resp.body)
	}
	if n := len(s.lookupLang("de").Strings); n != 1 {
		t.Errorf("replace should swap the whole map, got %d keys", n)
	}
}

func TestTranslationsDelete(t *testing.T) {
	s := newTestServer(t)
	caps := map[string]bool{capI18nManage: true}
	if err := s.putTranslation(&langCatalog{Code: "de", Label: "Deutsch", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	resp := s.adminHandler(adminReq(t, "DELETE", "?code=de", ""), "/translations", "admin", caps)
	if resp.status != 200 {
		t.Fatalf("DELETE: %d %s", resp.status, resp.body)
	}
	if len(s.listLangs()) != 0 {
		t.Error("language survived delete")
	}
}

func TestTranslationsRejectsBadCode(t *testing.T) {
	s := newTestServer(t)
	caps := map[string]bool{capI18nManage: true}
	for _, q := range []string{"?code=../escape", "?code=", "?code=en"} {
		resp := s.adminHandler(adminReq(t, "DELETE", q, ""), "/translations", "admin", caps)
		if resp.status != 400 {
			t.Errorf("DELETE %s: status = %d, want 400", q, resp.status)
		}
	}
	resp := s.adminHandler(adminReq(t, "PUT", "", `{"code":"../x","label":"X"}`), "/translations", "admin", caps)
	if resp.status != 400 {
		t.Errorf("PUT with a traversing code: status = %d, want 400", resp.status)
	}
}

// The account dropdown reads this, so English must always be present and
// disabled languages must not leak into it.
func TestLanguagesEndpoint(t *testing.T) {
	s := newTestServer(t)

	got := decodeBody(t, s.languagesResponse())
	langs, _ := got["languages"].([]any)
	if len(langs) != 1 {
		t.Fatalf("a fresh server should offer only English, got %v", langs)
	}

	if err := s.putTranslation(&langCatalog{Code: "de", Label: "Deutsch", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.putTranslation(&langCatalog{Code: "fr", Label: "Français", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	got = decodeBody(t, s.languagesResponse())
	langs, _ = got["languages"].([]any)
	if len(langs) != 2 {
		t.Fatalf("want English + the enabled German, got %v", langs)
	}
	for _, l := range langs {
		if m, _ := l.(map[string]any); m["code"] == "fr" {
			t.Error("a disabled language must not be offered to users")
		}
	}
}

func TestCatalogResponseAndETag(t *testing.T) {
	s := newTestServer(t)
	if err := s.putTranslation(&langCatalog{
		Code: "de", Label: "Deutsch", Enabled: true,
		Strings: map[string]message{"Tags": {One: "Schlagworte"}, "{n} entry": {One: "{n} Eintrag", Other: "{n} Einträge"}},
	}); err != nil {
		t.Fatal(err)
	}

	req := newRequest(httptest.NewRequest("GET", "/timetagger/api/v2/i18n/de.json", nil))
	resp := s.catalogResponse(req, "de")
	if resp.status != 200 {
		t.Fatalf("status = %d", resp.status)
	}
	etag := resp.headers["ETag"]
	if etag == "" {
		t.Fatal("catalog must carry an ETag so edits land without a hard refresh")
	}
	got := decodeBody(t, resp)
	strs, _ := got["strings"].(map[string]any)
	if strs["Tags"] != "Schlagworte" {
		t.Errorf("plain string wrong: %v", strs["Tags"])
	}
	if pl, _ := strs["{n} entry"].(map[string]any); pl["other"] != "{n} Einträge" {
		t.Errorf("plural forms wrong: %v", strs["{n} entry"])
	}

	// Revalidation.
	req2 := httptest.NewRequest("GET", "/timetagger/api/v2/i18n/de.json", nil)
	req2.Header.Set("If-None-Match", etag)
	if resp := s.catalogResponse(newRequest(req2), "de"); resp.status != 304 {
		t.Errorf("matching ETag: status = %d, want 304", resp.status)
	}

	// A disabled language must stop serving.
	if err := s.putTranslation(&langCatalog{Code: "de", Label: "Deutsch", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if resp := s.catalogResponse(req, "de"); resp.status != 404 {
		t.Errorf("disabled language: status = %d, want 404", resp.status)
	}
	if resp := s.catalogResponse(req, "nope"); resp.status != 404 {
		t.Errorf("unknown language: status = %d, want 404", resp.status)
	}
}
