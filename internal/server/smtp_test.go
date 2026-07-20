package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// jsonRequest wraps a JSON body in the *request the admin handlers take.
func jsonRequest(t *testing.T, body string) *request {
	t.Helper()
	return newRequest(httptest.NewRequest("PUT", "/api/v2/admin/smtp", strings.NewReader(body)))
}

// decodeResp re-marshals a handler's response body into out. The body is an
// `any` the server marshals on the way out, so tests take the same round trip.
func decodeResp(t *testing.T, resp response, out any) {
	t.Helper()
	raw, err := json.Marshal(resp.body)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
}

func TestNormalizeSMTPDefaultsPortToSecurity(t *testing.T) {
	for _, tc := range []struct {
		security string
		want     int
	}{{"starttls", 587}, {"tls", 465}, {"none", 25}} {
		got, err := normalizeSMTP(smtpConfig{Security: tc.security})
		if err != nil {
			t.Fatalf("%s: %v", tc.security, err)
		}
		if got.Port != tc.want {
			t.Errorf("%s: port = %d, want %d", tc.security, got.Port, tc.want)
		}
	}
	// An empty security mode falls back to STARTTLS rather than plaintext.
	got, err := normalizeSMTP(smtpConfig{})
	if err != nil {
		t.Fatalf("empty security: %v", err)
	}
	if got.Security != "starttls" {
		t.Errorf("security = %q, want starttls", got.Security)
	}
}

func TestNormalizeSMTPValidatesOnlyWhenEnabled(t *testing.T) {
	// A half-filled draft saves fine while switched off.
	if _, err := normalizeSMTP(smtpConfig{Enabled: false}); err != nil {
		t.Fatalf("disabled draft rejected: %v", err)
	}
	for name, c := range map[string]smtpConfig{
		"no host":          {Enabled: true, FromAddr: "a@example.com"},
		"no from":          {Enabled: true, Host: "smtp.example.com"},
		"bad from":         {Enabled: true, Host: "smtp.example.com", FromAddr: "not-an-address"},
		"user no password": {Enabled: true, Host: "smtp.example.com", FromAddr: "a@example.com", Username: "u"},
		"bad security":     {Enabled: true, Host: "smtp.example.com", FromAddr: "a@example.com", Security: "ssl"},
		"bad port":         {Enabled: true, Host: "smtp.example.com", FromAddr: "a@example.com", Port: 70000},
	} {
		if _, err := normalizeSMTP(c); err == nil {
			t.Errorf("%s: expected an error, got none", name)
		}
	}
}

// The password is the one field the admin API must not hand back, so an admin
// editing the host cannot read the secret out of the settings endpoint.
func TestAdminGetSMTPWithholdsPassword(t *testing.T) {
	s := newTestServer(t)
	if err := s.setSMTPSettings(smtpConfig{
		Enabled: true, Host: "smtp.example.com", FromAddr: "a@example.com",
		Username: "u", Password: "hunter2",
	}); err != nil {
		t.Fatalf("setSMTPSettings: %v", err)
	}
	var got struct {
		SMTP        smtpConfig `json:"smtp"`
		PasswordSet bool       `json:"password_set"`
	}
	decodeResp(t, s.adminGetSMTP(), &got)
	if got.SMTP.Password != "" {
		t.Errorf("password leaked through the admin API: %q", got.SMTP.Password)
	}
	if !got.PasswordSet {
		t.Error("password_set = false, want true")
	}
	if got.SMTP.Host != "smtp.example.com" {
		t.Errorf("host = %q", got.SMTP.Host)
	}
}

