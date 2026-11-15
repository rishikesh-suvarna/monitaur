package notify

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// SMTPConfig is the backend-wide outgoing mail server. Username empty means
// an unauthenticated relay (for example a local Postfix).
type SMTPConfig struct {
	Host, Port, Username, Password, From string
	RequireTLS                           bool
}

const (
	defaultSMTPPort     = "587"
	smtpDialTimeout     = 10 * time.Second
	smtpExchangeTimeout = 30 * time.Second
	messageIDRandBytes  = 16
	messageIDFallback   = "monitaur.invalid"
	smtpRejectMsgRunes  = 100
	crlf                = "\r\n"

	colorCritical = "#E5484D"
	colorWarning  = "#F5A524"
	colorResolved = "#30A46C"
	colorInfo     = "#3B82F6"
)

type smtpSender struct {
	cfg SMTPConfig
	now func() time.Time
}

// NewSMTPSender delivers email channels and direct (invite) mail.
func NewSMTPSender(cfg SMTPConfig) Sender {
	return &smtpSender{cfg: cfg, now: time.Now}
}

func (s *smtpSender) Send(ctx context.Context, ch Channel, msg Message) error {
	if err := checkType(ch, Email); err != nil {
		return err
	}
	if s.cfg.Host == "" {
		return errors.New("smtp: host is not configured")
	}
	from, err := mail.ParseAddress(s.cfg.From)
	if err != nil {
		return errors.New("smtp: from address is missing or invalid")
	}
	to := make([]*mail.Address, 0, len(ch.Config.EmailTo))
	for _, raw := range ch.Config.EmailTo {
		addr, err := mail.ParseAddress(raw)
		if err != nil {
			return fmt.Errorf("smtp: invalid recipient: %w", err)
		}
		to = append(to, addr)
	}

	now := s.now()
	raw, err := buildEmail(from, to, render(msg, now), now)
	if err != nil {
		return err
	}
	return s.transmit(ctx, from.Address, to, raw)
}

// transmit runs one SMTP session. Every network step is bounded: the dial by
// smtpDialTimeout, the whole exchange by a connection deadline, and a
// cancelled ctx aborts blocked I/O immediately. The old sender had none of
// these, so a blackholed relay leaked a goroutine per alert.
func (s *smtpSender) transmit(ctx context.Context, from string, to []*mail.Address, raw []byte) error {
	port := s.cfg.Port
	if port == "" {
		port = defaultSMTPPort
	}
	dialer := net.Dialer{Timeout: smtpDialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(s.cfg.Host, port))
	if err != nil {
		return smtpErr(ctx, "connect", err)
	}
	defer conn.Close()

	deadline := time.Now().Add(smtpExchangeTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return smtpErr(ctx, "set deadline", err)
	}
	// A deadline in the past unblocks any pending read or write at once.
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	defer stop()

	c, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		return smtpErr(ctx, "greeting", err)
	}
	defer c.Close()

	secure := false
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: s.cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return smtpErr(ctx, "starttls", err)
		}
		secure = true
	} else if s.cfg.RequireTLS {
		return errors.New("smtp: server does not offer STARTTLS and TLS is required")
	}

	if s.cfg.Username != "" {
		// Credentials only ever travel inside TLS, even to a relay that would
		// accept them in cleartext.
		if !secure {
			return errors.New("smtp: refusing to authenticate without TLS")
		}
		if err := c.Auth(smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)); err != nil {
			return smtpErr(ctx, "auth", err)
		}
	}

	if err := c.Mail(from); err != nil {
		return smtpErr(ctx, "mail from", err)
	}
	accepted := 0
	var rejected []string
	for _, addr := range to {
		if err := c.Rcpt(addr.Address); err != nil {
			var perr *textproto.Error
			if !errors.As(err, &perr) {
				return smtpErr(ctx, "rcpt to", err)
			}
			// One bad address must not block delivery to the rest of the team.
			rejected = append(rejected, fmt.Sprintf("%s (%d %s)", addr.Address, perr.Code, clean(perr.Msg, smtpRejectMsgRunes)))
			continue
		}
		accepted++
	}
	if accepted == 0 {
		return fmt.Errorf("smtp: all recipients rejected: %s", strings.Join(rejected, "; "))
	}

	w, err := c.Data()
	if err != nil {
		return smtpErr(ctx, "data", err)
	}
	if _, err := w.Write(raw); err != nil {
		_ = w.Close()
		return smtpErr(ctx, "write message", err)
	}
	// Close sends the final dot and reads the server's verdict on the message.
	// The old sender ignored this error and logged rejected mail as sent.
	if err := w.Close(); err != nil {
		return smtpErr(ctx, "message rejected", err)
	}
	// The message is already accepted; a failed QUIT does not undo that.
	_ = c.Quit()

	if len(rejected) > 0 {
		return fmt.Errorf("smtp: delivered to %d of %d recipients; rejected: %s", accepted, len(to), strings.Join(rejected, "; "))
	}
	return nil
}

// smtpErr prefers the context's error so a timeout reads as one rather than
// as an opaque "i/o timeout" from the forced deadline. The connection
// deadline can expire a moment before ctx's own timer fires, hence the
// explicit deadline comparison.
func smtpErr(ctx context.Context, step string, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("smtp: %s: %w", step, ctxErr)
	}
	if d, ok := ctx.Deadline(); ok && !time.Now().Before(d) {
		return fmt.Errorf("smtp: %s: %w", step, context.DeadlineExceeded)
	}
	return fmt.Errorf("smtp: %s: %w", step, err)
}

