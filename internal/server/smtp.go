package server

// Outbound email. The server does not send anything on its own yet; this holds
// the operator's SMTP settings (Admin · Settings) and the one call features will
// use to send through them, so adding a notification later is a matter of
// calling sendMail rather than inventing transport.

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// smtpConfig is the server-wide mail relay configuration. It is persisted in
// setup.json; Password is sealed there (see setupSnapshot) rather than written
// in the clear, unlike the OAuth client secrets that predate sealing.
type smtpConfig struct {
	Enabled  bool   `json:"enabled"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Security string `json:"security"` // "none", "starttls" or "tls"
	Username string `json:"username"` // empty means send unauthenticated
	Password string `json:"password"`
	FromAddr string `json:"from_addr"` // envelope + header From, e.g. "tagged@example.com"
	FromName string `json:"from_name"` // optional display name
}

// smtpDialTimeout bounds both the connect and the whole conversation, so a relay
// that accepts the TCP connection and then stalls cannot pin the request.
const smtpDialTimeout = 15 * time.Second

// validSMTPSecurity reports whether v is one of the three transport modes.
func validSMTPSecurity(v string) bool {
	switch v {
	case "none", "starttls", "tls":
		return true
	}
	return false
}

// defaultSMTPPort is the conventional port for each transport mode, used when
// the operator leaves the port blank.
func defaultSMTPPort(security string) int {
	switch security {
	case "tls":
		return 465
	case "none":
		return 25
	default:
		return 587
	}
}

// smtpSettings returns a copy of the current configuration, password included.
// Callers that hand it outward must strip the password first; see adminGetSMTP.
func (s *Server) smtpSettings() smtpConfig {
	s.smtpMu.RLock()
	defer s.smtpMu.RUnlock()
	return s.smtp
}

// mailEnabled reports whether sendMail has somewhere to send. Features that gain
// an email step should check this and degrade quietly rather than erroring on a
// server whose operator never configured a relay.
func (s *Server) mailEnabled() bool {
	c := s.smtpSettings()
	return c.Enabled && c.Host != "" && c.FromAddr != ""
}

// normalizeSMTP trims and fills in defaults, then validates. Validation is only
// enforced for an enabled config, matching setOAuthProviders: a half-filled
// draft can be saved while switched off.
func normalizeSMTP(c smtpConfig) (smtpConfig, error) {
	c.Host = strings.TrimSpace(c.Host)
	c.Username = strings.TrimSpace(c.Username)
	c.FromAddr = strings.TrimSpace(c.FromAddr)
	c.FromName = strings.TrimSpace(c.FromName)
	c.Security = strings.ToLower(strings.TrimSpace(c.Security))
	if c.Security == "" {
		c.Security = "starttls"
	}
	if !validSMTPSecurity(c.Security) {
		return c, fmt.Errorf("unknown security mode %q: use none, starttls or tls", c.Security)
	}
	if c.Port == 0 {
		c.Port = defaultSMTPPort(c.Security)
	}
	if c.Port < 1 || c.Port > 65535 {
		return c, fmt.Errorf("port %d is out of range", c.Port)
	}
	if !c.Enabled {
		return c, nil
	}
	if c.Host == "" {
		return c, fmt.Errorf("a host is required to enable email")
	}
	if c.FromAddr == "" {
		return c, fmt.Errorf("a from address is required to enable email")
	}
	if _, err := mail.ParseAddress(c.FromAddr); err != nil {
		return c, fmt.Errorf("%q is not a valid email address", c.FromAddr)
	}
	// A username with no password is almost always a half-filled form rather than
	// a relay that authenticates on username alone.
	if c.Username != "" && c.Password == "" {
		return c, fmt.Errorf("a password is required when a username is set")
	}
	return c, nil
}

// setSMTPSettings validates and persists the configuration.
func (s *Server) setSMTPSettings(c smtpConfig) error {
	c, err := normalizeSMTP(c)
	if err != nil {
		return err
	}
	s.smtpMu.Lock()
	s.smtp = c
	s.smtpMu.Unlock()
	return s.persistSetup()
}

// ---- sending ----------------------------------------------------------------

// smtpDial opens a connection in the configured transport mode. For "tls" the
// session is encrypted from the first byte (the submissions port, 465); for
// "starttls" it is upgraded after greeting, and a relay that will not upgrade is
// an error rather than a silent fallback to plaintext.
func smtpDial(c smtpConfig) (*smtp.Client, error) {
	addr := net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	tlsCfg := &tls.Config{ServerName: c.Host}
	if c.Security == "tls" {
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: smtpDialTimeout}, "tcp", addr, tlsCfg)
		if err != nil {
			return nil, err
		}
		return smtp.NewClient(conn, c.Host)
	}
	conn, err := net.DialTimeout("tcp", addr, smtpDialTimeout)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(smtpDialTimeout))
	client, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if c.Security == "starttls" {
		if err := client.StartTLS(tlsCfg); err != nil {
			client.Close()
			return nil, fmt.Errorf("the server would not start TLS: %w", err)
		}
	}
	return client, nil
}

// buildMessage renders an RFC 5322 message. The body is plain UTF-8 text; the
// subject is Q-encoded so non-ASCII survives the header.
func buildMessage(c smtpConfig, to []string, subject, body string) []byte {
	from := (&mail.Address{Name: c.FromName, Address: c.FromAddr}).String()
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", strings.Join(to, ", "))
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", subject))
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("\r\n")
	// Dot-stuffing is handled by the client's Data writer, but bare LF is not:
	// normalise to CRLF so the body is not mangled by strict relays.
	b.WriteString(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n"))
	return []byte(b.String())
}

// sendMail delivers a plain-text message to the given recipients through the
// configured relay. This is the entry point for any feature that needs to email
// a user; it returns an error when email is switched off, so the caller decides
// whether that is fatal or something to skip.
func (s *Server) sendMail(to []string, subject, body string) error {
	c := s.smtpSettings()
	if !c.Enabled {
		return fmt.Errorf("email is not enabled on this server")
	}
	if c.Host == "" || c.FromAddr == "" {
		return fmt.Errorf("email is not fully configured")
	}
	if len(to) == 0 {
		return fmt.Errorf("no recipients")
	}
	for _, addr := range to {
		if _, err := mail.ParseAddress(addr); err != nil {
			return fmt.Errorf("%q is not a valid email address", addr)
		}
	}

	client, err := smtpDial(c)
	if err != nil {
		return fmt.Errorf("could not connect to %s: %w", c.Host, err)
	}
	defer client.Close()

	if c.Username != "" {
		// PlainAuth refuses to hand credentials to an unencrypted connection
		// (except on localhost), which is the behaviour we want: a misconfigured
		// "none" relay fails loudly instead of leaking the password.
		if err := client.Auth(smtp.PlainAuth("", c.Username, c.Password, c.Host)); err != nil {
			return fmt.Errorf("the server rejected the login: %w", err)
		}
	}
	if err := client.Mail(c.FromAddr); err != nil {
		return fmt.Errorf("the server rejected the sender %s: %w", c.FromAddr, err)
	}
	for _, addr := range to {
		if err := client.Rcpt(addr); err != nil {
			return fmt.Errorf("the server rejected the recipient %s: %w", addr, err)
		}
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(buildMessage(c, to, subject, body)); err != nil {
		w.Close()
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return client.Quit()
}

// ---- admin API --------------------------------------------------------------

// adminGetSMTP returns the mail settings for the Admin · Settings page. The
// password is never sent back: the page shows whether one is stored and leaves
// the field blank, so an admin editing the host does not have to retype it and a
// read of this endpoint does not disclose it.
func (s *Server) adminGetSMTP() response {
	c := s.smtpSettings()
	c.Password = ""
	return jsonResp(200, map[string]any{
		"smtp":         c,
		"password_set": s.smtpSettings().Password != "",
	})
}

// adminSetSMTP replaces the mail settings. An absent or empty password keeps the
// stored one, so the page can save without ever holding the secret; sending
// "password": "" with clear_password true wipes it.
func (s *Server) adminSetSMTP(req *request) response {
	raw, err := req.getBody(64 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		smtpConfig
		ClearPassword bool `json:"clear_password"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}
	c := body.smtpConfig
	if c.Password == "" && !body.ClearPassword {
		c.Password = s.smtpSettings().Password
	}
	if err := s.setSMTPSettings(c); err != nil {
		return textResp(400, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok"})
}

// adminTestSMTP sends a single message to the given address so the operator can
// confirm the relay works before anything depends on it. It sends with whatever
// is currently saved, so the page saves first.
func (s *Server) adminTestSMTP(req *request) response {
	raw, err := req.getBody(8 * 1024)
	if err != nil {
		return textResp(500, "internal error: "+err.Error())
	}
	var body struct {
		To string `json:"to"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return textResp(400, "bad request: body must be JSON")
	}
	to := strings.TrimSpace(body.To)
	if to == "" {
		return textResp(400, "an address to send the test to is required")
	}
	subject := "Tagged test email"
	text := "This is a test message from your Tagged server.\n\n" +
		"If you are reading it, the SMTP settings on Admin · Settings work.\n"
	if err := s.sendMail([]string{to}, subject, text); err != nil {
		return textResp(400, err.Error())
	}
	return jsonResp(200, map[string]any{"status": "ok", "to": to})
}
