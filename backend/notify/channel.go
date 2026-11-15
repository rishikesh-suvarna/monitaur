// Package notify delivers alert, test and invite messages to tenant-configured
// channels (email, Slack, Discord, Telegram, generic webhooks).
//
// Every string that reaches a message (server names, rule names, org names) is
// tenant-controlled now that sign-up is public, so all formatting goes through
// one sanitizer and each sender escapes for its own output format.
package notify

import (
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ChannelType identifies the delivery mechanism of a channel.
type ChannelType string

const (
	Email    ChannelType = "email"
	Slack    ChannelType = "slack"
	Discord  ChannelType = "discord"
	Telegram ChannelType = "telegram"
	Webhook  ChannelType = "webhook"
)

// Channel is one notification destination owned by an organization.
type Channel struct {
	ID, OrgID int64
	Type      ChannelType
	Name      string
	Enabled   bool
	Config    ChannelConfig
}

// ChannelConfig holds the per-type destination settings. It contains secrets
// (webhook URLs, HMAC secrets, bot tokens): use Redacted for anything that
// leaves the backend.
type ChannelConfig struct {
	EmailTo        []string `json:"email_to,omitempty"`
	WebhookURL     string   `json:"webhook_url,omitempty"`    // slack, discord, webhook
	WebhookSecret  string   `json:"webhook_secret,omitempty"` // webhook HMAC
	TelegramToken  string   `json:"telegram_token,omitempty"`
	TelegramChatID string   `json:"telegram_chat_id,omitempty"`
}

const (
	maxChannelNameRunes = 60
	minEmailRecipients  = 1
	maxEmailRecipients  = 10
	maxWebhookSecretLen = 256
	maxURLLen           = 2048
	maxTelegramChatLen  = 64

	slackHost       = "hooks.slack.com"
	discordHost     = "discord.com"
	discordHostOld  = "discordapp.com"
	discordHookPath = "/api/webhooks/"
	httpsPort       = "443"

	schemeHTTP  = "http"
	schemeHTTPS = "https"
)

var (
	telegramTokenRe = regexp.MustCompile(`^\d+:[A-Za-z0-9_-]{20,}$`)
	// Telegram accepts a numeric chat id (negative for groups and channels) or
	// a public @username. Anything else would fail at Telegram anyway, so
	// rejecting it here gives the user an immediate, clear error.
	telegramChatRe = regexp.MustCompile(`^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$`)
)

// Validate checks the channel name and the config fields required by its type.
func (c Channel) Validate() error {
	if err := validateName(c.Name); err != nil {
		return err
	}
	switch c.Type {
	case Email:
		return validateEmailRecipients(c.Config.EmailTo)
	case Slack:
		_, err := validateSlackURL(c.Config.WebhookURL)
		return err
	case Discord:
		_, err := validateDiscordURL(c.Config.WebhookURL)
		return err
	case Webhook:
		if _, err := validateWebhookURL(c.Config.WebhookURL); err != nil {
			return err
		}
		if len(c.Config.WebhookSecret) > maxWebhookSecretLen {
			return fmt.Errorf("webhook secret must be at most %d characters", maxWebhookSecretLen)
		}
		return nil
	case Telegram:
		if !telegramTokenRe.MatchString(c.Config.TelegramToken) {
			return errors.New("telegram bot token is malformed")
		}
		chat := c.Config.TelegramChatID
		if chat == "" {
			return errors.New("telegram chat id is required")
		}
		if len(chat) > maxTelegramChatLen || !telegramChatRe.MatchString(chat) {
			return errors.New("telegram chat id must be a numeric id or an @username")
		}
		return nil
	default:
		return fmt.Errorf("unknown channel type %q", c.Type)
	}
}

func validateName(name string) error {
	trimmed := strings.TrimSpace(name)
	if !utf8.ValidString(name) {
		return errors.New("channel name must be valid UTF-8")
	}
	n := utf8.RuneCountInString(trimmed)
	if n < 1 || n > maxChannelNameRunes {
		return fmt.Errorf("channel name must be 1 to %d characters", maxChannelNameRunes)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return errors.New("channel name must not contain control characters")
		}
	}
	return nil
}

func validateEmailRecipients(to []string) error {
	if len(to) < minEmailRecipients || len(to) > maxEmailRecipients {
		return fmt.Errorf("email channels need %d to %d recipients", minEmailRecipients, maxEmailRecipients)
	}
	for i, raw := range to {
		if _, err := mail.ParseAddress(raw); err != nil {
			return fmt.Errorf("recipient %d is not a valid email address", i+1)
		}
	}
	return nil
}

