package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/TaggedHQ/server/internal/store"
	"github.com/TaggedHQ/server/internal/util"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// Passkey (WebAuthn) support. Credentials live in the user's own database (the
// userinfo table), like TOTP. Passkeys are a passwordless *primary* login: the
// user types their username, then authenticates with the passkey alone. They are
// only offered to password ("non-OAuth") accounts — OAuth users delegate their
// security to the external provider.
const (
	webauthnCredsKey      = "webauthn_credentials" // JSON array of storedCredential
	webauthnHandleKey     = "webauthn_handle"      // base64 user handle (stable per user)
	webauthnSessionCookie = "tt_wa_session"        // signed ceremony state
	webauthnSessionTTL    = 5 * time.Minute
	rpDisplayName         = "Tagged"
)

// storedCredential is a WebAuthn credential plus UI metadata.
type storedCredential struct {
	Credential webauthn.Credential `json:"credential"`
	Label      string              `json:"label"`
	Added      int64               `json:"added"` // unix seconds
}

// webAuthnUser adapts an account to the go-webauthn User interface.
type webAuthnUser struct {
	id    []byte
	name  string
	creds []webauthn.Credential
}

func (u *webAuthnUser) WebAuthnID() []byte                         { return u.id }
func (u *webAuthnUser) WebAuthnName() string                       { return u.name }
func (u *webAuthnUser) WebAuthnDisplayName() string                { return u.name }
func (u *webAuthnUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// ---- storage ----------------------------------------------------------------

func storedCredentials(db store.UserDB) []storedCredential {
	s, _ := userinfoGet(db, webauthnCredsKey).(string)
	if s == "" {
		return nil
	}
	var out []storedCredential
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

func saveStoredCredentials(db store.UserDB, creds []storedCredential) error {
	b, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	return userinfoPut(db, webauthnCredsKey, string(b))
}

// webauthnCreds returns just the credentials for the go-webauthn user.
func webauthnCreds(db store.UserDB) []webauthn.Credential {
	stored := storedCredentials(db)
	creds := make([]webauthn.Credential, 0, len(stored))
	for _, sc := range stored {
		creds = append(creds, sc.Credential)
	}
	return creds
}

// userHandle returns the account's stable WebAuthn user handle, creating and
// persisting one on first use.
func userHandle(db store.UserDB) ([]byte, error) {
	if s, _ := userinfoGet(db, webauthnHandleKey).(string); s != "" {
		if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
			return b, nil
		}
	}
	h := []byte(randSeed(32)) // randSeed returns url-safe base64 text; 32 chars is plenty
	if err := userinfoPut(db, webauthnHandleKey, base64.RawURLEncoding.EncodeToString(h)); err != nil {
		return nil, err
	}
	return h, nil
}

// ---- relying party ----------------------------------------------------------

// webAuthn builds a WebAuthn relying party bound to the host the request came in
// on: RPID is the hostname (no port) and the expected origin is scheme://host.
func (s *Server) webAuthn(req *request) (*webauthn.WebAuthn, error) {
	origin := externalBaseURL(req.r)
	host := origin
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return webauthn.New(&webauthn.Config{
		RPDisplayName: rpDisplayName,
		RPID:          host,
		RPOrigins:     []string{origin},
	})
}

// excludeList builds the credential-exclusion descriptors from existing creds so
// an authenticator isn't enrolled twice.
func excludeList(creds []webauthn.Credential) []protocol.CredentialDescriptor {
	out := make([]protocol.CredentialDescriptor, 0, len(creds))
	for _, c := range creds {
		out = append(out, protocol.CredentialDescriptor{
			Type:         protocol.PublicKeyCredentialType,
			CredentialID: c.ID,
			Transport:    c.Transport,
		})
	}
	return out
}

// ---- ceremony session cookie (signed, not stored server-side) ---------------

// signWebauthnSession serializes the ceremony SessionData into a JWT signed with
// the server key, binding it to username with a short expiry.
func (s *Server) signWebauthnSession(username string, sd *webauthn.SessionData) (string, error) {
	b, err := json.Marshal(sd)
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"username": username,
		"expires":  time.Now().Add(webauthnSessionTTL).Unix(),
		"seed":     base64.RawURLEncoding.EncodeToString(b),
	}
	return util.CreateJWT(payload, s.jwtKey)
}

