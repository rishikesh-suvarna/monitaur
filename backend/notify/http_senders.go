package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultHTTPTimeout   = 10 * time.Second
	errorBodySnippet     = 200
	maxDrainBytes        = 64 << 10
	contentTypeJSON      = "application/json"
	userAgentDefault     = "Monitaur/1"
	userAgentWebhook     = "Monitaur-Webhook/1"
	headerEvent          = "X-Monitaur-Event"
	headerSignature      = "X-Monitaur-Signature"
	signaturePrefix      = "sha256="
	defaultTelegramAPI   = "https://api.telegram.org"
	telegramParseMode    = "HTML"
	discordColorCritical = 0xE5484D
	discordColorWarning  = 0xF5A524
	discordColorOK       = 0x30A46C
	discordContentMax    = 2000
	discordTitleMax      = 256
	discordDescMax       = 4096
	telegramTextMax      = 4096
)

// defaultClient keeps a nil *http.Client from silently meaning "no SSRF
// protection": callers that do not pass one get the strict client.
func defaultClient(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return SafeHTTPClient(defaultHTTPTimeout, false)
}

// postJSON sends body and turns any failure into an error that is safe to
// store and show to the tenant: the request URL is never included because
// for Slack, Discord and Telegram the URL is the credential.
func postJSON(ctx context.Context, client *http.Client, service, target string, body []byte, header http.Header) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%s: build request: %w", service, stripURL(err))
	}
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set("Content-Type", contentTypeJSON)
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", userAgentDefault)
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%s: request to %s failed: %w", service, req.URL.Hostname(), stripURL(err))
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		// Drain so the keep-alive connection can be reused.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxDrainBytes))
		return nil
	}
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodySnippet))
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxDrainBytes))
	msg := clean(string(snippet), errorBodySnippet)
	if msg == "" {
		return fmt.Errorf("%s: unexpected status %d", service, resp.StatusCode)
	}
	return fmt.Errorf("%s: unexpected status %d: %s", service, resp.StatusCode, msg)
}

// stripURL removes the *url.Error wrapper, whose message embeds the full
// request URL (and with it the webhook secret or bot token).
func stripURL(err error) error {
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return uerr.Err
	}
	return err
}

func checkType(ch Channel, want ChannelType) error {
	if ch.Type != want {
		return fmt.Errorf("%s sender cannot deliver to a %s channel", want, ch.Type)
	}
	// Re-validating at send time keeps a stale or tampered row from steering
	// a vendor sender at an arbitrary host.
	return ch.Validate()
}

// ---- Slack ----

type slackSender struct {
	client *http.Client
	now    func() time.Time
}

// NewSlackSender posts to Slack incoming webhooks.
func NewSlackSender(client *http.Client) Sender {
	return &slackSender{client: defaultClient(client), now: time.Now}
}

type slackText struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type slackBlock struct {
	Type     string      `json:"type"`
	Text     *slackText  `json:"text,omitempty"`
	Fields   []slackText `json:"fields,omitempty"`
	Elements []slackText `json:"elements,omitempty"`
}

type slackPayload struct {
	Text   string       `json:"text"`
	Blocks []slackBlock `json:"blocks"`
}

const (
	slackMrkdwn       = "mrkdwn"
	slackMaxFields    = 10 // Slack rejects section blocks with more fields
	slackBlockSection = "section"
	slackBlockContext = "context"
)

func slackBold(s string) string { return "*" + s + "*" }

// slackEscape neutralises mrkdwn control sequences. Without it a server named
// "<!channel>" would ping the whole channel.
var slackEscape = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// slackLinkEscape keeps a URL from closing the <url|label> link syntax.
var slackLinkEscape = strings.NewReplacer("<", "%3C", ">", "%3E", "|", "%7C")

