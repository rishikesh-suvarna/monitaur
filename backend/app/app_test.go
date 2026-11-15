package app_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"backend/app"
	"backend/auth"
	"backend/config"
	"backend/testdb"
)

// fakeVerifier accepts tokens shaped "uid|email|provider|verified".
type fakeVerifier struct{}

func (fakeVerifier) VerifyIDToken(_ context.Context, token string) (auth.Claims, error) {
	parts := strings.Split(token, "|")
	if len(parts) != 4 {
		return auth.Claims{}, errors.New("bad token")
	}
	return auth.Claims{UID: parts[0], Email: parts[1], Provider: parts[2], EmailVerified: parts[3] == "true", IssuedAt: time.Now()}, nil
}
func (fakeVerifier) TokensValidAfter(context.Context, string) (time.Time, error) {
	return time.Time{}, nil
}
func (fakeVerifier) RevokeSessions(context.Context, string) error { return nil }
func (fakeVerifier) DeleteUser(context.Context, string) error     { return nil }
func (fakeVerifier) VerifyAppCheck(string) error                  { return nil }

type env struct {
	t   *testing.T
	srv *httptest.Server
	ctx context.Context
}

// newEnv starts the fully wired app; opts adjust the config before New.
func newEnv(t *testing.T, opts ...func(*config.Config)) *env {
	t.Helper()
	pool := testdb.Migrated(t)
	cfg := &config.Config{
		Server:   config.ServerConfig{AllowOrigins: "http://localhost:5173"},
		Public:   config.PublicConfig{AppURL: "http://localhost:5173", IngestURL: "ws://localhost:8080/agent/connect"},
		Firebase: config.FirebaseConfig{ProjectID: "test"},
		Metrics:  config.MetricsConfig{FlushInterval: time.Hour, RawWindow: time.Hour, RecentWindow: 24 * time.Hour, JournalDir: t.TempDir()},
		Limits:   config.LimitsConfig{DefaultPlan: "free"},
		Secrets:  config.SecretsConfig{EncryptionKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))},
	}
	for _, opt := range opts {
		opt(cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := app.New(ctx, cfg, log, pool, fakeVerifier{})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { defer close(done); a.Run(ctx) }()
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(func() {
		a.Shutdown()
		srv.Close()
		cancel()
		<-done
	})
	return &env{t: t, srv: srv, ctx: ctx}
}

func user(uid string) string { return uid + "|" + uid + "@example.com|google.com|true" }

func (e *env) do(token, method, path string, body any, headers ...string) (int, map[string]any) {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, r)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *env) must(want int, token, method, path string, body any, headers ...string) map[string]any {
	e.t.Helper()
	got, out := e.do(token, method, path, body, headers...)
	if got != want {
		e.t.Fatalf("%s %s = %d, want %d: %v", method, path, got, want, out)
	}
	return out
}

func (e *env) agent(token string) *websocket.Conn {
	e.t.Helper()
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/agent/connect"
	ws, resp, err := websocket.DefaultDialer.Dial(url, http.Header{"Authorization": {"Bearer " + token}, "X-Agent-Version": {"2.0.0"}})
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		e.t.Fatalf("agent dial: %v (status %d)", err, status)
	}
	e.t.Cleanup(func() { ws.Close() })
	return ws
}