// parseHookURL applies the checks shared by every URL-based channel. Userinfo
// is rejected for vendor webhooks because it is never needed there and only
// serves to disguise the real host ("https://hooks.slack.com@evil.test").
func parseHookURL(raw string, allowedSchemes ...string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("webhook url is required")
	}
	if len(raw) > maxURLLen {
		return nil, fmt.Errorf("webhook url must be at most %d characters", maxURLLen)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("webhook url is not a valid URL")
	}
	schemeOK := false
	for _, s := range allowedSchemes {
		if u.Scheme == s {
			schemeOK = true
			break
		}
	}
	if !schemeOK {
		return nil, fmt.Errorf("webhook url must use %s", strings.Join(allowedSchemes, " or "))
	}
	if u.Hostname() == "" {
		return nil, errors.New("webhook url must include a host")
	}
	return u, nil
}

func validateVendorURL(raw string, hosts ...string) (*url.URL, error) {
	u, err := parseHookURL(raw, schemeHTTPS)
	if err != nil {
		return nil, err
	}
	if u.User != nil {
		return nil, errors.New("webhook url must not contain credentials")
	}
	if p := u.Port(); p != "" && p != httpsPort {
		return nil, errors.New("webhook url must not use a custom port")
	}
	for _, h := range hosts {
		if strings.EqualFold(u.Hostname(), h) {
			return u, nil
		}
	}
	return nil, fmt.Errorf("webhook url host must be %s", strings.Join(hosts, " or "))
}

func validateSlackURL(raw string) (*url.URL, error) {
	return validateVendorURL(raw, slackHost)
}

func validateDiscordURL(raw string) (*url.URL, error) {
	u, err := validateVendorURL(raw, discordHost, discordHostOld)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(u.Path, discordHookPath) {
		return nil, fmt.Errorf("discord webhook url path must start with %s", discordHookPath)
	}
	return u, nil
}

func validateWebhookURL(raw string) (*url.URL, error) {
	return parseHookURL(raw, schemeHTTP, schemeHTTPS)
}

const (
	redactEllipsis       = "\u2026"
	redactTailLen        = 4
	redactChatHeadLen    = 4
	redactChatTailLen    = 3
	redactChatMinMasked  = redactChatHeadLen + redactChatTailLen + 1
	redactInvalid        = "invalid"
	redactSignedYes      = "yes"
	redactSignedNo       = "no"
	redactKeyRecipients  = "recipients"
	redactKeyDestination = "destination"
	redactKeyChat        = "chat"
	redactKeyURL         = "url"
	redactKeySigned      = "signed"
)

// Redacted returns a summary that is safe to show in the API and UI. It never
// contains a full webhook URL (the URL is the credential for Slack and
// Discord), a bot token or an HMAC secret.
func (c ChannelConfig) Redacted(t ChannelType) map[string]string {
	switch t {
	case Email:
		return map[string]string{redactKeyRecipients: redactRecipients(c.EmailTo)}
	case Slack, Discord:
		return map[string]string{redactKeyDestination: redactVendorURL(c.WebhookURL)}
	case Telegram:
		return map[string]string{redactKeyChat: redactChat(c.TelegramChatID)}
	case Webhook:
		signed := redactSignedNo
		if c.WebhookSecret != "" {
			signed = redactSignedYes
		}
		return map[string]string{redactKeyURL: redactWebhookURL(c.WebhookURL), redactKeySigned: signed}
	default:
		return map[string]string{}
	}
}

func redactRecipients(to []string) string {
	if len(to) == 0 {
		return ""
	}
	first := clean(to[0], maxNameRunes)
	if addr, err := mail.ParseAddress(to[0]); err == nil {
		first = addr.Address
	}
	if len(to) == 1 {
		return first
	}
	return first + " +" + strconv.Itoa(len(to)-1)
}

// redactVendorURL keeps the host and the last few characters of the path so a
// user can tell two Slack channels apart without the URL being replayable.
func redactVendorURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return redactInvalid
	}
	host := strings.ToLower(u.Hostname())
	path := strings.TrimRight(u.Path, "/")
	if utf8.RuneCountInString(path) <= redactTailLen {
		return host + "/" + redactEllipsis
	}
	runes := []rune(path)
	return host + "/" + redactEllipsis + "/" + string(runes[len(runes)-redactTailLen:])
}

func redactWebhookURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return redactInvalid
	}
	// u.Host keeps an explicit port, which helps tell receivers apart; userinfo
	// is dropped because it may carry basic-auth credentials.
	base := u.Scheme + "://" + strings.ToLower(u.Host)
	if strings.Trim(u.Path, "/") == "" && u.RawQuery == "" {
		return base
	}
	return base + "/" + redactEllipsis
}

func redactChat(chat string) string {
	runes := []rune(clean(chat, maxTelegramChatLen))
	if len(runes) < redactChatMinMasked {
		return string(runes)
	}
	return string(runes[:redactChatHeadLen]) + redactEllipsis + string(runes[len(runes)-redactChatTailLen:])
}
