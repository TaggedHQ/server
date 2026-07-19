// Command gen regenerates the translatable-string catalog at
// internal/webui/static/i18n/en.json.
//
// Run it after adding or changing any data-i18n attribute or t()/tn() call:
//
//	go generate ./internal/webui/
//
// Forgetting is not fatal: TestCatalogIsCurrent fails in CI and tells you to
// run this.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/TaggedHQ/server/internal/webui"
)

func main() {
	// The extractor reads the embedded copy of the assets. `go run` compiles a
	// fresh binary from the current source, so the embed is always up to date.
	entries, err := webui.ExtractCatalog()
	if err != nil {
		fmt.Fprintf(os.Stderr, "extract: %v\n", err)
		os.Exit(1)
	}
	if bad, err := webui.MarkupMismatches(); err != nil {
		fmt.Fprintf(os.Stderr, "markup check: %v\n", err)
		os.Exit(1)
	} else if len(bad) > 0 {
		fmt.Fprintf(os.Stderr, "data-i18n does not match element text:\n")
		for _, b := range bad {
			fmt.Fprintf(os.Stderr, "  %s\n", b)
		}
		os.Exit(1)
	}

	raw, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode: %v\n", err)
		os.Exit(1)
	}
	raw = append(raw, '\n')
	const out = "static/i18n/en.json"
	if err := os.WriteFile(out, raw, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", out, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s with %d keys\n", out, len(entries))
}
