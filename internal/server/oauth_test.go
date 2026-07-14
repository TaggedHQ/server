package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/TaggedHQ/server/internal/config"
)

// newTestServer builds a Server backed by a throwaway SQLite datadir.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	cfg, err := config.New([]string{"--datadir=" + t.TempDir(), "--bind=127.0.0.1:0"}, nil)
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	srv, err := New(cfg)
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	return srv
}

// mockProvider stands in for an external OAuth2 provider's token + userinfo
// endpoints, handing back the given email at /userinfo.
func mockProvider(t *testing.T, email string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "abc123", "token_type": "bearer"})
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer abc123" {
			t.Errorf("userinfo got Authorization %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"email": email, "name": "Test User"})
	})
	return httptest.NewServer(mux)
}

func configureProvider(t *testing.T, s *Server, prov *httptest.Server) {
	t.Helper()
	err := s.setOAuthProviders([]oauthProvider{{
		ID: "test", Name: "Test", Enabled: true,
		ClientID: "cid", ClientSecret: "secret",
		AuthURL:     prov.URL + "/authorize",
		TokenURL:    prov.URL + "/token",
		UserinfoURL: prov.URL + "/userinfo",
		Scopes:      "openid email", UsernameField: "email",
	}})
	if err != nil {
		t.Fatalf("setOAuthProviders: %v", err)
	}
}

// callbackReq builds a callback *request carrying a valid signed state and the
// matching CSRF cookie.
func (s *Server) callbackReq(t *testing.T, code string) *request {
	t.Helper()
	nonce := "test-nonce"
	state, err := s.signOAuthState("test", nonce)
	if err != nil {
		t.Fatalf("signOAuthState: %v", err)
	}
	u := "/timetagger/api/v2/oauth/callback/test?code=" + url.QueryEscape(code) + "&state=" + url.QueryEscape(state)
	r := httptest.NewRequest("GET", u, nil)
	r.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: nonce})
	return newRequest(r)
}

func TestOAuthCallbackProvisionsAndIssuesToken(t *testing.T) {
	s := newTestServer(t)
	prov := mockProvider(t, "Alice@Example.com")
	defer prov.Close()
	configureProvider(t, s, prov)

	resp := s.oauthCallbackHandler(s.callbackReq(t, "goodcode"), "test")
	if resp.status != 302 {
		t.Fatalf("status = %d, want 302 (body=%v)", resp.status, resp.body)
	}
	loc := resp.headers["Location"]
	if !strings.Contains(loc, "#token=") || !strings.Contains(loc, "user=alice%40example.com") {
		t.Fatalf("Location = %q, want token+lowercased user fragment", loc)
	}

	// The account should now exist (username normalized to lowercase email).
	exists, err := s.userExists("alice@example.com")
	if err != nil || !exists {
		t.Fatalf("user not provisioned: exists=%v err=%v", exists, err)
	}

	// The issued web-token must authenticate against the new account.
	token := extractFragToken(t, loc)
	r := httptest.NewRequest("GET", "/timetagger/api/v2/whoami", nil)
	r.Header.Set("authtoken", token)
	authInfo, db, err := s.authenticate(newRequest(r))
	if err != nil {
		t.Fatalf("issued token failed to authenticate: %v", err)
	}
	defer db.Close()
	if authInfo["username"] != "alice@example.com" {
		t.Fatalf("token username = %v", authInfo["username"])
	}
}

func TestOAuthCallbackRejectsBadState(t *testing.T) {
	s := newTestServer(t)
	prov := mockProvider(t, "bob@example.com")
	defer prov.Close()
	configureProvider(t, s, prov)

	// Cookie nonce does not match the one signed into the state.
	state, _ := s.signOAuthState("test", "real-nonce")
	r := httptest.NewRequest("GET", "/x?code=c&state="+url.QueryEscape(state), nil)
	r.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "attacker-nonce"})
	resp := s.oauthCallbackHandler(newRequest(r), "test")
	if resp.status != 302 || !strings.Contains(resp.headers["Location"], "oauth_error=") {
		t.Fatalf("expected error redirect, got status=%d loc=%q", resp.status, resp.headers["Location"])
	}
	if exists, _ := s.userExists("bob@example.com"); exists {
		t.Fatalf("no account should be provisioned on CSRF failure")
	}
}

