package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg" // register JPEG for image.DecodeConfig
	_ "image/png"  // register PNG for image.DecodeConfig
	"regexp"
	"strings"

	"github.com/TaggedHQ/server/internal/store"
)

// Directory details for an account: the name/contact fields and the profile
// picture. Both live in the user's own database in the userinfo table, next to
// the password hash and the role flags, so they travel with the account through
// backups and the migrate tool and work the same on SQLite and Postgres.
//
// A user may edit their own profile via /profile; an admin holding the
// "users.manage" capability may edit anyone's via /admin/profile.
const (
	profileKey = "profile" // JSON object: the text fields below
	avatarKey  = "avatar"  // data URI of the profile picture
)

// userProfile holds the editable directory fields of an account. The username
// stays the identity/login and is not part of this struct; Email is a separate
// contact address (which may differ from the username).
type userProfile struct {
	FirstName  string `json:"first_name"`
	LastName   string `json:"last_name"`
	Job        string `json:"job"`
	Department string `json:"department"`
	Email      string `json:"email"`
	Phone      string `json:"phone"`
	Mobile     string `json:"mobile"`
}

// maxProfileField caps every text field, so one account cannot bloat the list
// response.
const maxProfileField = 120

// maxAvatarBytes caps the decoded profile picture. The UI resizes to a 256px
// square JPEG (~15KB); this leaves generous headroom for a hand-crafted upload
// while keeping the admin list payload bounded.
const maxAvatarBytes = 512 * 1024

// maxAvatarDim is the largest accepted edge length, in pixels.
const maxAvatarDim = 1024

// emailRe is a deliberately permissive sanity check: it rejects obvious typos
// without trying to out-guess the RFC.
var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// avatarDataURIRe splits a data URI into its image subtype and base64 payload.
var avatarDataURIRe = regexp.MustCompile(`^data:image/(jpeg|png);base64,([A-Za-z0-9+/=]+)$`)

// clean trims a field and reports whether it is within the length cap.
func cleanField(name, v string) (string, error) {
	v = strings.TrimSpace(v)
	if len(v) > maxProfileField {
		return "", fmt.Errorf("%s must be at most %d characters", name, maxProfileField)
	}
	return v, nil
}

// validate normalises every field, returning the first problem found.
func (p *userProfile) validate() error {
	var err error
	fields := []struct {
		name string
		ptr  *string
	}{
		{"first name", &p.FirstName},
		{"last name", &p.LastName},
		{"job", &p.Job},
		{"department", &p.Department},
		{"email", &p.Email},
		{"phone", &p.Phone},
		{"mobile", &p.Mobile},
	}
	for _, f := range fields {
		if *f.ptr, err = cleanField(f.name, *f.ptr); err != nil {
			return err
		}
	}
	if p.Email != "" && !emailRe.MatchString(p.Email) {
		return fmt.Errorf("%q is not a valid e-mail address", p.Email)
	}
	return nil
}

// validateAvatar checks that raw is a JPEG/PNG data URI within the size and
// dimension caps, so a bad upload fails here rather than in every browser that
// later renders it.
func validateAvatar(raw string) error {
	m := avatarDataURIRe.FindStringSubmatch(raw)
	if m == nil {
		return fmt.Errorf("the profile picture must be a JPEG or PNG data URI")
	}
	data, err := base64.StdEncoding.DecodeString(m[2])
	if err != nil {
		return fmt.Errorf("the profile picture is not valid base64")
	}
	if len(data) > maxAvatarBytes {
		return fmt.Errorf("the profile picture must be at most %d KB", maxAvatarBytes/1024)
	}
	cfg, _, err := image.DecodeConfig(strings.NewReader(string(data)))
	if err != nil {
		return fmt.Errorf("the profile picture is not a readable image")
	}
	if cfg.Width > maxAvatarDim || cfg.Height > maxAvatarDim {
		return fmt.Errorf("the profile picture must be at most %dx%d pixels", maxAvatarDim, maxAvatarDim)
	}
	return nil
}

// readProfile loads the stored profile from an open user database. A missing or
// unreadable value yields the zero profile, so a fresh account simply has empty
// fields.
func readProfile(db store.UserDB) userProfile {
	var p userProfile
	ob, err := db.Get("userinfo", profileKey)
	if err != nil || ob == nil {
		return p
	}
	raw, ok := ob["value"].(string)
	if !ok {
		return p
	}
	_ = json.Unmarshal([]byte(raw), &p)
	return p
}