func (s *slackSender) Send(ctx context.Context, ch Channel, msg Message) error {
	if err := checkType(ch, Slack); err != nil {
		return err
	}
	c := render(msg, s.now())
	payload := slackPayload{
		Text: slackEscape.Replace(c.Subject),
		Blocks: []slackBlock{{
			Type: slackBlockSection,
			Text: &slackText{Type: slackMrkdwn, Text: slackBold(slackEscape.Replace(c.Subject))},
		}},
	}
	if len(c.Fields) > 0 {
		fields := make([]slackText, 0, min(len(c.Fields), slackMaxFields))
		for i, f := range c.Fields {
			if i == slackMaxFields {
				break
			}
			fields = append(fields, slackText{Type: slackMrkdwn, Text: slackBold(slackEscape.Replace(f.Label)) + "\n" + slackEscape.Replace(f.Value)})
		}
		payload.Blocks = append(payload.Blocks, slackBlock{Type: slackBlockSection, Fields: fields})
	}
	for _, p := range c.Paragraphs {
		payload.Blocks = append(payload.Blocks, slackBlock{Type: slackBlockSection, Text: &slackText{Type: slackMrkdwn, Text: slackEscape.Replace(p)}})
	}
	if c.Link != "" {
		payload.Blocks = append(payload.Blocks, slackBlock{
			Type:     slackBlockContext,
			Elements: []slackText{{Type: slackMrkdwn, Text: "<" + slackLinkEscape.Replace(c.Link) + "|" + slackEscape.Replace(c.LinkLabel) + ">"}},
		})
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("slack: encode payload: %w", err)
	}
	return postJSON(ctx, s.client, "slack", ch.Config.WebhookURL, body, nil)
}

// ---- Discord ----

type discordSender struct {
	client *http.Client
	now    func() time.Time
}

// NewDiscordSender posts to Discord channel webhooks.
func NewDiscordSender(client *http.Client) Sender {
	return &discordSender{client: defaultClient(client), now: time.Now}
}

type discordEmbed struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Color       int    `json:"color"`
	URL         string `json:"url,omitempty"`
	Timestamp   string `json:"timestamp"`
}

type discordAllowedMentions struct {
	Parse []string `json:"parse"`
}

type discordPayload struct {
	Content string         `json:"content"`
	Embeds  []discordEmbed `json:"embeds"`
	// An empty parse list stops "@everyone" or role mentions in a server name
	// from pinging anyone.
	AllowedMentions discordAllowedMentions `json:"allowed_mentions"`
}

// discordEscape backslash-escapes markdown so tenant strings render as text
// (and cannot forge masked links) in content and descriptions.
var discordEscape = strings.NewReplacer(
	`\`, `\\`, "*", `\*`, "_", `\_`, "~", `\~`, "`", "\\`", "|", `\|`,
	">", `\>`, "#", `\#`, "[", `\[`, "]", `\]`, "(", `\(`, ")", `\)`, "@", "@\u200B",
)

func discordColor(t tone) int {
	switch t {
	case toneCritical:
		return discordColorCritical
	case toneWarning:
		return discordColorWarning
	default:
		return discordColorOK
	}
}

func (s *discordSender) Send(ctx context.Context, ch Channel, msg Message) error {
	if err := checkType(ch, Discord); err != nil {
		return err
	}
	c := render(msg, s.now())
	var desc strings.Builder
	for _, f := range c.Fields {
		desc.WriteString("**" + discordEscape.Replace(f.Label) + ":** " + discordEscape.Replace(f.Value) + "\n")
	}
	for _, p := range c.Paragraphs {
		desc.WriteString(discordEscape.Replace(p) + "\n")
	}
	payload := discordPayload{
		Content: truncateRunes(discordEscape.Replace(c.Subject), discordContentMax),
		Embeds: []discordEmbed{{
			Title:       truncateRunes(c.Title+": "+c.Summary, discordTitleMax),
			Description: truncateRunes(strings.TrimRight(desc.String(), "\n"), discordDescMax),
			Color:       discordColor(c.Tone),
			URL:         c.Link,
			Timestamp:   c.Timestamp.UTC().Format(time.RFC3339),
		}},
		AllowedMentions: discordAllowedMentions{Parse: []string{}},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("discord: encode payload: %w", err)
	}
	return postJSON(ctx, s.client, "discord", ch.Config.WebhookURL, body, nil)
}

// ---- Telegram ----

type telegramSender struct {
	client  *http.Client
	apiBase string
	now     func() time.Time
}

// NewTelegramSender sends through the Bot API. An empty apiBase means the
// public api.telegram.org; tests and self-hosted Bot API servers override it.
func NewTelegramSender(client *http.Client, apiBase string) Sender {
	base := strings.TrimRight(apiBase, "/")
	if base == "" {
		base = defaultTelegramAPI
	}
	return &telegramSender{client: defaultClient(client), apiBase: base, now: time.Now}
}

type telegramPayload struct {
	ChatID                string `json:"chat_id"`
	Text                  string `json:"text"`
	ParseMode             string `json:"parse_mode"`
	DisableWebPagePreview bool   `json:"disable_web_page_preview"`
}

