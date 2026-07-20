package webui

import (
	"encoding/json"
	"sync"
)

// The catalog of translatable UI strings. It is generated from the source by
// the extractor (see i18n_extract.go) and committed as static/i18n/en.json, so
// it rides the existing //go:embed and changes Version whenever the key set
// changes.
//
// The key is the English source string itself. That means an untranslated key
// falls back to correct English for free, and it spares us inventing ~900
// symbolic names for strings that already read perfectly well.
const catalogFile = "static/i18n/en.json"

// CatalogEntry is one translatable key.
type CatalogEntry struct {
	// Key is the English source text, and the lookup key in every catalog.
	Key string `json:"key"`
	// Ctx groups keys for the translator: "nav", "account", "admin·roles".
	// Without it the admin page is 900 undifferentiated rows.
	Ctx string `json:"ctx"`
	// Plural marks a key that carries separate singular and plural forms.
	Plural bool `json:"plural"`
	// Other is the English plural for a plural key, shown next to the singular
	// so a translator can see which form is which.
	Other string `json:"other,omitempty"`
}

var (
	catalogOnce sync.Once
	catalog     []CatalogEntry
)

// Catalog returns the full key list, in the generated (stable, sorted) order.
// A missing or malformed catalog yields an empty list rather than a panic: the
// UI still works untranslated, which is the right failure mode.
func Catalog() []CatalogEntry {
	catalogOnce.Do(func() {
		raw, err := files.ReadFile(catalogFile)
		if err != nil {
			return
		}
		_ = json.Unmarshal(raw, &catalog)
	})
	return catalog
}

// CatalogKeys returns just the keys, as a set, for membership tests.
func CatalogKeys() map[string]bool {
	out := make(map[string]bool, len(Catalog()))
	for _, e := range Catalog() {
		out[e.Key] = true
	}
	return out
}
