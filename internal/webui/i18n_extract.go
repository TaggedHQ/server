package webui

import (
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
)

// The extractor builds the catalog of translatable strings from the source
// itself, so the Translations page always offers exactly the strings the UI
// currently has. It runs over the embedded FS, which means the drift-guard test
// can re-run it in memory and compare against the committed en.json -- go:generate
// alone would not stop the catalog going stale, because nothing forces a
// developer to run it.
//
// Two sources, both parser-free (golang.org/x/net/html is deliberately not a
// dependency):
//
//   - HTML: data-i18n="<English>" attributes, with the same English left in the
//     element as the fallback. A test asserts the two copies agree.
//   - JS: t("...") and tn("...", n) call sites. Extracting from call sites rather
//     than from string literals in general is what keeps design fixtures
//     (SAMPLE_GROUPS, SAMPLE_SKILLS) and technical tables (IE_HEADER_ALIASES) out
//     of the catalog automatically.

var (
	// data-i18n="..." and its attribute variants (data-i18n-placeholder, -title,
	// -aria-label, -alt). Values are single- or double-quoted.
	reHTMLKey = regexp.MustCompile(`data-i18n(?:-[a-z-]+)?\s*=\s*"([^"]*)"|data-i18n(?:-[a-z-]+)?\s*=\s*'([^']*)'`)
	// t("...") / t('...') / tn("...") -- a literal first argument only.
	reJSKey  = regexp.MustCompile(`\bt\(\s*"((?:[^"\\]|\\.)*)"|\bt\(\s*'((?:[^'\\]|\\.)*)'`)
	reJSNKey = regexp.MustCompile(`\btn\(\s*"((?:[^"\\]|\\.)*)"|\btn\(\s*'((?:[^'\\]|\\.)*)'`)
	// A t( whose first argument is not a string literal cannot be extracted, so
	// it would silently never be translatable.
	reDynamicT = regexp.MustCompile(`\bt\(\s*[^"')\s]`)
	// The one legitimate exception: labels and descriptions the server sends
	// (module metadata, the capability catalog, role definitions). Their English
	// is declared in i18nServerStrings so the extractor still catalogs it, and
	// an operator's own role name simply falls through untranslated -- which is
	// the wanted behaviour, since it is their data, not our copy.
	//
	// This is matched by shape rather than by a trailing comment because these
	// call sites sit inside template literals, where a // comment would be
	// rendered to the page instead of ignored.
	reServerLabel = regexp.MustCompile(`\bt\(\s*\w+\.(label|desc)\s*\)`)
	// A local named `t` shadows the translation function. Any t("...") inside
	// that scope then calls a string or a DOM node instead of translating, and
	// it fails silently -- so the name is reserved outright.
	reShadowT = regexp.MustCompile(`\b(?:const|let|var)\s+t\s*=|\.forEach\(\s*\(?\s*t\s*\)?\s*=>|function\s*\(\s*t\s*\)`)
)

// NormalizeKey collapses a source string to its canonical catalog form.
//
// This is the single most fragile part of the whole scheme: the extractor and
// the runtime must agree exactly, or a routine HTML reformat silently orphans a
// page's translations. Both call this.
func NormalizeKey(s string) string {
	s = htmlUnescape(s)
	return strings.Join(strings.Fields(s), " ")
}

// htmlUnescape decodes the handful of entities the templates actually use. The
// full entity table is not needed and importing html would drag in more than we
// want for five cases.
func htmlUnescape(s string) string {
	if !strings.Contains(s, "&") {
		return s
	}
	r := strings.NewReplacer(
		"&nbsp;", " ",
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
	)
	return r.Replace(s)
}

// ctxForFile names the group a key belongs to, shown as a section in the
// Translations page. Without it the admin faces ~900 undifferentiated rows.
func ctxForFile(path string) string {
	name := strings.TrimSuffix(strings.TrimPrefix(path, "static/"), ".html")
	switch name {
	case "index":
		return "dashboard"
	case "impexp":
		return "import-export"
	case "app.js":
		return "app"
	}
	if strings.HasSuffix(name, ".js") {
		return "app"
	}
	switch name {
	case "users", "roles", "groups", "settings", "oauth", "translations":
		return "admin·" + name
	}
	return name
}