// readWebauthnSession verifies the signed cookie and returns (username, session).
func (s *Server) readWebauthnSession(token string) (string, *webauthn.SessionData, error) {
	payload, err := util.DecodeJWT(token, s.jwtKey)
	if err != nil {
		return "", nil, err
	}
	if toFloat(payload["expires"]) < float64(time.Now().Unix()) {
		return "", nil, fmt.Errorf("session expired")
	}
	username, _ := payload["username"].(string)
	seed, _ := payload["seed"].(string)
	raw, err := base64.RawURLEncoding.DecodeString(seed)
	if err != nil {
		return "", nil, err
	}
	var sd webauthn.SessionData
	if err := json.Unmarshal(raw, &sd); err != nil {
		return "", nil, err
	}
	if username == "" {
		return "", nil, fmt.Errorf("malformed session")
	}
	return username, &sd, nil
}

func (s *Server) webauthnCookie(value string, req *request, maxAge int) string {
	c := &http.Cookie{
		Name:     webauthnSessionCookie,
		Value:    value,
		Path:     s.cfg.PathPrefix,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   maxAge,
		Secure:   externalScheme(req.r) == "https",
	}
	return c.String()
}

// ---- registration (authenticated, password accounts only) -------------------

// webauthnRegisterBegin issues creation options for enrolling a new passkey.
func (s *Server) webauthnRegisterBegin(req *request, username string, db store.UserDB) response {
	if !hasPassword(db) {
		return textResp(403, "passkeys are only available for password accounts")
	}
	wa, err := s.webAuthn(req)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	handle, err := userHandle(db)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	creds := webauthnCreds(db)
	user := &webAuthnUser{id: handle, name: username, creds: creds}
	creation, sd, err := wa.BeginRegistration(user,
		webauthn.WithExclusions(excludeList(creds)),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
			UserVerification: protocol.VerificationPreferred,
		}),
	)
	if err != nil {
		return textResp(500, "could not start passkey registration: "+err.Error())
	}
	token, err := s.signWebauthnSession(username, sd)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return response{
		status: 200,
		headers: map[string]string{
			"Set-Cookie":    s.webauthnCookie(token, req, int(webauthnSessionTTL.Seconds())),
			"Cache-Control": "no-store",
		},
		body: creation,
	}
}

