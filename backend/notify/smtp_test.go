package notify

import (
	"bytes"
	"context"
	"errors"
	"io"
	"maps"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"net/textproto"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const fakeSMTPSessionTimeout = 5 * time.Second

// fakeSMTP speaks just enough SMTP (EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT,
// no STARTTLS) to observe what the sender puts on the wire.
type fakeSMTP struct {
	ln         net.Listener
	rejectRcpt map[string]bool
	dataReply  string // reply after the terminating dot; default 250
	silent     bool   // accept the connection but never send a greeting

	mu       sync.Mutex
	sessions []*fakeSession
	wg       sync.WaitGroup
}

type fakeSession struct {
	auth bool
	from string
	rcpt []string
	data []byte
	cmds []string
}

// newFakeSMTP applies opts before the server starts, so the handler
// goroutines only ever read the behaviour fields.
func newFakeSMTP(t *testing.T, opts ...func(*fakeSMTP)) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeSMTP{ln: ln, rejectRcpt: map[string]bool{}}
	for _, opt := range opts {
		opt(f)
	}
	f.wg.Add(1)
	go f.serve()
	t.Cleanup(func() {
		ln.Close()
		f.wg.Wait()
	})
	return f
}

func (f *fakeSMTP) config() SMTPConfig {
	host, port, _ := net.SplitHostPort(f.ln.Addr().String())
	return SMTPConfig{Host: host, Port: port, From: "Monitaur <alerts@monitaur.test>"}
}

func (f *fakeSMTP) serve() {
	defer f.wg.Done()
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		f.wg.Add(1)
		go func() {
			defer f.wg.Done()
			f.handle(conn)
		}()
	}
}

// session returns a copy of the only session, waiting for its handler to
// finish so the test never reads state the server is still writing.
func (f *fakeSMTP) session(t *testing.T) fakeSession {
	t.Helper()
	f.ln.Close()
	f.wg.Wait()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sessions) != 1 {
		t.Fatalf("sessions = %d, want 1", len(f.sessions))
	}
	s := *f.sessions[0]
	s.rcpt = slices.Clone(s.rcpt)
	s.cmds = slices.Clone(s.cmds)
	return s
}

func (f *fakeSMTP) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(fakeSMTPSessionTimeout))
	sess := &fakeSession{}
	f.mu.Lock()
	f.sessions = append(f.sessions, sess)
	f.mu.Unlock()

	if f.silent {
		_, _ = io.Copy(io.Discard, conn)
		return
	}
	tp := textproto.NewConn(conn)
	reply := func(lines ...string) {
		for _, l := range lines {
			_ = tp.PrintfLine("%s", l)
		}
	}
	reply("220 fake.test ESMTP")
	for {
		line, err := tp.ReadLine()
		if err != nil {
			return
		}
		verb, arg, _ := strings.Cut(line, " ")
		f.mu.Lock()
		sess.cmds = append(sess.cmds, strings.ToUpper(verb))
		f.mu.Unlock()
		switch strings.ToUpper(verb) {
		case "EHLO":
			reply("250-fake.test", "250-AUTH PLAIN", "250 8BITMIME")
		case "HELO", "RSET", "NOOP":
			reply("250 OK")
		case "AUTH":
			f.mu.Lock()
			sess.auth = true
			f.mu.Unlock()
			reply("235 2.7.0 Authentication successful")
		case "MAIL":
			f.mu.Lock()
			sess.from = addrArg(arg)
			f.mu.Unlock()
			reply("250 OK")
		case "RCPT":
			addr := addrArg(arg)
			if f.rejectRcpt[addr] {
				reply("550 5.1.1 no such user")
				continue
			}
			f.mu.Lock()
			sess.rcpt = append(sess.rcpt, addr)
			f.mu.Unlock()
			reply("250 OK")
		case "DATA":
			reply("354 go ahead")
			data, err := readRawData(tp)
			if err != nil {
				return
			}
			f.mu.Lock()
			sess.data = data
			f.mu.Unlock()
			if f.dataReply != "" {
				reply(f.dataReply)
			} else {
				reply("250 2.0.0 queued")
			}
		case "QUIT":
			reply("221 bye")
			return
		default:
			reply("502 not implemented")
		}
	}
}