// ExtractCatalog walks the embedded assets and returns the catalog, sorted by
// key so the generated file has a stable order.
func ExtractCatalog() ([]CatalogEntry, error) {
	type found struct {
		ctx    string
		plural bool
	}
	keys := map[string]*found{}

	note := func(key, ctx string, plural bool) {
		key = NormalizeKey(key)
		if key == "" {
			return
		}
		if e, ok := keys[key]; ok {
			// A string used on several pages gets the generic context rather than
			// arbitrarily belonging to whichever file was walked first.
			if e.ctx != ctx {
				e.ctx = "common"
			}
			e.plural = e.plural || plural
			return
		}
		keys[key] = &found{ctx: ctx, plural: plural}
	}

	err := fs.WalkDir(files, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		isHTML := strings.HasSuffix(p, ".html")
		isJS := strings.HasSuffix(p, ".js")
		if !isHTML && !isJS {
			return nil
		}
		raw, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		body := string(raw)
		ctx := ctxForFile(p)

		if isHTML {
			for _, m := range reHTMLKey.FindAllStringSubmatch(body, -1) {
				note(firstNonEmpty(m[1], m[2]), ctx, false)
			}
			return nil
		}
		for _, m := range reJSKey.FindAllStringSubmatch(body, -1) {
			note(unquoteJS(firstNonEmpty(m[1], m[2])), ctx, false)
		}
		for _, m := range reJSNKey.FindAllStringSubmatch(body, -1) {
			note(unquoteJS(firstNonEmpty(m[1], m[2])), ctx, true)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	out := make([]CatalogEntry, 0, len(keys))
	for k, f := range keys {
		out = append(out, CatalogEntry{Key: k, Ctx: f.ctx, Plural: f.plural})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Ctx != out[j].Ctx {
			return out[i].Ctx < out[j].Ctx
		}
		return out[i].Key < out[j].Key
	})
	return out, nil
}

// unquoteJS undoes the escaping inside a JS string literal.
func unquoteJS(s string) string {
	r := strings.NewReplacer(`\"`, `"`, `\'`, `'`, `\\`, `\`, `\n`, "\n", `\t`, "\t")
	return r.Replace(s)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---- consistency checks used by the drift-guard tests -----------------------

// reI18nElement matches an element carrying data-i18n, capturing the attribute
// value and the element's inner text, so the two can be compared.
var reI18nElement = regexp.MustCompile(`<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-i18n\s*=\s*"([^"]*)"[^>]*>([^<]*)</`)

// MarkupMismatches reports elements whose data-i18n value disagrees with their
// own text. The redundancy is what lets the extractor and the server-side
// rewriter work without an HTML parser, so it has to be enforced.
func MarkupMismatches() ([]string, error) {
	var bad []string
	err := fs.WalkDir(files, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".html") {
			return err
		}
		raw, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		for _, m := range reI18nElement.FindAllStringSubmatch(string(raw), -1) {
			key, text := NormalizeKey(m[2]), NormalizeKey(m[3])
			if key != text {
				bad = append(bad, fmt.Sprintf("%s: <%s data-i18n=%q> but its text is %q", p, m[1], key, text))
			}
		}
		return nil
	})
	return bad, err
}

// ShadowedT reports declarations that bind the name `t` locally, shadowing the
// translation function. This is not style policing: a t("...") inside such a
// scope calls whatever `t` happens to be there, and fails quietly.
func ShadowedT() ([]string, error) {
	var bad []string
	err := fs.WalkDir(files, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".js") {
			return err
		}
		raw, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(raw), "\n") {
			if reShadowT.MatchString(line) && !strings.Contains(line, "i18n-dynamic") {
				bad = append(bad, fmt.Sprintf("%s:%d: %s", p, i+1, strings.TrimSpace(line)))
			}
		}
		return nil
	})
	return bad, err
}

// DynamicTCalls reports t( call sites whose first argument is not a literal.
// Those can never be extracted, so they would silently stay English forever.
func DynamicTCalls() ([]string, error) {
	var bad []string
	err := fs.WalkDir(files, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".js") {
			return err
		}
		raw, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(raw), "\n") {
			if !reDynamicT.MatchString(line) {
				continue
			}
			// The runtime's own plumbing looks up keys that the extractor has
			// already found elsewhere (from data-i18n attributes), so it is
			// legitimately dynamic. It says so explicitly rather than the check
			// quietly allowing a shape that would also hide real mistakes.
			if strings.Contains(line, "i18n-dynamic") {
				continue
			}
			if strings.Contains(line, "function t(") || strings.Contains(line, "function tn(") {
				continue
			}
			// Server-sent labels are the one sanctioned dynamic form.
			if reServerLabel.MatchString(line) && !reDynamicT.MatchString(reServerLabel.ReplaceAllString(line, "")) {
				continue
			}
			bad = append(bad, fmt.Sprintf("%s:%d: %s", p, i+1, strings.TrimSpace(line)))
		}
		return nil
	})
	return bad, err
}
