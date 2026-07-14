package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/TaggedHQ/server/internal/store"
	"github.com/TaggedHQ/server/internal/util"
)

// oauthProvider is one configured external identity provider. It uses the plain
// OAuth2 authorization-code flow followed by a userinfo call, which works for
// OIDC providers (Google, generic OIDC) as well as OAuth2-only ones (GitHub).
type oauthProvider struct {
	ID            string `json:"id"`             // url-safe slug, e.g. "google"
	Name          string `json:"name"`           // display label, e.g. "Google"
	Enabled       bool   `json:"enabled"`        // shown on the login page when true
	ClientID      string `json:"client_id"`      // OAuth client id
	ClientSecret  string `json:"client_secret"`  // OAuth client secret
	AuthURL       string `json:"auth_url"`       // authorization endpoint
	TokenURL      string `json:"token_url"`      // token endpoint
	UserinfoURL   string `json:"userinfo_url"`   // userinfo endpoint (returns JSON)
	Scopes        string `json:"scopes"`         // space-separated scopes
	UsernameField string `json:"username_field"` // userinfo claim to use as username
}

const (
	// oauthStateCookie carries the CSRF nonce that must match the signed state.
	oauthStateCookie = "tt_oauth_state"
	// oauthStateTTL bounds how long a sign-in attempt can stay in flight.
	oauthStateTTL = 10 * time.Minute
)

