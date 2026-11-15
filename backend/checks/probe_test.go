package checks

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	testTimeout = 2 * time.Second
	hoursInDay  = 24 * time.Hour
)

func httpCheck(target string) Check {
	return Check{ID: 1, OrgID: 1, Name: "web", Type: TypeHTTP, Target: target, Interval: time.Minute, Timeout: testTimeout, Enabled: true}
}

func TestProbeHTTP(t *testing.T) {
	big := strings.Repeat("a", MaxBodyBytes) + "needle"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/ok":
			_, _ = w.Write([]byte("all systems go"))
		case r.URL.Path == "/fail":
			w.WriteHeader(http.StatusInternalServerError)
		case r.URL.Path == "/missing":
			http.NotFound(w, r)
		case r.URL.Path == "/big":
			_, _ = w.Write([]byte(big))
		case r.URL.Path == "/slow":
			time.Sleep(300 * time.Millisecond)
		case strings.HasPrefix(r.URL.Path, "/hop/"):
			n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/hop/"))
			if n == 0 {
				_, _ = w.Write([]byte("landed"))
				return
			}
			http.Redirect(w, r, fmt.Sprintf("/hop/%d", n-1), http.StatusFound)
		}
	}))
	defer srv.Close()

	tests := []struct {
		name       string
		path       string
		expect     int
		keyword    string
		timeout    time.Duration
		wantOK     bool
		wantStatus int
		wantErr    string
	}{
		{name: "2xx by default", path: "/ok", wantOK: true, wantStatus: 200},
		{name: "5xx fails", path: "/fail", wantStatus: 500, wantErr: "status 500, expected 2xx or 3xx"},
		{name: "expected 404", path: "/missing", expect: 404, wantOK: true, wantStatus: 404},
		{name: "exact status", path: "/ok", expect: 201, wantStatus: 200, wantErr: "status 200, expected 201"},
		{name: "keyword found", path: "/ok", keyword: "systems go", wantOK: true, wantStatus: 200},
		{name: "keyword missing", path: "/ok", keyword: "outage", wantStatus: 200, wantErr: "keyword not found"},
		{name: "keyword past 1 MB", path: "/big", keyword: "needle", wantStatus: 200, wantErr: "keyword not found"},
		{name: "three redirects", path: "/hop/3", keyword: "landed", wantOK: true, wantStatus: 200},
		{name: "four redirects", path: "/hop/4", wantErr: "stopped after 3 redirects"},
		{name: "expected redirect is not followed", path: "/hop/1", expect: 302, wantOK: true, wantStatus: 302},
		{name: "timeout", path: "/slow", timeout: 100 * time.Millisecond, wantErr: "timed out after 100ms"},
	}
	p := NewProber(true, nil, nil)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := httpCheck(srv.URL + tt.path)
			c.ExpectStatus, c.Keyword = tt.expect, tt.keyword
			if tt.timeout > 0 {
				c.Timeout = tt.timeout
			}
			res := p.Probe(context.Background(), c)
			if res.OK != tt.wantOK || res.StatusCode != tt.wantStatus {
				t.Fatalf("ok=%v status=%d err=%q, want ok=%v status=%d", res.OK, res.StatusCode, res.Error, tt.wantOK, tt.wantStatus)
			}
			if !strings.Contains(res.Error, tt.wantErr) || (tt.wantErr == "") != (res.Error == "") {
				t.Fatalf("error = %q, want %q", res.Error, tt.wantErr)
			}
			if res.Latency <= 0 || res.At.IsZero() || res.CertDaysLeft != nil {
				t.Fatalf("result = %+v", res)
			}
		})
	}
}

func TestProbeTCP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	open := ln.Addr().String()
	closedLn, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := closedLn.Addr().String()
	closedLn.Close()
	defer ln.Close()

	p := NewProber(true, nil, nil)
	for _, tt := range []struct {
		target string
		wantOK bool
	}{{open, true}, {closed, false}} {
		res := p.Probe(context.Background(), Check{Type: TypeTCP, Target: tt.target, Timeout: testTimeout})
		if res.OK != tt.wantOK || (res.Error == "") != tt.wantOK {
			t.Fatalf("tcp %s = %+v, want ok %v", tt.target, res, tt.wantOK)
		}
	}
}

// The SSRF guard refuses loopback for every probe type unless private
// targets are allowed, including hostnames that resolve to loopback.
func TestProbeRefusesPrivateTargets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("probe reached a loopback server")
	}))
	defer srv.Close()
	hostPort := strings.TrimPrefix(srv.URL, "http://")
	p := NewProber(false, nil, nil)
	for _, c := range []Check{
		httpCheck(srv.URL),
		httpCheck(strings.Replace(srv.URL, "127.0.0.1", "localhost", 1)),
		{Type: TypeTCP, Target: hostPort, Timeout: testTimeout},
		{Type: TypeTLS, Target: hostPort, Timeout: testTimeout},
	} {
		res := p.Probe(context.Background(), c)
		if res.OK || !strings.Contains(res.Error, "destination address is not allowed") {
			t.Fatalf("%s %s = %+v, want blocked", c.Type, c.Target, res)
		}
	}
}

// selfSigned returns a certificate for 127.0.0.1 valid until notAfter.
func selfSigned(t *testing.T, notAfter time.Time) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "monitaur test"},
		NotBefore: time.Now().Add(-hoursInDay * 30), NotAfter: notAfter,
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, IsCA: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, pool
}

func tlsServer(t *testing.T, cert tls.Certificate) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("secure"))
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

func TestProbeCertificateDaysLeft(t *testing.T) {
	// The extra hour keeps floor() from landing a day short while the test runs.
	soon, soonRoots := selfSigned(t, time.Now().Add(5*hoursInDay+time.Hour))
	expired, expiredRoots := selfSigned(t, time.Now().Add(-2*hoursInDay+time.Hour))
	soonSrv, expiredSrv := tlsServer(t, soon), tlsServer(t, expired)

	tests := []struct {
		name     string
		check    Check
		roots    *x509.CertPool
		wantOK   bool
		wantDays int
		wantErr  string
	}{
		{name: "tls handshake", check: Check{Type: TypeTLS, Target: strings.TrimPrefix(soonSrv.URL, "https://")},
			roots: soonRoots, wantOK: true, wantDays: 5},
		{name: "https check", check: httpCheck(soonSrv.URL), roots: soonRoots, wantOK: true, wantDays: 5},
		{name: "expired certificate fails but reports days", check: Check{Type: TypeTLS, Target: strings.TrimPrefix(expiredSrv.URL, "https://")},
			roots: expiredRoots, wantDays: -2, wantErr: "expired"},
		{name: "expired https", check: httpCheck(expiredSrv.URL), roots: expiredRoots, wantDays: -2, wantErr: "expired"},
		{name: "untrusted certificate fails", check: Check{Type: TypeTLS, Target: strings.TrimPrefix(soonSrv.URL, "https://")},
			wantDays: 5, wantErr: "certificate"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.check.Timeout = testTimeout
			res := NewProber(true, tt.roots, nil).Probe(context.Background(), tt.check)
			if res.OK != tt.wantOK || !strings.Contains(res.Error, tt.wantErr) {
				t.Fatalf("ok=%v err=%q, want ok=%v err~%q", res.OK, res.Error, tt.wantOK, tt.wantErr)
			}
			if res.CertDaysLeft == nil || *res.CertDaysLeft != tt.wantDays {
				t.Fatalf("days left = %v, want %d", res.CertDaysLeft, tt.wantDays)
			}
		})
	}
}