// setup.json is a backup-visible file, so the relay password must be sealed
// there and must still come back intact on the next boot.
func TestSMTPPasswordIsSealedOnDiskAndReloads(t *testing.T) {
	s := newTestServer(t)
	if err := s.setSMTPSettings(smtpConfig{
		Enabled: true, Host: "smtp.example.com", FromAddr: "a@example.com",
		Username: "u", Password: "hunter2",
	}); err != nil {
		t.Fatalf("setSMTPSettings: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(s.rootTTDir, setupFile))
	if err != nil {
		t.Fatalf("read setup.json: %v", err)
	}
	if strings.Contains(string(raw), "hunter2") {
		t.Error("the SMTP password was written to setup.json in the clear")
	}

	var saved setupState
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatalf("unmarshal setup.json: %v", err)
	}
	if saved.SMTP == nil || !strings.HasPrefix(saved.SMTP.Password, secretEnvelopePrefix) {
		t.Fatalf("stored password is not sealed: %+v", saved.SMTP)
	}

	// The same datadir (hence the same jwt.key) must open it again.
	reopened, err := New(s.cfg)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reopened.smtpSettings().Password; got != "hunter2" {
		t.Errorf("password after reload = %q, want hunter2", got)
	}
	if got := reopened.smtpSettings().Host; got != "smtp.example.com" {
		t.Errorf("host after reload = %q", got)
	}
}

// An empty password on save means "keep what is stored", so the page can save
// without ever holding the secret.
func TestAdminSetSMTPKeepsStoredPassword(t *testing.T) {
	s := newTestServer(t)
	if err := s.setSMTPSettings(smtpConfig{
		Enabled: true, Host: "old.example.com", FromAddr: "a@example.com",
		Username: "u", Password: "hunter2",
	}); err != nil {
		t.Fatalf("setSMTPSettings: %v", err)
	}

	body := `{"enabled":true,"host":"new.example.com","from_addr":"a@example.com","username":"u","password":""}`
	if resp := s.adminSetSMTP(jsonRequest(t, body)); resp.status != 200 {
		t.Fatalf("adminSetSMTP: %d %v", resp.status, resp.body)
	}
	c := s.smtpSettings()
	if c.Password != "hunter2" {
		t.Errorf("password = %q, want the stored one kept", c.Password)
	}
	if c.Host != "new.example.com" {
		t.Errorf("host = %q, want the edit applied", c.Host)
	}

	// clear_password is the explicit way to remove it.
	clear := `{"enabled":false,"host":"new.example.com","from_addr":"a@example.com","username":"","password":"","clear_password":true}`
	if resp := s.adminSetSMTP(jsonRequest(t, clear)); resp.status != 200 {
		t.Fatalf("adminSetSMTP clear: %d %v", resp.status, resp.body)
	}
	if got := s.smtpSettings().Password; got != "" {
		t.Errorf("password after clear = %q, want empty", got)
	}
}

func TestBuildMessageHeadersAndCRLF(t *testing.T) {
	c := smtpConfig{FromAddr: "tagged@example.com", FromName: "Tagged"}
	msg := string(buildMessage(c, []string{"a@example.com", "b@example.com"}, "Hi", "line one\nline two"))
	for _, want := range []string{
		`From: "Tagged" <tagged@example.com>`,
		"To: a@example.com, b@example.com",
		"Subject: Hi",
		"Content-Type: text/plain; charset=utf-8",
		"line one\r\nline two",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("message missing %q\n---\n%s", want, msg)
		}
	}
	if strings.Contains(strings.ReplaceAll(msg, "\r\n", ""), "\n") {
		t.Error("message contains a bare LF")
	}
}

// A non-ASCII subject has to be encoded rather than dropped into the header raw.
func TestBuildMessageEncodesSubject(t *testing.T) {
	c := smtpConfig{FromAddr: "tagged@example.com"}
	msg := string(buildMessage(c, []string{"a@example.com"}, "Übersicht", "body"))
	if strings.Contains(msg, "Subject: Übersicht") {
		t.Error("subject was not encoded")
	}
	if !strings.Contains(msg, "Subject: =?utf-8?q?") {
		t.Errorf("subject is not Q-encoded:\n%s", msg)
	}
}

func TestSendMailRefusesWhenDisabled(t *testing.T) {
	s := newTestServer(t)
	if err := s.sendMail([]string{"a@example.com"}, "s", "b"); err == nil {
		t.Error("expected an error when email is switched off")
	}
	if s.mailEnabled() {
		t.Error("mailEnabled = true on a fresh server")
	}
}
