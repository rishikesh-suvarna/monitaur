package client

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const (
	testToken      = "test-token"
	testServerName = "test-host"
	waitTimeout    = 3 * time.Second
	pollInterval   = 5 * time.Millisecond
)

// fastOptions shrinks every timer so lifecycle tests run in milliseconds.
func fastOptions() options {
	return options{
		pingInterval:     20 * time.Millisecond,
		pongWait:         150 * time.Millisecond,
		writeWait:        time.Second,
		handshakeTimeout: time.Second,
		minBackoff:       5 * time.Millisecond,
		maxBackoff:       20 * time.Millisecond,
		stableAfter:      time.Minute,
	}
}

// fakeBackend mimics backend/handlers/websocket.go closely enough to exercise
// the client: token check, upgrade, read loop, default pong replies.
type fakeBackend struct {
	t        *testing.T
	server   *httptest.Server
	upgrader websocket.Upgrader

	rejectFirst     atomic.Int32 // upgrades to refuse with 503 before accepting
	ignorePings     bool         // simulate a half-open peer that never pongs
	dropAfterFirst  bool         // close the first connection after one message
	connections     atomic.Int32
	active          atomic.Int32
	maxActive       atomic.Int32
	received        chan Message
	closeCodes      chan int
	mu              sync.Mutex
	serverSideConns []*websocket.Conn
}

func newFakeBackend(t *testing.T, configure func(*fakeBackend)) *fakeBackend {
	t.Helper()
	b := &fakeBackend{
		t:          t,
		received:   make(chan Message, 1024),
		closeCodes: make(chan int, 8),
	}
	if configure != nil {
		configure(b)
	}
	b.server = httptest.NewServer(http.HandlerFunc(b.handle))
	t.Cleanup(b.close)
	return b
}

func (b *fakeBackend) url() string {
	return "ws" + strings.TrimPrefix(b.server.URL, "http") + "/agent/connect"
}

func (b *fakeBackend) handle(w http.ResponseWriter, r *http.Request) {
	if b.rejectFirst.Load() > 0 {
		b.rejectFirst.Add(-1)
		http.Error(w, "warming up", http.StatusServiceUnavailable)
		return
	}
	if r.URL.Query().Get("token") != testToken {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	conn, err := b.upgrader.Upgrade(w, r, nil)
	if err != nil {
		b.t.Errorf("upgrade: %v", err)
		return
	}
	b.mu.Lock()
	b.serverSideConns = append(b.serverSideConns, conn)
	b.mu.Unlock()

	connNumber := b.connections.Add(1)
	active := b.active.Add(1)
	for {
		peak := b.maxActive.Load()
		if active <= peak || b.maxActive.CompareAndSwap(peak, active) {
			break
		}
	}
	defer b.active.Add(-1)
	defer conn.Close()

	if b.ignorePings {
		conn.SetPingHandler(func(string) error { return nil })
	}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) {
				b.closeCodes <- closeErr.Code
			}
			return
		}
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			b.t.Errorf("unmarshal: %v", err)
			return
		}
		b.received <- msg
		if b.dropAfterFirst && connNumber == 1 {
			return // abrupt close, no close frame
		}
	}
}

func (b *fakeBackend) close() {
	b.mu.Lock()
	for _, c := range b.serverSideConns {
		c.Close()
	}
	b.mu.Unlock()
	b.server.Close()
}

// startClient runs the client until the test ends and waits for Run to return,
// so no goroutine outlives its test.
func startClient(t *testing.T, endpoint string, opts options) (*Client, context.CancelFunc, <-chan struct{}) {
	t.Helper()
	c, err := newClient(endpoint, testToken, testServerName, opts)
	if err != nil {
		t.Fatalf("newClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(waitTimeout):
			t.Errorf("Run did not return after cancel")
		}
	})
	return c, cancel, done
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(pollInterval)
	}
}

func receive(t *testing.T, b *fakeBackend) Message {
	t.Helper()
	select {
	case msg := <-b.received:
		return msg
	case <-time.After(waitTimeout):
		t.Fatalf("backend received nothing")
		return Message{}
	}
}

func TestNewClientValidatesEndpoint(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		wantErr  bool
	}{
		{"plain ws", "ws://localhost:8080/agent/connect", false},
		{"tls wss", "wss://monitaur.example.com/agent/connect", false},
		{"http scheme", "http://localhost:8080/agent/connect", true},
		{"missing scheme", "localhost:8080/agent/connect", true},
		{"no host", "ws:///agent/connect", true},
		{"empty", "", true},
		{"unparseable", "ws://%zz", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewClient(tt.endpoint, testToken, testServerName)
			if (err != nil) != tt.wantErr {
				t.Fatalf("NewClient(%q) error = %v, wantErr %v", tt.endpoint, err, tt.wantErr)
			}
		})
	}
}

func TestSendWhileDisconnectedReturnsErrNotConnected(t *testing.T) {
	c, err := NewClient("ws://localhost:1/agent/connect", testToken, testServerName)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if err := c.SendMetrics(map[string]float64{"cpu": 1}); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("SendMetrics error = %v, want ErrNotConnected", err)
	}
}

