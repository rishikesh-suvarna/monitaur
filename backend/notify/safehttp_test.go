package notify

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testClientTimeout = 2 * time.Second

func TestIsBlockedIP(t *testing.T) {
	tests := []struct {
		ip      string
		blocked bool
	}{
		// loopback
		{"127.0.0.1", true},
		{"127.1.2.3", true},
		{"::1", true},
		// RFC 1918
		{"10.0.0.1", true},
		{"172.16.5.4", true},
		{"172.31.255.255", true},
		{"192.168.1.1", true},
		// link-local, including the cloud metadata endpoint
		{"169.254.169.254", true},
		{"fe80::1", true},
		// IPv6 ULA
		{"fc00::1", true},
		{"fd12:3456::1", true},
		// CGNAT
		{"100.64.0.1", true},
		{"100.127.255.255", true},
		// unspecified and "this network"
		{"0.0.0.0", true},
		{"0.1.2.3", true},
		{"::", true},
		// multicast and broadcast
		{"224.0.0.1", true},
		{"ff02::1", true},
		{"255.255.255.255", true},
		// IPv4-mapped and NAT64 forms of private addresses
		{"::ffff:127.0.0.1", true},
		{"::ffff:10.0.0.1", true},
		{"64:ff9b::a00:1", true},
		// public
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"100.63.255.255", false},
		{"100.128.0.0", false},
		{"172.32.0.1", false},
		{"2606:4700:4700::1111", false},
		{"::ffff:8.8.8.8", false},
		{"64:ff9b::808:808", false},
	}
	for _, tt := range tests {
		t.Run(tt.ip, func(t *testing.T) {
			if got := isBlockedIP(netip.MustParseAddr(tt.ip)); got != tt.blocked {
				t.Errorf("isBlockedIP(%s) = %v, want %v", tt.ip, got, tt.blocked)
			}
		})
	}
}

func TestSafeHTTPClientBlocksLoopbackByDefault(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("request reached a loopback server")
	}))
	defer srv.Close()

	client := SafeHTTPClient(testClientTimeout, false)
	for _, target := range []string{srv.URL, strings.Replace(srv.URL, "127.0.0.1", "localhost", 1)} {
		resp, err := client.Get(target)
		if err == nil {
			resp.Body.Close()
			t.Fatalf("GET %s succeeded, want blocked", target)
		}
		if !errors.Is(err, errBlockedAddress) {
			t.Fatalf("GET %s error = %v, want errBlockedAddress", target, err)
		}
	}
}

func TestSafeHTTPClientAllowsPrivateWhenConfigured(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	resp, err := SafeHTTPClient(testClientTimeout, true).Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}
}

func TestSafeHTTPClientRedirectLimit(t *testing.T) {
	// /hop/N redirects to /hop/N-1; /hop/0 answers 200.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/hop/"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if n == 0 {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, fmt.Sprintf("/hop/%d", n-1), http.StatusTemporaryRedirect)
	}))
	defer srv.Close()

	client := SafeHTTPClient(testClientTimeout, true)
	tests := []struct {
		hops    int
		wantErr bool
	}{
		{0, false},
		{MaxRedirects, false},
		{MaxRedirects + 1, true},
	}
	for _, tt := range tests {
		t.Run(strconv.Itoa(tt.hops), func(t *testing.T) {
			resp, err := client.Get(fmt.Sprintf("%s/hop/%d", srv.URL, tt.hops))
			if resp != nil {
				resp.Body.Close()
			}
			if (err != nil) != tt.wantErr {
				t.Fatalf("hops=%d err = %v, wantErr %v", tt.hops, err, tt.wantErr)
			}
		})
	}
}
