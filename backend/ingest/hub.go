// Package ingest accepts agent WebSocket connections. Agents are
// authenticated from the in-memory directory and samples go to the metrics
// store and alerting engine, so ingest never touches the database.
package ingest

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"backend/limits"
	"backend/metrics"
	"backend/secrets"
	"backend/store"
)

const (
	maxMessageBytes = 64 << 10
	// Agents ping every 30 s and send data every few seconds; any frame
	// extends the deadline.
	readWait   = 70 * time.Second
	pingPeriod = 50 * time.Second
	writeWait  = 10 * time.Second
	sendQueue  = 16

	connectsPerMinutePerIP = 30
	connectBurstPerIP      = 10

	agentVersionHeader = "X-Agent-Version"
	maxVersionLen      = 32
	maxServerNameLen   = 64

	msgMetrics      = "metrics"
	msgAlert        = "alert" // sent by v1 agents; v2 evaluates rules server-side
	msgConfigUpdate = "config_update"
)

var versionPattern = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,32}$`)

// Directory resolves tokens and plans from memory.
type Directory interface {
	ServerByTokenHash(hash string) (store.Server, bool)
	Plan(orgID int64) store.Plan
}

// Recorder receives everything an agent reports.
type Recorder interface {
	Sample(serverID int64, s metrics.Sample, minInterval time.Duration) error
	Connected(serverID int64, version string, at time.Time)
	Disconnected(serverID int64, at time.Time)
}

type Hub struct {
	dir      Directory
	rec      Recorder
	limiter  *limits.RateLimiter
	origins  map[string]bool
	log      *slog.Logger
	now      func() time.Time
	upgrader websocket.Upgrader

	mu    sync.RWMutex
	conns map[int64]*conn

	dropped atomic.Int64 // samples rejected (too frequent or invalid)
}

type conn struct {
	ws        *websocket.Conn
	serverID  int64
	orgID     int64
	tokenHash string
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

func (c *conn) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.ws.Close()
	})
}

func NewHub(dir Directory, rec Recorder, limiter *limits.RateLimiter, allowedOrigins []string, log *slog.Logger) *Hub {
	h := &Hub{
		dir: dir, rec: rec, limiter: limiter, log: log, now: time.Now,
		origins: map[string]bool{},
		conns:   map[int64]*conn{},
	}
	for _, o := range allowedOrigins {
		h.origins[strings.TrimRight(o, "/")] = true
	}
	h.upgrader = websocket.Upgrader{CheckOrigin: h.checkOrigin}
	return h
}

// checkOrigin: agents send no Origin header. A browser always does, so only
// allowlisted dashboard origins may open a socket (blocks cross-site
// WebSocket hijacking with a stolen token in a malicious page).
func (h *Hub) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || h.origins[strings.TrimRight(origin, "/")]
}

func agentToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); len(h) > len("Bearer ") && strings.EqualFold(h[:len("Bearer ")], "Bearer ") {
		return strings.TrimSpace(h[len("Bearer "):])
	}
	// v1 agents only send the query parameter. The request logger strips
	// query strings, so it does not end up in logs.
	return r.URL.Query().Get("token")
}

// Handle is the GET /agent/connect handler.
func (h *Hub) Handle(c *gin.Context) {
	if !h.limiter.Allow("agent-ip:"+c.ClientIP(), connectsPerMinutePerIP, connectBurstPerIP) {
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many connection attempts", "code": "rate_limited"})
		return
	}
	token := agentToken(c.Request)
	if token == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "token required", "code": "unauthorized"})
		return
	}
	hash := secrets.HashToken(token)
	srv, ok := h.dir.ServerByTokenHash(hash)
	if !ok {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token", "code": "unauthorized"})
		return
	}
	version := c.GetHeader(agentVersionHeader)
	if !versionPattern.MatchString(version) {
		version = ""
	}

	ws, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		h.log.Debug("agent upgrade failed", "server_id", srv.ID, "err", err)
		return
	}
	ws.SetReadLimit(maxMessageBytes)
	cn := &conn{ws: ws, serverID: srv.ID, orgID: srv.OrgID, tokenHash: hash, send: make(chan []byte, sendQueue), done: make(chan struct{})}

	h.register(cn)
	now := h.now()
	h.rec.Connected(srv.ID, version, now)
	h.log.Info("agent connected", "server_id", srv.ID, "org_id", srv.OrgID, "agent_version", version)

	h.pushConfig(cn, h.dir.Plan(srv.OrgID))
	go h.writePump(cn)
	go h.readPump(cn)
}

func (h *Hub) register(cn *conn) {
	h.mu.Lock()
	prev := h.conns[cn.serverID]
	h.conns[cn.serverID] = cn
	h.mu.Unlock()
	if prev != nil {
		// A reconnect while the old socket is half-open: close the old one so
		// it cannot later unregister the new connection.
		prev.close()
	}
}

func (h *Hub) unregister(cn *conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[cn.serverID] != cn {
		return false
	}
	delete(h.conns, cn.serverID)
	return true
}

// pushConfig tells the agent the plan's minimum interval; v2 agents never
// send faster, v1 agents log it and are throttled at ingest instead.
func (h *Hub) pushConfig(cn *conn, plan store.Plan) {
	if plan.MinIntervalSeconds <= 0 {
		return
	}
	msg, err := json.Marshal(map[string]any{
		"type":      msgConfigUpdate,
		"data":      map[string]int{"collection_interval": plan.MinIntervalSeconds},
		"timestamp": h.now(),
	})
	if err != nil {
		return
	}
	select {
	case cn.send <- msg:
	default:
	}
}

func (h *Hub) writePump(cn *conn) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer cn.close()
	for {
		select {
		case <-cn.done:
			_ = cn.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(writeWait))
			return
		case msg := <-cn.send:
			_ = cn.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := cn.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = cn.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := cn.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Hub) readPump(cn *conn) {
	defer func() {
		cn.close()
		if h.unregister(cn) {
			h.rec.Disconnected(cn.serverID, h.now())
			h.log.Info("agent disconnected", "server_id", cn.serverID)
		}
	}()
	extend := func() { _ = cn.ws.SetReadDeadline(time.Now().Add(readWait)) }
	extend()
	cn.ws.SetPongHandler(func(string) error { extend(); return nil })
	replyPong := cn.ws.PingHandler()
	cn.ws.SetPingHandler(func(data string) error { extend(); return replyPong(data) })

	minInterval := h.dir.Plan(cn.orgID).MinInterval()
	for {
		_, data, err := cn.ws.ReadMessage()
		if err != nil {
			return
		}
		extend()
		h.handleMessage(cn, data, minInterval)
	}
}

type agentMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// metricData is the v1/v2 agent payload (agent/metrics/collector.go).
type metricData struct {
	CPU struct {
		Usage float64 `json:"usage"`
		Cores int     `json:"cores"`
	} `json:"cpu"`
	Memory struct {
		Total       uint64  `json:"total"`
		Used        uint64  `json:"used"`
		UsedPercent float64 `json:"used_percent"`
	} `json:"memory"`
	Disk struct {
		Total       uint64  `json:"total"`
		Used        uint64  `json:"used"`
		UsedPercent float64 `json:"used_percent"`
	} `json:"disk"`
	Network struct {
		BytesSent uint64 `json:"bytes_sent"`
		BytesRecv uint64 `json:"bytes_recv"`
	} `json:"network"`
	Uptime int64 `json:"uptime"`
}

func (h *Hub) handleMessage(cn *conn, data []byte, minInterval time.Duration) {
	var msg agentMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		h.dropped.Add(1)
		return
	}
	switch msg.Type {
	case msgMetrics:
		var md metricData
		if err := json.Unmarshal(msg.Data, &md); err != nil {
			h.dropped.Add(1)
			return
		}
		// Server time, not the agent's clock: buckets stay aligned even when
		// a host's clock drifts.
		sample := metrics.Sample{
			Time:           h.now(),
			CPUPercent:     md.CPU.Usage,
			CPUCores:       md.CPU.Cores,
			MemTotalBytes:  md.Memory.Total,
			MemUsedBytes:   md.Memory.Used,
			MemPercent:     md.Memory.UsedPercent,
			DiskTotalBytes: md.Disk.Total,
			DiskUsedBytes:  md.Disk.Used,
			DiskPercent:    md.Disk.UsedPercent,
			NetRxTotal:     md.Network.BytesRecv,
			NetTxTotal:     md.Network.BytesSent,
			UptimeSeconds:  md.Uptime,
		}
		if err := h.rec.Sample(cn.serverID, sample, minInterval); err != nil {
			h.dropped.Add(1)
			if !errors.Is(err, metrics.ErrTooFrequent) {
				h.log.Debug("rejected sample", "server_id", cn.serverID, "err", err)
			}
		}
	case msgAlert:
		// Ignored: alert rules run in the backend now.
	default:
		h.log.Debug("unknown agent message", "server_id", cn.serverID, "type", truncate(msg.Type, maxServerNameLen))
	}
}

func (h *Hub) IsConnected(serverID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.conns[serverID]
	return ok
}

func (h *Hub) ConnectedCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

func (h *Hub) Dropped() int64 { return h.dropped.Load() }

// Disconnect closes a server's agent connection (server deleted).
func (h *Hub) Disconnect(serverID int64) {
	h.mu.RLock()
	cn := h.conns[serverID]
	h.mu.RUnlock()
	if cn != nil {
		cn.close()
	}
}

// SweepTokens drops connections whose token is no longer accepted, so a
// rotated-out token stops working when its grace period ends, not just on
// the next reconnect.
func (h *Hub) SweepTokens() {
	h.mu.RLock()
	var stale []*conn
	for _, cn := range h.conns {
		if srv, ok := h.dir.ServerByTokenHash(cn.tokenHash); !ok || srv.ID != cn.serverID {
			stale = append(stale, cn)
		}
	}
	h.mu.RUnlock()
	for _, cn := range stale {
		h.log.Info("closing agent with revoked token", "server_id", cn.serverID)
		cn.close()
	}
}

func (h *Hub) CloseAll() {
	h.mu.RLock()
	all := make([]*conn, 0, len(h.conns))
	for _, cn := range h.conns {
		all = append(all, cn)
	}
	h.mu.RUnlock()
	for _, cn := range all {
		cn.close()
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
