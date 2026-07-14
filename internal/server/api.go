package server

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/TaggedHQ/server/internal/store"
)

const (
	strMax  = 256
	jsonMax = 8192
)

var falsyValues = map[string]struct{}{
	"false": {}, "off": {}, "no": {}, "n": {}, "0": {},
}

// request is a thin wrapper over *http.Request providing the conveniences the
// Python handlers rely on (querydict, headers, body/json).
type request struct {
	r        *http.Request
	query    url.Values
	body     []byte
	bodyRead bool
}

func newRequest(r *http.Request) *request {
	return &request{r: r, query: r.URL.Query()}
}

func (req *request) method() string             { return req.r.Method }
func (req *request) header(name string) string  { return req.r.Header.Get(name) }
func (req *request) queryGet(key string) string { return req.query.Get(key) }

func (req *request) getBody(limit int64) ([]byte, error) {
	if req.bodyRead {
		return req.body, nil
	}
	defer req.r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(req.r.Body, limit))
	if err != nil {
		return nil, err
	}
	req.body = b
	req.bodyRead = true
	return b, nil
}

// apiHandler ports __main__.api_handler: it handles unauthenticated endpoints,
// authenticates, and delegates to the triage.
func (s *Server) apiHandler(r *http.Request, path string) response {
	req := newRequest(r)

	if path == "" && req.method() == "GET" {
		return textResp(200, "See https://timetagger.readthedocs.io")
	}
	if path == "bootstrap_authentication" {
		return s.getWebtokenBootstrap(req)
	}
	if path == "register" {
		return s.registerHandler(req)
	}
	if path == "setup_status" {
		return s.setupStatusHandler()
	}
	if path == "setup" {
		return s.setupHandler(req)
	}
	// OAuth sign-in endpoints are unauthenticated: they establish identity via an
	// external provider. (Admin configuration lives under /admin/oauth, below.)
	if path == "oauth/providers" {
		return s.oauthProvidersHandler()
	}
	if strings.HasPrefix(path, "oauth/login/") {
		return s.oauthLoginHandler(req, strings.TrimPrefix(path, "oauth/login/"))
	}
	if strings.HasPrefix(path, "oauth/callback/") {
		return s.oauthCallbackHandler(req, strings.TrimPrefix(path, "oauth/callback/"))
	}

	authInfo, db, err := s.authenticate(req)
	if err != nil {
		if ae, ok := err.(*AuthError); ok {
			return textResp(401, "unauthorized: "+ae.Error())
		}
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()

	if s.cfg.ProxyAuthEnabled {
		if err := s.validateAuth(req, authInfo); err != nil {
			if ae, ok := err.(*AuthError); ok {
				return textResp(401, "unauthorized: "+ae.Error())
			}
			return textResp(500, "internal error: "+err.Error())
		}
	}

	return s.apiHandlerTriage(req, path, authInfo, db)
}

// apiHandlerTriage ports _apiserver.api_handler_triage.
func (s *Server) apiHandlerTriage(req *request, path string, authInfo map[string]any, db store.UserDB) response {
	m := req.method()

	username, _ := authInfo["username"].(string)

	// Identity + admin-only user management.
	if path == "whoami" {
		if m == "GET" {
			return s.whoamiHandler(username, db)
		}
		return textResp(405, "method not allowed: /whoami can only be used with GET")
	}
	if path == "admin" || strings.HasPrefix(path, "admin/") {
		if !s.isAdmin(username, db) {
			return textResp(403, "forbidden: admin access required")
		}
		return s.adminHandler(req, strings.TrimPrefix(path, "admin"), username)
	}
	if path == "controller" || strings.HasPrefix(path, "controller/") {
		if !s.isController(username, db) {
			return textResp(403, "forbidden: controller access required")
		}
		return s.controllerHandler(req, strings.TrimPrefix(path, "controller"))
	}

	// Data plane: a controller may act as another user via the "actasuser"
	// header. For those routes dataDB is the target's db; otherwise it is the
	// authenticated user's own db. Control-plane routes above/below use db.
	dataDB := db
	if isDataPath(path) {
		d, extra, errResp := s.dataDB(req, username, db)
		if errResp != nil {
			return *errResp
		}
		dataDB = d
		if extra {
			defer dataDB.Close()
		}
	}

	switch path {
	case "version":
		if m == "GET" {
			return s.getVersion()
		}
		return textResp(405, "method not allowed: /version can only be used with GET")
	case "about":
		if m == "GET" {
			return s.aboutHandler()
		}
		return textResp(405, "method not allowed: /about can only be used with GET")
	case "updates":
		if m == "GET" {
			return s.getUpdates(req, dataDB)
		}
		return textResp(405, "method not allowed: /updates can only be used with GET")
	case "records":
		if m == "GET" {
			return s.getRecords(req, dataDB)
		} else if m == "PUT" {
			return s.pushItems(req, dataDB, "records")
		}
		return textResp(405, "method not allowed: /records can only be used with GET and PUT")
	case "settings":
		if m == "GET" {
			return s.getSettings(dataDB)
		} else if m == "PUT" {
			return s.pushItems(req, dataDB, "settings")
		}
		return textResp(405, "method not allowed: /settings can only be used with GET and PUT")
	case "forcereset":
		if m == "PUT" {
			return s.putForcereset(dataDB)
		}
		return textResp(405, "method not allowed: /forcereset can only be used with PUT")
	case "webtoken":
		if m == "GET" {
			return s.getWebtokenEndpoint(req, authInfo, db)
		}
		return textResp(405, "method not allowed: /webtoken can only be used with GET")
	case "apitoken":
		if m == "GET" {
			return s.getApitokenEndpoint(req, authInfo, db)
		}
		return textResp(405, "method not allowed: /apitoken can only be used with GET")
	case "password":
		if m == "PUT" {
			return s.changePasswordEndpoint(req, db)
		}
		return textResp(405, "method not allowed: /password can only be used with PUT")
	case "totp/setup", "totp/enable", "totp/disable":
		if m != "POST" {
			return textResp(405, "method not allowed: /"+path+" can only be used with POST")
		}
		if !isWebtoken(authInfo) {
			return textResp(403, "forbidden: /"+path+" needs auth with a web-token")
		}
		switch path {
		case "totp/setup":
			return s.totpSetup(authInfo, db)
		case "totp/enable":
			return s.totpEnable(req, db)
		default:
			return s.totpDisable(req, db)
		}
	default:
		return textResp(404, "not found: /"+path+" is not a valid API path")
	}
}

// isDataPath reports whether path is a data-plane route whose db may be swapped
// for a controller's impersonation target.
func isDataPath(path string) bool {
	switch path {
	case "updates", "records", "settings", "forcereset":
		return true
	}
	return false
}

// dataDB resolves the database a data-plane request should operate on. Without an
// "actasuser" header (or when it names the caller), it returns realDB unchanged.
// Otherwise the caller must be a controller and the target must be a registered
// regular user (not a config/stored admin and not another controller); on success
// the target's db is returned with extra=true (the caller must Close it). Any
// failure returns a non-nil *response for the handler to send.
func (s *Server) dataDB(req *request, realUser string, realDB store.UserDB) (store.UserDB, bool, *response) {
	target := strings.TrimSpace(req.header("actasuser"))
	if target == "" || target == realUser {
		return realDB, false, nil
	}
	if !s.isController(realUser, realDB) {
		r := textResp(403, "forbidden: controller role required to act as another user")
		return nil, false, &r
	}
	if s.isConfigAdmin(target) {
		r := textResp(403, "forbidden: cannot act as this user")
		return nil, false, &r
	}
	tdb, err := s.openUserDB(target)
	if err != nil {
		r := textResp(500, "internal error: "+err.Error())
		return nil, false, &r
	}
	if !dbRegistered(tdb) || dbAdminFlag(tdb) || dbControllerFlag(tdb) {
		tdb.Close()
		r := textResp(403, "forbidden: cannot act as this user")
		return nil, false, &r
	}
	return tdb, true, nil
}

func parseReset(raw string) bool {
	raw = strings.ToLower(raw)
	if raw == "" {
		return false
	}
	_, falsy := falsyValues[raw]
	return !falsy
}

func (s *Server) getVersion() response {
	return jsonResp(200, map[string]any{"version": Version})
}

func (s *Server) getWebtokenEndpoint(req *request, authInfo map[string]any, db store.UserDB) response {
	reset := parseReset(req.queryGet("reset"))
	if toFloat(authInfo["expires"]) > now()+webtokenLifetime {
		return textResp(403, "forbidden: /webtoken needs auth with a web-token")
	}
	resp, err := s.getAnyToken(db, authInfo, "webtoken", reset)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return resp
}

func (s *Server) getApitokenEndpoint(req *request, authInfo map[string]any, db store.UserDB) response {
	reset := parseReset(req.queryGet("reset"))
	if toFloat(authInfo["expires"]) > now()+webtokenLifetime {
		return textResp(403, "forbidden: /apitoken needs auth with a web-token")
	}
	resp, err := s.getAnyToken(db, authInfo, "apitoken", reset)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return resp
}

func (s *Server) getUpdates(req *request, db store.UserDB) response {
	sinceStr := strings.TrimSpace(req.queryGet("since"))
	if sinceStr == "" {
		return textResp(400, "bad request: /updates needs since")
	}
	since, err := strconv.ParseFloat(sinceStr, 64)
	if err != nil {
		return textResp(400, "bad request: /updates since needs a number (timestamp)")
	}

	serverTime := now()

	// Early exit: file untouched since the client's last sync. Uses a 0.2s
	// margin for getmtime resolution. reset:0 (not false) matches the tests.
	if db.Mtime()+0.2 < since {
		return jsonResp(200, map[string]any{
			"server_time": serverTime,
			"reset":       0,
			"records":     []any{},
			"settings":    []any{},
		})
	}

	ob, err := db.Get("userinfo", "reset_time")
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	resetTime := float64(-1)
	if ob != nil {
		resetTime = toFloat(ob["value"])
	}
	reset := since <= resetTime

	var records, settings []store.Item
	if reset {
		if records, err = db.All("records"); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		if settings, err = db.All("settings"); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
	} else {
		if records, err = db.ItemsSince("records", since); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		if settings, err = db.ItemsSince("settings", since); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
	}

	return jsonResp(200, map[string]any{
		"server_time": serverTime,
		"reset":       reset,
		"records":     orEmpty(records),
		"settings":    orEmpty(settings),
	})
}

func (s *Server) getRecords(req *request, db store.UserDB) response {
	timerangeStr := strings.TrimSpace(req.queryGet("timerange"))
	if timerangeStr == "" {
		return textResp(400, "bad request: /records needs timerange (2 timestamps)")
	}
	parts := strings.Split(timerangeStr, "-")
	if len(parts) != 2 {
		return textResp(400, "bad request: /records timerange needs 2 numbers (timestamps)")
	}
	f0, err0 := strconv.ParseFloat(parts[0], 64)
	f1, err1 := strconv.ParseFloat(parts[1], 64)
	if err0 != nil || err1 != nil {
		return textResp(400, "bad request: /records timerange needs 2 numbers (timestamps)")
	}

	// Parse the tag option: strip '#' and split on commas. LIKE-escaping and the
	// dialect-specific query are handled by the backend.
	tagStr := strings.TrimSpace(req.queryGet("tag"))
	var tags []string
	if tagStr != "" {
		tagStr = strings.ReplaceAll(tagStr, "#", "")
		for _, t := range strings.Split(tagStr, ",") {
			tags = append(tags, strings.TrimSpace(t))
		}
	}

	records, err := db.QueryRecords(store.RecordFilter{
		T1:      int64(math.Trunc(f0)),
		T2:      int64(math.Trunc(f1)),
		Tags:    tags,
		Running: parseTriState(req.queryGet("running")),
		Hidden:  parseTriState(req.queryGet("hidden")),
	})
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"records": orEmpty(records)})
}

