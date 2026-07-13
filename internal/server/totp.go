package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/TaggedHQ/server/internal/store"
	qrcode "github.com/skip2/go-qrcode"
	"golang.org/x/crypto/bcrypt"
)

// TOTP (RFC 6238) two-factor auth. Secrets, the enabled flag and hashed backup
// codes are stored in the user's own database (the userinfo key/value table), so
// no schema change or global datastore is needed.
const (
	totpSecretKey  = "totp_secret"       // base32 secret, present only once enabled
	totpPendingKey = "totp_pending"      // base32 secret during setup, before confirm
	totpEnabledKey = "totp_enabled"      // bool
	totpBackupKey  = "totp_backup_codes" // JSON array of bcrypt hashes (as a string)

	totpIssuer  = "Tagged"
	totpPeriod  = 30
	totpDigits  = 6
	backupCount = 10
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// ---- core algorithm ---------------------------------------------------------

func generateTOTPSecret() string {
	buf := make([]byte, 20) // 160-bit, per RFC 4226 recommendation
	_, _ = rand.Read(buf)
	return b32.EncodeToString(buf)
}

// totpAt computes the 6-digit code for a secret at unix time t.
func totpAt(secret string, t int64) (string, error) {
	key, err := b32.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", err
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(t/totpPeriod))
	h := hmac.New(sha1.New, key)
	h.Write(msg[:])
	sum := h.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := (uint32(sum[off]&0x7f) << 24) | (uint32(sum[off+1]) << 16) |
		(uint32(sum[off+2]) << 8) | uint32(sum[off+3])
	return fmt.Sprintf("%0*d", totpDigits, bin%1_000_000), nil
}

