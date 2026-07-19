package server

import (
	"html"
	"regexp"
	"strings"

	"github.com/TaggedHQ/server/internal/webui"
)

// Server-side translation of the static HTML.
//
// The alternative -- translating in the browser after load -- means every page
// paints in English first and then flips, on every navigation. Doing it here
// means the bytes leave the server already translated.
//
// It works without an HTML parser (golang.org/x/net/html is deliberately not a
// dependency) because the markup carries the English twice: once in
// data-i18n="..." as the key, once as the element's own text as the fallback.
// A test asserts the two never drift apart, which is what makes the naive
// regex rewrite safe here where it would not be in general.

var (
	// An opening tag carrying plain data-i18n, plus the text run after it.
	// `data-i18n\s*=` cannot match `data-i18n-placeholder=`, so the attribute
	// variants below are left alone by this one.
	reI18nText = regexp.MustCompile(`(<[a-zA-Z][^<>]*\bdata-i18n\s*=\s*"([^"]*)"[^<>]*>)([^<]*)`)
	// The attribute variants: data-i18n-placeholder, -title, -aria-label, -alt.
	reI18nAttrTag = regexp.MustCompile(`<[a-zA-Z][^<>]*\bdata-i18n-[a-z-]+\s*=\s*"[^"]*"[^<>]*>`)
	reI18nAttr    = regexp.MustCompile(`\bdata-i18n-([a-z-]+)\s*=\s*"([^"]*)"`)
)

// translateHTML rewrites every marked string in body into the given language.
// Values are escaped unconditionally: they are admin-authored text going into
// markup, and while the CSP already blocks inline script, defence in depth is
// cheap here.
func translateHTML(body []byte, c *langCatalog) []byte {
	lookup := func(key string) (string, bool) {
		m, ok := c.Strings[webui.NormalizeKey(key)]
		if !ok {
			return "", false
		}
		v := strings.TrimSpace(m.One)
		if v == "" {
			return "", false // untranslated: leave the English in place
		}
		return v, true
	}

	out := reI18nText.ReplaceAllStringFunc(string(body), func(match string) string {
		g := reI18nText.FindStringSubmatch(match)
		tag, key, text := g[1], g[2], g[3]
		v, ok := lookup(key)
		if !ok {
			return match
		}
		// Keep the original leading/trailing whitespace so the markup's own
		// indentation survives; only the words themselves change.
		lead := text[:len(text)-len(strings.TrimLeft(text, " \t\r\n"))]
		trail := text[len(strings.TrimRight(text, " \t\r\n")):]
		return tag + lead + html.EscapeString(v) + trail
	})

	out = reI18nAttrTag.ReplaceAllStringFunc(out, func(tag string) string {
		for _, m := range reI18nAttr.FindAllStringSubmatch(tag, -1) {
			attr, key := m[1], m[2]
			v, ok := lookup(key)
			if !ok {
				continue
			}
			// Replace the value of the twin attribute (placeholder, title, ...)
			// in this same tag. The English value is the key, so the pair is
			// unambiguous even when a tag carries several.
			old := attr + `="` + key + `"`
			if !strings.Contains(tag, old) {
				continue
			}
			tag = strings.Replace(tag, old, attr+`="`+html.EscapeString(v)+`"`, 1)
		}
		return tag
	})
	return []byte(out)
}

// langCookie is where the browser remembers the chosen language. It is written
// by the client after the per-user setting loads, and read here to decide what
// to render.
//
// The synced setting is the source of truth for the cookie; the cookie is the
// source of truth for rendering. It has to be that way round: page loads carry
// no auth token (it lives in localStorage and only rides API calls), so at
// render time the cookie is the only thing the server knows about the viewer.
const langCookie = "tt_lang"

// requestLang returns the language code the browser asked for, or "".
func requestLang(req *request) string {
	ck, err := req.r.Cookie(langCookie)
	if err != nil || ck == nil {
		return ""
	}
	if validateLangCode(ck.Value) != nil {
		return ""
	}
	return ck.Value
}

// renderPage returns the page translated for the given language, memoising the
// result. Without the cache every request would re-run the rewrite; with it a
// repeat view is a map lookup under a read lock.
//
// The key includes the revision, so an admin's edit invalidates it implicitly
// and a stale entry can never be served.
func (s *Server) renderPage(page, lang string, body []byte) []byte {
	c := s.lookupLang(lang)
	if c == nil {
		return body // no such language, or English: serve the source bytes
	}
	rev := s.i18nRevision()
	key := page + "\x00" + lang + "\x00" + rev

	s.i18nMu.RLock()
	cached, ok := s.htmlCache[key]
	s.i18nMu.RUnlock()
	if ok {
		return cached
	}

	rendered := translateHTML(body, c)
	s.i18nMu.Lock()
	// Bound the cache so a scripted sweep of language codes cannot grow it
	// without limit; pages are cheap to re-render.
	if len(s.htmlCache) > 256 {
		s.htmlCache = map[string][]byte{}
	}
	s.htmlCache[key] = rendered
	s.i18nMu.Unlock()
	return rendered
}