// oauthSlugRe validates provider ids so they map cleanly into URL paths.
var oauthSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,39}$`)

// oauthHTTP is the client used for token/userinfo calls to providers.
var oauthHTTP = &http.Client{Timeout: 15 * time.Second}

// getOAuthProvider returns the configured provider with id, or false if absent.
func (s *Server) getOAuthProvider(id string) (oauthProvider, bool) {
	s.oauthMu.RLock()
	defer s.oauthMu.RUnlock()
	for _, p := range s.oauthProviders {
		if p.ID == id {
			return p, true
		}
	}
	return oauthProvider{}, false
}

// listOAuthProviders returns a copy of the configured providers.
func (s *Server) listOAuthProviders() []oauthProvider {
	s.oauthMu.RLock()
	defer s.oauthMu.RUnlock()
	out := make([]oauthProvider, len(s.oauthProviders))
	copy(out, s.oauthProviders)
	return out
}

// setOAuthProviders validates and persists the provider list to setup.json.
func (s *Server) setOAuthProviders(providers []oauthProvider) error {
	seen := map[string]bool{}
	for i := range providers {
		p := &providers[i]
		p.ID = strings.TrimSpace(strings.ToLower(p.ID))
		p.Name = strings.TrimSpace(p.Name)
		p.UsernameField = strings.TrimSpace(p.UsernameField)
		if p.UsernameField == "" {
			p.UsernameField = "email"
		}
		if !oauthSlugRe.MatchString(p.ID) {
			return fmt.Errorf("provider id %q must be lowercase letters, digits, '-' or '_'", p.ID)
		}
		if seen[p.ID] {
			return fmt.Errorf("duplicate provider id %q", p.ID)
		}
		seen[p.ID] = true
		if p.Name == "" {
			p.Name = p.ID
		}
		// Fully validate only providers that are turned on; drafts can be incomplete.
		if p.Enabled {
			for label, v := range map[string]string{
				"client id": p.ClientID, "client secret": p.ClientSecret,
				"authorization URL": p.AuthURL, "token URL": p.TokenURL, "userinfo URL": p.UserinfoURL,
			} {
				if strings.TrimSpace(v) == "" {
					return fmt.Errorf("provider %q needs a %s to be enabled", p.ID, label)
				}
			}
		}
	}
	s.oauthMu.Lock()
	s.oauthProviders = providers
	s.oauthMu.Unlock()
	s.storeMu.RLock()
	kind, dbURL := s.backendKind, s.backendURL
	s.storeMu.RUnlock()
	return saveSetup(s.rootTTDir, s.setupSnapshot(kind, dbURL))
}

// ---- public sign-in endpoints ----------------------------------------------

// oauthProvidersHandler lists enabled providers for the login page. No secrets.
func (s *Server) oauthProvidersHandler() response {
	type pub struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := []pub{}
	for _, p := range s.listOAuthProviders() {
		if p.Enabled {
			out = append(out, pub{ID: p.ID, Name: p.Name})
		}
	}
	return jsonResp(200, map[string]any{"providers": out})
}

// oauthLoginHandler starts the authorization-code flow: it sets a signed-state
// CSRF cookie and redirects the browser to the provider's authorization URL.
func (s *Server) oauthLoginHandler(req *request, providerID string) response {
	p, ok := s.getOAuthProvider(providerID)
	if !ok || !p.Enabled {
		return textResp(404, "unknown or disabled oauth provider")
	}
	nonce := randSeed(16)
	state, err := s.signOAuthState(p.ID, nonce)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	redirectURI := s.oauthRedirectURI(req, p.ID)
	q := url.Values{}
	q.Set("client_id", p.ClientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("response_type", "code")
	if scopes := strings.TrimSpace(p.Scopes); scopes != "" {
		q.Set("scope", scopes)
	}
	q.Set("state", state)
	sep := "?"
	if strings.Contains(p.AuthURL, "?") {
		sep = "&"
	}
	authURL := p.AuthURL + sep + q.Encode()
	return response{
		status: 302,
		headers: map[string]string{
			"Location":      authURL,
			"Set-Cookie":    s.oauthCookie(oauthStateCookie, nonce, req, int(oauthStateTTL.Seconds())),
			"Cache-Control": "no-store",
		},
		body: []byte{},
	}
}

// oauthCallbackHandler completes the flow: it verifies state, exchanges the code
// for an access token, fetches the userinfo, provisions/looks up the account,
// and hands a fresh web-token to the UI via the login page's URL fragment.
func (s *Server) oauthCallbackHandler(req *request, providerID string) response {
	p, ok := s.getOAuthProvider(providerID)
	if !ok || !p.Enabled {
		return textResp(404, "unknown or disabled oauth provider")
	}
	if errParam := req.queryGet("error"); errParam != "" {
		return s.oauthFail(req, "provider returned an error: "+errParam)
	}
	code := strings.TrimSpace(req.queryGet("code"))
	state := strings.TrimSpace(req.queryGet("state"))
	if code == "" || state == "" {
		return s.oauthFail(req, "missing code or state")
	}

	// Verify the signed state and the matching CSRF cookie.
	claimedProvider, nonce, err := s.verifyOAuthState(state)
	if err != nil || claimedProvider != p.ID {
		return s.oauthFail(req, "invalid or expired sign-in state")
	}
	c, cerr := req.r.Cookie(oauthStateCookie)
	if cerr != nil || c.Value != nonce {
		return s.oauthFail(req, "sign-in state cookie mismatch")
	}

	token, err := s.oauthExchangeCode(p, code, s.oauthRedirectURI(req, p.ID))
	if err != nil {
		return s.oauthFail(req, "could not exchange code: "+err.Error())
	}
	username, err := s.oauthFetchUsername(p, token)
	if err != nil {
		return s.oauthFail(req, "could not read profile: "+err.Error())
	}

	// Provision on first sign-in, gated by the same switch as self-registration.
	exists, err := s.userExists(username)
	if err != nil {
		return s.oauthFail(req, "internal error")
	}
	if !exists {
		if !s.registrationEnabled() {
			return s.oauthFail(req, "no account for "+username+" and registration is disabled")
		}
		if err := s.provisionOAuthUser(username, p.ID); err != nil {
			return s.oauthFail(req, "could not create account")
		}
	}

	webtoken, err := s.getWebtokenUnsafe(username, false)
	if err != nil {
		return s.oauthFail(req, "could not issue token")
	}
	frag := "#token=" + url.QueryEscape(webtoken) + "&user=" + url.QueryEscape(username)
	return response{
		status: 302,
		headers: map[string]string{
			"Location":      s.cfg.PathPrefix + "login" + frag,
			"Set-Cookie":    s.oauthCookie(oauthStateCookie, "", req, -1), // clear nonce
			"Cache-Control": "no-store",
		},
		body: []byte{},
	}
}

// oauthFail redirects back to the login page with a human-readable error in the
// fragment, clearing the state cookie.
func (s *Server) oauthFail(req *request, msg string) response {
	return response{
		status: 302,
		headers: map[string]string{
			"Location":      s.cfg.PathPrefix + "login#oauth_error=" + url.QueryEscape(msg),
			"Set-Cookie":    s.oauthCookie(oauthStateCookie, "", req, -1),
			"Cache-Control": "no-store",
		},
		body: []byte{},
	}
}

// ---- flow helpers -----------------------------------------------------------

// oauthExchangeCode swaps an authorization code for an access token.
func (s *Server) oauthExchangeCode(p oauthProvider, code, redirectURI string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("client_id", p.ClientID)
	form.Set("client_secret", p.ClientSecret)

	ctx, cancel := context.WithTimeout(context.Background(), oauthHTTP.Timeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, "POST", p.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	httpReq.Header.Set("Accept", "application/json") // GitHub returns form-encoding otherwise
	resp, err := oauthHTTP.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("token endpoint returned %d", resp.StatusCode)
	}
	var tr struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if err := json.Unmarshal(raw, &tr); err != nil || tr.AccessToken == "" {
		// Fall back to form-encoded token responses (some OAuth2 providers).
		if vals, perr := url.ParseQuery(string(raw)); perr == nil {
			if at := vals.Get("access_token"); at != "" {
				return at, nil
			}
		}
		return "", fmt.Errorf("no access_token in response")
	}
	return tr.AccessToken, nil
}

// oauthFetchUsername calls the userinfo endpoint and extracts the configured
// username claim, normalized to a trimmed, lowercased string.
func (s *Server) oauthFetchUsername(p oauthProvider, accessToken string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), oauthHTTP.Timeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, "GET", p.UserinfoURL, nil)
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Authorization", "Bearer "+accessToken)
	httpReq.Header.Set("Accept", "application/json")
	resp, err := oauthHTTP.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("userinfo endpoint returned %d", resp.StatusCode)
	}
	var info map[string]any
	if err := json.Unmarshal(raw, &info); err != nil {
		return "", fmt.Errorf("userinfo is not JSON")
	}
	// username_field may list several candidate claims (comma/space separated);
	// the first that yields a non-empty value wins. This lets a provider fall back
	// gracefully, e.g. "email,login" for GitHub where email can be null.
	fields := parseClaimFields(p.UsernameField)
	for _, field := range fields {
		if val, ok := info[field]; ok && val != nil {
			username := strings.TrimSpace(strings.ToLower(fmt.Sprint(val)))
			if username != "" {
				return username, nil
			}
		}
	}
	return "", fmt.Errorf("userinfo has no non-empty %s claim (fields returned: %s)",
		strings.Join(quoteAll(fields), " or "), strings.Join(availableKeys(info), ", "))
}

// parseClaimFields splits a username_field spec ("email", "email,login",
// "email login") into candidate claim names, defaulting to ["email"].
func parseClaimFields(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' })
	if len(parts) == 0 {
		return []string{"email"}
	}
	return parts
}

// availableKeys returns the sorted top-level keys of a userinfo object, for
// diagnostics when no configured claim matched.
func availableKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// userExists reports whether username is a known account (has data on disk),
// without creating one as a side effect.
func (s *Server) userExists(username string) (bool, error) {
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return false, err
	}
	for _, m := range metas {
		if m.Username == username {
			return true, nil
		}
	}
	return false, nil
}

// provisionOAuthUser creates the account's database and records which provider
// first created it. The account has no password (OAuth-only) until one is set.
func (s *Server) provisionOAuthUser(username, providerID string) error {
	db, err := s.openUserDB(username)
	if err != nil {
		return err
	}
	defer db.Close()
	st := now()
	return db.Write(func(tx store.WTx) error {
		return tx.Upsert("userinfo", store.Item{
			"key": "oauth_provider", "st": st, "mt": st, "value": providerID,
		})
	})
}

// ---- state signing + cookies + urls ----------------------------------------

// signOAuthState returns a JWT (signed with the server key) binding the provider
// and CSRF nonce to a short expiry. Reuses the JWT helpers already used for
// web-tokens so no new crypto is introduced.
func (s *Server) signOAuthState(providerID, nonce string) (string, error) {
	payload := map[string]any{
		"username": "_oauth_state", // required by CreateJWT; unused
		"expires":  time.Now().Add(oauthStateTTL).Unix(),
		"seed":     nonce,
		"provider": providerID,
	}
	return util.CreateJWT(payload, s.jwtKey)
}

// verifyOAuthState checks the signature and expiry and returns (provider, nonce).
func (s *Server) verifyOAuthState(state string) (string, string, error) {
	payload, err := util.DecodeJWT(state, s.jwtKey)
	if err != nil {
		return "", "", err
	}
	if toFloat(payload["expires"]) < float64(time.Now().Unix()) {
		return "", "", fmt.Errorf("state expired")
	}
	provider, _ := payload["provider"].(string)
	nonce, _ := payload["seed"].(string)
	if provider == "" || nonce == "" {
		return "", "", fmt.Errorf("malformed state")
	}
	return provider, nonce, nil
}

// oauthCookie builds a Set-Cookie value for the CSRF nonce, scoped to the path
// prefix, http-only, SameSite=Lax (so it survives the top-level redirect back),
// and Secure over HTTPS. A negative maxAge clears it.
func (s *Server) oauthCookie(name, value string, req *request, maxAge int) string {
	c := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     s.cfg.PathPrefix,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
		Secure:   externalScheme(req.r) == "https",
	}
	return c.String()
}

// oauthRedirectURI builds the absolute callback URL for a provider, honoring
// reverse-proxy forwarding headers.
func (s *Server) oauthRedirectURI(req *request, providerID string) string {
	return externalBaseURL(req.r) + s.cfg.PathPrefix + "api/v2/oauth/callback/" + providerID
}

// externalScheme returns the client-facing scheme, honoring X-Forwarded-Proto.
func externalScheme(r *http.Request) string {
	if p := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); p != "" {
		return strings.ToLower(strings.SplitN(p, ",", 2)[0])
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

// externalBaseURL returns scheme://host as seen by the client, honoring the
// X-Forwarded-Proto / X-Forwarded-Host headers set by a reverse proxy.
func externalBaseURL(r *http.Request) string {
	host := r.Host
	if h := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); h != "" {
		host = strings.SplitN(h, ",", 2)[0]
	}
	return externalScheme(r) + "://" + strings.TrimSpace(host)
}
