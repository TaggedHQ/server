package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/TaggedHQ/server/internal/webui"
)

// Translations live one file per language in <datadir>/i18n/, deliberately not
// in setup.json: that file is rewritten whole on every settings change and
// holds the database password and OAuth client secrets, so a ~110 KB catalog
// has no business in it. One file per language also means saving German never
// rewrites French.
//
// There is no index file listing the languages. The directory itself is the
// list -- a second source of truth would only drift from it.
const i18nDir = "i18n"

// langCodeRe accepts BCP-47-ish codes: "de", "pt-BR", "zh-Hans-CN". It is the
// only thing standing between a request parameter and a file path, so it is
// deliberately strict and is applied before any path join.
var langCodeRe = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)

// message is one translated string. Most are a plain string; the handful with
// a count in them carry separate singular and plural forms. English source
// text is the key, so an untranslated key falls back to correct English.
type message struct {
	One   string // singular form; also the whole translation for non-plural keys
	Other string // plural form, empty for non-plural keys
}

// MarshalJSON writes a plain string for the common case and an object only for
// plural messages, keeping exported catalogs readable for translators.
func (m message) MarshalJSON() ([]byte, error) {
	if m.Other == "" {
		return json.Marshal(m.One)
	}
	return json.Marshal(map[string]string{"one": m.One, "other": m.Other})
}

// UnmarshalJSON accepts both shapes.
func (m *message) UnmarshalJSON(raw []byte) error {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		m.One, m.Other = s, ""
		return nil
	}
	var o struct {
		One   string `json:"one"`
		Other string `json:"other"`
	}
	if err := json.Unmarshal(raw, &o); err != nil {
		return fmt.Errorf("translation must be a string or {one, other}: %w", err)
	}
	m.One, m.Other = o.One, o.Other
	return nil
}

// langCatalog is one language's file.
type langCatalog struct {
	Code    string             `json:"code"`
	Label   string             `json:"label"`   // shown in the account dropdown, in that language
	Enabled bool               `json:"enabled"` // offered to users at all
	Updated int64              `json:"updated"` // unix seconds, for the admin page
	Strings map[string]message `json:"strings"`
}

// translated counts the keys with a non-empty translation, for progress
// reporting on the admin page.
func (c *langCatalog) translated() int {
	n := 0
	for _, m := range c.Strings {
		if strings.TrimSpace(m.One) != "" {
			n++
		}
	}
	return n
}

// validateLangCode rejects anything that could escape the i18n directory or
// collide with the temp-file suffix.
func validateLangCode(code string) error {
	if code == "" {
		return errors.New("a language code is required")
	}
	if !langCodeRe.MatchString(code) {
		return fmt.Errorf("invalid language code %q: use a form like \"de\" or \"pt-BR\"", code)
	}
	if code == "en" {
		return errors.New("English is the source language and cannot be edited")
	}
	return nil
}

// loadTranslations reads every catalog in dir/i18n. A missing directory is not
// an error -- a server with no translations is the normal case.
//
// Unlike loadSetup, a single unreadable or malformed file is logged and
// skipped rather than failing startup: a bad translation must never keep the
// server from booting.
func loadTranslations(dir string) map[string]*langCatalog {
	out := map[string]*langCatalog{}
	entries, err := os.ReadDir(filepath.Join(dir, i18nDir))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("i18n: cannot read translations directory: %v", err)
		}
		return out
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		code := strings.TrimSuffix(name, ".json")
		if validateLangCode(code) != nil {
			log.Printf("i18n: skipping %s: not a valid language code", name)
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, i18nDir, name))
		if err != nil {
			log.Printf("i18n: skipping %s: %v", name, err)
			continue
		}
		var c langCatalog
		if err := json.Unmarshal(raw, &c); err != nil {
			log.Printf("i18n: skipping %s: %v", name, err)
			continue
		}
		c.Code = code // the filename wins, so a hand-edited file cannot lie about itself
		if c.Strings == nil {
			c.Strings = map[string]message{}
		}
		out[code] = &c
	}
	return out
}

// saveTranslation writes one catalog atomically (temp file + rename). 0644,
// not setup.json's 0600: translations hold no secrets.
func saveTranslation(dir string, c *langCatalog) error {
	if err := validateLangCode(c.Code); err != nil {
		return err
	}
	d := filepath.Join(dir, i18nDir)
	if err := os.MkdirAll(d, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(d, c.Code+".json.tmp")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(d, c.Code+".json"))
}