func sendMetrics(t *testing.T, ws *websocket.Conn, cpu float64) {
	t.Helper()
	msg := fmt.Sprintf(`{"type":"metrics","data":{"cpu":{"usage":%f,"cores":4},"memory":{"total":8000,"used":4000,"used_percent":50},
		"disk":{"total":100,"used":60,"used_percent":60},"network":{"bytes_sent":100,"bytes_recv":200},"uptime":1234}}`, cpu)
	if err := ws.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
		t.Fatal(err)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func list(m map[string]any, key string) []any {
	v, _ := m[key].([]any)
	return v
}

func obj(m map[string]any, key string) map[string]any {
	v, _ := m[key].(map[string]any)
	return v
}

func TestEndToEnd(t *testing.T) {
	e := newEnv(t)
	alice, bob := user("alice"), user("bob")

	// First sign-in creates the user, a personal org and default rules.
	me := e.must(http.StatusOK, alice, "GET", "/api/v1/me", nil)
	if len(list(me, "orgs")) != 1 {
		t.Fatalf("orgs = %v", me["orgs"])
	}
	rules := e.must(http.StatusOK, alice, "GET", "/api/v1/rules", nil)
	if n := len(list(rules, "rules")); n != 5 {
		t.Fatalf("default rules = %d, want 5", n)
	}

	// Unverified password accounts are gated.
	unverified := "carol|carol@example.com|password|false"
	if _, out := e.do(unverified, "GET", "/api/v1/me", nil); out["code"] != "email_unverified" {
		t.Fatalf("unverified = %v", out)
	}
	if code, _ := e.do("", "GET", "/api/v1/servers", nil); code != http.StatusUnauthorized {
		t.Fatalf("no token = %d", code)
	}

	// Create a server; the plaintext token is returned once.
	created := e.must(http.StatusCreated, alice, "POST", "/api/v1/servers", map[string]any{"name": "web-01", "tags": []string{"Prod", "db"}})
	token, _ := created["token"].(string)
	srv := obj(created, "server")
	serverID := int(srv["id"].(float64))
	if !strings.HasPrefix(token, "mt_live_") || !strings.Contains(obj(created, "install")["config"].(string), token) {
		t.Fatalf("create = %v", created)
	}
	if tags := srv["tags"].([]any); len(tags) != 2 || tags[0] != "db" || tags[1] != "prod" {
		t.Fatalf("tags not normalized: %v", tags)
	}
	path := fmt.Sprintf("/api/v1/servers/%d", serverID)
	detail := e.must(http.StatusOK, alice, "GET", path, nil)
	if obj(detail, "token")["prefix"] != token[:12] || strings.Contains(fmt.Sprint(detail), token) {
		t.Fatalf("detail leaks or lacks token prefix: %v", detail["token"])
	}

	// An agent connects and streams metrics; the API shows it live.
	ws := e.agent(token)
	sendMetrics(t, ws, 42)
	eventually(t, "server online with latest metrics", func() bool {
		out := e.must(http.StatusOK, alice, "GET", "/api/v1/servers", nil)
		s := list(out, "servers")[0].(map[string]any)
		latest := obj(s, "latest")
		return s["connected"] == true && s["status"] == "healthy" && latest != nil && latest["cpu"].(float64) == 42
	})
	series := e.must(http.StatusOK, alice, "GET", path+"/series?range=live", nil)
	if len(list(series, "points")) == 0 || obj(series, "thresholds")["cpu"] == nil {
		t.Fatalf("series = %v", series)
	}

	// Tenant isolation: bob sees nothing of alice's and cannot act on it.
	e.must(http.StatusOK, bob, "GET", "/api/v1/me", nil)
	if out := e.must(http.StatusOK, bob, "GET", "/api/v1/servers", nil); len(list(out, "servers")) != 0 {
		t.Fatalf("bob sees servers: %v", out)
	}
	for _, req := range []struct{ method, path string }{
		{"GET", path}, {"PATCH", path}, {"DELETE", path}, {"GET", path + "/series"}, {"POST", path + "/token/rotate"},
	} {
		if code, _ := e.do(bob, req.method, req.path, map[string]any{"name": "pwned"}); code != http.StatusNotFound {
			t.Fatalf("bob %s %s = %d, want 404", req.method, req.path, code)
		}
	}
	aliceOrg := fmt.Sprint(int(list(me, "orgs")[0].(map[string]any)["id"].(float64)))
	if code, _ := e.do(bob, "GET", "/api/v1/servers", nil, "X-Monitaur-Org", aliceOrg); code != http.StatusNotFound {
		t.Fatalf("bob with alice's org header = %d, want 404", code)
	}

	// Rules: validation and tenant checks.
	bobCh := e.must(http.StatusCreated, bob, "POST", "/api/v1/channels", map[string]any{
		"type": "slack", "name": "bob-slack", "config": map[string]string{"webhook_url": "https://hooks.slack.com/services/T0/B0/BOBSECRET"}})
	bobChID := obj(bobCh, "channel")["id"]
	if strings.Contains(fmt.Sprint(bobCh), "BOBSECRET") {
		t.Fatalf("channel response leaks secret: %v", bobCh)
	}
	if code, out := e.do(alice, "POST", "/api/v1/rules", map[string]any{"name": "steal", "metric": "cpu", "threshold": 50,
		"severity": "warning", "channel_ids": []any{bobChID}}); code != http.StatusBadRequest {
		t.Fatalf("rule with foreign channel = %d %v", code, out)
	}
	if code, _ := e.do(alice, "POST", "/api/v1/rules", map[string]any{"name": "bad", "metric": "cpu", "threshold": 150, "severity": "warning"}); code != http.StatusBadRequest {
		t.Fatalf("cpu threshold 150 accepted: %d", code)
	}
	rule := e.must(http.StatusCreated, alice, "POST", "/api/v1/rules", map[string]any{"name": "prod-cpu", "metric": "cpu",
		"threshold": 90, "for_seconds": 60, "severity": "critical", "scope": map[string]any{"all": false, "tags": []string{"prod"}}})
	ruleID := int(obj(rule, "rule")["id"].(float64))
	if m := obj(e.must(http.StatusOK, alice, "GET", "/api/v1/rules", nil), "matched"); m[fmt.Sprint(ruleID)].(float64) != 1 {
		t.Fatalf("matched = %v", m)
	}
	e.must(http.StatusOK, alice, "POST", "/api/v1/rules/preview", map[string]any{"name": "p", "metric": "cpu", "threshold": 10, "severity": "warning"})

	// Plan quota: free allows 3 servers.
	for i := 2; i <= 3; i++ {
		e.must(http.StatusCreated, alice, "POST", "/api/v1/servers", map[string]any{"name": fmt.Sprintf("s%d", i)})
	}
	if _, out := e.do(alice, "POST", "/api/v1/servers", map[string]any{"name": "s4"}); out["code"] != "limit_reached" {
		t.Fatalf("4th server = %v", out)
	}

	// Token rotation keeps the old token valid during the grace period.
	rot := e.must(http.StatusOK, alice, "POST", path+"/token/rotate", nil)
	newToken := rot["token"].(string)
	e.agent(token).Close()
	e.agent(newToken)

	// Status page: off by default, then public once enabled.
	orgOut := e.must(http.StatusOK, alice, "GET", "/api/v1/org", nil)
	slug := obj(obj(orgOut, "org"), "status_page")["slug"].(string)
	if code, _ := e.do("", "GET", "/api/v1/public/status/"+slug, nil); code != http.StatusNotFound {
		t.Fatalf("disabled status page = %d", code)
	}
	e.must(http.StatusOK, alice, "PATCH", "/api/v1/org", map[string]any{"status_page": map[string]any{
		"enabled": true, "title": "Alice status", "server_ids": []int{serverID}}})
	status := e.must(http.StatusOK, "", "GET", "/api/v1/public/status/"+slug, nil)
	if status["title"] != "Alice status" || len(list(status, "services")) != 1 {
		t.Fatalf("status page = %v", status)
	}
	// Nothing has been flushed yet, so uptime is unknown, not ~0%.
	if svc := list(status, "services")[0].(map[string]any); svc["uptime_pct"] != nil {
		t.Fatalf("uptime before any flush = %v, want null", svc["uptime_pct"])
	}

	// SSE stream delivers a servers snapshot.
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/v1/stream", nil)
	req.Header.Set("Authorization", "Bearer "+alice)
	ctx, cancel := context.WithTimeout(e.ctx, 5*time.Second)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(resp.Body)
	sawServers := false
	for sc.Scan() {
		if sc.Text() == "event: servers" {
			sawServers = true
			break
		}
	}
	resp.Body.Close()
	if !sawServers {
		t.Fatal("no servers event on the stream")
	}

	// Deleting the server cuts off its agent and rejects the token.
	e.must(http.StatusNoContent, alice, "DELETE", path, nil)
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/agent/connect"
	if _, resp, err := websocket.DefaultDialer.Dial(url, http.Header{"Authorization": {"Bearer " + newToken}}); err == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("deleted server's token still accepted")
	}

	// Members: viewer cannot create servers.
	inv := e.must(http.StatusCreated, alice, "POST", "/api/v1/org/invites", map[string]any{"email": "dave@example.com", "role": "viewer"})
	inviteToken := strings.TrimPrefix(inv["invite_url"].(string), "http://localhost:5173/invite/")
	dave := user("dave")
	e.must(http.StatusOK, dave, "POST", "/api/v1/invites/accept", map[string]any{"token": inviteToken})
	if _, out := e.do(dave, "POST", "/api/v1/servers", map[string]any{"name": "nope"}, "X-Monitaur-Org", aliceOrg); out["code"] != "forbidden" {
		t.Fatalf("viewer created server: %v", out)
	}
	e.must(http.StatusOK, dave, "GET", "/api/v1/servers", nil, "X-Monitaur-Org", aliceOrg)
	if code, _ := e.do(bob, "POST", "/api/v1/invites/accept", map[string]any{"token": inviteToken}); code != http.StatusBadRequest {
		t.Fatalf("reused invite accepted: %d", code)
	}

	// Account deletion removes the org.
	e.must(http.StatusNoContent, bob, "DELETE", "/api/v1/me", nil)
}

