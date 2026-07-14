package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/webauthn"
)

// doAPI runs an authenticated (if token != "") request through the full handler.
func doAPI(t *testing.T, s *Server, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	if token != "" {
		r.Header.Set("authtoken", token)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

// mkPasswordUser registers a password account and returns a web-token for it.
func mkPasswordUser(t *testing.T, s *Server, username, password string) string {
	t.Helper()
	if status, err := s.registerUser(username, password); err != nil {
		t.Fatalf("registerUser: %d %v", status, err)
	}
	tok, err := s.getWebtokenUnsafe(username, false)
	if err != nil {
		t.Fatalf("getWebtokenUnsafe: %v", err)
	}
	return tok
}

// mkOAuthUser provisions an OAuth-only account (no password) and returns a token.
func mkOAuthUser(t *testing.T, s *Server, username string) string {
	t.Helper()
	if err := s.provisionOAuthUser(username, "google"); err != nil {
		t.Fatalf("provisionOAuthUser: %v", err)
	}
	tok, err := s.getWebtokenUnsafe(username, false)
	if err != nil {
		t.Fatalf("getWebtokenUnsafe: %v", err)
	}
	return tok
}

func TestHasPasswordDistinguishesAccounts(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "pw@x.com", "secret")
	mkOAuthUser(t, s, "oauth@x.com")

	pwDB, _ := s.openUserDB("pw@x.com")
	defer pwDB.Close()
	oaDB, _ := s.openUserDB("oauth@x.com")
	defer oaDB.Close()

	if !hasPassword(pwDB) {
		t.Error("password account should report hasPassword=true")
	}
	if hasPassword(oaDB) {
		t.Error("oauth-only account should report hasPassword=false")
	}
}

func TestTOTPAndPasskeyBlockedForOAuthUser(t *testing.T) {
	s := newTestServer(t)
	tok := mkOAuthUser(t, s, "oauth@x.com")

	for _, path := range []string{"/api/v2/totp/setup", "/api/v2/webauthn/register/begin"} {
		w := doAPI(t, s, "POST", path, tok, "")
		if w.Code != 403 {
			t.Errorf("%s for oauth user = %d, want 403 (body=%s)", path, w.Code, w.Body.String())
		}
	}
}

func TestPasskeyRegisterBeginForPasswordUser(t *testing.T) {
	s := newTestServer(t)
	tok := mkPasswordUser(t, s, "pw@x.com", "secret")

	w := doAPI(t, s, "POST", "/api/v2/webauthn/register/begin", tok, "")
	if w.Code != 200 {
		t.Fatalf("register/begin = %d, want 200 (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "\"publicKey\"") || !strings.Contains(body, "\"challenge\"") {
		t.Errorf("register options missing publicKey/challenge: %s", body)
	}
	if !strings.Contains(w.Header().Get("Set-Cookie"), webauthnSessionCookie) {
		t.Errorf("expected %s cookie to be set, got %q", webauthnSessionCookie, w.Header().Get("Set-Cookie"))
	}
}

func TestPasskeyLoginBegin(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "pw@x.com", "secret")

	// No passkeys registered yet: begin should 404.
	w := doAPI(t, s, "POST", "/api/v2/webauthn/login/begin", "", `{"username":"pw@x.com"}`)
	if w.Code != 404 {
		t.Fatalf("login/begin without passkeys = %d, want 404", w.Code)
	}

	// Inject a stored credential, then begin should return assertion options.
	db, _ := s.openUserDB("pw@x.com")
	if err := saveStoredCredentials(db, []storedCredential{{
		Credential: webauthn.Credential{ID: []byte("credential-id-bytes")},
		Label:      "Test key", Added: int64(now()),
	}}); err != nil {
		t.Fatal(err)
	}
	db.Close()

	w = doAPI(t, s, "POST", "/api/v2/webauthn/login/begin", "", `{"username":"pw@x.com"}`)
	if w.Code != 200 {
		t.Fatalf("login/begin = %d, want 200 (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "\"challenge\"") {
		t.Errorf("assertion options missing challenge: %s", w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Set-Cookie"), webauthnSessionCookie) {
		t.Error("expected session cookie on login/begin")
	}
}

func TestPasskeyCredentialListAndDelete(t *testing.T) {
	s := newTestServer(t)
	tok := mkPasswordUser(t, s, "pw@x.com", "secret")

	db, _ := s.openUserDB("pw@x.com")
	_ = saveStoredCredentials(db, []storedCredential{
		{Credential: webauthn.Credential{ID: []byte("id-one")}, Label: "One", Added: int64(now())},
		{Credential: webauthn.Credential{ID: []byte("id-two")}, Label: "Two", Added: int64(now())},
	})
	db.Close()

	w := doAPI(t, s, "GET", "/api/v2/webauthn/credentials", tok, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "\"One\"") || !strings.Contains(w.Body.String(), "\"Two\"") {
		t.Fatalf("list = %d body=%s", w.Code, w.Body.String())
	}
	// The public list must never leak internal credential material.
	if strings.Contains(w.Body.String(), "publicKey") || strings.Contains(w.Body.String(), "authenticator") {
		t.Errorf("credential list leaked internal fields: %s", w.Body.String())
	}

	// Delete "id-one" (base64url of the raw id).
	idOne := b64url("id-one")
	w = doAPI(t, s, "DELETE", "/api/v2/webauthn/credentials", tok, `{"id":"`+idOne+`"}`)
	if w.Code != 200 {
		t.Fatalf("delete = %d body=%s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "\"One\"") || !strings.Contains(w.Body.String(), "\"Two\"") {
		t.Errorf("after delete, expected only Two to remain: %s", w.Body.String())
	}
}

func TestWebauthnSessionCookieRoundTrip(t *testing.T) {
	s := newTestServer(t)
	sd := &webauthn.SessionData{Challenge: "abc123", UserID: []byte("uid")}
	token, err := s.signWebauthnSession("alice@x.com", sd)
	if err != nil {
		t.Fatal(err)
	}
	user, got, err := s.readWebauthnSession(token)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if user != "alice@x.com" || got.Challenge != "abc123" || string(got.UserID) != "uid" {
		t.Errorf("round-trip mismatch: user=%q sd=%+v", user, got)
	}
	// A token signed with a different key must not verify.
	if _, _, err := s.readWebauthnSession(token + "x"); err == nil {
		t.Error("tampered token should fail verification")
	}
}

func TestWhoamiExposesAccountType(t *testing.T) {
	s := newTestServer(t)
	tok := mkPasswordUser(t, s, "pw@x.com", "secret")
	w := doAPI(t, s, "GET", "/api/v2/whoami", tok, "")
	b := w.Body.String()
	if !strings.Contains(b, "\"has_password\":true") || !strings.Contains(b, "\"passkeys\":0") {
		t.Errorf("whoami missing account-type fields: %s", b)
	}
}

// b64url is a tiny helper mirroring base64.RawURLEncoding for test ids.
func b64url(s string) string {
	return publicCredentials([]storedCredential{{Credential: webauthn.Credential{ID: []byte(s)}}})[0]["id"].(string)
}
