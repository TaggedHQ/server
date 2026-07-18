package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"strings"

	"github.com/TaggedHQ/server/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// getWebtokenBootstrap ports __main__.get_webtoken: it exchanges some form of
// trust (localhost / username+password / reverse proxy) for a webtoken. The body
// is base64-encoded JSON.
func (s *Server) getWebtokenBootstrap(req *request) response {
	raw, err := req.getBody(1024 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return textResp(400, "bad request: body must be base64")
	}
	var authInfo map[string]any
	if err := json.Unmarshal(decoded, &authInfo); err != nil {
		return textResp(400, "bad request: body must be base64-encoded JSON")
	}
	method, _ := authInfo["method"].(string)
	if method == "" {
		method = "unspecified"
	}
	switch method {
	case "localhost":
		return s.getWebtokenLocalhost(req, authInfo)
	case "usernamepassword":
		return s.getWebtokenUsernamePassword(req, authInfo)
	case "proxy":
		return s.getWebtokenProxy(req, authInfo)
	default:
		return textResp(401, "Invalid authentication method: "+method)
	}
}

func (s *Server) getWebtokenProxy(req *request, authInfo map[string]any) response {
	if !s.cfg.ProxyAuthEnabled {
		return textResp(403, "forbidden: proxy auth is not enabled")
	}
	client := clientIP(req.r)
	if !s.trusted.contains(client) {
		return textResp(403, "forbidden: the proxy is not trusted")
	}
	user := s.usernameFromProxy(req)
	if user == "" {
		return textResp(403, "forbidden: no proxy user provided")
	}
	token, err := s.getWebtokenUnsafe(user, false)
	if err != nil {
		return tokenErrResp(err)
	}
	return jsonResp(200, map[string]any{"token": token})
}

// usernameFromProxy returns the username set by the trusted reverse proxy header.
func (s *Server) usernameFromProxy(req *request) string {
	return strings.TrimSpace(req.header(s.cfg.ProxyAuthHeader))
}

func (s *Server) getWebtokenUsernamePassword(req *request, authInfo map[string]any) response {
	user, _ := authInfo["username"].(string)
	user = strings.TrimSpace(user)
	pw, _ := authInfo["password"].(string)
	pw = strings.TrimSpace(pw)

	ip := s.limiterIP(req.r)
	if !s.allowLogin(user, ip) {
		return textResp(429, "Too many attempts. Wait a moment and try again.")
	}

	// Accept either config-defined credentials (upstream behavior) or a
	// self-service account stored in the user's database (signup flow).
	hash := s.credentials[user]
	configOK := user != "" && hash != "" && bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
	if configOK || (user != "" && s.checkUserPassword(user, pw)) {
		// Password is correct. If the account has a second factor enabled,
		// require a valid TOTP (or backup) code before issuing a token.
		if s.userMFAEnabled(user) {
			code, _ := authInfo["totp"].(string)
			if strings.TrimSpace(code) == "" {
				return jsonResp(200, map[string]any{"mfa_required": "totp"})
			}
			// A wrong code is charged the same as a wrong password: the second
			// factor is six digits, so it is the easier of the two to guess.
			if !s.verifyMFACode(user, code) {
				s.noteLoginFailure(user, ip)
				return textResp(403, "Invalid two-factor code")
			}
		}
		token, err := s.getWebtokenUnsafe(user, false)
		if err != nil {
			return tokenErrResp(err)
		}
		s.noteLoginSuccess(user, ip)
		return jsonResp(200, map[string]any{"token": token})
	}
	s.noteLoginFailure(user, ip)
	return textResp(403, "Invalid credentials")
}

// registerHandler creates a new self-service account. Body is JSON
// {"username": ..., "password": ...}. Unauthenticated.
func (s *Server) registerHandler(req *request) response {
	if req.method() != "POST" {
		return textResp(405, "method not allowed: /register can only be used with POST")
	}
	if !s.registrationEnabled() {
		return textResp(403, "registration is disabled on this server")
	}
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with username and password")
	}
	status, err := s.registerUser(body.Username, body.Password)
	if err != nil {
		return textResp(status, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// changePasswordEndpoint updates the authenticated user's password. Body is JSON
// {"password": ...}.
func (s *Server) changePasswordEndpoint(req *request, db store.UserDB) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with password")
	}
	status, err := s.changePassword(db, body.Password)
	if err != nil {
		return textResp(status, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

func (s *Server) getWebtokenLocalhost(req *request, authInfo map[string]any) response {
	if !strings.HasPrefix(s.cfg.Bind, "127.0.0.1") {
		return textResp(403, "Can only login via localhost if the server address (config.bind) is '127.0.0.1'")
	}
	if s.cfg.ProxyAuthEnabled {
		return textResp(403, "forbidden: disabled when proxy auth is available")
	}
	host := requestHost(req.r)
	if host != "localhost" && host != "127.0.0.1" {
		return textResp(403, "forbidden: must be on localhost")
	}
	token, err := s.getWebtokenUnsafe("defaultuser", false)
	if err != nil {
		return tokenErrResp(err)
	}
	return jsonResp(200, map[string]any{"token": token})
}

// validateAuth ports __main__.validate_auth: when proxy auth is enabled, the
// authenticated user must still match the proxy-provided user.
func (s *Server) validateAuth(req *request, authInfo map[string]any) error {
	proxyUser := s.usernameFromProxy(req)
	username, _ := authInfo["username"].(string)
	if proxyUser != "" && proxyUser != username {
		return authErr("Autheticated user does not match proxy user")
	}
	return nil
}

// ---- trusted-proxy IP matching (replaces iptools.IpRangeList) ---------------

type ipRangeList struct {
	nets []*net.IPNet
	ips  []net.IP
}

// parseIPRangeList accepts a comma/semicolon separated list of IPs and CIDR
// ranges. Partial forms like "192.168/16" are normalized by padding with zeros.
func parseIPRangeList(raw string) (*ipRangeList, error) {
	l := &ipRangeList{}
	raw = strings.ReplaceAll(raw, ";", ",")
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.Contains(part, "/") {
			ipnet, err := parseCIDRLoose(part)
			if err != nil {
				return nil, fmt.Errorf("invalid trusted proxy range %q: %w", part, err)
			}
			l.nets = append(l.nets, ipnet)
		} else {
			ip := net.ParseIP(part)
			if ip == nil {
				return nil, fmt.Errorf("invalid trusted proxy ip %q", part)
			}
			l.ips = append(l.ips, ip)
		}
	}
	return l, nil
}

// parseCIDRLoose handles both standard CIDR and partial notations like
// "192.168/16" by padding the address portion out to four octets.
func parseCIDRLoose(part string) (*net.IPNet, error) {
	if _, ipnet, err := net.ParseCIDR(part); err == nil {
		return ipnet, nil
	}
	addr, mask, ok := strings.Cut(part, "/")
	if !ok {
		return nil, fmt.Errorf("not a CIDR")
	}
	octets := strings.Split(addr, ".")
	for len(octets) < 4 {
		octets = append(octets, "0")
	}
	_, ipnet, err := net.ParseCIDR(strings.Join(octets, ".") + "/" + mask)
	if err != nil {
		return nil, err
	}
	return ipnet, nil
}

func (l *ipRangeList) contains(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, known := range l.ips {
		if known.Equal(ip) {
			return true
		}
	}
	for _, n := range l.nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