// webauthnRegisterFinish verifies the attestation and stores the new credential.
func (s *Server) webauthnRegisterFinish(req *request, username string, db store.UserDB) response {
	if !hasPassword(db) {
		return textResp(403, "passkeys are only available for password accounts")
	}
	sessUser, sd, err := s.sessionFromCookie(req)
	if err != nil || sessUser != username {
		return textResp(400, "passkey session is missing or invalid; start again")
	}
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	// The body wraps the credential under {"credential": ..., "label": ...}.
	var wrapper struct {
		Credential json.RawMessage `json:"credential"`
		Label      string          `json:"label"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil || len(wrapper.Credential) == 0 {
		return textResp(400, "bad request: expected {credential, label}")
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(wrapper.Credential))
	if err != nil {
		return textResp(400, "invalid attestation: "+err.Error())
	}
	wa, err := s.webAuthn(req)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	user := &webAuthnUser{id: sd.UserID, name: username, creds: webauthnCreds(db)}
	cred, err := wa.CreateCredential(user, *sd, parsed)
	if err != nil {
		return textResp(400, "could not verify passkey: "+err.Error())
	}
	label := strings.TrimSpace(wrapper.Label)
	if label == "" {
		label = "Passkey"
	}
	if len(label) > 60 {
		label = label[:60]
	}
	stored := storedCredentials(db)
	stored = append(stored, storedCredential{Credential: *cred, Label: label, Added: int64(now())})
	if err := saveStoredCredentials(db, stored); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return response{
		status:  200,
		headers: map[string]string{"Set-Cookie": s.webauthnCookie("", req, -1)},
		body:    map[string]any{"status": "ok", "credentials": publicCredentials(stored)},
	}
}

// ---- passwordless login (unauthenticated, username-first) --------------------

// webauthnLoginBegin issues assertion options for a username's registered
// passkeys.
func (s *Server) webauthnLoginBegin(req *request) response {
	var body struct {
		Username string `json:"username"`
	}
	if err := readJSON(req, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with a username")
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	db, err := s.openUserDB(username)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()
	creds := webauthnCreds(db)
	if len(creds) == 0 {
		return textResp(404, "no passkeys registered for this account")
	}
	handle, err := userHandle(db)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	wa, err := s.webAuthn(req)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	user := &webAuthnUser{id: handle, name: username, creds: creds}
	assertion, sd, err := wa.BeginLogin(user)
	if err != nil {
		return textResp(500, "could not start passkey login: "+err.Error())
	}
	token, err := s.signWebauthnSession(username, sd)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return response{
		status: 200,
		headers: map[string]string{
			"Set-Cookie":    s.webauthnCookie(token, req, int(webauthnSessionTTL.Seconds())),
			"Cache-Control": "no-store",
		},
		body: assertion,
	}
}

// webauthnLoginFinish verifies the assertion and, on success, issues a web-token.
func (s *Server) webauthnLoginFinish(req *request) response {
	username, sd, err := s.sessionFromCookie(req)
	if err != nil {
		return textResp(400, "passkey session is missing or invalid; start again")
	}
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(bytes.NewReader(raw))
	if err != nil {
		return textResp(400, "invalid assertion: "+err.Error())
	}
	db, err := s.openUserDB(username)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()
	stored := storedCredentials(db)
	if len(stored) == 0 {
		return textResp(403, "no passkeys registered for this account")
	}
	wa, err := s.webAuthn(req)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	handle, _ := userHandle(db)
	user := &webAuthnUser{id: handle, name: username, creds: webauthnCreds(db)}
	cred, err := wa.ValidateLogin(user, *sd, parsed)
	if err != nil {
		return textResp(403, "passkey verification failed")
	}
	// Persist the updated sign count (clone-detection state) for the used credential.
	for i := range stored {
		if bytes.Equal(stored[i].Credential.ID, cred.ID) {
			stored[i].Credential = *cred
			_ = saveStoredCredentials(db, stored)
			break
		}
	}
	webtoken, err := s.getWebtokenUnsafe(username, false)
	if err != nil {
		return tokenErrResp(err)
	}
	return response{
		status:  200,
		headers: map[string]string{"Set-Cookie": s.webauthnCookie("", req, -1)},
		body:    map[string]any{"token": webtoken, "username": username},
	}
}

// ---- credential management (authenticated) ----------------------------------

// webauthnListCredentials returns the account's passkeys (no secrets).
func (s *Server) webauthnListCredentials(db store.UserDB) response {
	return jsonResp(200, map[string]any{"credentials": publicCredentials(storedCredentials(db))})
}

// webauthnDeleteCredential removes a passkey by its (base64url) id.
func (s *Server) webauthnDeleteCredential(req *request, db store.UserDB) response {
	var body struct {
		ID string `json:"id"`
	}
	if err := readJSON(req, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with an id")
	}
	id := strings.TrimSpace(body.ID)
	if id == "" {
		return textResp(400, "id is required")
	}
	stored := storedCredentials(db)
	kept := stored[:0]
	removed := false
	for _, sc := range stored {
		if base64.RawURLEncoding.EncodeToString(sc.Credential.ID) == id {
			removed = true
			continue
		}
		kept = append(kept, sc)
	}
	if !removed {
		return textResp(404, "passkey not found")
	}
	if err := saveStoredCredentials(db, kept); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "credentials": publicCredentials(kept)})
}

// publicCredentials projects stored credentials to safe display fields.
func publicCredentials(stored []storedCredential) []map[string]any {
	out := make([]map[string]any, 0, len(stored))
	for _, sc := range stored {
		out = append(out, map[string]any{
			"id":    base64.RawURLEncoding.EncodeToString(sc.Credential.ID),
			"label": sc.Label,
			"added": sc.Added,
		})
	}
	return out
}

// ---- helpers ----------------------------------------------------------------

// sessionFromCookie reads and verifies the ceremony cookie from the request.
func (s *Server) sessionFromCookie(req *request) (string, *webauthn.SessionData, error) {
	c, err := req.r.Cookie(webauthnSessionCookie)
	if err != nil {
		return "", nil, err
	}
	return s.readWebauthnSession(c.Value)
}

// hasPassword reports whether the account has a password set, i.e. it is a
// "non-OAuth" account eligible for TOTP and passkeys.
func hasPassword(db store.UserDB) bool {
	ob, err := db.Get("userinfo", passwordHashKey)
	if err != nil || ob == nil {
		return false
	}
	v, _ := ob["value"].(string)
	return v != ""
}
