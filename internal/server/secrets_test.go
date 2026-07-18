package server

import (
	"strings"
	"testing"
	"time"
)

// rawUserinfo reads a userinfo value straight out of the database, bypassing the
// decryption helpers -- this is what someone holding the database file sees.
func rawUserinfo(t *testing.T, s *Server, username, key string) string {
	t.Helper()
	db, err := s.openUserDB(username)
	if err != nil {
		t.Fatalf("openUserDB: %v", err)
	}
	defer db.Close()
	v, _ := userinfoGet(db, key).(string)
	return v
}

// enrolTOTP turns on two-factor for a user and returns the secret.
func enrolTOTP(t *testing.T, s *Server, username string) string {
	t.Helper()
	db, err := s.openUserDB(username)
	if err != nil {
		t.Fatalf("openUserDB: %v", err)
	}
	defer db.Close()
	secret := generateTOTPSecret()
	if err := firstErr(
		s.writeSecret(db, totpSecretKey, secret),
		userinfoPut(db, totpEnabledKey, true),
	); err != nil {
		t.Fatalf("enrol: %v", err)
	}
	return secret
}

// The whole point: the secret must not be sitting in the database in the clear.
func TestTOTPSecretIsNotStoredInTheClear(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "u@x.com", "secret")
	plain := enrolTOTP(t, s, "u@x.com")

	stored := rawUserinfo(t, s, "u@x.com", totpSecretKey)
	if stored == plain {
		t.Fatal("the TOTP secret is stored verbatim")
	}
	if strings.Contains(stored, plain) {
		t.Fatal("the stored value still contains the plaintext secret")
	}
	if !strings.HasPrefix(stored, secretEnvelopePrefix) {
		t.Errorf("stored value %q is not a sealed envelope", stored)
	}
	// And it still round-trips for the server itself.
	db, _ := s.openUserDB("u@x.com")
	defer db.Close()
	if got := s.totpSecretOf(db); got != plain {
		t.Errorf("decrypted secret = %q, want %q", got, plain)
	}
}

// A code generated from the enrolled secret must still verify, or the
// encryption would have broken two-factor outright.
func TestTOTPStillVerifiesWhenEncrypted(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "u@x.com", "secret")
	secret := enrolTOTP(t, s, "u@x.com")

	code, err := totpAt(secret, time.Now().Unix())
	if err != nil {
		t.Fatalf("totpAt: %v", err)
	}
	if !s.verifyMFACode("u@x.com", code) {
		t.Error("a valid code was rejected after the secret was encrypted")
	}
	if s.verifyMFACode("u@x.com", "000000") {
		t.Error("an invalid code was accepted")
	}
}

// Servers upgrading from an earlier build have plaintext secrets on disk. They
// must keep working, and must be sealed the first time they are read.
func TestLegacyPlaintextSecretIsReadAndMigrated(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "u@x.com", "secret")

	// Write it the old way: straight in, unencrypted.
	secret := generateTOTPSecret()
	db, err := s.openUserDB("u@x.com")
	if err != nil {
		t.Fatalf("openUserDB: %v", err)
	}
	if err := firstErr(
		userinfoPut(db, totpSecretKey, secret),
		userinfoPut(db, totpEnabledKey, true),
	); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if got := rawUserinfo(t, s, "u@x.com", totpSecretKey); got != secret {
		t.Fatalf("precondition: wanted a plaintext secret on disk, got %q", got)
	}

	// Reading it returns the secret and rewrites it sealed.
	if got := s.totpSecretOf(db); got != secret {
		t.Errorf("legacy secret read as %q, want %q", got, secret)
	}
	db.Close()

	stored := rawUserinfo(t, s, "u@x.com", totpSecretKey)
	if !strings.HasPrefix(stored, secretEnvelopePrefix) {
		t.Errorf("legacy secret was not migrated: %q", stored)
	}
	// Still usable after the migration.
	code, _ := totpAt(secret, time.Now().Unix())
	if !s.verifyMFACode("u@x.com", code) {
		t.Error("a valid code was rejected after migration")
	}
}

// Sealing is nonce-based, so the same input must not produce the same output --
// otherwise equal ciphertexts would reveal which users share a secret.
func TestSealingUsesAFreshNonce(t *testing.T) {
	s := newTestServer(t)
	a, err := s.sealSecret("SAMESECRET")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	b, err := s.sealSecret("SAMESECRET")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if a == b {
		t.Error("sealing the same value twice produced identical ciphertext")
	}
	for _, c := range []string{a, b} {
		got, encrypted := s.openSecret(c)
		if !encrypted || got != "SAMESECRET" {
			t.Errorf("openSecret(%q) = %q, %v", c, got, encrypted)
		}
	}
}

// If jwt.key is regenerated the secrets cannot be recovered. That must fail
// closed -- report nothing rather than hand back garbage the server would then
// treat as a real secret.
func TestSecretFromAnotherKeyDoesNotOpen(t *testing.T) {
	s := newTestServer(t)
	sealed, err := s.sealSecret("SOMESECRET")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	other := newTestServer(t) // its own datadir, so its own jwt.key
	got, encrypted := other.openSecret(sealed)
	if !encrypted {
		t.Error("a sealed value was not recognised as sealed")
	}
	if got != "" {
		t.Errorf("a foreign secret opened as %q, want it refused", got)
	}
}

// The derived key must not be the JWT key itself, so that a leak of one is not
// automatically a leak of the other.
func TestSecretKeyIsDerivedNotReused(t *testing.T) {
	s := newTestServer(t)
	if string(s.secretKey) == s.jwtKey {
		t.Error("the secret key is the JWT key verbatim")
	}
	if len(s.secretKey) != 32 {
		t.Errorf("secret key is %d bytes, want 32", len(s.secretKey))
	}
	// Derivation is deterministic: a restart must reach the same key, or every
	// stored secret would be lost on boot.
	again, err := deriveSecretKey(s.jwtKey)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if string(again) != string(s.secretKey) {
		t.Error("deriving the key twice gave different results")
	}
}

// The pending secret written during enrolment is a real secret too.
func TestPendingSecretIsAlsoEncrypted(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "u@x.com", "secret")
	token := mkPasswordUser(t, s, "v@x.com", "secret")

	w := doAPI(t, s, "POST", "/api/v2/totp/setup", token, "")
	if w.Code != 200 {
		t.Fatalf("totp/setup: %d %s", w.Code, w.Body.String())
	}
	stored := rawUserinfo(t, s, "v@x.com", totpPendingKey)
	if stored == "" {
		t.Fatal("no pending secret was stored")
	}
	if !strings.HasPrefix(stored, secretEnvelopePrefix) {
		t.Errorf("the pending secret is stored in the clear: %q", stored)
	}
}