// deleteTranslation removes one catalog. A missing file is not an error.
func deleteTranslation(dir, code string) error {
	if err := validateLangCode(code); err != nil {
		return err
	}
	err := os.Remove(filepath.Join(dir, i18nDir, code+".json"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ---- server state -----------------------------------------------------------

// i18nRevOf hashes every catalog into a short revision id. It changes whenever
// any translation changes, and is what both the rendered-HTML cache and the
// client-side catalog cache key off.
//
// webui.Version cannot serve this purpose: it hashes only the embedded assets,
// so it is blind to a translation edit. Keying the client cache off it would
// mean admins edit a string and see nothing until a hard refresh.
func i18nRevOf(langs map[string]*langCatalog) string {
	codes := make([]string, 0, len(langs))
	for code := range langs {
		codes = append(codes, code)
	}
	sort.Strings(codes) // map order is random; the revision must not be
	h := sha256.New()
	for _, code := range codes {
		c := langs[code]
		fmt.Fprintf(h, "%s\x00%s\x00%t\x00", c.Code, c.Label, c.Enabled)
		keys := make([]string, 0, len(c.Strings))
		for k := range c.Strings {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			m := c.Strings[k]
			fmt.Fprintf(h, "%s\x00%s\x00%s\x00", k, m.One, m.Other)
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

// lookupLang returns the catalog for code, or nil. Only enabled catalogs are
// returned: disabling a language must actually stop it rendering.
func (s *Server) lookupLang(code string) *langCatalog {
	if code == "" || code == "en" {
		return nil
	}
	s.i18nMu.RLock()
	defer s.i18nMu.RUnlock()
	c := s.langs[code]
	if c == nil || !c.Enabled {
		return nil
	}
	return c
}

// listLangs returns every catalog, enabled or not, sorted by code. The admin
// page needs the disabled ones too.
func (s *Server) listLangs() []*langCatalog {
	s.i18nMu.RLock()
	defer s.i18nMu.RUnlock()
	out := make([]*langCatalog, 0, len(s.langs))
	for _, c := range s.langs {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	return out
}

// i18nRevision returns the current revision id.
func (s *Server) i18nRevision() string {
	s.i18nMu.RLock()
	defer s.i18nMu.RUnlock()
	return s.i18nRev
}

// putTranslation creates or updates a catalog and persists it.
//
// The file write is the commit point: it happens first, and only then does the
// in-memory map change. That is the reverse of setModuleEnabled's
// optimistic-update-and-roll-back, and it is simpler -- a failed write leaves
// nothing to undo.
func (s *Server) putTranslation(c *langCatalog) error {
	if err := validateLangCode(c.Code); err != nil {
		return err
	}
	if strings.TrimSpace(c.Label) == "" {
		return errors.New("a display name is required")
	}
	if c.Strings == nil {
		c.Strings = map[string]message{}
	}
	if err := saveTranslation(s.rootTTDir, c); err != nil {
		return err
	}
	s.i18nMu.Lock()
	s.langs[c.Code] = c
	s.i18nRev = i18nRevOf(s.langs)
	s.htmlCache = map[string][]byte{} // rendered pages are keyed by revision, but drop them anyway
	s.i18nMu.Unlock()
	return nil
}

// dropTranslation removes a language entirely.
func (s *Server) dropTranslation(code string) error {
	if err := validateLangCode(code); err != nil {
		return err
	}
	if err := deleteTranslation(s.rootTTDir, code); err != nil {
		return err
	}
	s.i18nMu.Lock()
	delete(s.langs, code)
	s.i18nRev = i18nRevOf(s.langs)
	s.htmlCache = map[string][]byte{}
	s.i18nMu.Unlock()
	return nil
}

// ---- admin API --------------------------------------------------------------

// adminGetTranslations lists the languages, or -- with ?code=xx -- returns one
// full catalog alongside the key list to translate against.
//
// That single-language payload is also what the admin page downloads as an
// export, so there is no separate export endpoint to keep in step with it.
func (s *Server) adminGetTranslations(req *request) response {
	code := req.queryGet("code")
	keys := webui.Catalog()
	if code == "" {
		type row struct {
			Code       string `json:"code"`
			Label      string `json:"label"`
			Enabled    bool   `json:"enabled"`
			Updated    int64  `json:"updated"`
			Translated int    `json:"translated"`
			Total      int    `json:"total"`
		}
		out := []row{}
		for _, c := range s.listLangs() {
			out = append(out, row{c.Code, c.Label, c.Enabled, c.Updated, c.translated(), len(keys)})
		}
		return jsonResp(200, map[string]any{"languages": out, "total": len(keys)})
	}

	if err := validateLangCode(code); err != nil {
		return textResp(400, err.Error())
	}
	s.i18nMu.RLock()
	c := s.langs[code]
	s.i18nMu.RUnlock()
	if c == nil {
		return textResp(404, "no such language: "+code)
	}
	return jsonResp(200, map[string]any{
		"code": c.Code, "label": c.Label, "enabled": c.Enabled, "updated": c.Updated,
		"keys": keys, "strings": c.Strings,
	})
}

// adminPutTranslation creates or updates one language. It is also the import
// endpoint: the payload shape is exactly what the GET above returns.
//
// By default the posted strings are merged into what is already stored, so the
// admin page can save just the keys that changed. `replace: true` swaps the
// whole map instead, which is what a file import wants. A null value deletes a
// key either way.
func (s *Server) adminPutTranslation(req *request) response {
	// A full ~900-key catalog is around 110 KB; the 256 KB used for OAuth would
	// be uncomfortably close, so allow real headroom.
	raw, err := req.getBody(2 * 1024 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Code    string              `json:"code"`
		Label   string              `json:"label"`
		Enabled *bool               `json:"enabled"`
		Replace bool                `json:"replace"`
		Strings map[string]*message `json:"strings"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with a code and strings")
	}
	if err := validateLangCode(body.Code); err != nil {
		return textResp(400, err.Error())
	}

	s.i18nMu.RLock()
	existing := s.langs[body.Code]
	s.i18nMu.RUnlock()

	next := &langCatalog{Code: body.Code, Strings: map[string]message{}}
	if existing != nil {
		next.Label, next.Enabled = existing.Label, existing.Enabled
		if !body.Replace {
			for k, v := range existing.Strings {
				next.Strings[k] = v
			}
		}
	}
	if body.Label != "" {
		next.Label = body.Label
	}
	if body.Enabled != nil {
		next.Enabled = *body.Enabled
	}
	for k, m := range body.Strings {
		if m == nil || (strings.TrimSpace(m.One) == "" && strings.TrimSpace(m.Other) == "") {
			delete(next.Strings, k) // an empty value means "untranslated", not ""
			continue
		}
		next.Strings[k] = *m
	}
	next.Updated = time.Now().Unix()

	if err := s.putTranslation(next); err != nil {
		return textResp(400, err.Error())
	}

	// Keys the UI no longer has are kept, not dropped. An English string gets
	// edited, its key changes, and the old translation would otherwise vanish
	// silently -- taking real translator work with it. They are reported instead,
	// so the admin page can show them and offer to clear them deliberately.
	known := webui.CatalogKeys()
	orphaned := []string{}
	for k := range next.Strings {
		if !known[k] {
			orphaned = append(orphaned, k)
		}
	}
	sort.Strings(orphaned)
	return jsonResp(200, map[string]any{
		"status": "ok", "code": next.Code, "translated": next.translated(),
		"total": len(known), "orphaned": orphaned, "rev": s.i18nRevision(),
	})
}

// adminDeleteTranslation removes a language and its file.
func (s *Server) adminDeleteTranslation(req *request) response {
	code := req.queryGet("code")
	if err := validateLangCode(code); err != nil {
		return textResp(400, err.Error())
	}
	if err := s.dropTranslation(code); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// ---- public endpoints -------------------------------------------------------

// languagesResponse lists the languages users may pick, for the account page.
// English is always offered: it is the source language and needs no catalog.
func (s *Server) languagesResponse() response {
	type lang struct {
		Code  string `json:"code"`
		Label string `json:"label"`
	}
	out := []lang{{"en", "English"}}
	for _, c := range s.listLangs() {
		if c.Enabled {
			out = append(out, lang{c.Code, c.Label})
		}
	}
	return jsonResp(200, map[string]any{"languages": out, "rev": s.i18nRevision()})
}

// catalogResponse serves one language's strings for the client-side runtime.
// It is unauthenticated by design so the login and setup pages can use it, and
// it carries no user data -- only the admin-authored UI text.
func (s *Server) catalogResponse(req *request, code string) response {
	c := s.lookupLang(code)
	if c == nil {
		return textResp(404, "not found")
	}
	rev := s.i18nRevision()
	// The client caches aggressively and revalidates against this, so an admin's
	// edit lands on the next navigation rather than after a hard refresh.
	if req.header("If-None-Match") == `"`+rev+`"` {
		return response{status: 304, headers: map[string]string{"ETag": `"` + rev + `"`}}
	}
	flat := make(map[string]any, len(c.Strings))
	for k, m := range c.Strings {
		if m.Other == "" {
			flat[k] = m.One
		} else {
			flat[k] = map[string]string{"one": m.One, "other": m.Other}
		}
	}
	return response{
		status: 200,
		headers: map[string]string{
			"ETag":          `"` + rev + `"`,
			"Cache-Control": "no-cache",
		},
		body: map[string]any{"code": c.Code, "rev": rev, "strings": flat},
	}
}