// parseTriState returns nil for empty, false for falsy values, else true —
// matching the running/hidden option parsing in get_records.
func parseTriState(raw string) *bool {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" {
		return nil
	}
	v := true
	if _, falsy := falsyValues[raw]; falsy {
		v = false
	}
	return &v
}

func (s *Server) getSettings(db store.UserDB) response {
	settings, err := db.All("settings")
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"settings": orEmpty(settings)})
}

func (s *Server) putForcereset(db store.UserDB) response {
	st := now()
	if err := db.Write(func(tx store.WTx) error {
		return tx.Upsert("userinfo", store.Item{"key": "reset_time", "st": st, "mt": st, "value": st})
	}); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// specField pairs a field name with its converter, preserving order.
type specField struct {
	name string
	conv func(any) (any, error)
}

func recordSpec() []specField {
	return []specField{
		{"key", toStr}, {"mt", toIntVal}, {"t1", toIntVal}, {"t2", toIntVal}, {"ds", toStr},
	}
}
func settingSpec() []specField {
	return []specField{
		{"key", toStr}, {"mt", toIntVal}, {"value", toJsonable},
	}
}

func specFor(what string) ([]specField, []string) {
	if what == "records" {
		return recordSpec(), []string{"key", "mt", "t1", "t2"}
	}
	return settingSpec(), []string{"key", "mt", "value"}
}

// pushItems ports _apiserver._push_items — the eventual-consistency write path.
func (s *Server) pushItems(req *request, db store.UserDB, what string) response {
	raw, err := req.getBody(10 * 1024 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var items []any
	if err := json.Unmarshal(raw, &items); err != nil {
		return textResp(500, fmt.Sprintf("List of %s must be a list", what))
	}

	serverTime := now()
	spec, reqFields := specFor(what)

	var accepted, failed, errs, errs2 []string

	werr := db.Write(func(tx store.WTx) error {
		ob, err := tx.Get("userinfo", "reset_time")
		if err != nil {
			return err
		}
		resetTime := float64(-1)
		if ob != nil {
			resetTime = toFloat(ob["value"])
		}

		for _, rawItem := range items {
			itemIn, ok := rawItem.(map[string]any)
			var keyStr string
			keyOk := false
			if ok {
				if k, kok := itemIn["key"].(string); kok {
					keyStr = k
					keyOk = true
				}
			}
			if !ok || !keyOk {
				errs2 = append(errs2, "Got item that is not a dict with str 'key' field.")
				continue
			}

			curItem, err := tx.Get(what, keyStr)
			if err != nil {
				return err
			}

			item, verr := validateItem(itemIn, spec, reqFields, resetTime, what)
			if verr != nil {
				failed = append(failed, keyStr)
				errs = append(errs, verr.Error())
				if curItem != nil {
					item = curItem
				} else {
					continue
				}
			} else {
				accepted = append(accepted, keyStr)
			}

			// Keep the newer item if the stored one is newer.
			if curItem != nil && toFloat(curItem["mt"]) > toFloat(item["mt"]) {
				item = curItem
			}

			// Ensure st strictly increases so eventual consistency holds.
			if curItem != nil {
				item["st"] = math.Max(serverTime, toFloat(curItem["st"])+0.0001)
			} else {
				item["st"] = serverTime
			}

			if err := tx.Upsert(what, item); err != nil {
				return err
			}
		}
		return nil
	})
	if werr != nil {
		return textResp(500, "internal error: "+werr.Error())
	}

	return jsonResp(200, map[string]any{
		"accepted": orEmptyStr(accepted),
		"failed":   orEmptyStr(failed),
		"errors":   orEmptyStr(append(append([]string{}, errs...), errs2...)),
	})
}

// validateItem copies and converts the known fields per spec, checks required
// fields, and rejects items modified before a reset. Mirrors the inline logic
// in _push_items.
func validateItem(itemIn map[string]any, spec []specField, reqFields []string, resetTime float64, what string) (map[string]any, error) {
	out := map[string]any{}
	for _, f := range spec {
		if v, ok := itemIn[f.name]; ok {
			cv, err := f.conv(v)
			if err != nil {
				return nil, err
			}
			out[f.name] = cv
		}
	}
	var missing []string
	for _, rq := range reqFields {
		if _, ok := out[rq]; !ok {
			missing = append(missing, rq)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("A %s is missing required fields: {%s}", what, strings.Join(quoteAll(missing), ", "))
	}
	if toFloat(out["mt"]) < resetTime {
		return nil, fmt.Errorf("Item was modified after a reset")
	}
	return out, nil
}

func quoteAll(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = "'" + s + "'"
	}
	return out
}

// ---- spec converters (to_str / to_int / to_jsonable) ------------------------

func toStr(v any) (any, error) {
	s := pyStr(v)
	if utf8.RuneCountInString(s) >= strMax {
		return nil, fmt.Errorf("String values must be less than 256 chars.")
	}
	return s, nil
}

func toIntVal(v any) (any, error) {
	switch x := v.(type) {
	case float64:
		return int64(math.Trunc(x)), nil
	case bool:
		if x {
			return int64(1), nil
		}
		return int64(0), nil
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid literal for int: %q", x)
		}
		return n, nil
	case json.Number:
		n, err := x.Int64()
		if err != nil {
			f, ferr := x.Float64()
			if ferr != nil {
				return nil, ferr
			}
			return int64(math.Trunc(f)), nil
		}
		return n, nil
	default:
		return nil, fmt.Errorf("invalid value for int")
	}
}

func toJsonable(v any) (any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if len(b) >= jsonMax {
		return nil, fmt.Errorf("Values must be less than 256 chars when jsonized.")
	}
	return v, nil
}

// pyStr approximates Python's str() for the value types JSON can produce.
func pyStr(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case nil:
		return "None"
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	default:
		return fmt.Sprint(x)
	}
}

// ---- numeric + slice helpers ------------------------------------------------

func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case int:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	case bool:
		if x {
			return 1
		}
		return 0
	default:
		return 0
	}
}

func orEmpty(items []store.Item) []store.Item {
	if items == nil {
		return []store.Item{}
	}
	return items
}

func orEmptyStr(ss []string) []string {
	if ss == nil {
		return []string{}
	}
	return ss
}
