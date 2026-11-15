package ingest

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"backend/limits"
	"backend/metrics"
	"backend/processes"
	"backend/secrets"
	"backend/store"
)

const (
	goodToken   = "mt_live_good"
	legacyToken = "11111111-1111-1111-1111-111111111111"
	waitFor     = 3 * time.Second
)

type fakeDir struct {
	mu      sync.Mutex
	servers map[string]store.Server
}

func (d *fakeDir) ServerByTokenHash(h string) (store.Server, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s, ok := d.servers[h]
	return s, ok
}

func (d *fakeDir) Plan(int64) store.Plan { return store.Plan{MinIntervalSeconds: 10} }

func (d *fakeDir) revoke(token string) {
	d.mu.Lock()
	delete(d.servers, secrets.HashToken(token))
	d.mu.Unlock()
}

type fakeRec struct {
	mu           sync.Mutex
	samples      []metrics.Sample
	snapshots    []processes.Snapshot
	connects     []string
	disconnects  int
	lastInterval time.Duration
}

func (r *fakeRec) Processes(_ int64, snap processes.Snapshot) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.snapshots = append(r.snapshots, snap)
}

func (r *fakeRec) Sample(_ int64, s metrics.Sample, min time.Duration) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.samples, r.lastInterval = append(r.samples, s), min
	return nil
}

func (r *fakeRec) Connected(_ int64, v string, _ time.Time) {
	r.mu.Lock()
	r.connects = append(r.connects, v)
	r.mu.Unlock()
}

func (r *fakeRec) Disconnected(int64, time.Time) {
	r.mu.Lock()
	r.disconnects++
	r.mu.Unlock()
}

func (r *fakeRec) snapshot() (int, int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.samples), len(r.connects), r.disconnects
}

