package notify

import (
	"math"
	"strings"
	"testing"
	"time"
)

var (
	testStart = time.Date(2026, 11, 15, 14, 0, 0, 0, time.UTC)
	testNow   = testStart.Add(23 * time.Minute)
)

func TestRenderSubject(t *testing.T) {
	resolvedAt := testNow
	const mib = 1024 * 1024
	tests := []struct {
		name string
		msg  Message
		want string
	}{
		{
			name: "fired percent",
			msg:  Message{Kind: KindFired, ServerName: "db-primary-fra1", Metric: "disk", Severity: "critical", Value: 94.24, Threshold: 90, Unit: "%", StartedAt: testStart},
			want: "[CRITICAL] disk on db-primary-fra1: 94.2% (threshold 90%)",
		},
		{
			name: "renotify adds firing duration",
			msg:  Message{Kind: KindRenotify, ServerName: "db-primary-fra1", Metric: "disk", Severity: "critical", Value: 94.24, Threshold: 90, Unit: "%", StartedAt: testStart},
			want: "[CRITICAL] disk on db-primary-fra1: 94.2% (threshold 90%), firing for 23m",
		},
		{
			name: "resolved",
			msg:  Message{Kind: KindResolved, ServerName: "db-primary-fra1", Metric: "disk", Severity: "critical", Value: 80, Threshold: 90, Unit: "%", StartedAt: testStart, ResolvedAt: &resolvedAt},
			want: "[RESOLVED] disk on db-primary-fra1 after 23m",
		},
		{
			name: "heartbeat uses value as seconds of silence",
			msg:  Message{Kind: KindFired, ServerName: "db-primary-fra1", Metric: "heartbeat", Severity: "critical", Value: 360, StartedAt: testStart},
			want: "[CRITICAL] db-primary-fra1: no heartbeat for 6m",
		},
		{
			name: "heartbeat without value falls back to incident age",
			msg:  Message{Kind: KindFired, ServerName: "db-primary-fra1", Metric: "heartbeat", Severity: "critical", StartedAt: testNow.Add(-6 * time.Minute)},
			want: "[CRITICAL] db-primary-fra1: no heartbeat for 6m",
		},
		{
			name: "network rate humanised",
			msg:  Message{Kind: KindFired, ServerName: "web-1", Metric: "net_in", Severity: "warning", Value: 5.5 * mib, Threshold: 5 * mib, Unit: "B/s", StartedAt: testStart},
			want: "[WARNING] net in on web-1: 5.5 MB/s (threshold 5 MB/s)",
		},
		{
			name: "missing severity",
			msg:  Message{Kind: KindFired, ServerName: "web-1", Metric: "cpu", Value: 91, Threshold: 80, Unit: "%"},
			want: "[ALERT] cpu on web-1: 91.0% (threshold 80%)",
		},
		{
			name: "missing server name",
			msg:  Message{Kind: KindFired, Metric: "cpu", Severity: "warning", Value: 91, Threshold: 80, Unit: "%"},
			want: "[WARNING] cpu on unknown server: 91.0% (threshold 80%)",
		},
		{
			name: "header injection is flattened",
			msg:  Message{Kind: KindFired, ServerName: "web-1\r\nBcc: evil@example.com", Metric: "cpu", Severity: "warning", Value: 91, Threshold: 80, Unit: "%"},
			want: "[WARNING] cpu on web-1 Bcc: evil@example.com: 91.0% (threshold 80%)",
		},
		{
			name: "test",
			msg:  Message{Kind: KindTest},
			want: "[TEST] Monitaur test notification",
		},
		{
			name: "invite",
			msg:  Message{Kind: KindInvite, InviteOrgName: "Acme Ops", InviteURL: "https://app.example.com/invite/abc"},
			want: "You have been invited to join Acme Ops on Monitaur",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := render(tt.msg, testNow)
			if got.Subject != tt.want {
				t.Errorf("subject = %q, want %q", got.Subject, tt.want)
			}
			if strings.Contains(strings.ToLower(got.Title), "alert alert") {
				t.Errorf("title = %q", got.Title)
			}
			if strings.ContainsAny(got.Subject, "\r\n") {
				t.Errorf("subject contains CR or LF: %q", got.Subject)
			}
		})
	}
}

