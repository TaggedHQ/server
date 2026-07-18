package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log"
	"strings"

	"golang.org/x/crypto/hkdf"

	"github.com/TaggedHQ/server/internal/store"
)

// Encryption for the secrets that have to be stored recoverably.
//
// A password can be hashed, because verifying it only needs a comparison. A
// TOTP secret cannot: the server has to reproduce the code, so it needs the
// secret back. Stored as-is it is a standing offer to anyone who gets hold of
// the database -- a Postgres replica, a nightly backup, a copied volume -- to
// mint valid second factors indefinitely, without touching the server.
//
// What this does and does not buy:
//
//   - It protects a database seen on its own: dumps, backups, a remote
//     Postgres, a disk image of the data volume minus the key file.
//   - It does NOT protect against someone who reads the whole data directory,
//     because the key is derived from jwt.key, which lives there. Separating
//     them would mean a second secret for the operator to place and never lose,
//     and losing it would strand every enrolled user.
//
// Losing or regenerating jwt.key makes stored secrets undecryptable. That is
// survivable: affected users fall back to their backup codes (bcrypt hashed,
// unaffected) or an admin reset, rather than being locked out for good.

// secretEnvelopePrefix marks a stored value as encrypted. Anything without it is
// read as a legacy plaintext secret and re-written sealed, so an existing server
// migrates as its users sign in rather than needing a batch pass.
const secretEnvelopePrefix = "enc.v1."

// secretKeyInfo domain-separates this key from any other use of the JWT key, so
// the token signer and the secret sealer never share key material.
const secretKeyInfo = "tagged.totp-secret.v1"

// deriveSecretKey turns the server's JWT key into a 32-byte AES-256 key.
func deriveSecretKey(jwtKey string) ([]byte, error) {
	key := make([]byte, 32)
	r := hkdf.New(sha256.New, []byte(jwtKey), nil, []byte(secretKeyInfo))
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, err
	}
	return key, nil
}

// aead builds the AES-GCM cipher for the derived key.
func (s *Server) aead() (cipher.AEAD, error) {
	block, err := aes.NewCipher(s.secretKey)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// sealSecret encrypts plain into a self-describing string. Each call draws a
// fresh nonce, so enrolling the same secret twice never produces equal
// ciphertext.
func (s *Server) sealSecret(plain string) (string, error) {
	gcm, err := s.aead()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return secretEnvelopePrefix + base64.RawURLEncoding.EncodeToString(sealed), nil
}

// openSecret decrypts a stored value. encrypted reports whether the value was
// sealed, which is how the caller knows a legacy plaintext needs migrating.
// A sealed value that will not open yields "", so the account falls back to
// backup codes instead of the server trusting a corrupt secret.
func (s *Server) openSecret(stored string) (plain string, encrypted bool) {
	if !strings.HasPrefix(stored, secretEnvelopePrefix) {
		return stored, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(stored, secretEnvelopePrefix))
	if err != nil {
		log.Printf("stored secret is not decodable; treating it as unset")
		return "", true
	}
	gcm, err := s.aead()
	if err != nil || len(raw) < gcm.NonceSize() {
		return "", true
	}
	out, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		// Almost always a jwt.key that was regenerated or restored from a
		// different server; say so once rather than failing mutely.
		log.Printf("could not decrypt a stored secret (has jwt.key changed?); treating it as unset")
		return "", true
	}
	return string(out), true
}

// readSecret returns the plaintext behind a userinfo key, migrating a legacy
// plaintext value to sealed storage as a side effect. The rewrite is
// best-effort: failing to migrate must not stop a user logging in.
func (s *Server) readSecret(db store.UserDB, key string) string {
	raw, _ := userinfoGet(db, key).(string)
	if raw == "" {
		return ""
	}
	plain, encrypted := s.openSecret(raw)
	if !encrypted && plain != "" {
		if err := s.writeSecret(db, key, plain); err != nil {
			log.Printf("could not encrypt a stored secret in place: %v", err)
		}
	}
	return plain
}

// writeSecret stores plain sealed. An empty value clears the key, and is stored
// as-is: there is nothing to hide about "unset", and a sealed empty string would
// make totpEnabled-style checks harder to read.
func (s *Server) writeSecret(db store.UserDB, key, plain string) error {
	if plain == "" {
		return userinfoPut(db, key, "")
	}
	sealed, err := s.sealSecret(plain)
	if err != nil {
		return err
	}
	return userinfoPut(db, key, sealed)
}
