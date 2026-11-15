package notify

import (
	"maps"
	"strings"
	"testing"
)

const (
	validSlackURL     = "https://hooks.slack.com/services/T000/B000/XXXXXXXXabcd"
	validDiscordURL   = "https://discord.com/api/webhooks/123456/tokentokenwxyz"
	validTelegramTok  = "123456:ABCdefGhIJKlmNoPQRsTUVwxyZ_-12345"
	validTelegramChat = "-1001234567789"
)

func TestChannelValidate(t *testing.T) {
	email := func(to ...string) Channel {
		return Channel{Type: Email, Name: "ops", Config: ChannelConfig{EmailTo: to}}
	}
	hook := func(typ ChannelType, u string) Channel {
		return Channel{Type: typ, Name: "hook", Config: ChannelConfig{WebhookURL: u}}
	}
	tg := func(token, chat string) Channel {
		return Channel{Type: Telegram, Name: "tg", Config: ChannelConfig{TelegramToken: token, TelegramChatID: chat}}
	}
	eleven := make([]string, maxEmailRecipients+1)
	for i := range eleven {
		eleven[i] = "a@example.com"
	}

	tests := []struct {
		name    string
		ch      Channel
		wantErr string // substring; "" means valid
	}{
		{"email single", email("ops@example.com"), ""},
		{"email with display name", email("Ops Team <ops@example.com>"), ""},
		{"email ten recipients", email(eleven[:maxEmailRecipients]...), ""},
		{"email none", email(), "1 to 10 recipients"},
		{"email eleven", email(eleven...), "1 to 10 recipients"},
		{"email malformed", email("not-an-email"), "not a valid email"},
		{"email header injection", email("a@example.com\r\nBcc: c@example.com"), "not a valid email"},

		{"slack ok", hook(Slack, validSlackURL), ""},
		{"slack http", hook(Slack, "http://hooks.slack.com/services/x"), "must use https"},
		{"slack other host", hook(Slack, "https://evil.example.com/services/x"), "host must be hooks.slack.com"},
		{"slack suffix host", hook(Slack, "https://hooks.slack.com.evil.example/x"), "host must be hooks.slack.com"},
		{"slack userinfo disguise", hook(Slack, "https://hooks.slack.com@evil.example/x"), "credentials"},
		{"slack custom port", hook(Slack, "https://hooks.slack.com:8443/services/x"), "custom port"},
		{"slack empty", hook(Slack, ""), "required"},

		{"discord ok", hook(Discord, validDiscordURL), ""},
		{"discordapp ok", hook(Discord, "https://discordapp.com/api/webhooks/1/abc"), ""},
		{"discord wrong path", hook(Discord, "https://discord.com/api/other/1/abc"), "/api/webhooks/"},
		{"discord wrong host", hook(Discord, "https://discord.gg/api/webhooks/1/abc"), "host must be"},

		{"webhook http", hook(Webhook, "http://example.com/hook"), ""},
		{"webhook https with secret", Channel{Type: Webhook, Name: "w", Config: ChannelConfig{WebhookURL: "https://example.com/hook", WebhookSecret: strings.Repeat("s", maxWebhookSecretLen)}}, ""},
		{"webhook secret too long", Channel{Type: Webhook, Name: "w", Config: ChannelConfig{WebhookURL: "https://example.com/hook", WebhookSecret: strings.Repeat("s", maxWebhookSecretLen+1)}}, "at most 256"},
		{"webhook ftp", hook(Webhook, "ftp://example.com/hook"), "http or https"},
		{"webhook javascript", hook(Webhook, "javascript:alert(1)"), "http or https"},
		{"webhook no host", hook(Webhook, "http:///hook"), "host"},
		{"webhook url too long", hook(Webhook, "https://example.com/"+strings.Repeat("a", maxURLLen)), "at most"},

		{"telegram numeric chat", tg(validTelegramTok, validTelegramChat), ""},
		{"telegram username chat", tg(validTelegramTok, "@ops_alerts"), ""},
		{"telegram bad token", tg("abc", validTelegramChat), "token"},
		{"telegram short token secret", tg("123:short", validTelegramChat), "token"},
		{"telegram token with path", tg("123456:ABCdefGhIJKlmNoPQRsTUVwxyZ/../x", validTelegramChat), "token"},
		{"telegram empty chat", tg(validTelegramTok, ""), "required"},
		{"telegram junk chat", tg(validTelegramTok, "hello world"), "numeric id"},

		{"name empty", Channel{Type: Webhook, Name: "", Config: ChannelConfig{WebhookURL: "https://example.com"}}, "1 to 60"},
		{"name blank", Channel{Type: Webhook, Name: "   ", Config: ChannelConfig{WebhookURL: "https://example.com"}}, "1 to 60"},
		{"name 60 chars", Channel{Type: Webhook, Name: strings.Repeat("n", 60), Config: ChannelConfig{WebhookURL: "https://example.com"}}, ""},
		{"name 61 chars", Channel{Type: Webhook, Name: strings.Repeat("n", 61), Config: ChannelConfig{WebhookURL: "https://example.com"}}, "1 to 60"},
		{"name with newline", Channel{Type: Webhook, Name: "a\nb", Config: ChannelConfig{WebhookURL: "https://example.com"}}, "control"},
		{"unknown type", Channel{Type: "pager", Name: "x"}, "unknown channel type"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.ch.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() = nil, want error containing %q", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Validate() = %q, want it to contain %q", err, tt.wantErr)
			}
		})
	}
}

