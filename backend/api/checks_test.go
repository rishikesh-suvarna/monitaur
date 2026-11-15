package api

import (
	"testing"

	"backend/checks"
	"backend/config"
)

func TestNormalizeTarget(t *testing.T) {
	tests := []struct {
		name         string
		typ          checks.Type
		raw          string
		allowPrivate bool
		want         string // "" means rejected
	}{
		{"https url", checks.TypeHTTP, "https://example.com/health?x=1", false, "https://example.com/health?x=1"},
		{"http url with port", checks.TypeHTTP, "http://example.com:8080/", false, "http://example.com:8080/"},
		{"not http", checks.TypeHTTP, "ftp://example.com", false, ""},
		{"no host", checks.TypeHTTP, "https:///path", false, ""},
		{"credentials", checks.TypeHTTP, "https://u:p@example.com", false, ""},
		{"bad port", checks.TypeHTTP, "https://example.com:0", false, ""},
		{"spaces", checks.TypeHTTP, "https://exa mple.com", false, ""},
		{"loopback literal", checks.TypeHTTP, "http://127.0.0.1:8080", false, ""},
		{"metadata endpoint", checks.TypeHTTP, "http://169.254.169.254/latest", false, ""},
		{"localhost", checks.TypeHTTP, "http://localhost:3000", false, ""},
		{"ipv6 loopback", checks.TypeHTTP, "http://[::1]:80", false, ""},
		{"private allowed when self-hosted", checks.TypeHTTP, "http://10.0.0.5:9000/ping", true, "http://10.0.0.5:9000/ping"},
		{"tcp host:port", checks.TypeTCP, "db.example.com:5432", false, "db.example.com:5432"},
		{"tcp missing port", checks.TypeTCP, "db.example.com", false, ""},
		{"tcp with scheme", checks.TypeTCP, "tcp://db.example.com:5432", false, ""},
		{"tcp private", checks.TypeTCP, "192.168.1.10:22", false, ""},
		{"tcp bad host", checks.TypeTCP, "a:b:c", false, ""},
		{"tls default port", checks.TypeTLS, "example.com", false, "example.com:443"},
		{"tls explicit port", checks.TypeTLS, "example.com:8443", false, "example.com:8443"},
		{"tls ipv6 default port", checks.TypeTLS, "2606:4700::1111", false, "[2606:4700::1111]:443"},
		{"tls path", checks.TypeTLS, "example.com/x", false, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := &API{Deps: Deps{Config: &config.Config{Checks: config.ChecksConfig{AllowPrivateTargets: tt.allowPrivate}}}}
			got, msg := a.normalizeTarget(tt.typ, tt.raw)
			if got != tt.want || (tt.want == "") != (msg != "") {
				t.Fatalf("normalizeTarget(%s, %q) = %q, %q; want %q", tt.typ, tt.raw, got, msg, tt.want)
			}
		})
	}
}
