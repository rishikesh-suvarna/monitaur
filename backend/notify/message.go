package notify

import (
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// MessageKind is what happened. Alert kinds count against the email quota.
type MessageKind string

const (
	KindFired    MessageKind = "fired"
	KindRenotify MessageKind = "renotify"
	KindResolved MessageKind = "resolved"
	KindTest     MessageKind = "test"
	KindInvite   MessageKind = "invite"
)

// Message is the channel-agnostic notification. Senders render it with render
// so every channel shows the same subject and text.
type Message struct {
	Kind         MessageKind
	OrgID        int64
	IncidentID   int64
	ServerName   string
	RuleName     string
	Metric       string
	Severity     string
	Value        float64
	Threshold    float64
	Unit         string // "%", "B/s", ""
	StartedAt    time.Time
	ResolvedAt   *time.Time
	DashboardURL string
	// invites only
	InviteOrgName, InviteURL string
}

func isAlertKind(k MessageKind) bool {
	return k == KindFired || k == KindRenotify || k == KindResolved
}

const (
	unitPercent = "%"
	unitBytesPS = "B/s"

	metricHeartbeat = "heartbeat"
	severityCrit    = "critical"

	// Caps keep a hostile name from producing multi-kilobyte subjects or
	// blowing past vendor limits (Slack 3000, Discord 256 for titles).
	maxNameRunes     = 120
	maxSeverityRunes = 16
	maxMetricRunes   = 32
	maxUnitRunes     = 8

	productName     = "Monitaur"
	unknownServer   = "unknown server"
	timeLayout      = "2006-01-02 15:04:05 UTC"
	bytesStep       = 1024
	valuePrecision  = 1
	notApplicable   = "n/a"
	linkLabelAlert  = "View in Monitaur"
	linkLabelInvite = "Accept invitation"
	footerText      = "Sent by Monitaur."
)

// tone drives the accent colour of rich formats (email, Discord).
type tone int

const (
	toneCritical tone = iota
	toneWarning
	toneResolved
	toneInfo
)

type field struct {
	Label string
	Value string
}

// content is the rendered, sanitized form of a Message. Every string in it
// has had control characters removed and is length-capped, but is NOT
// escaped: each sender escapes for its own format (HTML, mrkdwn, JSON).
type content struct {
	Subject    string // single line, starts with a [TAG]
	Title      string // short label, e.g. "Critical alert"
	Summary    string // one line, the subject without its tag
	Fields     []field
	Paragraphs []string
	Link       string // validated http(s) URL, or ""
	LinkLabel  string
	Tone       tone
	Timestamp  time.Time
}

// render builds the content for msg. now is used for "firing for" durations
// and for timestamps of messages that have no incident time.
func render(msg Message, now time.Time) content {
	switch msg.Kind {
	case KindFired, KindRenotify:
		return renderFiring(msg, now)
	case KindResolved:
		return renderResolved(msg, now)
	case KindTest:
		return content{
			Subject: "[TEST] " + productName + " test notification",
			Title:   "Test notification",
			Summary: productName + " test notification",
			Paragraphs: []string{
				"This is a test notification from " + productName + ". If you received it, this channel is set up correctly.",
			},
			Link:      safeLink(msg.DashboardURL),
			LinkLabel: linkLabelAlert,
			Tone:      toneResolved,
			Timestamp: now,
		}
	case KindInvite:
		org := clean(msg.InviteOrgName, maxNameRunes)
		if org == "" {
			org = "an organization"
		}
		return content{
			Subject: "You have been invited to join " + org + " on " + productName,
			Title:   "Invitation",
			Summary: "Join " + org + " on " + productName,
			Paragraphs: []string{
				"You have been invited to join " + org + " on " + productName + ", a server monitoring dashboard.",
				"If you did not expect this invitation, you can ignore this email.",
			},
			Link:      safeLink(msg.InviteURL),
			LinkLabel: linkLabelInvite,
			Tone:      toneInfo,
			Timestamp: now,
		}
	default:
		return content{
			Subject:   "[" + productName + "] notification",
			Title:     "Notification",
			Summary:   productName + " notification",
			Link:      safeLink(msg.DashboardURL),
			LinkLabel: linkLabelAlert,
			Tone:      toneInfo,
			Timestamp: now,
		}
	}
}

type alertParts struct {
	server, rule, metric, severity string
	heartbeat                      bool
}

func alertPartsOf(msg Message) alertParts {
	server := clean(msg.ServerName, maxNameRunes)
	if server == "" {
		server = unknownServer
	}
	metric := strings.ReplaceAll(clean(msg.Metric, maxMetricRunes), "_", " ")
	return alertParts{
		server:    server,
		rule:      clean(msg.RuleName, maxNameRunes),
		metric:    metric,
		severity:  strings.ToLower(clean(msg.Severity, maxSeverityRunes)),
		heartbeat: strings.EqualFold(msg.Metric, metricHeartbeat),
	}
}

func renderFiring(msg Message, now time.Time) content {
	p := alertPartsOf(msg)
	firingFor := nonNegative(now.Sub(msg.StartedAt))

	var summary string
	if p.heartbeat {
		summary = fmt.Sprintf("%s: no heartbeat for %s", p.server, humanDuration(heartbeatSilence(msg, now)))
	} else {
		summary = fmt.Sprintf("%s on %s: %s (threshold %s)",
			p.metric, p.server, formatValue(msg.Value, msg.Unit), formatThreshold(msg.Threshold, msg.Unit))
		if msg.Kind == KindRenotify && !msg.StartedAt.IsZero() {
			summary += ", firing for " + humanDuration(firingFor)
		}
	}

	tag := strings.ToUpper(p.severity)
	if tag == "" {
		tag = "ALERT"
	}
	title := "Alert"
	if p.severity != "" {
		title = titleCase(p.severity) + " alert"
	}
	if msg.Kind == KindRenotify {
		title += ", still firing"
	}

	fields := []field{{"Server", p.server}}
	if p.rule != "" {
		fields = append(fields, field{"Rule", p.rule})
	}
	fields = append(fields, field{"Metric", p.metric})
	if !p.heartbeat {
		fields = append(fields,
			field{"Value", formatValue(msg.Value, msg.Unit)},
			field{"Threshold", formatThreshold(msg.Threshold, msg.Unit)})
	}
	if p.severity != "" {
		fields = append(fields, field{"Severity", p.severity})
	}
	ts := now
	if !msg.StartedAt.IsZero() {
		fields = append(fields, field{"Started", formatTime(msg.StartedAt)})
		if msg.Kind == KindRenotify {
			fields = append(fields, field{"Firing for", humanDuration(firingFor)})
		} else {
			ts = msg.StartedAt
		}
	}

	t := toneWarning
	if p.severity == severityCrit {
		t = toneCritical
	}
	return content{
		Subject:   "[" + tag + "] " + summary,
		Title:     title,
		Summary:   summary,
		Fields:    fields,
		Link:      safeLink(msg.DashboardURL),
		LinkLabel: linkLabelAlert,
		Tone:      t,
		Timestamp: ts.UTC(),
	}
}

func renderResolved(msg Message, now time.Time) content {
	p := alertPartsOf(msg)
	resolvedAt := now
	if msg.ResolvedAt != nil && !msg.ResolvedAt.IsZero() {
		resolvedAt = *msg.ResolvedAt
	}

	summary := fmt.Sprintf("%s on %s resolved", p.metric, p.server)
	var duration string
	if !msg.StartedAt.IsZero() {
		duration = humanDuration(nonNegative(resolvedAt.Sub(msg.StartedAt)))
		summary = fmt.Sprintf("%s on %s after %s", p.metric, p.server, duration)
	}

	fields := []field{{"Server", p.server}}
	if p.rule != "" {
		fields = append(fields, field{"Rule", p.rule})
	}
	fields = append(fields, field{"Metric", p.metric})
	if !p.heartbeat {
		fields = append(fields,
			field{"Value", formatValue(msg.Value, msg.Unit)},
			field{"Threshold", formatThreshold(msg.Threshold, msg.Unit)})
	}
	if !msg.StartedAt.IsZero() {
		fields = append(fields, field{"Started", formatTime(msg.StartedAt)})
	}
	fields = append(fields, field{"Resolved", formatTime(resolvedAt)})
	if duration != "" {
		fields = append(fields, field{"Duration", duration})
	}

	return content{
		Subject:   "[RESOLVED] " + summary,
		Title:     "Resolved",
		Summary:   summary,
		Fields:    fields,
		Link:      safeLink(msg.DashboardURL),
		LinkLabel: linkLabelAlert,
		Tone:      toneResolved,
		Timestamp: resolvedAt.UTC(),
	}
}

// heartbeatSilence is how long the server has been silent. The alerting
// engine reports it as Value in seconds; when it does not, the time since the
// incident started is the best available lower bound.
func heartbeatSilence(msg Message, now time.Time) time.Duration {
	if isFinite(msg.Value) && msg.Value > 0 {
		return time.Duration(msg.Value * float64(time.Second))
	}
	return nonNegative(now.Sub(msg.StartedAt))
}

// plainText is the text/plain rendering shared by email and any format that
// lacks structure.
func (c content) plainText() string {
	var b strings.Builder
	b.WriteString(c.Title)
	b.WriteString(": ")
	b.WriteString(c.Summary)
	b.WriteString("\n")
	if len(c.Fields) > 0 {
		b.WriteString("\n")
		for _, f := range c.Fields {
			b.WriteString(f.Label)
			b.WriteString(": ")
			b.WriteString(f.Value)
			b.WriteString("\n")
		}
	}
	for _, p := range c.Paragraphs {
		b.WriteString("\n")
		b.WriteString(p)
		b.WriteString("\n")
	}
	if c.Link != "" {
		b.WriteString("\n")
		b.WriteString(c.LinkLabel)
		b.WriteString(": ")
		b.WriteString(c.Link)
		b.WriteString("\n")
	}
	b.WriteString("\n")
	b.WriteString(footerText)
	b.WriteString("\n")
	return b.String()
}

// clean makes a tenant-controlled string safe to embed in any single-line
// context: invalid UTF-8 is replaced, control characters (CR, LF, tab, C1),
// Unicode line separators and bidi overrides become spaces, whitespace runs
// collapse, and the result is capped at max runes. Output-format escaping is
// still the sender's job.
func clean(s string, max int) string {
	if max < 1 {
		return ""
	}
	words := strings.FieldsFunc(strings.ToValidUTF8(s, "\uFFFD"), func(r rune) bool {
		return isUnsafeRune(r) || unicode.IsSpace(r)
	})
	out := strings.Join(words, " ")
	if utf8.RuneCountInString(out) <= max {
		return out
	}
	runes := []rune(out)
	return strings.TrimSpace(string(runes[:max-1])) + redactEllipsis
}

func isUnsafeRune(r rune) bool {
	if unicode.IsControl(r) {
		return true
	}
	switch {
	case r == '\u2028', r == '\u2029': // line and paragraph separators
		return true
	case r >= '\u202A' && r <= '\u202E', r >= '\u2066' && r <= '\u2069': // bidi embeddings, overrides, isolates
		return true
	case r == '\u200E', r == '\u200F', r == '\u061C': // directional marks
		return true
	case r == '\uFEFF': // BOM / zero-width no-break space
		return true
	}
	return false
}

// safeLink returns raw only if it is an absolute http(s) URL without
// whitespace or control characters, so it can be used as a link target.
func safeLink(raw string) string {
	if raw == "" || len(raw) > maxURLLen {
		return ""
	}
	for _, r := range raw {
		if isUnsafeRune(r) || unicode.IsSpace(r) {
			return ""
		}
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != schemeHTTP && u.Scheme != schemeHTTPS) || u.Host == "" {
		return ""
	}
	return u.String()
}

func formatValue(v float64, unit string) string {
	if !isFinite(v) {
		return notApplicable
	}
	switch unit {
	case unitPercent:
		return strconv.FormatFloat(v, 'f', valuePrecision, 64) + "%"
	case unitBytesPS:
		return humanRate(v, false)
	case "":
		return trimZero(strconv.FormatFloat(v, 'f', valuePrecision, 64))
	default:
		return trimZero(strconv.FormatFloat(v, 'f', valuePrecision, 64)) + " " + clean(unit, maxUnitRunes)
	}
}

// formatThreshold drops a trailing ".0" so a 90% threshold reads "90%".
func formatThreshold(v float64, unit string) string {
	if !isFinite(v) {
		return notApplicable
	}
	switch unit {
	case unitPercent:
		return trimZero(strconv.FormatFloat(v, 'f', valuePrecision, 64)) + "%"
	case unitBytesPS:
		return humanRate(v, true)
	default:
		return formatValue(v, unit)
	}
}

var rateUnits = []string{"B/s", "KB/s", "MB/s", "GB/s", "TB/s"}

// humanRate uses 1024 steps to match the dashboard's network charts.
func humanRate(v float64, trim bool) string {
	i := 0
	for math.Abs(v) >= bytesStep && i < len(rateUnits)-1 {
		v /= bytesStep
		i++
	}
	if i == 0 {
		return strconv.FormatFloat(math.Round(v), 'f', 0, 64) + " " + rateUnits[0]
	}
	s := strconv.FormatFloat(v, 'f', valuePrecision, 64)
	if trim {
		s = trimZero(s)
	}
	return s + " " + rateUnits[i]
}

func trimZero(s string) string {
	return strings.TrimSuffix(s, ".0")
}

const day = 24 * time.Hour

// humanDuration renders coarse, two-unit durations: 45s, 23m, 1h 5m, 2d 3h.
func humanDuration(d time.Duration) string {
	d = nonNegative(d)
	switch {
	case d < time.Minute:
		return strconv.Itoa(int(d/time.Second)) + "s"
	case d < time.Hour:
		return strconv.Itoa(int(d/time.Minute)) + "m"
	case d < day:
		h, m := int(d/time.Hour), int((d%time.Hour)/time.Minute)
		if m == 0 {
			return strconv.Itoa(h) + "h"
		}
		return strconv.Itoa(h) + "h " + strconv.Itoa(m) + "m"
	default:
		days, h := int(d/day), int((d%day)/time.Hour)
		if h == 0 {
			return strconv.Itoa(days) + "d"
		}
		return strconv.Itoa(days) + "d " + strconv.Itoa(h) + "h"
	}
}

func formatTime(t time.Time) string {
	return t.UTC().Format(timeLayout)
}

func nonNegative(d time.Duration) time.Duration {
	if d < 0 {
		return 0
	}
	return d
}

func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

func finiteOrZero(v float64) float64 {
	if isFinite(v) {
		return v
	}
	return 0
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	r, size := utf8.DecodeRuneInString(s)
	return string(unicode.ToUpper(r)) + s[size:]
}