// verifyTOTP checks a code against the secret, allowing ±1 time step of skew.
func verifyTOTP(secret, code string) bool {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits {
		return false
	}
	t := time.Now().Unix()
	for _, skew := range []int64{0, -1, 1} {
		want, err := totpAt(secret, t+skew*totpPeriod)
		if err != nil {
			return false
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

// totpURI builds the otpauth:// URI a QR code encodes for authenticator apps.
func totpURI(secret, username string) string {
	label := url.PathEscape(totpIssuer + ":" + username)
	v := url.Values{}
	v.Set("secret", secret)
	v.Set("issuer", totpIssuer)
	v.Set("algorithm", "SHA1")
	v.Set("digits", fmt.Sprint(totpDigits))
	v.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + label + "?" + v.Encode()
}

// qrDataURI renders content as a QR code and returns it as a PNG data URI.
func qrDataURI(content string) (string, error) {
	png, err := qrcode.Encode(content, qrcode.Medium, 256)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

// ---- backup recovery codes --------------------------------------------------

// generateBackupCodes returns human-friendly single-use recovery codes using an
// unambiguous alphabet (no 0/o/1/l/i).
func generateBackupCodes(n int) []string {
	const alphabet = "23456789abcdefghjkmnpqrstuvwxyz"
	codes := make([]string, n)
	for i := range codes {
		raw := make([]byte, 10)
		_, _ = rand.Read(raw)
		s := make([]byte, 10)
		for j := range s {
			s[j] = alphabet[int(raw[j])%len(alphabet)]
		}
		codes[i] = string(s[:5]) + "-" + string(s[5:])
	}
	return codes
}

func normalizeBackup(code string) string {
	return strings.ToLower(strings.TrimSpace(code))
}

// ---- userinfo storage helpers ----------------------------------------------

func userinfoGet(db store.UserDB, key string) any {
	ob, err := db.Get("userinfo", key)
	if err != nil || ob == nil {
		return nil
	}
	return ob["value"]
}

func userinfoPut(db store.UserDB, key string, value any) error {
	st := now()
	return db.Write(func(tx store.WTx) error {
		return tx.Upsert("userinfo", store.Item{"key": key, "st": st, "mt": st, "value": value})
	})
}

func totpEnabled(db store.UserDB) bool {
	b, _ := userinfoGet(db, totpEnabledKey).(bool)
	return b
}

func totpSecretOf(db store.UserDB) string {
	s, _ := userinfoGet(db, totpSecretKey).(string)
	return s
}

func setBackupCodes(db store.UserDB, plain []string) error {
	hashes := make([]string, len(plain))
	for i, c := range plain {
		h, err := bcrypt.GenerateFromPassword([]byte(normalizeBackup(c)), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		hashes[i] = string(h)
	}
	b, _ := json.Marshal(hashes)
	return userinfoPut(db, totpBackupKey, string(b))
}

func backupHashes(db store.UserDB) []string {
	s, _ := userinfoGet(db, totpBackupKey).(string)
	if s == "" {
		return nil
	}
	var hashes []string
	_ = json.Unmarshal([]byte(s), &hashes)
	return hashes
}

// consumeBackupCode returns true if code matches an unused backup code, and
// removes it so each code works only once.
func consumeBackupCode(db store.UserDB, code string) bool {
	code = normalizeBackup(code)
	if code == "" {
		return false
	}
	hashes := backupHashes(db)
	for i, h := range hashes {
		if bcrypt.CompareHashAndPassword([]byte(h), []byte(code)) == nil {
			remaining := append(append([]string{}, hashes[:i]...), hashes[i+1:]...)
			b, _ := json.Marshal(remaining)
			_ = userinfoPut(db, totpBackupKey, string(b))
			return true
		}
	}
	return false
}

// ---- login-time checks (open the user's DB by username) ---------------------

// userMFAEnabled reports whether the user has TOTP enabled.
func (s *Server) userMFAEnabled(username string) bool {
	db, err := s.openUserDB(username)
	if err != nil {
		return false
	}
	defer db.Close()
	return totpEnabled(db)
}

// verifyMFACode validates a TOTP code or a backup code for the user. If MFA is
// not enabled it returns true (nothing to check).
func (s *Server) verifyMFACode(username, code string) bool {
	db, err := s.openUserDB(username)
	if err != nil {
		return false
	}
	defer db.Close()
	if !totpEnabled(db) {
		return true
	}
	if secret := totpSecretOf(db); secret != "" && verifyTOTP(secret, code) {
		return true
	}
	return consumeBackupCode(db, code)
}

// ---- endpoints (authenticated with a web-token) -----------------------------

// totpSetup provisions a fresh (pending) secret and returns it plus the
// otpauth URI for the QR code. It does not enable TOTP yet.
func (s *Server) totpSetup(authInfo map[string]any, db store.UserDB) response {
	if totpEnabled(db) {
		return textResp(409, "two-factor authentication is already enabled")
	}
	secret := generateTOTPSecret()
	if err := userinfoPut(db, totpPendingKey, secret); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	username, _ := authInfo["username"].(string)
	uri := totpURI(secret, username)
	qr, err := qrDataURI(uri)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"secret": secret, "uri": uri, "qr": qr})
}

// totpEnable confirms the pending secret with a code, turns TOTP on, and returns
// the one-time backup codes (shown to the user only here).
func (s *Server) totpEnable(req *request, db store.UserDB) response {
	if totpEnabled(db) {
		return textResp(409, "two-factor authentication is already enabled")
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := readJSON(req, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with a code")
	}
	secret, _ := userinfoGet(db, totpPendingKey).(string)
	if secret == "" {
		return textResp(400, "no setup in progress; call totp/setup first")
	}
	if !verifyTOTP(secret, body.Code) {
		return textResp(400, "invalid code")
	}
	codes := generateBackupCodes(backupCount)
	if err := firstErr(
		userinfoPut(db, totpSecretKey, secret),
		userinfoPut(db, totpEnabledKey, true),
		userinfoPut(db, totpPendingKey, ""),
		setBackupCodes(db, codes),
	); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "backup_codes": codes})
}

// totpDisable turns TOTP off. It requires a valid current code (or backup code)
// so a stolen web session alone cannot remove the second factor silently.
func (s *Server) totpDisable(req *request, db store.UserDB) response {
	if !totpEnabled(db) {
		return jsonResp(200, map[string]any{"status": "ok"})
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := readJSON(req, &body); err != nil {
		return textResp(400, "bad request: body must be JSON with a code")
	}
	secret := totpSecretOf(db)
	if !(secret != "" && verifyTOTP(secret, body.Code)) && !consumeBackupCode(db, body.Code) {
		return textResp(400, "invalid code")
	}
	if err := firstErr(
		userinfoPut(db, totpEnabledKey, false),
		userinfoPut(db, totpSecretKey, ""),
		userinfoPut(db, totpPendingKey, ""),
		userinfoPut(db, totpBackupKey, ""),
	); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// ---- small helpers ----------------------------------------------------------

func readJSON(req *request, v any) error {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// isWebtoken reports whether authInfo came from a web-token (not an api-token).
// Sensitive account operations require a web-token.
func isWebtoken(authInfo map[string]any) bool {
	return toFloat(authInfo["expires"]) <= now()+webtokenLifetime
}
