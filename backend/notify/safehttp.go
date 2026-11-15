package notify

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

const (
	safeDialTimeout           = 5 * time.Second
	safeKeepAlive             = 30 * time.Second
	safeTLSHandshakeTimeout   = 5 * time.Second
	safeResponseHeaderTimeout = 10 * time.Second
	safeExpectContinueTimeout = 1 * time.Second
	safeIdleConnTimeout       = 90 * time.Second
	safeMaxIdleConns          = 32
	safeMaxIdleConnsPerHost   = 4
	maxRedirects              = 3
)

// errBlockedAddress is returned (wrapped) when a destination resolves to an
// address tenants must not reach.
var errBlockedAddress = errors.New("destination address is not allowed")

// blockedPrefixes are ranges that IsLoopback/IsPrivate/IsLinkLocal* and
// friends in net/netip do not cover but that still reach infrastructure
// rather than the public internet.
var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),     // "this network"; 0.0.0.0 reaches localhost on Linux
	netip.MustParsePrefix("100.64.0.0/10"), // CGNAT, also used by Tailscale and some cloud metadata setups
	netip.MustParsePrefix("192.0.0.0/24"),  // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"), // benchmarking, sometimes used for internal networks
	netip.MustParsePrefix("240.0.0.0/4"),   // reserved, includes 255.255.255.255 broadcast
	netip.MustParsePrefix("fec0::/10"),     // deprecated site-local, still routed by some stacks
}

// nat64Prefix is the well-known NAT64 prefix; its last 32 bits embed an IPv4
// address that a NAT64 gateway would forward to.
var nat64Prefix = netip.MustParsePrefix("64:ff9b::/96")

// isBlockedIP reports whether a tenant-supplied URL may not connect to addr.
func isBlockedIP(addr netip.Addr) bool {
	if !addr.IsValid() {
		return true
	}
	addr = addr.Unmap() // ::ffff:127.0.0.1 must be judged as 127.0.0.1
	if addr.IsLoopback() || addr.IsPrivate() || addr.IsUnspecified() ||
		addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() ||
		addr.IsInterfaceLocalMulticast() || addr.IsMulticast() {
		return true
	}
	for _, p := range blockedPrefixes {
		if p.Contains(addr) {
			return true
		}
	}
	if nat64Prefix.Contains(addr) {
		b := addr.As16()
		return isBlockedIP(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
	}
	return false
}

// blockPrivateControl runs after DNS resolution and before connect, for every
// connection the transport opens (including redirects and keep-alive
// re-dials). Checking here rather than on the URL is what defeats DNS
// rebinding and redirect-based SSRF.
func blockPrivateControl(network, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%w: %v", errBlockedAddress, err)
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("%w: unparseable address %q", errBlockedAddress, host)
	}
	if isBlockedIP(addr) {
		return fmt.Errorf("%w: %s", errBlockedAddress, addr.WithZone(""))
	}
	return nil
}

// SafeHTTPClient refuses loopback, private, link-local and unspecified addresses unless allowPrivate (self-hosted).
func SafeHTTPClient(timeout time.Duration, allowPrivate bool) *http.Client {
	dialer := &net.Dialer{Timeout: safeDialTimeout, KeepAlive: safeKeepAlive}
	if !allowPrivate {
		dialer.Control = blockPrivateControl
	}
	transport := &http.Transport{
		// No proxy, deliberately: with a proxy the dialer only ever sees the
		// proxy's address, so the private-range check would be bypassed.
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   safeTLSHandshakeTimeout,
		ResponseHeaderTimeout: safeResponseHeaderTimeout,
		ExpectContinueTimeout: safeExpectContinueTimeout,
		IdleConnTimeout:       safeIdleConnTimeout,
		MaxIdleConns:          safeMaxIdleConns,
		MaxIdleConnsPerHost:   safeMaxIdleConnsPerHost,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return fmt.Errorf("stopped after %d redirects", maxRedirects)
			}
			return nil
		},
	}
}
