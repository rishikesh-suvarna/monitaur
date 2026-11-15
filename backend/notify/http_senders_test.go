package notify

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"
)

type capturedRequest struct {
	method string
	path   string
	host   string
	header http.Header
	body   []byte
}

// receiver is a fake vendor endpoint that records every request.
func receiver(t *testing.T, status int, respBody string) (*httptest.Server, <-chan capturedRequest) {
	t.Helper()
	reqs := make(chan capturedRequest, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		reqs <- capturedRequest{method: r.Method, path: r.URL.Path, host: r.Host, header: r.Header.Clone(), body: body}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, reqs
}

// rewriteTransport sends every request to target while keeping the original
// Host and path, so vendor senders can be pointed at a local receiver
// without loosening their hooks.slack.com / discord.com validation.
type rewriteTransport struct{ target *url.URL }

func (rt rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.URL.Scheme = rt.target.Scheme
	r2.URL.Host = rt.target.Host
	return http.DefaultTransport.RoundTrip(r2)
}

func clientFor(t *testing.T, srv *httptest.Server) *http.Client {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: rewriteTransport{target: u}, Timeout: testClientTimeout}
}

func receive(t *testing.T, reqs <-chan capturedRequest) capturedRequest {
	t.Helper()
	select {
	case r := <-reqs:
		return r
	case <-time.After(testClientTimeout):
		t.Fatal("receiver got no request")
		return capturedRequest{}
	}
}

func firedMessage(server string) Message {
	return Message{
		Kind: KindFired, OrgID: 1, IncidentID: 42, ServerName: server, RuleName: "Disk critical",
		Metric: "disk", Severity: "critical", Value: 94.2, Threshold: 90, Unit: "%",
		StartedAt: testStart, DashboardURL: "https://app.example.com/incidents/42",
	}
}

func TestSlackSender(t *testing.T) {
	srv, reqs := receiver(t, http.StatusOK, "ok")
	s := NewSlackSender(clientFor(t, srv))
	ch := Channel{ID: 7, OrgID: 1, Type: Slack, Name: "ops", Enabled: true, Config: ChannelConfig{WebhookURL: validSlackURL}}

	if err := s.Send(context.Background(), ch, firedMessage("<!channel> db & co")); err != nil {
		t.Fatalf("Send: %v", err)
	}
	r := receive(t, reqs)
	if r.method != http.MethodPost || r.host != slackHost || r.path != "/services/T000/B000/XXXXXXXXabcd" {
		t.Fatalf("request = %s %s%s, want POST to the webhook path", r.method, r.host, r.path)
	}
	if ct := r.header.Get("Content-Type"); ct != contentTypeJSON {
		t.Errorf("Content-Type = %q", ct)
	}
	var p slackPayload
	if err := json.Unmarshal(r.body, &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	wantText := "[CRITICAL] disk on &lt;!channel&gt; db &amp; co: 94.2% (threshold 90%)"
	if p.Text != wantText {
		t.Errorf("text = %q, want %q", p.Text, wantText)
	}
	if strings.Contains(string(r.body), "<!channel>") {
		t.Error("payload contains an unescaped <!channel> mention")
	}
	if len(p.Blocks) < 2 || p.Blocks[0].Text == nil || p.Blocks[0].Text.Text != "*"+wantText+"*" {
		t.Fatalf("first block = %+v, want bold subject", p.Blocks)
	}
	last := p.Blocks[len(p.Blocks)-1]
	if last.Type != slackBlockContext || len(last.Elements) != 1 ||
		last.Elements[0].Text != "<https://app.example.com/incidents/42|View in Monitaur>" {
		t.Errorf("last block = %+v, want dashboard link", last)
	}
}

func TestSlackSenderRefusesNonSlackHost(t *testing.T) {
	srv, reqs := receiver(t, http.StatusOK, "ok")
	s := NewSlackSender(clientFor(t, srv))
	ch := Channel{Type: Slack, Name: "ops", Config: ChannelConfig{WebhookURL: "https://evil.example.com/services/x"}}
	if err := s.Send(context.Background(), ch, firedMessage("web-1")); err == nil {
		t.Fatal("Send to a non-Slack host succeeded")
	}
	select {
	case <-reqs:
		t.Fatal("a request was sent despite the invalid URL")
	default:
	}
}

func TestDiscordSender(t *testing.T) {
	resolvedAt := testNow
	tests := []struct {
		name      string
		msg       Message
		wantColor int
		wantTS    time.Time
	}{
		{"critical is red", firedMessage("@everyone db-1"), discordColorCritical, testStart},
		{"warning is amber", func() Message { m := firedMessage("db-1"); m.Severity = "warning"; return m }(), discordColorWarning, testStart},
		{"resolved is green", func() Message { m := firedMessage("db-1"); m.Kind = KindResolved; m.ResolvedAt = &resolvedAt; return m }(), discordColorOK, resolvedAt},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, reqs := receiver(t, http.StatusNoContent, "")
			s := NewDiscordSender(clientFor(t, srv))
			ch := Channel{Type: Discord, Name: "ops", Config: ChannelConfig{WebhookURL: validDiscordURL}}
			if err := s.Send(context.Background(), ch, tt.msg); err != nil {
				t.Fatalf("Send: %v", err)
			}
			r := receive(t, reqs)
			if r.host != discordHost || r.path != "/api/webhooks/123456/tokentokenwxyz" {
				t.Fatalf("request to %s%s", r.host, r.path)
			}
			var p discordPayload
			if err := json.Unmarshal(r.body, &p); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if len(p.Embeds) != 1 {
				t.Fatalf("embeds = %d, want 1", len(p.Embeds))
			}
			e := p.Embeds[0]
			if e.Color != tt.wantColor {
				t.Errorf("color = %#x, want %#x", e.Color, tt.wantColor)
			}
			if e.URL != "https://app.example.com/incidents/42" {
				t.Errorf("url = %q", e.URL)
			}
			ts, err := time.Parse(time.RFC3339, e.Timestamp)
			if err != nil || !ts.Equal(tt.wantTS) {
				t.Errorf("timestamp = %q (%v), want %s", e.Timestamp, err, tt.wantTS)
			}
			if e.Title == "" || e.Description == "" || p.Content == "" {
				t.Errorf("empty title, description or content: %+v", p)
			}
			if p.AllowedMentions.Parse == nil || len(p.AllowedMentions.Parse) != 0 {
				t.Errorf("allowed_mentions.parse = %v, want empty list", p.AllowedMentions.Parse)
			}
			if strings.Contains(p.Content, "@everyone") {
				t.Errorf("content contains a live @everyone: %q", p.Content)
			}
		})
	}
}