// readAvatar loads the stored profile picture data URI, or "" if unset.
func readAvatar(db store.UserDB) string {
	ob, err := db.Get("userinfo", avatarKey)
	if err != nil || ob == nil {
		return ""
	}
	v, _ := ob["value"].(string)
	return v
}

// writeProfile stores the text fields. The picture is written separately by
// writeAvatar, so saving a profile never has to round-trip the image.
func writeProfile(db store.UserDB, p userProfile) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	st := now()
	return db.Write(func(tx store.WTx) error {
		return tx.Upsert("userinfo", store.Item{
			"key": profileKey, "st": st, "mt": st, "value": string(raw),
		})
	})
}

// writeAvatar stores (or, given "", clears) the profile picture.
func writeAvatar(db store.UserDB, dataURI string) error {
	st := now()
	return db.Write(func(tx store.WTx) error {
		return tx.Upsert("userinfo", store.Item{
			"key": avatarKey, "st": st, "mt": st, "value": dataURI,
		})
	})
}

// profileBody is the wire format for a profile update. Avatar is a pointer so
// the three cases stay distinct: absent = leave the picture alone, "" = remove
// it, a data URI = replace it.
type profileBody struct {
	Username   string  `json:"username"` // admin route only; ignored for self-service
	FirstName  string  `json:"first_name"`
	LastName   string  `json:"last_name"`
	Job        string  `json:"job"`
	Department string  `json:"department"`
	Email      string  `json:"email"`
	Phone      string  `json:"phone"`
	Mobile     string  `json:"mobile"`
	Avatar     *string `json:"avatar"`
}

func (b profileBody) profile() userProfile {
	return userProfile{
		FirstName: b.FirstName, LastName: b.LastName, Job: b.Job,
		Department: b.Department, Email: b.Email, Phone: b.Phone, Mobile: b.Mobile,
	}
}

// parseProfileBody reads and validates an update from the request.
func parseProfileBody(req *request) (profileBody, userProfile, *response) {
	var body profileBody
	raw, err := req.getBody(2 * 1024 * 1024)
	if err != nil {
		r := textResp(500, "internal error: "+err.Error())
		return body, userProfile{}, &r
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		r := textResp(400, "bad request: body must be a JSON profile object")
		return body, userProfile{}, &r
	}
	p := body.profile()
	if err := p.validate(); err != nil {
		r := textResp(400, err.Error())
		return body, userProfile{}, &r
	}
	if body.Avatar != nil && *body.Avatar != "" {
		if err := validateAvatar(*body.Avatar); err != nil {
			r := textResp(400, err.Error())
			return body, userProfile{}, &r
		}
	}
	return body, p, nil
}

// saveProfile applies a validated update to an open user database.
func saveProfile(db store.UserDB, p userProfile, avatar *string) error {
	if err := writeProfile(db, p); err != nil {
		return err
	}
	if avatar != nil {
		return writeAvatar(db, *avatar)
	}
	return nil
}

// profileHandler serves the authenticated user's own profile: GET to read it,
// PUT/POST to update it. Every account may manage its own directory details.
func (s *Server) profileHandler(req *request, db store.UserDB) response {
	switch req.method() {
	case "GET":
		return jsonResp(200, map[string]any{
			"profile": readProfile(db),
			"avatar":  readAvatar(db),
		})
	case "PUT", "POST":
		body, p, errResp := parseProfileBody(req)
		if errResp != nil {
			return *errResp
		}
		if err := saveProfile(db, p, body.Avatar); err != nil {
			return textResp(500, "internal error: "+err.Error())
		}
		return jsonResp(200, map[string]any{"status": "ok", "profile": p})
	}
	return textResp(405, "method not allowed")
}

// adminSetProfile updates any user's profile. Gated on "users.manage" by the
// admin dispatcher.
func (s *Server) adminSetProfile(req *request) response {
	body, p, errResp := parseProfileBody(req)
	if errResp != nil {
		return *errResp
	}
	username := strings.TrimSpace(body.Username)
	if username == "" {
		return textResp(400, "username is required")
	}
	// Guard against a typo'd name: openUserDB would otherwise create an empty
	// database for an account that never existed.
	switch exists, err := s.userExists(username); {
	case err != nil:
		return textResp(500, "internal error: "+err.Error())
	case !exists:
		return textResp(404, "user not found")
	}
	db, err := s.openUserDB(username)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	defer db.Close()
	if err := saveProfile(db, p, body.Avatar); err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "profile": p})
}