// readRawData reads a DATA payload byte for byte. textproto's ReadDotBytes
// would normalise CRLF to LF and hide a bare LF smuggled into a header.
func readRawData(tp *textproto.Conn) ([]byte, error) {
	var buf bytes.Buffer
	for {
		line, err := tp.R.ReadString('\n')
		if err != nil {
			return nil, err
		}
		if line == ".\r\n" {
			return buf.Bytes(), nil
		}
		buf.WriteString(strings.TrimPrefix(line, ".")) // undo dot-stuffing
	}
}

// addrArg extracts the address from "FROM:<a@b>" or "TO:<a@b>".
func addrArg(arg string) string {
	_, rest, _ := strings.Cut(arg, ":")
	rest = strings.TrimSpace(rest)
	if i := strings.IndexByte(rest, ' '); i >= 0 {
		rest = rest[:i]
	}
	return strings.Trim(rest, "<>")
}

func emailChannel(to ...string) Channel {
	return Channel{ID: 3, OrgID: 1, Type: Email, Name: "ops", Enabled: true, Config: ChannelConfig{EmailTo: to}}
}

func TestSMTPSendDeliversSanitizedMultipart(t *testing.T) {
	f := newFakeSMTP(t)
	s := NewSMTPSender(f.config())
	hostile := "<script>alert(1)</script>\r\nBcc: evil@example.com"

	if err := s.Send(context.Background(), emailChannel("ops@example.com"), firedMessage(hostile)); err != nil {
		t.Fatalf("Send: %v", err)
	}
	sess := f.session(t)
	if sess.auth {
		t.Error("AUTH sent although no username is configured")
	}
	if sess.from != "alerts@monitaur.test" {
		t.Errorf("MAIL FROM = %q", sess.from)
	}
	if !slices.Equal(sess.rcpt, []string{"ops@example.com"}) {
		t.Fatalf("RCPT = %v, want only the channel recipient", sess.rcpt)
	}

	// Every header line must be a real header: no injected line may start a
	// new field such as Bcc.
	head, _, ok := bytes.Cut(sess.data, []byte("\r\n\r\n"))
	if !ok {
		t.Fatal("message has no header/body separator")
	}
	for _, line := range strings.Split(string(head), "\r\n") {
		if strings.HasPrefix(strings.ToLower(line), "bcc:") {
			t.Fatalf("injected header line %q", line)
		}
		if strings.ContainsAny(line, "\r\n") {
			t.Fatalf("header line contains a bare CR or LF: %q", line)
		}
	}

	m, err := mail.ReadMessage(bytes.NewReader(sess.data))
	if err != nil {
		t.Fatalf("parse message: %v", err)
	}
	if len(m.Header["Bcc"]) != 0 {
		t.Fatalf("message has a Bcc header: %v", m.Header["Bcc"])
	}
	subject, err := new(mime.WordDecoder).DecodeHeader(m.Header.Get("Subject"))
	if err != nil {
		t.Fatalf("decode subject: %v", err)
	}
	wantSubject := "[CRITICAL] disk on <script>alert(1)</script> Bcc: evil@example.com: 94.2% (threshold 90%)"
	if subject != wantSubject {
		t.Errorf("subject = %q, want %q", subject, wantSubject)
	}
	if !strings.HasPrefix(m.Header.Get("Message-Id"), "<") || !strings.HasSuffix(m.Header.Get("Message-Id"), "@monitaur.test>") {
		t.Errorf("Message-ID = %q", m.Header.Get("Message-Id"))
	}
	if _, err := m.Header.Date(); err != nil {
		t.Errorf("Date header: %v", err)
	}
	if got := m.Header.Get("Auto-Submitted"); got != "auto-generated" {
		t.Errorf("Auto-Submitted = %q", got)
	}

	mediaType, params, err := mime.ParseMediaType(m.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/alternative" {
		t.Fatalf("Content-Type = %q (%v)", m.Header.Get("Content-Type"), err)
	}
	parts := map[string]string{}
	mr := multipart.NewReader(m.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("next part: %v", err)
		}
		body, err := io.ReadAll(p) // multipart decodes quoted-printable transparently
		if err != nil {
			t.Fatalf("read part: %v", err)
		}
		ct, _, _ := mime.ParseMediaType(p.Header.Get("Content-Type"))
		parts[ct] = string(body)
	}
	text, html := parts["text/plain"], parts["text/html"]
	if text == "" || html == "" {
		t.Fatalf("want text/plain and text/html parts, got %v", slices.Sorted(maps.Keys(parts)))
	}
	if strings.Contains(html, "<script>") {
		t.Error("HTML part contains an unescaped <script> tag")
	}
	if !strings.Contains(html, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Error("HTML part is missing the escaped server name")
	}
	if !strings.Contains(html, `href="https://app.example.com/incidents/42"`) {
		t.Error("HTML part is missing the dashboard link")
	}
	// html/template replaces unsafe CSS with ZgotmplZ; the accent must survive.
	if !strings.Contains(html, "solid "+colorCritical) || strings.Contains(html, "ZgotmplZ") {
		t.Error("HTML part lost the critical accent colour")
	}
	if !strings.Contains(text, "View in Monitaur: https://app.example.com/incidents/42") {
		t.Errorf("text part is missing the dashboard link:\n%s", text)
	}
}

