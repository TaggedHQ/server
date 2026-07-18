package server

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/webauthn"
)

// setDisabled flips the deactivated flag straight in the user's database, the
// way adminSetDisabled does, without going through the HTTP layer.
func setDisabled(t *testing.T, s *Server, username string, disabled bool) {
	t.Helper()
	db, err := s.openUserDB(username)
	if err != nil {
		t.Fatalf("openUserDB: %v", err)
	}
	defer db.Close()
	if err := userinfoPut(db, disabledFlagKey, disabled); err != nil {
		t.Fatalf("userinfoPut: %v", err)
	}
}

func TestDeactivatedUserCannotGetAToken(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "off@x.com", "secret")

	setDisabled(t, s, "off@x.com", true)
	if _, err := s.getWebtokenUnsafe("off@x.com", false); !errors.Is(err, errAccountDisabled) {
		t.Fatalf("getWebtokenUnsafe for a deactivated user: got %v, want errAccountDisabled", err)
	}

	// Reactivating puts the account straight back into service.
	setDisabled(t, s, "off@x.com", false)
	if _, err := s.getWebtokenUnsafe("off@x.com", false); err != nil {
		t.Fatalf("getWebtokenUnsafe after reactivating: %v", err)
	}
}

// A token handed out before the deactivation must stop working too, otherwise
// an open session would outlive the block.
func TestDeactivationRejectsExistingTokens(t *testing.T) {
	s := newTestServer(t)
	token := mkPasswordUser(t, s, "off@x.com", "secret")

	if w := doAPI(t, s, "GET", "/api/v2/whoami", token, ""); w.Code != 200 {
		t.Fatalf("whoami before deactivating: got %d, want 200", w.Code)
	}
	setDisabled(t, s, "off@x.com", true)
	w := doAPI(t, s, "GET", "/api/v2/whoami", token, "")
	if w.Code != 401 {
		t.Fatalf("whoami after deactivating: got %d, want 401", w.Code)
	}
	if !strings.Contains(w.Body.String(), "deactivated") {
		t.Errorf("whoami body = %q, want it to mention the deactivation", w.Body.String())
	}
}

// adminResetMFA is the way back in for a locked-out user, so it has to clear
// every factor at once — a leftover passkey would still block the password.
func TestAdminResetMFAClearsEveryFactor(t *testing.T) {
	s := newTestServer(t)
	mkPasswordUser(t, s, "mfa@x.com", "secret")

	db, err := s.openUserDB("mfa@x.com")
	if err != nil {
		t.Fatalf("openUserDB: %v", err)
	}
	if err := firstErr(
		userinfoPut(db, totpEnabledKey, true),
		userinfoPut(db, totpSecretKey, generateTOTPSecret()),
		setBackupCodes(db, []string{"aaaaa-bbbbb"}),
		saveStoredCredentials(db, []storedCredential{{
			Credential: webauthn.Credential{ID: []byte("cred-1")},
			Label:      "Test key",
		}}),
	); err != nil {
		t.Fatalf("seeding factors: %v", err)
	}
	db.Close()

	if !s.userMFAEnabled("mfa@x.com") {
		t.Fatal("the seeded account should have MFA enabled")
	}

	w := doAPI(t, s, "DELETE", "/api/v2/admin/mfa",
		mkAdminToken(t, s), `{"username":"mfa@x.com"}`)
	if w.Code != 200 {
		t.Fatalf("admin/mfa: got %d %s, want 200", w.Code, w.Body.String())
	}

	db, err = s.openUserDB("mfa@x.com")
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db.Close()
	if totpEnabled(db) {
		t.Error("TOTP is still enabled")
	}
	if got := totpSecretOf(db); got != "" {
		t.Errorf("TOTP secret = %q, want it cleared", got)
	}
	if got := len(backupHashes(db)); got != 0 {
		t.Errorf("backup codes left = %d, want 0", got)
	}
	if got := len(storedCredentials(db)); got != 0 {
		t.Errorf("passkeys left = %d, want 0", got)
	}
	if s.userMFAEnabled("mfa@x.com") {
		t.Error("MFA still reads as enabled after the reset")
	}
}

// mkAdminToken registers an account and grants it the stored admin role.
func mkAdminToken(t *testing.T, s *Server, username ...string) string {
	t.Helper()
	name := "admin@x.com"
	if len(username) > 0 {
		name = username[0]
	}
	token := mkPasswordUser(t, s, name, "secret")
	if err := s.setStoredAdmin(name, true); err != nil {
		t.Fatalf("setStoredAdmin: %v", err)
	}
	return token
}