func TestRenderLinks(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want string
	}{
		{"https dashboard link is kept", "https://app.example.com/incidents/7", "https://app.example.com/incidents/7"},
		{"javascript scheme is dropped", "javascript:alert(1)", ""},
		{"relative url is dropped", "/incidents/7", ""},
		{"url with whitespace is dropped", "https://app.example.com/a b", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := render(Message{Kind: KindFired, ServerName: "web-1", DashboardURL: tt.url}, testNow)
			if c.Link != tt.want {
				t.Errorf("link = %q, want %q", c.Link, tt.want)
			}
			hasLink := strings.Contains(c.plainText(), "View in Monitaur: ")
			if hasLink != (tt.want != "") {
				t.Errorf("plain text link presence = %v, want %v:\n%s", hasLink, tt.want != "", c.plainText())
			}
		})
	}
}

func TestFormatValue(t *testing.T) {
	tests := []struct {
		name      string
		v         float64
		unit      string
		value     string
		threshold string
	}{
		{"percent", 94.24, "%", "94.2%", "94.2%"},
		{"percent whole", 90, "%", "90.0%", "90%"},
		{"bytes", 512, "B/s", "512 B/s", "512 B/s"},
		{"kilobytes", 1536, "B/s", "1.5 KB/s", "1.5 KB/s"},
		{"megabytes whole", 10 * 1024 * 1024, "B/s", "10.0 MB/s", "10 MB/s"},
		{"gigabytes", 2.25 * 1024 * 1024 * 1024, "B/s", "2.2 GB/s", "2.2 GB/s"},
		{"unitless", 3, "", "3", "3"},
		{"other unit", 2.5, "req", "2.5 req", "2.5 req"},
		{"NaN", math.NaN(), "%", "n/a", "n/a"},
		{"Inf", math.Inf(1), "B/s", "n/a", "n/a"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatValue(tt.v, tt.unit); got != tt.value {
				t.Errorf("formatValue = %q, want %q", got, tt.value)
			}
			if got := formatThreshold(tt.v, tt.unit); got != tt.threshold {
				t.Errorf("formatThreshold = %q, want %q", got, tt.threshold)
			}
		})
	}
}

func TestHumanDuration(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want string
	}{
		{-5 * time.Second, "0s"},
		{45 * time.Second, "45s"},
		{23 * time.Minute, "23m"},
		{65 * time.Minute, "1h 5m"},
		{2 * time.Hour, "2h"},
		{48 * time.Hour, "2d"},
		{51 * time.Hour, "2d 3h"},
	}
	for _, tt := range tests {
		if got := humanDuration(tt.d); got != tt.want {
			t.Errorf("humanDuration(%v) = %q, want %q", tt.d, got, tt.want)
		}
	}
}

func TestClean(t *testing.T) {
	tests := []struct {
		name string
		in   string
		max  int
		want string
	}{
		{"plain", "web-1", 20, "web-1"},
		{"crlf becomes space", "a\r\nb", 20, "a b"},
		{"tabs and runs collapse", "a\t\t  b ", 20, "a b"},
		{"bidi override removed", "abc\u202Etxt.exe", 20, "abc txt.exe"},
		{"line separator removed", "a\u2028b", 20, "a b"},
		{"invalid utf8 replaced", "a\xffb", 20, "a\uFFFDb"},
		{"truncated with ellipsis", "abcdefghij", 5, "abcd\u2026"},
		{"exact length kept", "abcde", 5, "abcde"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := clean(tt.in, tt.max); got != tt.want {
				t.Errorf("clean(%q, %d) = %q, want %q", tt.in, tt.max, got, tt.want)
			}
		})
	}
}