// hookReceiver stands in for a webhook endpoint and hands over every payload.
func hookReceiver(t *testing.T) (*httptest.Server, <-chan map[string]any) {
	t.Helper()
	got := make(chan map[string]any, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		select {
		case got <- body:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

type sseEvent struct {
	name string
	data map[string]any
}

// stream subscribes to the SSE endpoint and delivers decoded events until the
// test ends.
func (e *env) stream(token string) <-chan sseEvent {
	e.t.Helper()
	ctx, cancel := context.WithCancel(e.ctx)
	e.t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", e.srv.URL+"/api/v1/stream", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	out := make(chan sseEvent, 64)
	go func() {
		defer resp.Body.Close()
		defer close(out)
		sc := bufio.NewScanner(resp.Body)
		name := ""
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data := map[string]any{}
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &data) != nil {
					continue
				}
				select {
				case out <- sseEvent{name: name, data: data}:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out
}

func nextEvent(t *testing.T, events <-chan sseEvent, name string) map[string]any {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatalf("stream closed before a %s event", name)
			}
			if ev.name == name {
				return ev.data
			}
		case <-timeout:
			t.Fatalf("no %s event on the stream", name)
		}
	}
}

// num reads a JSON number as an int (IDs in decoded bodies).
func num(v any) int {
	f, _ := v.(float64)
	return int(f)
}

// maintenanceByID maps server id to its maintenance flag, for both the REST
// list and the live snapshot (which carries no names).
func maintenanceByID(servers []any) map[int]any {
	out := map[int]any{}
	for _, s := range servers {
		s, _ := s.(map[string]any)
		out[num(s["id"])] = s["maintenance"]
	}
	return out
}

func TestMaintenanceWindows(t *testing.T) {
	e := newEnv(t, func(c *config.Config) {
		// The receiver listens on loopback. The legacy plan keeps the per-user
		// API rate limit out of the way of the polling below.
		c.Notify.AllowPrivateWebhooks = true
		c.Limits.DefaultPlan = "legacy"
	})
	alice, bob := user("alice"), user("bob")
	me := e.must(http.StatusOK, alice, "GET", "/api/v1/me", nil)
	aliceOrg := fmt.Sprint(num(list(me, "orgs")[0].(map[string]any)["id"]))
	hook, received := hookReceiver(t)

	ch := obj(e.must(http.StatusCreated, alice, "POST", "/api/v1/channels", map[string]any{
		"type": "webhook", "name": "hook", "config": map[string]any{"webhook_url": hook.URL}}), "channel")
	prod := e.must(http.StatusCreated, alice, "POST", "/api/v1/servers", map[string]any{"name": "web-01", "tags": []string{"prod"}})
	dev := e.must(http.StatusCreated, alice, "POST", "/api/v1/servers", map[string]any{"name": "web-02"})
	prodID, devID := num(obj(prod, "server")["id"]), num(obj(dev, "server")["id"])
	e.must(http.StatusCreated, alice, "POST", "/api/v1/rules", map[string]any{"name": "cpu-hot", "metric": "cpu",
		"threshold": 90, "for_seconds": 0, "severity": "critical", "channel_ids": []any{ch["id"]}})

	// web-01 is in an active window by tag; web-02 only in a later one.
	now := time.Now().UTC()
	active := obj(e.must(http.StatusCreated, alice, "POST", "/api/v1/maintenance", map[string]any{
		"name": "prod patching", "scope": map[string]any{"tags": []string{"Prod"}},
		"starts_at": now.Add(-time.Minute), "ends_at": now.Add(time.Hour)}), "window")
	if active["state"] != "active" || fmt.Sprint(obj(active, "scope")["tags"]) != "[prod]" || active["created_by"] != "alice@example.com" {
		t.Fatalf("active window = %v", active)
	}
	later := obj(e.must(http.StatusCreated, alice, "POST", "/api/v1/maintenance", map[string]any{
		"name": "dev later", "scope": map[string]any{"server_ids": []int{devID, devID}, "check_ids": []int{12345}},
		"starts_at": now.Add(time.Hour), "ends_at": now.Add(2 * time.Hour)}), "window")
	if scope := obj(later, "scope"); later["state"] != "scheduled" || len(list(scope, "server_ids")) != 1 ||
		num(list(scope, "server_ids")[0]) != devID || fmt.Sprint(scope["check_ids"]) != "[12345]" {
		t.Fatalf("scheduled window = %v", later)
	}
	if ws := list(e.must(http.StatusOK, alice, "GET", "/api/v1/maintenance", nil), "windows"); len(ws) != 2 {
		t.Fatalf("windows = %v", ws)
	}

	m := maintenanceByID(list(e.must(http.StatusOK, alice, "GET", "/api/v1/servers", nil), "servers"))
	if m[prodID] != true || m[devID] != false {
		t.Fatalf("/servers maintenance = %v, want only web-01 (%d)", m, prodID)
	}
	events := e.stream(alice)
	if m := maintenanceByID(list(nextEvent(t, events, "servers"), "servers")); m[prodID] != true || m[devID] != false {
		t.Fatalf("live maintenance = %v, want only web-01 (%d)", m, prodID)
	}

	// A real breach on web-01: recorded and streamed, but not delivered.
	sendMetrics(t, e.agent(prod["token"].(string)), 95)
	opened := nextEvent(t, events, "incident")
	if inc := obj(opened, "incident"); opened["action"] != "opened" || num(inc["server_id"]) != prodID ||
		inc["silenced"] != true || len(list(inc, "notified_channels")) != 0 {
		t.Fatalf("live incident = %v", opened)
	}
	incidentsOf := func(serverID int) []any {
		return list(e.must(http.StatusOK, alice, "GET", fmt.Sprintf("/api/v1/incidents?server_id=%d", serverID), nil), "incidents")
	}
	eventually(t, "silenced incident recorded", func() bool {
		incs := incidentsOf(prodID)
		return len(incs) == 1 && incs[0].(map[string]any)["silenced"] == true
	})

	// The same rule on web-02, outside any active window: delivered. Had
	// web-01's alert been dispatched it would have been queued first.
	sendMetrics(t, e.agent(dev["token"].(string)), 95)
	select {
	case body := <-received:
		if body["server"] != "web-02" {
			t.Fatalf("notification for %v, want only web-02 (web-01 is in maintenance)", body["server"])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no notification for the server outside maintenance")
	}
	select {
	case body := <-received:
		t.Fatalf("unexpected second notification: %v", body)
	case <-time.After(300 * time.Millisecond):
	}
	if incs := incidentsOf(devID); len(incs) != 1 || incs[0].(map[string]any)["silenced"] != false {
		t.Fatalf("web-02 incidents = %v", incs)
	}

	// End now: the window is over and web-01 leaves maintenance.
	windowPath := fmt.Sprintf("/api/v1/maintenance/%d", num(active["id"]))
	ended := obj(e.must(http.StatusOK, alice, "PATCH", windowPath, map[string]any{"ends_at": time.Now().UTC()}), "window")
	if ended["state"] != "ended" || ended["name"] != "prod patching" || fmt.Sprint(obj(ended, "scope")["tags"]) != "[prod]" {
		t.Fatalf("ended window = %v", ended)
	}
	if m := maintenanceByID(list(e.must(http.StatusOK, alice, "GET", "/api/v1/servers", nil), "servers")); m[prodID] != false {
		t.Fatalf("/servers maintenance after end = %v", m)
	}
	// web-01's incident is still firing after the window: it is announced
	// once now (on the next engine tick), not silently dropped.
	select {
	case body := <-received:
		if body["server"] != "web-01" || body["event"] != "fired" {
			t.Fatalf("after the window: got %v, want a fired notification for web-01", body)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("incident that outlived the maintenance window was never announced")
	}

	// Validation.
	start := time.Now().UTC().Add(time.Hour)
	valid := func(mut func(map[string]any)) map[string]any {
		body := map[string]any{"name": "w", "scope": map[string]any{"all": true}, "starts_at": start, "ends_at": start.Add(time.Hour)}
		mut(body)
		return body
	}
	for name, body := range map[string]map[string]any{
		"blank name":      valid(func(b map[string]any) { b["name"] = "  " }),
		"long name":       valid(func(b map[string]any) { b["name"] = strings.Repeat("x", 81) }),
		"inverted":        valid(func(b map[string]any) { b["ends_at"] = start.Add(-time.Minute) }),
		"empty range":     valid(func(b map[string]any) { b["ends_at"] = start }),
		"over 30 days":    valid(func(b map[string]any) { b["ends_at"] = start.Add(30*24*time.Hour + time.Second) }),
		"missing end":     valid(func(b map[string]any) { delete(b, "ends_at") }),
		"no scope":        valid(func(b map[string]any) { delete(b, "scope") }),
		"empty scope":     valid(func(b map[string]any) { b["scope"] = map[string]any{} }),
		"bad check id":    valid(func(b map[string]any) { b["scope"] = map[string]any{"check_ids": []int{0}} }),
		"bad tag":         valid(func(b map[string]any) { b["scope"] = map[string]any{"tags": []string{"not a tag"}} }),
		"unknown server":  valid(func(b map[string]any) { b["scope"] = map[string]any{"server_ids": []int{999_999}} }),
		"malformed times": valid(func(b map[string]any) { b["starts_at"] = "tomorrow" }),
	} {
		if code, out := e.do(alice, "POST", "/api/v1/maintenance", body); code != http.StatusBadRequest || out["code"] != "invalid" {
			t.Errorf("%s: %d %v, want 400 invalid", name, code, out)
		}
	}
	e.must(http.StatusCreated, alice, "POST", "/api/v1/maintenance", valid(func(b map[string]any) {
		b["name"], b["ends_at"] = strings.Repeat("y", 80), start.Add(30*24*time.Hour)
	}))
	if code, _ := e.do(alice, "PATCH", windowPath, map[string]any{"ends_at": now.Add(-2 * time.Minute)}); code != http.StatusBadRequest {
		t.Fatalf("patch ending before start = %d, want 400", code)
	}

	// Tenant isolation: bob cannot see, change, delete or target alice's.
	e.must(http.StatusOK, bob, "GET", "/api/v1/me", nil)
	if ws := list(e.must(http.StatusOK, bob, "GET", "/api/v1/maintenance", nil), "windows"); len(ws) != 0 {
		t.Fatalf("bob sees windows: %v", ws)
	}
	for _, method := range []string{"PATCH", "DELETE"} {
		if code, _ := e.do(bob, method, windowPath, map[string]any{"name": "pwned"}); code != http.StatusNotFound {
			t.Fatalf("bob %s alice's window = %d, want 404", method, code)
		}
	}
	if code, _ := e.do(bob, "POST", "/api/v1/maintenance", valid(func(b map[string]any) {
		b["scope"] = map[string]any{"server_ids": []int{prodID}}
	})); code != http.StatusBadRequest {
		t.Fatalf("bob window over alice's server = %d, want 400", code)
	}
	if code, _ := e.do(bob, "GET", "/api/v1/maintenance", nil, "X-Monitaur-Org", aliceOrg); code != http.StatusNotFound {
		t.Fatalf("bob with alice's org header = %d, want 404", code)
	}
	if ws := list(e.must(http.StatusOK, alice, "GET", "/api/v1/maintenance", nil), "windows"); len(ws) != 3 {
		t.Fatalf("alice's windows after bob's attempts = %d, want 3", len(ws))
	}

	// Roles: viewers read, members and up write.
	inv := e.must(http.StatusCreated, alice, "POST", "/api/v1/org/invites", map[string]any{"email": "dave@example.com", "role": "viewer"})
	dave := user("dave")
	e.must(http.StatusOK, dave, "POST", "/api/v1/invites/accept", map[string]any{
		"token": strings.TrimPrefix(inv["invite_url"].(string), "http://localhost:5173/invite/")})
	if ws := list(e.must(http.StatusOK, dave, "GET", "/api/v1/maintenance", nil, "X-Monitaur-Org", aliceOrg), "windows"); len(ws) != 3 {
		t.Fatalf("viewer sees %d windows, want 3", len(ws))
	}
	for _, req := range []struct{ method, path string }{
		{"POST", "/api/v1/maintenance"}, {"PATCH", windowPath}, {"DELETE", windowPath},
	} {
		if _, out := e.do(dave, req.method, req.path, valid(func(map[string]any) {}), "X-Monitaur-Org", aliceOrg); out["code"] != "forbidden" {
			t.Fatalf("viewer %s %s = %v, want forbidden", req.method, req.path, out)
		}
	}

	laterPath := fmt.Sprintf("/api/v1/maintenance/%d", num(later["id"]))
	e.must(http.StatusNoContent, alice, "DELETE", laterPath, nil)
	if code, _ := e.do(alice, "DELETE", laterPath, nil); code != http.StatusNotFound {
		t.Fatalf("second delete = %d, want 404", code)
	}
}