func TestDeliversMetricsAndAlerts(t *testing.T) {
	b := newFakeBackend(t, nil)
	c, _, _ := startClient(t, b.url(), fastOptions())
	waitFor(t, "connection", c.IsConnected)

	if err := c.SendMetrics(map[string]float64{"cpu": 42}); err != nil {
		t.Fatalf("SendMetrics: %v", err)
	}
	if err := c.SendAlert(map[string]string{"type": "cpu"}); err != nil {
		t.Fatalf("SendAlert: %v", err)
	}

	for _, wantType := range []string{"metrics", "alert"} {
		msg := receive(t, b)
		if msg.Type != wantType || msg.ServerName != testServerName {
			t.Fatalf("got {type:%q server_name:%q}, want {type:%q server_name:%q}", msg.Type, msg.ServerName, wantType, testServerName)
		}
	}
}

// Regression: metrics from the main loop and pings from the heartbeat used to
// write to the socket concurrently, which panics in gorilla/websocket. Run
// with -race.
func TestConcurrentSendsWithFrequentPings(t *testing.T) {
	const senders, perSender = 16, 25
	opts := fastOptions()
	opts.pingInterval = time.Millisecond

	b := newFakeBackend(t, nil)
	c, _, _ := startClient(t, b.url(), opts)
	waitFor(t, "connection", c.IsConnected)

	var wg sync.WaitGroup
	for range senders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for sent := 0; sent < perSender; {
				err := c.SendMetrics(map[string]int{"n": sent})
				switch {
				case err == nil:
					sent++
				case errors.Is(err, ErrQueueFull):
					time.Sleep(time.Millisecond)
				default:
					t.Errorf("SendMetrics: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()

	for i := 0; i < senders*perSender; i++ {
		receive(t, b)
	}
	if got := b.connections.Load(); got != 1 {
		t.Fatalf("connections = %d, want 1 (no reconnects under load)", got)
	}
}

// Regression: after the first reconnect the reader was never restarted and
// every reconnect added another heartbeat goroutine.
func TestReconnectsAfterServerDropsConnection(t *testing.T) {
	b := newFakeBackend(t, func(b *fakeBackend) { b.dropAfterFirst = true })
	c, _, _ := startClient(t, b.url(), fastOptions())
	waitFor(t, "first connection", c.IsConnected)

	if err := c.SendMetrics("before drop"); err != nil {
		t.Fatalf("SendMetrics: %v", err)
	}
	receive(t, b)

	waitFor(t, "second connection", func() bool { return b.connections.Load() == 2 && c.IsConnected() })
	if err := c.SendMetrics("after reconnect"); err != nil {
		t.Fatalf("SendMetrics after reconnect: %v", err)
	}
	if msg := receive(t, b); msg.Data != "after reconnect" {
		t.Fatalf("got data %v, want %q", msg.Data, "after reconnect")
	}
	if peak := b.maxActive.Load(); peak != 1 {
		t.Fatalf("peak concurrent connections = %d, want 1", peak)
	}
}

// Regression: a failed first dial used to exit the whole agent.
func TestRetriesUntilBackendAcceptsFirstConnection(t *testing.T) {
	const refusals = 3
	b := newFakeBackend(t, func(b *fakeBackend) { b.rejectFirst.Store(refusals) })
	c, _, _ := startClient(t, b.url(), fastOptions())

	waitFor(t, "connection after refusals", c.IsConnected)
	if left := b.rejectFirst.Load(); left != 0 {
		t.Fatalf("connected with %d refusals still pending", left)
	}
}

func TestDetectsSilentPeerAndRedials(t *testing.T) {
	b := newFakeBackend(t, func(b *fakeBackend) { b.ignorePings = true })
	c, _, _ := startClient(t, b.url(), fastOptions())
	waitFor(t, "first connection", c.IsConnected)

	// No pongs arrive, so the read deadline (pongWait) must fire and the
	// client must dial again instead of hanging on a half-open socket.
	waitFor(t, "redial after silence", func() bool { return b.connections.Load() >= 2 })
}

func TestShutdownSendsNormalCloseFrame(t *testing.T) {
	b := newFakeBackend(t, nil)
	c, cancel, done := startClient(t, b.url(), fastOptions())
	waitFor(t, "connection", c.IsConnected)

	cancel()
	select {
	case <-done:
	case <-time.After(waitTimeout):
		t.Fatalf("Run did not return after cancel")
	}

	select {
	case code := <-b.closeCodes:
		if code != websocket.CloseNormalClosure {
			t.Fatalf("close code = %d, want %d", code, websocket.CloseNormalClosure)
		}
	case <-time.After(waitTimeout):
		t.Fatalf("backend never saw a close frame")
	}
	if c.IsConnected() {
		t.Fatalf("IsConnected() = true after shutdown")
	}
}

func TestRejectedTokenKeepsRetryingWithoutConnecting(t *testing.T) {
	b := newFakeBackend(t, nil)
	c, err := newClient(b.url(), "wrong-token", testServerName, fastOptions())
	if err != nil {
		t.Fatalf("newClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	c.Run(ctx) // must return when ctx expires, not spin or panic
	if c.IsConnected() || b.connections.Load() != 0 {
		t.Fatalf("connected with a rejected token")
	}
}

func TestJitterStaysWithinBounds(t *testing.T) {
	for _, d := range []time.Duration{0, time.Nanosecond, time.Millisecond, time.Minute} {
		for range 100 {
			got := jitter(d)
			if got < d/2 || got > d {
				t.Fatalf("jitter(%v) = %v, want within [%v, %v]", d, got, d/2, d)
			}
		}
	}
}