// buildEmail assembles a multipart/alternative message. Header values come
// from parsed addresses and sanitized content, and writeHeader strips CR and
// LF once more so no interpolated value can start a new header.
func buildEmail(from *mail.Address, to []*mail.Address, c content, now time.Time) ([]byte, error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := writeQPPart(mw, "text/plain; charset=utf-8", []byte(c.plainText())); err != nil {
		return nil, fmt.Errorf("smtp: text part: %w", err)
	}
	var htmlBuf bytes.Buffer
	if err := emailTemplate.Execute(&htmlBuf, newEmailView(c)); err != nil {
		return nil, fmt.Errorf("smtp: render html: %w", err)
	}
	if err := writeQPPart(mw, "text/html; charset=utf-8", htmlBuf.Bytes()); err != nil {
		return nil, fmt.Errorf("smtp: html part: %w", err)
	}
	if err := mw.Close(); err != nil {
		return nil, fmt.Errorf("smtp: close multipart: %w", err)
	}

	msgID, err := newMessageID(from.Address, now)
	if err != nil {
		return nil, err
	}
	recipients := make([]string, len(to))
	for i, a := range to {
		recipients[i] = a.String()
	}

	var buf bytes.Buffer
	writeHeader(&buf, "From", from.String())
	writeHeader(&buf, "To", strings.Join(recipients, ", "))
	writeHeader(&buf, "Subject", mime.QEncoding.Encode("utf-8", c.Subject))
	writeHeader(&buf, "Date", now.Format(time.RFC1123Z))
	writeHeader(&buf, "Message-ID", msgID)
	writeHeader(&buf, "MIME-Version", "1.0")
	writeHeader(&buf, "Content-Type", mime.FormatMediaType("multipart/alternative", map[string]string{"boundary": mw.Boundary()}))
	// RFC 3834: stops vacation responders from replying to alert mail.
	writeHeader(&buf, "Auto-Submitted", "auto-generated")
	buf.WriteString(crlf)
	buf.Write(body.Bytes())
	return buf.Bytes(), nil
}

var headerCRLF = strings.NewReplacer("\r", "", "\n", "")

func writeHeader(buf *bytes.Buffer, name, value string) {
	buf.WriteString(name)
	buf.WriteString(": ")
	buf.WriteString(headerCRLF.Replace(value))
	buf.WriteString(crlf)
}

func writeQPPart(mw *multipart.Writer, contentType string, data []byte) error {
	h := textproto.MIMEHeader{}
	h.Set("Content-Type", contentType)
	h.Set("Content-Transfer-Encoding", "quoted-printable")
	pw, err := mw.CreatePart(h)
	if err != nil {
		return err
	}
	qp := quotedprintable.NewWriter(pw)
	if _, err := qp.Write(data); err != nil {
		return err
	}
	return qp.Close()
}

func newMessageID(from string, now time.Time) (string, error) {
	b := make([]byte, messageIDRandBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("smtp: message id: %w", err)
	}
	domain := messageIDFallback
	if i := strings.LastIndexByte(from, '@'); i >= 0 && i < len(from)-1 {
		domain = from[i+1:]
	}
	return "<" + hex.EncodeToString(b) + "." + strconv.FormatInt(now.UnixNano(), 36) + "@" + domain + ">", nil
}

type emailView struct {
	Subject    string
	Title      string
	Summary    string
	Fields     []field
	Paragraphs []string
	Link       string
	LinkLabel  string
	Accent     template.CSS // only ever one of the color constants, never tenant input
	Footer     string
}

func newEmailView(c content) emailView {
	accent := colorInfo
	switch c.Tone {
	case toneCritical:
		accent = colorCritical
	case toneWarning:
		accent = colorWarning
	case toneResolved:
		accent = colorResolved
	}
	return emailView{
		Subject:    c.Subject,
		Title:      c.Title,
		Summary:    c.Summary,
		Fields:     c.Fields,
		Paragraphs: c.Paragraphs,
		Link:       c.Link,
		LinkLabel:  c.LinkLabel,
		Accent:     template.CSS(accent),
		Footer:     footerText,
	}
}

// emailTemplate is parsed at init from a constant, so Must can only fail on a
// programming error that every test run would catch.
var emailTemplate = template.Must(template.New("email").Parse(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{.Subject}}</title></head>
<body style="margin:0;padding:24px 12px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2328;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e1e4e8;border-radius:8px;border-collapse:separate;">
<tr><td style="padding:20px 24px 12px;border-top:4px solid {{.Accent}};border-radius:8px 8px 0 0;">
<p style="margin:0;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:{{.Accent}};">{{.Title}}</p>
<h1 style="margin:8px 0 0;font-size:18px;line-height:1.4;font-weight:600;">{{.Summary}}</h1>
</td></tr>
{{if .Fields}}<tr><td style="padding:4px 24px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
{{range .Fields}}<tr><td style="padding:6px 12px 6px 0;color:#57606a;white-space:nowrap;vertical-align:top;width:1%;">{{.Label}}</td><td style="padding:6px 0;word-break:break-word;">{{.Value}}</td></tr>
{{end}}</table>
</td></tr>{{end}}
{{range .Paragraphs}}<tr><td style="padding:4px 24px;font-size:14px;line-height:1.5;"><p style="margin:0 0 8px;">{{.}}</p></td></tr>
{{end}}
{{if .Link}}<tr><td style="padding:12px 24px 4px;"><a href="{{.Link}}" style="display:inline-block;padding:8px 16px;background:#1f2328;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">{{.LinkLabel}}</a></td></tr>{{end}}
<tr><td style="padding:16px 24px 20px;font-size:12px;color:#6e7781;">{{.Footer}}</td></tr>
</table>
</body>
</html>
`))