// An admin must not be able to deactivate themselves, or a single click would
// lock the last admin out of their own server.
func TestAdminCannotDeactivateThemselves(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)

	w := doAPI(t, s, "PUT", "/api/v2/admin/disable", token,
		`{"username":"admin@x.com","disabled":true}`)
	if w.Code != 400 {
		t.Fatalf("self-deactivation: got %d %s, want 400", w.Code, w.Body.String())
	}
	db, err := s.openUserDB("admin@x.com")
	if err != nil {
		t.Fatalf("openUserDB: %v", err)
	}
	defer db.Close()
	if dbDisabledFlag(db) {
		t.Error("the admin was deactivated despite the guard")
	}
}

// mkGroup creates an empty group and returns its id.
func mkGroup(t *testing.T, s *Server, token, name string) string {
	t.Helper()
	w := doAPI(t, s, "PUT", "/api/v2/admin/groups", token,
		`{"name":"`+name+`","members":[],"controllers":[]}`)
	if w.Code != 200 {
		t.Fatalf("create group %q: %d %s", name, w.Code, w.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode group id: %v", err)
	}
	return out.ID
}

// groupByID looks one group up out of the live list.
func groupByID(t *testing.T, s *Server, id string) group {
	t.Helper()
	for _, g := range s.listGroups() {
		if g.ID == id {
			return g
		}
	}
	t.Fatalf("group %q not found", id)
	return group{}
}

// A user can be in several groups at once, so setting their groups has to add
// and remove across the whole list in one pass.
func TestSetUserGroupsSpansSeveralGroups(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	mkPasswordUser(t, s, "user@x.com", "secret")
	a := mkGroup(t, s, token, "Alpha")
	b := mkGroup(t, s, token, "Beta")
	c := mkGroup(t, s, token, "Gamma")

	w := doAPI(t, s, "PUT", "/api/v2/admin/user-groups", token,
		`{"username":"user@x.com","groups":["`+a+`","`+b+`"]}`)
	if w.Code != 200 {
		t.Fatalf("set groups: %d %s", w.Code, w.Body.String())
	}
	for _, tc := range []struct {
		id   string
		want bool
	}{{a, true}, {b, true}, {c, false}} {
		got := slices.Contains(groupByID(t, s, tc.id).Members, "user@x.com")
		if got != tc.want {
			t.Errorf("group %q membership = %v, want %v", tc.id, got, tc.want)
		}
	}

	// Moving to a different pair must drop the old ones in the same call.
	w = doAPI(t, s, "PUT", "/api/v2/admin/user-groups", token,
		`{"username":"user@x.com","groups":["`+c+`"]}`)
	if w.Code != 200 {
		t.Fatalf("move groups: %d %s", w.Code, w.Body.String())
	}
	for _, tc := range []struct {
		id   string
		want bool
	}{{a, false}, {b, false}, {c, true}} {
		got := slices.Contains(groupByID(t, s, tc.id).Members, "user@x.com")
		if got != tc.want {
			t.Errorf("after the move, group %q membership = %v, want %v", tc.id, got, tc.want)
		}
	}
}

// Which list a name lands in follows the role: controllers oversee groups
// rather than belonging to them.
func TestSetUserGroupsUsesTheRoleSlot(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	mkPasswordUser(t, s, "ctrl@x.com", "secret")
	if err := s.setStoredController("ctrl@x.com", true); err != nil {
		t.Fatalf("setStoredController: %v", err)
	}
	id := mkGroup(t, s, token, "Alpha")

	w := doAPI(t, s, "PUT", "/api/v2/admin/user-groups", token,
		`{"username":"ctrl@x.com","groups":["`+id+`"]}`)
	if w.Code != 200 {
		t.Fatalf("set groups: %d %s", w.Code, w.Body.String())
	}
	g := groupByID(t, s, id)
	if !slices.Contains(g.Controllers, "ctrl@x.com") {
		t.Errorf("controllers = %v, want it to contain ctrl@x.com", g.Controllers)
	}
	if slices.Contains(g.Members, "ctrl@x.com") {
		t.Errorf("members = %v, want a controller to stay out of it", g.Members)
	}
}

func TestSetUserGroupsRejectsAdmins(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	mkPasswordUser(t, s, "other@x.com", "secret")
	if err := s.setStoredAdmin("other@x.com", true); err != nil {
		t.Fatalf("setStoredAdmin: %v", err)
	}
	id := mkGroup(t, s, token, "Alpha")

	w := doAPI(t, s, "PUT", "/api/v2/admin/user-groups", token,
		`{"username":"other@x.com","groups":["`+id+`"]}`)
	if w.Code != 400 {
		t.Fatalf("admin into a group: got %d %s, want 400", w.Code, w.Body.String())
	}
}

// An unknown id must abort before anything is written, or a typo would silently
// drop the memberships the request did name.
func TestSetUserGroupsRejectsUnknownGroupWithoutWriting(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	mkPasswordUser(t, s, "user@x.com", "secret")
	id := mkGroup(t, s, token, "Alpha")

	if w := doAPI(t, s, "PUT", "/api/v2/admin/user-groups", token,
		`{"username":"user@x.com","groups":["`+id+`"]}`); w.Code != 200 {
		t.Fatalf("seed membership: %d %s", w.Code, w.Body.String())
	}
	w := doAPI(t, s, "PUT", "/api/v2/admin/user-groups", token,
		`{"username":"user@x.com","groups":["`+id+`","made-up"]}`)
	if w.Code != 404 {
		t.Fatalf("unknown group: got %d %s, want 404", w.Code, w.Body.String())
	}
	if !slices.Contains(groupByID(t, s, id).Members, "user@x.com") {
		t.Error("the existing membership was dropped by a request that failed")
	}
}

// seedBothFactors gives an account an authenticator and a passkey.
func seedBothFactors(t *testing.T, s *Server, username string) {
	t.Helper()
	db, err := s.openUserDB(username)
	if err != nil {
		t.Fatalf("openUserDB: %v", err)
	}
	defer db.Close()
	if err := firstErr(
		userinfoPut(db, totpEnabledKey, true),
		userinfoPut(db, totpSecretKey, generateTOTPSecret()),
		setBackupCodes(db, []string{"aaaaa-bbbbb"}),
		saveStoredCredentials(db, []storedCredential{{
			Credential: webauthn.Credential{ID: []byte("cred-1")},
			Label:      "Test key",
		}}),
	); err != nil {
		t.Fatalf("seeding factors: %v", err)
	}
}

// The row menu offers the two factors separately, so each scope must leave the
// other one alone — resetting a lost authenticator must not strip the passkeys.
func TestAdminResetMFAScopes(t *testing.T) {
	for _, tc := range []struct {
		scope        string
		wantTOTP     bool
		wantPasskeys int
	}{
		{"totp", false, 1},
		{"passkeys", true, 0},
		{"all", false, 0},
	} {
		t.Run(tc.scope, func(t *testing.T) {
			s := newTestServer(t)
			token := mkAdminToken(t, s)
			mkPasswordUser(t, s, "u@x.com", "secret")
			seedBothFactors(t, s, "u@x.com")

			w := doAPI(t, s, "DELETE", "/api/v2/admin/mfa", token,
				`{"username":"u@x.com","scope":"`+tc.scope+`"}`)
			if w.Code != 200 {
				t.Fatalf("scope %q: %d %s", tc.scope, w.Code, w.Body.String())
			}
			db, err := s.openUserDB("u@x.com")
			if err != nil {
				t.Fatalf("reopen: %v", err)
			}
			defer db.Close()
			if got := totpEnabled(db); got != tc.wantTOTP {
				t.Errorf("totpEnabled = %v, want %v", got, tc.wantTOTP)
			}
			if got := len(storedCredentials(db)); got != tc.wantPasskeys {
				t.Errorf("passkeys = %d, want %d", got, tc.wantPasskeys)
			}
			// Backup codes ride with the authenticator, never with the passkeys.
			wantBackup := 1
			if !tc.wantTOTP {
				wantBackup = 0
			}
			if got := len(backupHashes(db)); got != wantBackup {
				t.Errorf("backup codes = %d, want %d", got, wantBackup)
			}
		})
	}
}

func TestAdminResetMFARejectsAnUnknownScope(t *testing.T) {
	s := newTestServer(t)
	token := mkAdminToken(t, s)
	mkPasswordUser(t, s, "u@x.com", "secret")
	seedBothFactors(t, s, "u@x.com")

	w := doAPI(t, s, "DELETE", "/api/v2/admin/mfa", token,
		`{"username":"u@x.com","scope":"everything"}`)
	if w.Code != 400 {
		t.Fatalf("bad scope: got %d %s, want 400", w.Code, w.Body.String())
	}
	db, _ := s.openUserDB("u@x.com")
	defer db.Close()
	if !totpEnabled(db) || len(storedCredentials(db)) != 1 {
		t.Error("a rejected scope still changed the account")
	}
}