func TestSMTPRequireTLSFailsWithoutSTARTTLS(t *testing.T) {
	f := newFakeSMTP(t)
	cfg := f.config()
	cfg.RequireTLS = true

	err := NewSMTPSender(cfg).Send(context.Background(), emailChannel("ops@example.com"), firedMessage("db-1"))
	if err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("Send = %v, want a STARTTLS error", err)
	}
	if sess := f.session(t); slices.Contains(sess.cmds, "MAIL") {
		t.Error("MAIL sent although TLS was required and unavailable")
	}
}

func TestSMTPRefusesAuthWithoutTLS(t *testing.T) {
	f := newFakeSMTP(t)
	cfg := f.config()
	cfg.Username, cfg.Password = "user", "pass"

	err := NewSMTPSender(cfg).Send(context.Background(), emailChannel("ops@example.com"), firedMessage("db-1"))
	if err == nil || !strings.Contains(err.Error(), "without TLS") {
		t.Fatalf("Send = %v, want a refusal to authenticate", err)
	}
	if sess := f.session(t); sess.auth {
		t.Error("credentials were sent over a cleartext connection")
	}
}

func TestSMTPReportsRejectionAfterData(t *testing.T) {
	f := newFakeSMTP(t, func(f *fakeSMTP) { f.dataReply = "554 5.7.1 rejected as spam" })

	err := NewSMTPSender(f.config()).Send(context.Background(), emailChannel("ops@example.com"), firedMessage("db-1"))
	if err == nil || !strings.Contains(err.Error(), "554") {
		t.Fatalf("Send = %v, want the 554 from the end of DATA", err)
	}
}

func TestSMTPPartialRecipientRejection(t *testing.T) {
	f := newFakeSMTP(t, func(f *fakeSMTP) { f.rejectRcpt["gone@example.com"] = true })

	err := NewSMTPSender(f.config()).Send(context.Background(), emailChannel("ops@example.com", "gone@example.com"), firedMessage("db-1"))
	if err == nil || !strings.Contains(err.Error(), "delivered to 1 of 2") || !strings.Contains(err.Error(), "gone@example.com") {
		t.Fatalf("Send = %v, want a partial delivery error naming the rejected address", err)
	}
	sess := f.session(t)
	if !slices.Equal(sess.rcpt, []string{"ops@example.com"}) || len(sess.data) == 0 {
		t.Fatalf("rcpt = %v, data = %d bytes; want delivery to the accepted address", sess.rcpt, len(sess.data))
	}
}

func TestSMTPHonoursContextDeadline(t *testing.T) {
	f := newFakeSMTP(t, func(f *fakeSMTP) { f.silent = true })
	const budget = 200 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()

	start := time.Now()
	err := NewSMTPSender(f.config()).Send(ctx, emailChannel("ops@example.com"), firedMessage("db-1"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Send = %v, want context.DeadlineExceeded", err)
	}
	if elapsed := time.Since(start); elapsed > 10*budget {
		t.Fatalf("Send took %v against a silent server, want about %v", elapsed, budget)
	}
}

func TestSMTPConfigErrors(t *testing.T) {
	tests := []struct {
		name string
		cfg  SMTPConfig
		want string
	}{
		{"no host", SMTPConfig{From: "a@example.com"}, "host"},
		{"bad from", SMTPConfig{Host: "127.0.0.1", From: "not an address"}, "from"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := NewSMTPSender(tt.cfg).Send(context.Background(), emailChannel("ops@example.com"), firedMessage("db-1"))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Send = %v, want error mentioning %q", err, tt.want)
			}
		})
	}
}