func (s *telegramSender) Send(ctx context.Context, ch Channel, msg Message) error {
	if err := checkType(ch, Telegram); err != nil {
		return err
	}
	c := render(msg, s.now())
	esc := html.EscapeString
	var b strings.Builder
	b.WriteString("<b>" + esc(c.Subject) + "</b>\n")
	if len(c.Fields) > 0 {
		b.WriteString("\n")
		for _, f := range c.Fields {
			b.WriteString(esc(f.Label) + ": " + esc(f.Value) + "\n")
		}
	}
	for _, p := range c.Paragraphs {
		b.WriteString("\n" + esc(p) + "\n")
	}
	if c.Link != "" {
		b.WriteString("\n<a href=\"" + esc(c.Link) + "\">" + esc(c.LinkLabel) + "</a>")
	}
	payload := telegramPayload{
		ChatID:                ch.Config.TelegramChatID,
		Text:                  strings.TrimRight(b.String(), "\n"),
		ParseMode:             telegramParseMode,
		DisableWebPagePreview: true,
	}
	if len([]rune(payload.Text)) > telegramTextMax {
		// Truncating escaped HTML could cut a tag in half; fall back to the
		// subject alone, which is short by construction.
		payload.Text = "<b>" + esc(c.Subject) + "</b>"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("telegram: encode payload: %w", err)
	}
	target := s.apiBase + "/bot" + url.PathEscape(ch.Config.TelegramToken) + "/sendMessage"
	return postJSON(ctx, s.client, "telegram", target, body, nil)
}

// ---- Generic webhook ----

type webhookSender struct {
	client *http.Client
	now    func() time.Time
}

// NewWebhookSender posts a JSON event to an arbitrary URL. Pass a
// SafeHTTPClient: the URL is fully tenant-controlled.
func NewWebhookSender(client *http.Client) Sender {
	return &webhookSender{client: defaultClient(client), now: time.Now}
}

type webhookPayload struct {
	Event        string     `json:"event"`
	IncidentID   int64      `json:"incident_id"`
	OrgID        int64      `json:"org_id"`
	Server       string     `json:"server"`
	Rule         string     `json:"rule"`
	Metric       string     `json:"metric"`
	Severity     string     `json:"severity"`
	Value        float64    `json:"value"`
	Threshold    float64    `json:"threshold"`
	Unit         string     `json:"unit"`
	StartedAt    *time.Time `json:"started_at"`
	ResolvedAt   *time.Time `json:"resolved_at"`
	DashboardURL string     `json:"dashboard_url"`
	SentAt       time.Time  `json:"sent_at"`
}

func (s *webhookSender) Send(ctx context.Context, ch Channel, msg Message) error {
	if err := checkType(ch, Webhook); err != nil {
		return err
	}
	payload := webhookPayload{
		Event:        string(msg.Kind),
		IncidentID:   msg.IncidentID,
		OrgID:        msg.OrgID,
		Server:       clean(msg.ServerName, maxNameRunes),
		Rule:         clean(msg.RuleName, maxNameRunes),
		Metric:       clean(msg.Metric, maxMetricRunes),
		Severity:     clean(msg.Severity, maxSeverityRunes),
		Value:        finiteOrZero(msg.Value), // encoding/json rejects NaN and Inf
		Threshold:    finiteOrZero(msg.Threshold),
		Unit:         clean(msg.Unit, maxUnitRunes),
		DashboardURL: safeLink(msg.DashboardURL),
		SentAt:       s.now().UTC(),
	}
	if !msg.StartedAt.IsZero() {
		t := msg.StartedAt.UTC()
		payload.StartedAt = &t
	}
	if msg.ResolvedAt != nil && !msg.ResolvedAt.IsZero() {
		t := msg.ResolvedAt.UTC()
		payload.ResolvedAt = &t
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("webhook: encode payload: %w", err)
	}
	header := http.Header{}
	header.Set("User-Agent", userAgentWebhook)
	header.Set(headerEvent, string(msg.Kind))
	if ch.Config.WebhookSecret != "" {
		header.Set(headerSignature, signaturePrefix+sign(ch.Config.WebhookSecret, body))
	}
	return postJSON(ctx, s.client, "webhook", ch.Config.WebhookURL, body, header)
}

// sign returns the hex HMAC-SHA256 of body, the value receivers recompute.
func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + redactEllipsis
}