func newTestHub(t *testing.T) (*Hub, *fakeDir, *fakeRec, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	srv := store.Server{ID: 7, OrgID: 3}
	dir := &fakeDir{servers: map[string]store.Server{
		secrets.HashToken(goodToken):   srv,
		secrets.HashToken(legacyToken): srv,
	}}
	rec := &fakeRec{}
	hub := NewHub(dir, rec, limits.NewRateLimiter(nil), []string{"https://app.example.com"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r := gin.New()
	r.GET("/agent/connect", hub.Handle)
	ts := httptest.NewServer(r)
	t.Cleanup(func() { hub.CloseAll(); ts.Close() })
	return hub, dir, rec, "ws" + strings.TrimPrefix(ts.URL, "http") + "/agent/connect"
}

func dial(t *testing.T, url string, header http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ws, resp, err := websocket.DefaultDialer.Dial(url, header)
	if ws != nil {
		t.Cleanup(func() { ws.Close() })
	}
	return ws, resp, err
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestHandshakeAuthentication(t *testing.T) {
	_, _, _, url := newTestHub(t)
	tests := []struct {
		name       string
		url        string
		header     http.Header
		wantStatus int
	}{
		{"bearer header", url, http.Header{"Authorization": {"Bearer " + goodToken}}, http.StatusSwitchingProtocols},
		{"legacy query token", url + "?token=" + legacyToken, nil, http.StatusSwitchingProtocols},
		{"missing token", url, nil, http.StatusUnauthorized},
		{"wrong token", url, http.Header{"Authorization": {"Bearer nope"}}, http.StatusUnauthorized},
		{"browser from foreign origin", url, http.Header{"Authorization": {"Bearer " + goodToken}, "Origin": {"https://evil.example"}}, http.StatusForbidden},
		{"dashboard origin allowed", url, http.Header{"Authorization": {"Bearer " + goodToken}, "Origin": {"https://app.example.com"}}, http.StatusSwitchingProtocols},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, resp, _ := dial(t, tt.url, tt.header)
			if resp == nil || resp.StatusCode != tt.wantStatus {
				got := 0
				if resp != nil {
					got = resp.StatusCode
				}
				t.Fatalf("status = %d, want %d", got, tt.wantStatus)
			}
		})
	}
}

func TestMetricsFlowAndConfigPush(t *testing.T) {
	_, _, rec, url := newTestHub(t)
	ws, _, err := dial(t, url, http.Header{"Authorization": {"Bearer " + goodToken}, agentVersionHeader: {"0.9.4"}})
	if err != nil {
		t.Fatal(err)
	}

	_ = ws.SetReadDeadline(time.Now().Add(waitFor))
	var push struct {
		Type string `json:"type"`
		Data struct {
			Interval int `json:"collection_interval"`
		} `json:"data"`
	}
	if err := ws.ReadJSON(&push); err != nil || push.Type != msgConfigUpdate || push.Data.Interval != 10 {
		t.Fatalf("config push = %+v, %v", push, err)
	}

	payload := `{"type":"metrics","token":"ignored","data":{"cpu":{"usage":42.5,"cores":4},
		"memory":{"total":8,"used":4,"used_percent":50},"disk":{"total":100,"used":60,"used_percent":60},
		"network":{"bytes_sent":10,"bytes_recv":20},"uptime":99}}`
	for _, m := range []string{payload, `{"type":"alert","data":{}}`, `not json`} {
		if err := ws.WriteMessage(websocket.TextMessage, []byte(m)); err != nil {
			t.Fatal(err)
		}
	}
	eventually(t, "sample recorded", func() bool { n, _, _ := rec.snapshot(); return n == 1 })
	rec.mu.Lock()
	s, version := rec.samples[0], rec.connects[0]
	rec.mu.Unlock()
	if s.CPUPercent != 42.5 || s.NetRxTotal != 20 || s.NetTxTotal != 10 || s.UptimeSeconds != 99 || version != "0.9.4" || rec.lastInterval != 10*time.Second {
		t.Fatalf("sample = %+v version %q interval %v", s, version, rec.lastInterval)
	}
}

func TestReconnectReplacesWithoutEvictingNewConnection(t *testing.T) {
	hub, _, rec, url := newTestHub(t)
	hdr := http.Header{"Authorization": {"Bearer " + goodToken}}
	first, _, err := dial(t, url, hdr)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "first connect", func() bool { _, c, _ := rec.snapshot(); return c == 1 })
	if _, _, err := dial(t, url, hdr); err != nil {
		t.Fatal(err)
	}
	eventually(t, "second connect", func() bool { _, c, _ := rec.snapshot(); return c == 2 })

	// The old socket gets closed by the server...
	_ = first.SetReadDeadline(time.Now().Add(waitFor))
	for {
		if _, _, err := first.ReadMessage(); err != nil {
			break
		}
	}
	// ...and its cleanup must not unregister the live connection.
	time.Sleep(50 * time.Millisecond)
	if !hub.IsConnected(7) {
		t.Fatal("new connection was evicted by the old one's cleanup")
	}
	if _, _, d := rec.snapshot(); d != 0 {
		t.Fatalf("disconnects = %d, want 0", d)
	}
}

func TestSweepClosesRevokedTokens(t *testing.T) {
	hub, dir, rec, url := newTestHub(t)
	if _, _, err := dial(t, url, http.Header{"Authorization": {"Bearer " + goodToken}}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "connect", func() bool { return hub.IsConnected(7) })
	dir.revoke(goodToken)
	hub.SweepTokens()
	eventually(t, "disconnect after revoke", func() bool { _, _, d := rec.snapshot(); return d == 1 && !hub.IsConnected(7) })
}

func TestOversizedFrameDropsConnection(t *testing.T) {
	hub, _, _, url := newTestHub(t)
	ws, _, err := dial(t, url, http.Header{"Authorization": {"Bearer " + goodToken}})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "connect", func() bool { return hub.IsConnected(7) })
	big, _ := json.Marshal(map[string]string{"type": "metrics", "data": strings.Repeat("x", maxMessageBytes+1)})
	_ = ws.WriteMessage(websocket.TextMessage, big)
	eventually(t, "disconnect on oversized frame", func() bool { return !hub.IsConnected(7) })
}