func TestChannelConfigRedacted(t *testing.T) {
	tests := []struct {
		name    string
		typ     ChannelType
		cfg     ChannelConfig
		want    map[string]string
		secrets []string // must not appear in any value
	}{
		{
			name: "email single",
			typ:  Email,
			cfg:  ChannelConfig{EmailTo: []string{"ops@x.com"}},
			want: map[string]string{"recipients": "ops@x.com"},
		},
		{
			name: "email several with display name",
			typ:  Email,
			cfg:  ChannelConfig{EmailTo: []string{"Ops <ops@x.com>", "b@x.com", "c@x.com"}},
			want: map[string]string{"recipients": "ops@x.com +2"},
		},
		{
			name:    "slack",
			typ:     Slack,
			cfg:     ChannelConfig{WebhookURL: validSlackURL},
			want:    map[string]string{"destination": "hooks.slack.com/\u2026/abcd"},
			secrets: []string{"T000", "B000", "XXXXXXXX"},
		},
		{
			name:    "discord",
			typ:     Discord,
			cfg:     ChannelConfig{WebhookURL: validDiscordURL},
			want:    map[string]string{"destination": "discord.com/\u2026/wxyz"},
			secrets: []string{"123456", "tokentoken"},
		},
		{
			name:    "telegram",
			typ:     Telegram,
			cfg:     ChannelConfig{TelegramToken: validTelegramTok, TelegramChatID: validTelegramChat},
			want:    map[string]string{"chat": "-100\u2026789"},
			secrets: []string{validTelegramTok, "ABCdef", "1234567"},
		},
		{
			name: "telegram short chat id shown as is",
			typ:  Telegram,
			cfg:  ChannelConfig{TelegramToken: validTelegramTok, TelegramChatID: "12345"},
			want: map[string]string{"chat": "12345"},
		},
		{
			name:    "webhook signed",
			typ:     Webhook,
			cfg:     ChannelConfig{WebhookURL: "https://example.com/hooks/secret-path?k=v", WebhookSecret: "s3cret-value"},
			want:    map[string]string{"url": "https://example.com/\u2026", "signed": "yes"},
			secrets: []string{"secret-path", "k=v", "s3cret-value"},
		},
		{
			name:    "webhook with basic auth and port",
			typ:     Webhook,
			cfg:     ChannelConfig{WebhookURL: "https://user:pass@example.com:8443/"},
			want:    map[string]string{"url": "https://example.com:8443", "signed": "no"},
			secrets: []string{"user", "pass"},
		},
		{
			name: "unparseable url",
			typ:  Slack,
			cfg:  ChannelConfig{WebhookURL: "::not a url"},
			want: map[string]string{"destination": "invalid"},
		},
		{
			name: "unknown type",
			typ:  "pager",
			cfg:  ChannelConfig{WebhookSecret: "x"},
			want: map[string]string{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.cfg.Redacted(tt.typ)
			if !maps.Equal(got, tt.want) {
				t.Fatalf("Redacted() = %v, want %v", got, tt.want)
			}
			for _, v := range got {
				for _, s := range tt.secrets {
					if strings.Contains(v, s) {
						t.Errorf("redacted value %q leaks %q", v, s)
					}
				}
			}
		})
	}
}
