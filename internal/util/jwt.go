// Package util ports the JWT and username helpers from timetagger/server/_utils.py.
package util

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// CreateJWT builds an HS256 JWT for the given payload, signed with key. It
// requires the same fields as create_jwt in _utils.py.
func CreateJWT(payload map[string]any, key string) (string, error) {
	for _, k := range []string{"username", "expires", "seed"} {
		if _, ok := payload[k]; !ok {
			return "", fmt.Errorf("JWT must have a %s field", k)
		}
	}
	header := map[string]any{"alg": "HS256", "typ": "JWT"}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	pb, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	seg := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(pb)
	sig := sign(seg, key)
	return seg + "." + sig, nil
}

// DecodeJWT verifies an HS256 token against key and returns its payload. It
// verifies the signature over the token's raw header.payload segments, so tokens
// issued by the Python server (same key) validate here and vice versa. It does
// NOT check the `expires` claim — the caller (authenticate) does that, matching
// PyJWT's behavior for this non-registered claim.
func DecodeJWT(token, key string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("not enough segments")
	}
	// Confirm the header declares HS256.
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("invalid header: %w", err)
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(hb, &header); err != nil {
		return nil, fmt.Errorf("invalid header: %w", err)
	}
	if header.Alg != "HS256" {
		return nil, fmt.Errorf("unexpected algorithm: %s", header.Alg)
	}
	// Verify signature over "header.payload".
	expected := sign(parts[0]+"."+parts[1], key)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(parts[2])) != 1 {
		return nil, errors.New("signature verification failed")
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("invalid payload: %w", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(pb, &payload); err != nil {
		return nil, fmt.Errorf("invalid payload: %w", err)
	}
	return payload, nil
}

func sign(seg, key string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(seg))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
