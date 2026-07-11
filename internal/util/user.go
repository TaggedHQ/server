package util

import (
	"encoding/base64"
	"path/filepath"
	"strings"
)

const okChars = "-_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func isOkChar(r rune) bool {
	return strings.ContainsRune(okChars, r)
}

// User2Filename converts a username (e.g. an email address) to the absolute
// filename of its per-user database. It builds a human-recognizable "clean"
// prefix plus a reversible urlsafe-base64 encoding, exactly like
// _utils.user2filename so existing database files map to the same users.
func User2Filename(rootUserDir, username string) string {
	var clean strings.Builder
	for _, c := range username {
		if isOkChar(c) {
			clean.WriteRune(c)
		} else {
			clean.WriteByte('-')
		}
	}
	// Python urlsafe_b64encode includes '=' padding; base64.URLEncoding matches.
	encoded := base64.URLEncoding.EncodeToString([]byte(username))
	fname := clean.String() + "~" + encoded + ".db"
	return filepath.Join(rootUserDir, fname)
}

// Filename2User reverses User2Filename. Mirrors _utils.filename2user.
func Filename2User(filename string) (string, error) {
	fname := filepath.Base(filename)
	afterTilde := fname
	if i := strings.LastIndex(fname, "~"); i >= 0 {
		afterTilde = fname[i+1:]
	}
	encoded := afterTilde
	if i := strings.Index(afterTilde, "."); i >= 0 {
		encoded = afterTilde[:i]
	}
	raw, err := base64.URLEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
