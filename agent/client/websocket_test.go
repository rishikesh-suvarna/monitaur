package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	testVersion    = "v9.9.9-test"
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

	rejectFirst    atomic.Int32 // upgrades to refuse with 503 before accepting
	ignorePings    bool         // simulate a half-open peer that never pongs
	dropAfterFirst bool         // close the first connection after one message
	// headerAuthOnly emulates backend v2, which reads the token only from the
	// Authorization header. Otherwise it behaves like the deployed backend,
	// which reads only ?token=.
	headerAuthOnly bool
	// onConnect runs after the upgrade and before the read loop, so it may
	// write to the connection (the read loop never writes data frames).
	onConnect       func(*websocket.Conn)
	connections     atomic.Int32
	active          atomic.Int32
	maxActive       atomic.Int32
	received        chan Message
	rawReceived     chan []byte
	closeCodes      chan int
	mu              sync.Mutex
	serverSideConns []*websocket.Conn
	handshakes      []handshake
}

// handshake is what the backend saw on one dial attempt.
type handshake struct {
	header http.Header
	query  url.Values
}

func newFakeBackend(t *testing.T, configure func(*fakeBackend)) *fakeBackend {
	t.Helper()
	b := &fakeBackend{
		t:           t,
		received:    make(chan Message, 1024),
		rawReceived: make(chan []byte, 1024),
		closeCodes:  make(chan int, 8),
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
	b.mu.Lock()
	b.handshakes = append(b.handshakes, handshake{header: r.Header.Clone(), query: r.URL.Query()})
	b.mu.Unlock()

	if b.rejectFirst.Load() > 0 {
		b.rejectFirst.Add(-1)
		http.Error(w, "warming up", http.StatusServiceUnavailable)
		return
	}
	presented := r.URL.Query().Get("token")
	if b.headerAuthOnly {
		presented = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if presented != testToken {
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
	if b.onConnect != nil {
		b.onConnect(conn)
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
		// Checked on every message in every test: the token belongs in the
		// dial request only.
		if bytes.Contains(data, []byte(testToken)) {
			b.t.Errorf("message body carries the token: %s", data)
		}
		b.rawReceived <- data
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

func (b *fakeBackend) firstHandshake(t *testing.T) handshake {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.handshakes) == 0 {
		t.Fatalf("backend saw no handshake")
	}
	return b.handshakes[0]
}

// pushConfig returns an onConnect hook that writes config_update messages
// with the given raw data payloads.
func pushConfig(t *testing.T, payloads ...string) func(*websocket.Conn) {
	return func(conn *websocket.Conn) {
		for _, p := range payloads {
			msg := fmt.Sprintf(`{"type":%q,"data":%s}`, configUpdateType, p)
			if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
				t.Errorf("push config: %v", err)
				return
			}
		}
	}
}

// startClient runs the client until the test ends and waits for Run to return,
// so no goroutine outlives its test.
func startClient(t *testing.T, endpoint string, opts options) (*Client, context.CancelFunc, <-chan struct{}) {
	t.Helper()
	c, err := newClient(endpoint, testToken, testServerName, testVersion, opts)
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
			_, err := NewClient(tt.endpoint, testToken, testServerName, testVersion)
			if (err != nil) != tt.wantErr {
				t.Fatalf("NewClient(%q) error = %v, wantErr %v", tt.endpoint, err, tt.wantErr)
			}
		})
	}
}

func TestSendWhileDisconnectedReturnsErrNotConnected(t *testing.T) {
	c, err := NewClient("ws://localhost:1/agent/connect", testToken, testServerName, testVersion)
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
	c, err := newClient(b.url(), "wrong-token", testServerName, testVersion, fastOptions())
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

func TestDialAuthenticatesWithHeaderAndLegacyQuery(t *testing.T) {
	b := newFakeBackend(t, nil)
	c, _, _ := startClient(t, b.url(), fastOptions())
	waitFor(t, "connection", c.IsConnected)

	hs := b.firstHandshake(t)
	checks := []struct {
		name, got, want string
	}{
		{"Authorization header", hs.header.Get("Authorization"), "Bearer " + testToken},
		{"X-Agent-Version header", hs.header.Get(agentVersionHeader), testVersion},
		// Until backend v2 is deployed, the live backend reads only this.
		{"legacy token query", hs.query.Get("token"), testToken},
		{"server_name query", hs.query.Get("server_name"), testServerName},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Errorf("%s = %q, want %q", check.name, check.got, check.want)
		}
	}
}

func TestConnectsToBackendThatReadsOnlyTheHeader(t *testing.T) {
	b := newFakeBackend(t, func(b *fakeBackend) { b.headerAuthOnly = true })
	c, _, _ := startClient(t, b.url(), fastOptions())
	waitFor(t, "connection", c.IsConnected)

	if err := c.SendMetrics("via header auth"); err != nil {
		t.Fatalf("SendMetrics: %v", err)
	}
	receive(t, b)
}

func TestMessageBodiesHaveNoTokenField(t *testing.T) {
	b := newFakeBackend(t, nil)
	c, _, _ := startClient(t, b.url(), fastOptions())
	waitFor(t, "connection", c.IsConnected)

	if err := c.SendMetrics(map[string]float64{"cpu": 1}); err != nil {
		t.Fatalf("SendMetrics: %v", err)
	}
	// Alerts still go out: the deployed backend stores and emails them.
	if err := c.SendAlert(map[string]string{"type": "cpu"}); err != nil {
		t.Fatalf("SendAlert: %v", err)
	}

	for range 2 {
		var raw []byte
		select {
		case raw = <-b.rawReceived:
		case <-time.After(waitTimeout):
			t.Fatalf("backend received nothing")
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatalf("unmarshal %s: %v", raw, err)
		}
		if _, ok := fields["token"]; ok {
			t.Fatalf("message has a token field: %s", raw)
		}
		for _, want := range []string{"type", "server_name", "data", "timestamp"} {
			if _, ok := fields[want]; !ok {
				t.Fatalf("message lacks %q: %s", want, raw)
			}
		}
	}
}

