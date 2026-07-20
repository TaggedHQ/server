package server

import (
	"bufio"
	"fmt"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

// capturedMail is one message the fake relay accepted.
type capturedMail struct {
	from string
	rcpt []string
	data string
}

// fakeSMTP is a minimal SMTP server for tests: enough of the protocol for
// net/smtp to complete an unauthenticated plaintext session, and no more. Each
// accepted message is pushed onto got.
type fakeSMTP struct {
	ln   net.Listener
	got  chan capturedMail
	host string
	port int
}

func newFakeSMTP(t *testing.T) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	f := &fakeSMTP{ln: ln, got: make(chan capturedMail, 8), host: host, port: port}
	go f.serve()
	t.Cleanup(func() { ln.Close() })
	return f
}

func (f *fakeSMTP) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.session(conn)
	}
}

func (f *fakeSMTP) session(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReader(conn)
	w := func(s string) { fmt.Fprintf(conn, "%s\r\n", s) }

	w("220 fake ESMTP")
	var msg capturedMail
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			w("250-fake")
			w("250 OK")
		case strings.HasPrefix(cmd, "MAIL FROM"):
			msg.from = strings.TrimSpace(line[len("MAIL FROM:"):])
			w("250 OK")
		case strings.HasPrefix(cmd, "RCPT TO"):
			msg.rcpt = append(msg.rcpt, strings.Trim(strings.TrimSpace(line[len("RCPT TO:"):]), "<>"))
			w("250 OK")
		case cmd == "DATA":
			w("354 send it")
			var b strings.Builder
			for {
				dl, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if dl == ".\r\n" || dl == ".\n" {
					break
				}
				b.WriteString(dl)
			}
			msg.data = b.String()
			f.got <- msg
			msg = capturedMail{}
			w("250 queued")
		case cmd == "QUIT":
			w("221 bye")
			return
		case cmd == "RSET":
			msg = capturedMail{}
			w("250 OK")
		default:
			w("250 OK")
		}
	}
}

// waitMail returns the next captured message, or fails if none arrives. The
// notifications are sent off the request goroutine, so tests have to wait.
func (f *fakeSMTP) waitMail(t *testing.T) capturedMail {
	t.Helper()
	select {
	case m := <-f.got:
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for a message")
		return capturedMail{}
	}
}

// expectNoMail fails if any message shows up within a short grace period.
func (f *fakeSMTP) expectNoMail(t *testing.T) {
	t.Helper()
	select {
	case m := <-f.got:
		t.Fatalf("unexpected message to %v:\n%s", m.rcpt, m.data)
	case <-time.After(700 * time.Millisecond):
	}
}

// notifyFixture is a server wired to a fake relay, with a holder in a group, a
// manager controlling it, and one skill that needs approval.
type notifyFixture struct {
	s      *Server
	relay  *fakeSMTP
	holder string
	mgr    string
}

func newNotifyFixture(t *testing.T) *notifyFixture {
	t.Helper()
	s := newTestServer(t)
	relay := newFakeSMTP(t)

	if err := s.setSMTPSettings(smtpConfig{
		Enabled: true, Host: relay.host, Port: relay.port,
		Security: "none", FromAddr: "tagged@example.com", FromName: "Tagged",
	}); err != nil {
		t.Fatalf("setSMTPSettings: %v", err)
	}

	const holder, mgr = "holder@example.com", "manager@example.com"
	for _, u := range []string{holder, mgr} {
		if _, err := s.registerUser(u, "password123"); err != nil {
			t.Fatalf("registerUser %s: %v", u, err)
		}
	}
	setEmail(t, s, holder, "holder-inbox@example.com")
	setEmail(t, s, mgr, "manager-inbox@example.com")

	if err := s.saveGroups([]group{{
		ID: "g1", Name: "Team", Members: []string{holder}, Controllers: []string{mgr},
	}}); err != nil {
		t.Fatalf("saveGroups: %v", err)
	}
	if err := s.saveSkills([]skill{{
		ID: "forklift", Name: "Forklift", Cat: "general", RequiresApproval: true,
	}}); err != nil {
		t.Fatalf("saveSkills: %v", err)
	}
	return &notifyFixture{s: s, relay: relay, holder: holder, mgr: mgr}
}

// setEmail writes a contact address into username's profile.
func setEmail(t *testing.T, s *Server, username, email string) {
	t.Helper()
	db, err := s.getStore().UserDB(username)
	if err != nil {
		t.Fatalf("UserDB %s: %v", username, err)
	}
	defer db.Close()
	p := readProfile(db)
	p.Email = email
	if err := writeProfile(db, p); err != nil {
		t.Fatalf("writeProfile %s: %v", username, err)
	}
}