func TestOAuthCallbackBlockedWhenRegistrationClosed(t *testing.T) {
	s := newTestServer(t)
	prov := mockProvider(t, "carol@example.com")
	defer prov.Close()
	configureProvider(t, s, prov)
	if err := s.setRegistrationEnabled(false); err != nil {
		t.Fatalf("setRegistrationEnabled: %v", err)
	}

	resp := s.oauthCallbackHandler(s.callbackReq(t, "goodcode"), "test")
	if resp.status != 302 || !strings.Contains(resp.headers["Location"], "oauth_error=") {
		t.Fatalf("expected error redirect, got status=%d loc=%q", resp.status, resp.headers["Location"])
	}
	if exists, _ := s.userExists("carol@example.com"); exists {
		t.Fatalf("new account should not be provisioned while registration is closed")
	}
}

// userinfoProvider returns a provider whose /userinfo emits an arbitrary object,
// to exercise claim selection and fallback.
func userinfoProvider(t *testing.T, info map[string]any) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "abc123"})
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info)
	})
	return httptest.NewServer(mux)
}

func TestOAuthUsernameFieldFallback(t *testing.T) {
	s := newTestServer(t)
	// GitHub-like: email is null, login present. Claim "email,login" should fall
	// back to login.
	prov := userinfoProvider(t, map[string]any{"email": nil, "login": "Octocat"})
	defer prov.Close()
	if err := s.setOAuthProviders([]oauthProvider{{
		ID: "test", Name: "T", Enabled: true, ClientID: "c", ClientSecret: "s",
		AuthURL: prov.URL + "/a", TokenURL: prov.URL + "/token", UserinfoURL: prov.URL + "/userinfo",
		UsernameField: "email,login",
	}}); err != nil {
		t.Fatal(err)
	}
	resp := s.oauthCallbackHandler(s.callbackReq(t, "code"), "test")
	if !strings.Contains(resp.headers["Location"], "user=octocat") {
		t.Fatalf("expected fallback to login=octocat, got %q", resp.headers["Location"])
	}
}

func TestOAuthUsernameFieldMissingListsAvailable(t *testing.T) {
	s := newTestServer(t)
	prov := userinfoProvider(t, map[string]any{"email": nil, "login": "octocat", "id": 42})
	defer prov.Close()
	if err := s.setOAuthProviders([]oauthProvider{{
		ID: "test", Name: "T", Enabled: true, ClientID: "c", ClientSecret: "s",
		AuthURL: prov.URL + "/a", TokenURL: prov.URL + "/token", UserinfoURL: prov.URL + "/userinfo",
		UsernameField: "email",
	}}); err != nil {
		t.Fatal(err)
	}
	_, err := s.oauthFetchUsername(mustProvider(s, "test"), "abc123")
	if err == nil || !strings.Contains(err.Error(), "login") || !strings.Contains(err.Error(), "id") {
		t.Fatalf("error should list available fields, got: %v", err)
	}
}

func mustProvider(s *Server, id string) oauthProvider {
	p, _ := s.getOAuthProvider(id)
	return p
}

func TestOAuthProvidersHandlerHidesSecrets(t *testing.T) {
	s := newTestServer(t)
	prov := mockProvider(t, "x@example.com")
	defer prov.Close()
	configureProvider(t, s, prov)

	resp := s.oauthProvidersHandler()
	body, _ := json.Marshal(resp.body)
	if strings.Contains(string(body), "secret") || strings.Contains(string(body), "client_id") {
		t.Fatalf("public providers list leaked config: %s", body)
	}
	if !strings.Contains(string(body), `"id":"test"`) {
		t.Fatalf("public providers list missing provider: %s", body)
	}
}

func extractFragToken(t *testing.T, loc string) string {
	t.Helper()
	i := strings.Index(loc, "#")
	if i < 0 {
		t.Fatalf("no fragment in %q", loc)
	}
	vals, err := url.ParseQuery(loc[i+1:])
	if err != nil {
		t.Fatalf("parse fragment: %v", err)
	}
	return vals.Get("token")
}