func TestParseConfigUpdate(t *testing.T) {
	maxSeconds := int64(maxPushedInterval / time.Second)
	tests := []struct {
		name    string
		data    string
		want    time.Duration
		wantErr bool
	}{
		{"whole seconds", `{"collection_interval": 30}`, 30 * time.Second, false},
		{"one second", `{"collection_interval": 1}`, time.Second, false},
		{"upper bound", fmt.Sprintf(`{"collection_interval": %d}`, maxSeconds), maxPushedInterval, false},
		{"unknown fields ignored", `{"collection_interval": 60, "later": true}`, time.Minute, false},
		{"zero", `{"collection_interval": 0}`, 0, true},
		{"negative", `{"collection_interval": -5}`, 0, true},
		{"above upper bound", fmt.Sprintf(`{"collection_interval": %d}`, maxSeconds+1), 0, true},
		{"would overflow Duration", `{"collection_interval": 9223372036854775807}`, 0, true},
		{"fractional", `{"collection_interval": 2.5}`, 0, true},
		{"string", `{"collection_interval": "30"}`, 0, true},
		{"missing field", `{}`, 0, true},
		{"null data", `null`, 0, true},
		{"absent data", ``, 0, true},
		{"not an object", `[30]`, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseConfigUpdate(json.RawMessage(tt.data))
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseConfigUpdate(%s) error = %v, wantErr %v", tt.data, err, tt.wantErr)
			}
			if got.CollectionInterval != tt.want {
				t.Fatalf("parseConfigUpdate(%s) = %v, want %v", tt.data, got.CollectionInterval, tt.want)
			}
		})
	}
}

func TestDeliversConfigUpdateFromServer(t *testing.T) {
	b := newFakeBackend(t, func(b *fakeBackend) {
		// The invalid update must be skipped without dropping the connection.
		b.onConnect = pushConfig(t, `{"collection_interval": "soon"}`, `{"collection_interval": 30}`)
	})
	c, _, _ := startClient(t, b.url(), fastOptions())

	select {
	case update := <-c.ConfigUpdates():
		if want := 30 * time.Second; update.CollectionInterval != want {
			t.Fatalf("CollectionInterval = %v, want %v", update.CollectionInterval, want)
		}
	case <-time.After(waitTimeout):
		t.Fatalf("no config update delivered")
	}

	if err := c.SendMetrics("after config update"); err != nil {
		t.Fatalf("SendMetrics: %v", err)
	}
	receive(t, b)
	if got := b.connections.Load(); got != 1 {
		t.Fatalf("connections = %d, want 1", got)
	}
}

func TestUnreadConfigUpdateIsReplacedByNewer(t *testing.T) {
	c, err := NewClient("ws://localhost:1/agent/connect", testToken, testServerName, testVersion)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	for _, seconds := range []time.Duration{10, 20, 30} {
		c.publishConfig(ConfigUpdate{CollectionInterval: seconds * time.Second})
	}

	select {
	case update := <-c.ConfigUpdates():
		if want := 30 * time.Second; update.CollectionInterval != want {
			t.Fatalf("CollectionInterval = %v, want the newest %v", update.CollectionInterval, want)
		}
	default:
		t.Fatalf("no config update queued")
	}
	select {
	case stale := <-c.ConfigUpdates():
		t.Fatalf("stale update still queued: %v", stale.CollectionInterval)
	default:
	}
}

// Nobody reads ConfigUpdates here. The reader must keep consuming frames
// anyway, or it would stop answering pings from the backend.
func TestUnreadConfigUpdatesDoNotStallTheReader(t *testing.T) {
	const (
		pushes = 200
		marker = "after-config-pushes"
	)
	payloads := make([]string, pushes)
	for i := range payloads {
		payloads[i] = fmt.Sprintf(`{"collection_interval": %d}`, i+1)
	}

	pongSeen := make(chan struct{})
	var markPong sync.Once
	b := newFakeBackend(t, func(b *fakeBackend) {
		b.onConnect = func(conn *websocket.Conn) {
			pushConfig(t, payloads...)(conn)
			conn.SetPongHandler(func(data string) error {
				if data == marker {
					markPong.Do(func() { close(pongSeen) })
				}
				return nil
			})
			// Frames are read in order, so the client answers this ping only
			// after it has handled every push sent before it.
			if err := conn.WriteControl(websocket.PingMessage, []byte(marker), time.Now().Add(waitTimeout)); err != nil {
				t.Errorf("ping: %v", err)
			}
		}
	})
	c, _, _ := startClient(t, b.url(), fastOptions())

	select {
	case <-pongSeen:
	case <-time.After(waitTimeout):
		t.Fatalf("client stopped reading while config updates were unread")
	}
	select {
	case update := <-c.ConfigUpdates():
		if want := pushes * time.Second; update.CollectionInterval != want {
			t.Fatalf("CollectionInterval = %v, want the newest push %v", update.CollectionInterval, want)
		}
	default:
		t.Fatalf("no config update queued")
	}
}