func TestTelegramSender(t *testing.T) {
	srv, reqs := receiver(t, http.StatusOK, `{"ok":true}`)
	s := NewTelegramSender(srv.Client(), srv.URL)
	ch := Channel{Type: Telegram, Name: "tg", Config: ChannelConfig{TelegramToken: validTelegramTok, TelegramChatID: validTelegramChat}}

	if err := s.Send(context.Background(), ch, firedMessage("<script>alert(1)</script>")); err != nil {
		t.Fatalf("Send: %v", err)
	}
	r := receive(t, reqs)
	if r.path != "/bot"+validTelegramTok+"/sendMessage" {
		t.Fatalf("path = %q", r.path)
	}
	var p telegramPayload
	if err := json.Unmarshal(r.body, &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.ChatID != validTelegramChat || p.ParseMode != "HTML" || !p.DisableWebPagePreview {
		t.Errorf("payload = %+v", p)
	}
	if strings.Contains(p.Text, "<script>") {
		t.Errorf("text contains unescaped HTML: %q", p.Text)
	}
	if !strings.Contains(p.Text, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Errorf("text missing escaped server name: %q", p.Text)
	}
	if !strings.HasPrefix(p.Text, "<b>[CRITICAL] ") {
		t.Errorf("text should start with the bold subject: %q", p.Text)
	}
	if !strings.Contains(p.Text, `<a href="https://app.example.com/incidents/42">View in Monitaur</a>`) {
		t.Errorf("text missing dashboard link: %q", p.Text)
	}
}

func TestWebhookSenderSignsBody(t *testing.T) {
	const secret = "s3cret"
	srv, reqs := receiver(t, http.StatusAccepted, "")
	s := NewWebhookSender(srv.Client())
	ch := Channel{Type: Webhook, Name: "hook", Config: ChannelConfig{WebhookURL: srv.URL + "/hook", WebhookSecret: secret}}

	before := time.Now().UTC().Add(-time.Second)
	if err := s.Send(context.Background(), ch, firedMessage("db-1")); err != nil {
		t.Fatalf("Send: %v", err)
	}
	r := receive(t, reqs)

	// Verify exactly as a receiver would.
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(r.body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if got := r.header.Get(headerSignature); !hmac.Equal([]byte(got), []byte(want)) {
		t.Fatalf("signature = %q, want %q", got, want)
	}
	if ua := r.header.Get("User-Agent"); ua != "Monitaur-Webhook/1" {
		t.Errorf("User-Agent = %q", ua)
	}
	if ev := r.header.Get(headerEvent); ev != "fired" {
		t.Errorf("X-Monitaur-Event = %q", ev)
	}
	if ct := r.header.Get("Content-Type"); ct != contentTypeJSON {
		t.Errorf("Content-Type = %q", ct)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(r.body, &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	keys := slices.Sorted(maps.Keys(raw))
	wantKeys := []string{"dashboard_url", "event", "incident_id", "metric", "org_id", "resolved_at", "rule", "sent_at", "server", "severity", "source", "started_at", "threshold", "unit", "value"}
	if !slices.Equal(keys, wantKeys) {
		t.Fatalf("keys = %v, want %v", keys, wantKeys)
	}
	var p webhookPayload
	if err := json.Unmarshal(r.body, &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.Event != "fired" || p.IncidentID != 42 || p.OrgID != 1 || p.Source != SourceServer || p.Server != "db-1" || p.Rule != "Disk critical" ||
		p.Metric != "disk" || p.Severity != "critical" || p.Value != 94.2 || p.Threshold != 90 || p.Unit != "%" ||
		p.DashboardURL != "https://app.example.com/incidents/42" {
		t.Errorf("payload = %+v", p)
	}
	if p.StartedAt == nil || !p.StartedAt.Equal(testStart) {
		t.Errorf("started_at = %v, want %v", p.StartedAt, testStart)
	}
	if string(raw["resolved_at"]) != "null" {
		t.Errorf("resolved_at = %s, want null", raw["resolved_at"])
	}
	if p.SentAt.Before(before) {
		t.Errorf("sent_at = %v, want after %v", p.SentAt, before)
	}
}

func TestWebhookSenderUnsignedWithoutSecret(t *testing.T) {
	srv, reqs := receiver(t, http.StatusOK, "")
	s := NewWebhookSender(srv.Client())
	ch := Channel{Type: Webhook, Name: "hook", Config: ChannelConfig{WebhookURL: srv.URL}}
	if err := s.Send(context.Background(), ch, Message{Kind: KindTest}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	r := receive(t, reqs)
	if sig := r.header.Get(headerSignature); sig != "" {
		t.Errorf("unexpected signature %q", sig)
	}
	if ev := r.header.Get(headerEvent); ev != "test" {
		t.Errorf("X-Monitaur-Event = %q, want test", ev)
	}
}

func TestHTTPSendersReportNon2xx(t *testing.T) {
	longBody := strings.Repeat("x", 1000)
	srv, _ := receiver(t, http.StatusInternalServerError, longBody)
	s := NewWebhookSender(srv.Client())
	ch := Channel{Type: Webhook, Name: "hook", Config: ChannelConfig{WebhookURL: srv.URL}}

	err := s.Send(context.Background(), ch, firedMessage("db-1"))
	if err == nil {
		t.Fatal("Send succeeded on a 500")
	}
	msg := err.Error()
	if !strings.Contains(msg, "500") {
		t.Errorf("error %q lacks the status code", msg)
	}
	if !strings.Contains(msg, strings.Repeat("x", errorBodySnippet)) || strings.Contains(msg, strings.Repeat("x", errorBodySnippet+1)) {
		t.Errorf("error should include exactly %d bytes of body, got %d", errorBodySnippet, strings.Count(msg, "x"))
	}
}

// The webhook URL is the credential for Slack and Discord and carries the bot
// token for Telegram, so transport errors must never echo it.
func TestHTTPSenderErrorsDoNotLeakURL(t *testing.T) {
	srv, reqs := receiver(t, http.StatusOK, "")
	s := NewWebhookSender(SafeHTTPClient(testClientTimeout, false))
	ch := Channel{Type: Webhook, Name: "hook", Config: ChannelConfig{WebhookURL: srv.URL + "/secret-token-path?key=hunter2"}}

	err := s.Send(context.Background(), ch, firedMessage("db-1"))
	if err == nil {
		t.Fatal("Send to loopback succeeded through the safe client")
	}
	if strings.Contains(err.Error(), "secret-token-path") || strings.Contains(err.Error(), "hunter2") {
		t.Errorf("error leaks the URL: %v", err)
	}
	if !strings.Contains(err.Error(), "not allowed") {
		t.Errorf("error = %v, want a blocked-address error", err)
	}
	select {
	case <-reqs:
		t.Fatal("request reached the loopback receiver")
	default:
	}
}

func TestSendersRejectWrongChannelType(t *testing.T) {
	ch := Channel{Type: Email, Name: "x", Config: ChannelConfig{EmailTo: []string{"a@example.com"}}}
	senders := map[string]Sender{
		"slack":    NewSlackSender(nil),
		"discord":  NewDiscordSender(nil),
		"telegram": NewTelegramSender(nil, ""),
		"webhook":  NewWebhookSender(nil),
	}
	for name, s := range senders {
		if err := s.Send(context.Background(), ch, firedMessage("db-1")); err == nil {
			t.Errorf("%s sender accepted an email channel", name)
		}
	}
}

func TestWebhookPayloadSource(t *testing.T) {
	tests := []struct {
		name, in, want string
	}{
		{"server", SourceServer, SourceServer},
		{"check", SourceCheck, SourceCheck},
		{"unset means server", "", SourceServer},
		{"unknown means server", "other", SourceServer},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, reqs := receiver(t, http.StatusOK, "")
			ch := Channel{Type: Webhook, Name: "hook", Config: ChannelConfig{WebhookURL: srv.URL}}
			msg := firedMessage("api health")
			msg.Source = tt.in
			if err := NewWebhookSender(srv.Client()).Send(context.Background(), ch, msg); err != nil {
				t.Fatalf("Send: %v", err)
			}
			var p webhookPayload
			if err := json.Unmarshal(receive(t, reqs).body, &p); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if p.Source != tt.want {
				t.Errorf("source = %q, want %q", p.Source, tt.want)
			}
		})
	}
}
