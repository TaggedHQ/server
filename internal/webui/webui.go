// Package webui serves a minimal embedded web UI (login, register, dashboard)
// for the Go TimeTagger server. Pages talk to the JSON API at
// <path_prefix>api/v2/. The path prefix is injected into HTML at serve time via
// the {{PREFIX}} placeholder so the UI works under any configured prefix.
package webui

import (
	"embed"
	"path"
	"strings"
)

//go:embed static/*
var files embed.FS

// route maps a request path (the part after the path prefix) to a file in the
// embedded static dir.
func route(reqPath string) string {
	switch reqPath {
	case "":
		return "index.html"
	case "login":
		return "login.html"
	case "register":
		return "register.html"
	case "setup":
		return "setup.html"
	case "account":
		return "account.html"
	case "entries":
		return "entries.html"
	case "admin":
		return "admin.html"
	case "servers":
		return "servers.html"
	case "oauth":
		return "oauth.html"
	case "tags":
		return "tags.html"
	case "about":
		return "about.html"
	case "impexp":
		return "impexp.html"
	default:
		return reqPath
	}
}

// Asset is a resolved static file ready to serve.
type Asset struct {
	Body        []byte
	ContentType string
	Found       bool
}

// Get resolves reqPath to an embedded asset, injecting prefix into HTML files.
func Get(reqPath, prefix string) Asset {
	name := route(reqPath)
	// Guard against path traversal.
	if strings.Contains(name, "..") {
		return Asset{Found: false}
	}
	body, err := files.ReadFile("static/" + name)
	if err != nil {
		return Asset{Found: false}
	}
	ct := contentType(name)
	if strings.HasSuffix(name, ".html") {
		body = []byte(strings.ReplaceAll(string(body), "{{PREFIX}}", prefix))
	}
	return Asset{Body: body, ContentType: ct, Found: true}
}

func contentType(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js":
		return "application/javascript; charset=utf-8"
	case ".json":
		return "application/json"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".ico":
		return "image/x-icon"
	case ".webmanifest":
		return "application/manifest+json"
	case ".ttf":
		return "font/ttf"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	default:
		return "application/octet-stream"
	}
}
