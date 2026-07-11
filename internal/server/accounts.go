package server

import (
	"fmt"
	"strings"

	"github.com/TaggedHQ/server/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// Account credentials are stored in each user's own database, in the userinfo
// table under the key "password_hash". This extends the upstream server (which
// only supported config-defined credentials) with a self-service signup flow,
// without adding a separate global datastore.
const passwordHashKey = "password_hash"

// registerUser creates a new account for username with the given password.
// Returns an error if the inputs are invalid or the account already exists.
func (s *Server) registerUser(username, password string) (int, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return 400, fmt.Errorf("username is required")
	}
	if len(username) > 200 {
		return 400, fmt.Errorf("username is too long")
	}
	if len(password) < 4 {
		return 400, fmt.Errorf("password must be at least 4 characters")
	}

	db, err := store.Open(s.userDBPath(username))
	if err != nil {
		return 500, err
	}
	defer db.Close()
	if err := db.EnsureTable("userinfo", "!key", "st"); err != nil {
		return 500, err
	}

	existing, err := db.SelectOne(db.DB(), "userinfo", "key = ?", passwordHashKey)
	if err != nil {
		return 500, err
	}
	if existing != nil {
		if v, _ := existing["value"].(string); v != "" {
			return 409, fmt.Errorf("account already exists")
		}
	}

	if err := storePasswordHash(db, password); err != nil {
		return 500, err
	}
	return 200, nil
}

// storePasswordHash writes a bcrypt hash of password into the userinfo table.
func storePasswordHash(db *store.ItemDB, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	st := now()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	if err := db.PutOne(tx, "userinfo", store.Item{
		"key": passwordHashKey, "st": st, "mt": st, "value": string(hash),
	}); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// changePassword updates the password for an already-authenticated user, using
// their open database. Returns an HTTP status and error.
func (s *Server) changePassword(db *store.ItemDB, password string) (int, error) {
	if len(password) < 4 {
		return 400, fmt.Errorf("password must be at least 4 characters")
	}
	if err := storePasswordHash(db, password); err != nil {
		return 500, err
	}
	return 200, nil
}

// checkUserPassword verifies a password against the account's stored hash.
// Returns true only if an account exists and the password matches.
func (s *Server) checkUserPassword(username, password string) bool {
	db, err := store.Open(s.userDBPath(username))
	if err != nil {
		return false
	}
	defer db.Close()
	if err := db.EnsureTable("userinfo", "!key", "st"); err != nil {
		return false
	}
	ob, err := db.SelectOne(db.DB(), "userinfo", "key = ?", passwordHashKey)
	if err != nil || ob == nil {
		return false
	}
	hash, _ := ob["value"].(string)
	if hash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
