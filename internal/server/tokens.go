package server

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/TaggedHQ/server/internal/store"
	"github.com/TaggedHQ/server/internal/util"
)

const (
	webtokenDays     = 2 * 7
	webtokenLifetime = webtokenDays * 24 * 60 * 60
	apiTokenExp      = 32503748400 // the year 3000
)

// AuthError corresponds to _apiserver.AuthException. The API handler maps it to
// a 401 response.
type AuthError struct{ msg string }

func (e *AuthError) Error() string { return e.msg }

func authErr(format string, args ...any) *AuthError {
	return &AuthError{fmt.Sprintf(format, args...)}
}

func now() float64 { return float64(time.Now().UnixNano()) / 1e9 }

func randSeed(nbytes int) string {
	buf := make([]byte, nbytes)
	_, _ = rand.Read(buf)
	return base64.RawURLEncoding.EncodeToString(buf)
}

// openUserDB opens a user's database and ensures all three tables exist,
// mirroring the table setup in authenticate().
func (s *Server) openUserDB(username string) (*store.ItemDB, error) {
	db, err := store.Open(s.userDBPath(username))
	if err != nil {
		return nil, err
	}
	if err := ensureAllTables(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func ensureAllTables(db *store.ItemDB) error {
	if err := db.EnsureTable("userinfo", "!key", "st"); err != nil {
		return err
	}
	if err := db.EnsureTable("records", "!key", "st", "t1", "t2"); err != nil {
		return err
	}
	return db.EnsureTable("settings", "!key", "st")
}

// authenticate validates the request's authtoken and returns (authInfo, db).
// Ports _apiserver.authenticate.
func (s *Server) authenticate(req *request) (map[string]any, *store.ItemDB, error) {
	st := now()

	token := req.header("authtoken")
	if token == "" {
		return nil, nil, authErr("Missing jwt 'authtoken' in header.")
	}

	authInfo, err := util.DecodeJWT(token, s.jwtKey)
	if err != nil {
		return nil, nil, authErr("%s", err.Error())
	}
	username, ok := authInfo["username"].(string)
	if !ok || username == "" {
		return nil, nil, authErr("Token has no username")
	}

	db, err := s.openUserDB(username)
	if err != nil {
		return nil, nil, err
	}

	expires := toFloat(authInfo["expires"])
	tokenkind := "webtoken"
	if expires > st+webtokenLifetime {
		tokenkind = "apitoken"
	}
	refSeed, err := s.getTokenSeedFromDB(db, tokenkind, false)
	if err != nil {
		db.Close()
		return nil, nil, err
	}

	seed, _ := authInfo["seed"].(string)
	if refSeed == "" || refSeed != seed {
		db.Close()
		return nil, nil, authErr("The %s is revoked (seed does not match)", tokenkind)
	}
	if expires < st {
		db.Close()
		return nil, nil, authErr("The %s has expired (after %d days)", tokenkind, webtokenDays)
	}

	return authInfo, db, nil
}

// getTokenSeedFromDB returns the seed for the given token kind, creating a fresh
// one if missing or if reset is requested. Ports _apiserver._get_token_seed_from_db.
func (s *Server) getTokenSeedFromDB(db *store.ItemDB, tokenkind string, reset bool) (string, error) {
	query := fmt.Sprintf("key = '%s_seed'", tokenkind)
	ob, err := db.SelectOne(db.DB(), "userinfo", query)
	if err != nil {
		return "", err
	}
	seed := ""
	if ob != nil {
		if v, ok := ob["value"].(string); ok {
			seed = v
		}
	}
	if reset || seed == "" {
		seed = randSeed(8)
		st := now()
		tx, err := db.Begin()
		if err != nil {
			return "", err
		}
		if err := db.PutOne(tx, "userinfo", store.Item{
			"key": tokenkind + "_seed", "st": st, "mt": st, "value": seed,
		}); err != nil {
			tx.Rollback()
			return "", err
		}
		if err := tx.Commit(); err != nil {
			return "", err
		}
	}
	return seed, nil
}

// getAnyToken issues a webtoken or apitoken. Ports _apiserver._get_any_token.
func (s *Server) getAnyToken(db *store.ItemDB, authInfo map[string]any, tokenkind string, reset bool) (response, error) {
	var expires int64
	if tokenkind == "apitoken" {
		expires = apiTokenExp
	} else {
		expires = int64(time.Now().Unix()) + webtokenLifetime
	}
	seed, err := s.getTokenSeedFromDB(db, tokenkind, reset)
	if err != nil {
		return response{}, err
	}
	payload := map[string]any{
		"username": authInfo["username"],
		"expires":  expires,
		"seed":     seed,
	}
	token, err := util.CreateJWT(payload, s.jwtKey)
	if err != nil {
		return response{}, err
	}
	return jsonResp(200, map[string]any{"token": token}), nil
}

// getWebtokenUnsafe issues a webtoken for a username without any authentication.
// The caller is responsible for having established trust. Ports
// _apiserver.get_webtoken_unsafe.
func (s *Server) getWebtokenUnsafe(username string, reset bool) (string, error) {
	db, err := store.Open(s.userDBPath(username))
	if err != nil {
		return "", err
	}
	defer db.Close()
	if err := db.EnsureTable("userinfo", "!key", "st"); err != nil {
		return "", err
	}
	seed, err := s.getTokenSeedFromDB(db, "webtoken", reset)
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"username": username,
		"expires":  int64(time.Now().Unix()) + webtokenLifetime,
		"seed":     seed,
	}
	return util.CreateJWT(payload, s.jwtKey)
}
