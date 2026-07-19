package webui

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// TestCatalogIsCurrent is the guard that actually stops the catalog drifting.
// go:generate does not, because nothing forces a developer to run it -- but a
// failing test does.
func TestCatalogIsCurrent(t *testing.T) {
	extracted, err := ExtractCatalog()
	if err != nil {
		t.Fatalf("ExtractCatalog: %v", err)
	}
	raw, err := files.ReadFile(catalogFile)
	if err != nil {
		t.Fatalf("read %s: %v", catalogFile, err)
	}
	var committed []CatalogEntry
	if err := json.Unmarshal(raw, &committed); err != nil {
		t.Fatalf("parse %s: %v", catalogFile, err)
	}
	if reflect.DeepEqual(extracted, committed) {
		return
	}

	// Report the difference precisely -- "they differ" is useless at 900 keys.
	inCommitted := map[string]CatalogEntry{}
	for _, e := range committed {
		inCommitted[e.Key] = e
	}
	inExtracted := map[string]CatalogEntry{}
	for _, e := range extracted {
		inExtracted[e.Key] = e
	}
	var added, removed, changed []string
	for k, e := range inExtracted {
		c, ok := inCommitted[k]
		switch {
		case !ok:
			added = append(added, k)
		case c != e:
			changed = append(changed, k)
		}
	}
	for k := range inCommitted {
		if _, ok := inExtracted[k]; !ok {
			removed = append(removed, k)
		}
	}
	t.Errorf("%s is out of date: %d added, %d removed, %d changed.\n"+
		"Run: go generate ./internal/webui/\nadded: %s\nremoved: %s\nchanged: %s",
		catalogFile, len(added), len(removed), len(changed),
		sample(added), sample(removed), sample(changed))
}

func sample(v []string) string {
	if len(v) == 0 {
		return "(none)"
	}
	if len(v) > 8 {
		v = append(v[:8:8], "…")
	}
	return strings.Join(v, ", ")
}

// The whole parser-free design rests on data-i18n duplicating the element's own
// text. If they drift apart, the server renders one string and the extractor
// catalogs another.
func TestMarkupMatchesKeys(t *testing.T) {
	bad, err := MarkupMismatches()
	if err != nil {
		t.Fatalf("MarkupMismatches: %v", err)
	}
	for _, b := range bad {
		t.Errorf("%s", b)
	}
}

// A local named `t` shadows the translation function, so any t("...") in that
// scope silently calls something else. Reserve the name.
func TestNoShadowedT(t *testing.T) {
	bad, err := ShadowedT()
	if err != nil {
		t.Fatalf("ShadowedT: %v", err)
	}
	for _, b := range bad {
		t.Errorf("`t` is the translation function and must not be shadowed: %s", b)
	}
}

// A t() whose argument is computed can never be extracted, so it would look
// translatable while silently never being translated.
func TestNoDynamicT(t *testing.T) {
	bad, err := DynamicTCalls()
	if err != nil {
		t.Fatalf("DynamicTCalls: %v", err)
	}
	for _, b := range bad {
		t.Errorf("t() needs a literal first argument so it can be extracted: %s", b)
	}
}

// Extractor and runtime must normalise identically, or an HTML reformat
// silently orphans translations.
func TestNormalizeKey(t *testing.T) {
	cases := map[string]string{
		"Region &amp; language": "Region & language",
		"  Time   entries  ":    "Time entries",
		"Log\n            out":  "Log out",
		"a&nbsp;b":              "a b",
		"&lt;tag&gt;":           "<tag>",
		"":                      "",
		"already normal":        "already normal",
		"Tabs\tand\nnewlines":   "Tabs and newlines",
	}
	for in, want := range cases {
		if got := NormalizeKey(in); got != want {
			t.Errorf("NormalizeKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractorFindsBothSources(t *testing.T) {
	entries, err := ExtractCatalog()
	if err != nil {
		t.Fatalf("ExtractCatalog: %v", err)
	}
	// Nothing to assert about specific keys until the markup lands; what must
	// hold from the start is that the output is well-formed and stable.
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Key == "" {
			t.Error("extracted an empty key")
		}
		if seen[e.Key] {
			t.Errorf("duplicate key %q", e.Key)
		}
		seen[e.Key] = true
		if e.Key != NormalizeKey(e.Key) {
			t.Errorf("key %q is not normalised", e.Key)
		}
	}
	again, err := ExtractCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(entries, again) {
		t.Error("extraction is not deterministic")
	}
}