// selfClaim makes the holder claim the skill, which is what lands it pending.
func (f *notifyFixture) selfClaim(t *testing.T) {
	t.Helper()
	resp := f.s.writeAssignment(
		assignBody{SkillID: "forklift", Level: 2}, f.holder, f.holder, false)
	if resp.status != 200 {
		t.Fatalf("writeAssignment: %d %v", resp.status, resp.body)
	}
}

func TestSelfClaimEmailsTheApprover(t *testing.T) {
	f := newNotifyFixture(t)
	f.selfClaim(t)

	m := f.relay.waitMail(t)
	if len(m.rcpt) != 1 || m.rcpt[0] != "manager-inbox@example.com" {
		t.Errorf("recipients = %v, want the manager's profile address", m.rcpt)
	}
	if !strings.Contains(m.data, "Skill approval needed") {
		t.Errorf("subject missing from message:\n%s", m.data)
	}
	if !strings.Contains(m.data, "Forklift") {
		t.Errorf("skill name missing from message:\n%s", m.data)
	}
}

// A manager assigning the skill directly is itself the approval, so there is
// nothing pending and nobody to notify.
func TestManagerAssignmentSendsNothing(t *testing.T) {
	f := newNotifyFixture(t)
	resp := f.s.writeAssignment(
		assignBody{SkillID: "forklift", Level: 2}, f.holder, f.mgr, true)
	if resp.status != 200 {
		t.Fatalf("writeAssignment: %d %v", resp.status, resp.body)
	}
	f.relay.expectNoMail(t)
}

func TestApprovalEmailsTheHolder(t *testing.T) {
	f := newNotifyFixture(t)
	f.selfClaim(t)
	f.relay.waitMail(t) // the pending notice

	body := `{"username":"` + f.holder + `","skill_id":"forklift"}`
	resp := f.s.approveSkill(jsonRequest(t, body), f.mgr, map[string]bool{})
	if resp.status != 200 {
		t.Fatalf("approveSkill: %d %v", resp.status, resp.body)
	}

	m := f.relay.waitMail(t)
	if len(m.rcpt) != 1 || m.rcpt[0] != "holder-inbox@example.com" {
		t.Errorf("recipients = %v, want the holder's profile address", m.rcpt)
	}
	if !strings.Contains(m.data, "Skill approved") {
		t.Errorf("message does not read as an approval:\n%s", m.data)
	}
}

func TestRejectionEmailsTheHolder(t *testing.T) {
	f := newNotifyFixture(t)
	f.selfClaim(t)
	f.relay.waitMail(t)

	body := `{"username":"` + f.holder + `","skill_id":"forklift","reject":true}`
	resp := f.s.approveSkill(jsonRequest(t, body), f.mgr, map[string]bool{})
	if resp.status != 200 {
		t.Fatalf("approveSkill: %d %v", resp.status, resp.body)
	}

	m := f.relay.waitMail(t)
	if len(m.rcpt) != 1 || m.rcpt[0] != "holder-inbox@example.com" {
		t.Errorf("recipients = %v", m.rcpt)
	}
	if !strings.Contains(m.data, "Skill rejected") {
		t.Errorf("message does not read as a rejection:\n%s", m.data)
	}
	// The name has to survive the assignment being cleared.
	if !strings.Contains(m.data, "Forklift") {
		t.Errorf("skill name missing from the rejection:\n%s", m.data)
	}
}

// No address in the profile means no email -- the username is a login, not
// necessarily a mailbox, so it must never be used as a fallback.
func TestNoProfileEmailSendsNothing(t *testing.T) {
	f := newNotifyFixture(t)
	setEmail(t, f.s, f.mgr, "")
	f.selfClaim(t)
	f.relay.expectNoMail(t)
}

// With email switched off the skill flow behaves exactly as it did before.
func TestNotificationsSkippedWhenEmailDisabled(t *testing.T) {
	f := newNotifyFixture(t)
	c := f.s.smtpSettings()
	c.Enabled = false
	if err := f.s.setSMTPSettings(c); err != nil {
		t.Fatalf("disable: %v", err)
	}
	f.selfClaim(t)
	f.relay.expectNoMail(t)
}

// A relay that refuses the message must not break the skill flow: the
// assignment still lands and the request still succeeds.
func TestSendFailureDoesNotBreakTheAssignment(t *testing.T) {
	f := newNotifyFixture(t)
	c := f.s.smtpSettings()
	c.Port = 1 // nothing listening
	if err := f.s.setSMTPSettings(c); err != nil {
		t.Fatalf("repoint: %v", err)
	}
	f.selfClaim(t)

	var found *userSkill
	for _, us := range f.s.readUserSkills(f.holder) {
		if us.SkillID == "forklift" {
			u := us
			found = &u
		}
	}
	if found == nil {
		t.Fatal("the assignment was not stored")
	}
	if found.Status != statusPending {
		t.Errorf("status = %q, want pending", found.Status)
	}
}
