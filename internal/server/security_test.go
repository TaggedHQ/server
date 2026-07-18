package server

import (
	"encoding/base64"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// login posts a password (and optional TOTP code) the way the UI does.
func login(t *testing.T, s *Server, username, password string) int {
	t.Helper()
	body := `{"method":"usernamepassword","username":"` + username + `","password":"` + password + `"}`
	w := doAPI(t, s, "POST", "/api/v2/bootstrap_authentication", "",
		base64.StdEncoding.EncodeToString([]byte(body)))
	return w.Code
}

// Unlimited guessing is what makes a six-digit second factor breakable, so a
// run of failures has to start being refused.
func TestLoginThrottlesRepeatedFailures(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "victim@x.com", "correct-horse")

	locked := false
	for i := 0; i < userBurst+2; i++ {
		if login(t, s, "victim@x.com", "wrong") == 429 {
			locked = true
			break
		}
	}
	if !locked {
		t.Fatalf("still accepting guesses after %d failures", userBurst+2)
	}

	// The right password is refused too while the account is locked, otherwise
	// the limit would only slow down the wrong guesses.
	if got := login(t, s, "victim@x.com", "correct-horse"); got != 429 {
		t.Errorf("during lockout the correct password returned %d, want 429", got)
	}
}

// A locked key must recover on its own, or a few fat-fingered attempts would
// lock someone out until a restart.
func TestLoginLockoutDecaysOverTime(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "victim@x.com", "correct-horse")

	base := time.Now()
	s.loginLimit.now = func() time.Time { return base }
	for i := 0; i < userBurst+2; i++ {
		login(t, s, "victim@x.com", "wrong")
	}
	if got := login(t, s, "victim@x.com", "correct-horse"); got != 429 {
		t.Fatalf("expected a lockout, got %d", got)
	}

	// Far enough ahead that every charged failure has aged out.
	s.loginLimit.now = func() time.Time { return base.Add(loginRefill * (userBurst + 4)) }
	if got := login(t, s, "victim@x.com", "correct-horse"); got != 200 {
		t.Errorf("after the lockout decayed, login returned %d, want 200", got)
	}
}

// A success clears the counter, so an earlier typo does not count against the
// next attempt.
func TestSuccessfulLoginClearsFailures(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "victim@x.com", "correct-horse")

	for i := 0; i < userBurst-1; i++ {
		login(t, s, "victim@x.com", "wrong")
	}
	if got := login(t, s, "victim@x.com", "correct-horse"); got != 200 {
		t.Fatalf("login before the limit returned %d, want 200", got)
	}
	// The budget is back: another near-full run of failures must not lock out.
	for i := 0; i < userBurst-1; i++ {
		if got := login(t, s, "victim@x.com", "wrong"); got == 429 {
			t.Fatalf("locked out at failure %d after a success reset the counter", i+1)
		}
	}
}

// The HTML pages must carry a policy that forbids inline script, which is what
// turns an injected attribute from a takeover into a no-op.
func TestHTMLCarriesContentSecurityPolicy(t *testing.T) {
	s := newTestServer(t)
	w := doAPI(t, s, "GET", "/login", "", "")
	if w.Code != 200 {
		t.Fatalf("GET /login: %d", w.Code)
	}
	csp := w.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("no Content-Security-Policy header on an HTML page")
	}
	if !strings.Contains(csp, "script-src 'self'") {
		t.Errorf("CSP does not pin script-src: %q", csp)
	}
	if strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Error("CSP allows inline script, which defeats the point")
	}
	for _, h := range []string{"X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"} {
		if w.Header().Get(h) == "" {
			t.Errorf("missing %s header", h)
		}
	}
}

// The CSP only holds if no page actually needs inline script.
func TestPagesHoldNoInlineScript(t *testing.T) {
	s := newTestServer(t)
	for _, p := range []string{"/", "/login", "/users", "/groups", "/account", "/tags"} {
		w := doAPI(t, s, "GET", p, "", "")
		if w.Code != 200 {
			continue // module pages may be switched off on a default server
		}
		if strings.Contains(w.Body.String(), "<script>") {
			t.Errorf("%s contains an inline <script>, which the CSP will block", p)
		}
	}
}

// Behind a reverse proxy every request shares the proxy's address, so keying on
// the peer would let one attacker lock out the whole user base. A proxied
// request must be identified by its forwarded client, and an unidentifiable one
// must contribute no address key at all.
func TestLimiterIPIsProxyAware(t *testing.T) {
	s := newTestServer(t) // trusts 127.0.0.1 by default

	r := httptest.NewRequest("POST", "/api/v2/bootstrap_authentication", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	if got := s.limiterIP(r); got != "" {
		t.Errorf("proxied request with no XFF gave key %q, want none", got)
	}

	r.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	if got := s.limiterIP(r); got != "203.0.113.9" {
		t.Errorf("limiterIP = %q, want the left-most forwarded client", got)
	}

	// An untrusted peer is taken at face value; its XFF is attacker-controlled.
	direct := httptest.NewRequest("POST", "/api/v2/bootstrap_authentication", nil)
	direct.RemoteAddr = "198.51.100.7:5000"
	direct.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := s.limiterIP(direct); got != "198.51.100.7" {
		t.Errorf("limiterIP = %q, want the peer address for an untrusted client", got)
	}
}

// Locking one account must not lock the next, or a single attacker takes the
// whole server down by guessing at one name.
func TestOneAccountLockoutDoesNotLockAnother(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "victim@x.com", "correct-horse")
	mkPasswordUser(t, s, "bystander@x.com", "other-secret")

	for i := 0; i < userBurst+2; i++ {
		login(t, s, "victim@x.com", "wrong")
	}
	if got := login(t, s, "victim@x.com", "correct-horse"); got != 429 {
		t.Fatalf("victim not locked out: %d", got)
	}
	if got := login(t, s, "bystander@x.com", "other-secret"); got != 200 {
		t.Errorf("bystander login returned %d, want 200", got)
	}
}
