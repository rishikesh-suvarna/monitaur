package checks

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"time"

	"backend/notify"
)

const (
	// MaxBodyBytes bounds how much of an http response is searched for the
	// keyword, so a huge or endless body cannot tie up a worker.
	MaxBodyBytes  = 1 << 20
	maxErrorRunes = 200
	hoursPerDay   = 24
	userAgent     = "Monitaur-Uptime/1.0"
	minRedirect   = 300
	maxRedirect   = 399
	minSuccess    = 200
	maxSuccess    = 399
)

// Prober runs one probe per call. Every connection goes through the notify
// SSRF guard (blocked ranges are refused after DNS resolution) unless
// allowPrivate.
type Prober struct {
	allowPrivate bool
	roots        *x509.CertPool // nil = system roots
	now          func() time.Time
}

func NewProber(allowPrivate bool, roots *x509.CertPool, now func() time.Time) *Prober {
	if now == nil {
		now = time.Now
	}
	return &Prober{allowPrivate: allowPrivate, roots: roots, now: now}
}

// Probe runs c once, bounded by c.Timeout. It never returns an error: a
// failure is a Result with OK false and a tenant-safe Error.
func (p *Prober) Probe(ctx context.Context, c Check) Result {
	ctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()
	start := time.Now() // monotonic, for latency
	res := Result{At: p.now()}
	var err error
	switch c.Type {
	case TypeHTTP:
		err = p.probeHTTP(ctx, c, &res)
	case TypeTCP:
		err = p.probeTCP(ctx, c)
	case TypeTLS:
		err = p.probeTLS(ctx, c, &res)
	default:
		err = fmt.Errorf("unknown check type %q", c.Type)
	}
	res.Latency = time.Since(start)
	if err != nil {
		res.Error = describe(err, c.Timeout)
		return res
	}
	res.OK = true
	return res
}

func (p *Prober) tlsConfig(serverName string) *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: p.roots, ServerName: serverName}
}

func (p *Prober) probeHTTP(ctx context.Context, c Check, res *Result) error {
	// A fresh transport per probe: every probe measures a full connection
	// (DNS, TCP, TLS) and nothing idles between probes.
	tr := notify.SafeTransport(p.allowPrivate)
	tr.TLSClientConfig = p.tlsConfig("")
	tr.DisableKeepAlives = true
	tr.ResponseHeaderTimeout = 0 // the check timeout bounds the whole probe
	tr.DialContext = notify.SafeDialer(c.Timeout, p.allowPrivate).DialContext
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: c.Timeout, CheckRedirect: redirectPolicy(c.ExpectStatus)}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		res.CertDaysLeft = certDaysFromErr(err, p.now())
		return err
	}
	defer resp.Body.Close()
	res.StatusCode = resp.StatusCode
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		res.CertDaysLeft = daysLeft(resp.TLS.PeerCertificates[0], p.now())
	}
	if !statusMatches(resp.StatusCode, c.ExpectStatus) {
		if c.ExpectStatus == 0 {
			return fmt.Errorf("status %d, expected 2xx or 3xx", resp.StatusCode)
		}
		return fmt.Errorf("status %d, expected %d", resp.StatusCode, c.ExpectStatus)
	}
	if c.Keyword == "" {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxBodyBytes))
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	if !bytes.Contains(body, []byte(c.Keyword)) {
		return errors.New("keyword not found in the first 1 MB of the response")
	}
	return nil
}

// redirectPolicy follows up to notify.MaxRedirects hops, except when the
// check expects a 3xx: then the redirect itself is what is being checked.
func redirectPolicy(expect int) func(*http.Request, []*http.Request) error {
	if expect >= minRedirect && expect <= maxRedirect {
		return func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	return notify.LimitRedirects
}

func statusMatches(code, expect int) bool {
	if expect == 0 {
		return code >= minSuccess && code <= maxSuccess
	}
	return code == expect
}

func (p *Prober) probeTCP(ctx context.Context, c Check) error {
	conn, err := notify.SafeDialer(c.Timeout, p.allowPrivate).DialContext(ctx, "tcp", c.Target)
	if err != nil {
		return err
	}
	return conn.Close()
}

func (p *Prober) probeTLS(ctx context.Context, c Check, res *Result) error {
	host, _, err := net.SplitHostPort(c.Target)
	if err != nil {
		return err
	}
	raw, err := notify.SafeDialer(c.Timeout, p.allowPrivate).DialContext(ctx, "tcp", c.Target)
	if err != nil {
		return err
	}
	// ServerName drives both SNI and hostname verification (Go omits SNI
	// for IP literals but still verifies them against IP SANs).
	conn := tls.Client(raw, p.tlsConfig(host))
	defer conn.Close()
	if err := conn.HandshakeContext(ctx); err != nil {
		res.CertDaysLeft = certDaysFromErr(err, p.now())
		return err
	}
	if certs := conn.ConnectionState().PeerCertificates; len(certs) > 0 {
		res.CertDaysLeft = daysLeft(certs[0], p.now())
	}
	return nil
}

// certDaysFromErr still reports expiry when verification failed (an expired
// certificate fails the probe, but the days left are what users need to see).
func certDaysFromErr(err error, now time.Time) *int {
	var verr *tls.CertificateVerificationError
	if errors.As(err, &verr) && len(verr.UnverifiedCertificates) > 0 {
		return daysLeft(verr.UnverifiedCertificates[0], now)
	}
	return nil
}

func daysLeft(leaf *x509.Certificate, now time.Time) *int {
	d := int(math.Floor(leaf.NotAfter.Sub(now).Hours() / hoursPerDay))
	return &d
}

// describe turns a probe error into a short message safe to show the tenant.
func describe(err error, timeout time.Duration) string {
	var uerr *url.Error
	if errors.As(err, &uerr) {
		// The URL is the check's own target; repeating it adds nothing.
		err = uerr.Err
	}
	var nerr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &nerr) && nerr.Timeout()) {
		return fmt.Sprintf("timed out after %s", timeout)
	}
	return truncateRunes(err.Error(), maxErrorRunes)
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
