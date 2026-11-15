package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultPingInterval = 30 * time.Second
	// Must exceed defaultPingInterval so a healthy but quiet link is not
	// mistaken for a dead one. Any frame from the backend (pong, ping, data)
	// extends the deadline.
	defaultPongWait         = 60 * time.Second
	defaultWriteWait        = 10 * time.Second
	defaultHandshakeTimeout = 10 * time.Second
	defaultMinBackoff       = 1 * time.Second
	defaultMaxBackoff       = 60 * time.Second
	// A session that lasted this long resets the backoff: a long-lived
	// connection reconnects promptly after a blip, a flapping one backs off.
	defaultStableAfter = 30 * time.Second

	sendQueueSize = 64
	// How long to wait for the backend to acknowledge our close frame.
	closeGracePeriod = 1 * time.Second
	closeReason      = "agent shutting down"

	agentVersionHeader = "X-Agent-Version"
	configUpdateType   = "config_update"
	// Upper bound for a pushed collection interval. Anything larger is a
	// backend bug, and it keeps seconds-to-Duration far from overflow.
	maxPushedInterval = 24 * time.Hour
)

var (
	ErrNotConnected = errors.New("not connected to monitoring server")
	ErrQueueFull    = errors.New("send queue full")
)

// Message is the wire format the backend expects (backend/models.AgentMessage).
// The token travels only in the dial request, never in message bodies.
type Message struct {
	Type       string    `json:"type"`
	ServerName string    `json:"server_name"`
	Data       any       `json:"data"`
	Timestamp  time.Time `json:"timestamp"`
}

// ConfigUpdate is a setting the backend pushed in a config_update message.
type ConfigUpdate struct {
	// CollectionInterval is the shortest interval the backend accepts for
	// this server, for example a plan's minimum.
	CollectionInterval time.Duration
}

type options struct {
	pingInterval     time.Duration
	pongWait         time.Duration
	writeWait        time.Duration
	handshakeTimeout time.Duration
	minBackoff       time.Duration
	maxBackoff       time.Duration
	stableAfter      time.Duration
}

func defaultOptions() options {
	return options{
		pingInterval:     defaultPingInterval,
		pongWait:         defaultPongWait,
		writeWait:        defaultWriteWait,
		handshakeTimeout: defaultHandshakeTimeout,
		minBackoff:       defaultMinBackoff,
		maxBackoff:       defaultMaxBackoff,
		stableAfter:      defaultStableAfter,
	}
}

// Client streams messages to the backend over a single WebSocket.
//
// gorilla/websocket allows one concurrent reader and one concurrent writer per
// connection. Run owns the connection: it is the only goroutine that writes,
// and it starts exactly one reader per connection. Send* methods only enqueue,
// so they are safe to call from any goroutine.
type Client struct {
	endpoint     *url.URL
	token        string
	serverName   string
	agentVersion string
	opts         options

	send          chan []byte
	configUpdates chan ConfigUpdate
	connected     atomic.Bool
}

// NewClient validates the endpoint up front so a typo in config.json fails at
// startup instead of turning into an endless reconnect loop. agentVersion is
// reported to the backend in the X-Agent-Version header.
func NewClient(endpoint, token, serverName, agentVersion string) (*Client, error) {
	return newClient(endpoint, token, serverName, agentVersion, defaultOptions())
}

func newClient(endpoint, token, serverName, agentVersion string, opts options) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("invalid endpoint URL: %w", err)
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return nil, fmt.Errorf("endpoint must use ws:// or wss://, got %q", endpoint)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("endpoint has no host: %q", endpoint)
	}

	q := u.Query()
	// Legacy: the currently deployed backend reads the token only from this
	// query parameter. Remove it once backend v2, which reads the
	// Authorization header, is deployed. The dial URL is never logged.
	q.Set("token", token)
	q.Set("server_name", serverName)
	u.RawQuery = q.Encode()

	return &Client{
		endpoint:     u,
		token:        token,
		serverName:   serverName,
		agentVersion: agentVersion,
		opts:         opts,
		send:         make(chan []byte, sendQueueSize),
		// One slot, latest wins (see publishConfig).
		configUpdates: make(chan ConfigUpdate, 1),
	}, nil
}

func (c *Client) IsConnected() bool {
	return c.connected.Load()
}

// ConfigUpdates delivers settings pushed by the backend. Only the latest
// update is kept: an unread one is replaced by a newer one, so a slow
// consumer never stalls the reader (and with it pong handling).
func (c *Client) ConfigUpdates() <-chan ConfigUpdate {
	return c.configUpdates
}

func (c *Client) SendMetrics(metrics any) error {
	return c.enqueue("metrics", metrics)
}

func (c *Client) SendAlert(alert any) error {
	return c.enqueue("alert", alert)
}

func (c *Client) enqueue(msgType string, data any) error {
	if !c.connected.Load() {
		return ErrNotConnected
	}

	payload, err := json.Marshal(Message{
		Type:       msgType,
		ServerName: c.serverName,
		Data:       data,
		Timestamp:  time.Now(),
	})
	if err != nil {
		return fmt.Errorf("marshal %s message: %w", msgType, err)
	}

	select {
	case c.send <- payload:
		return nil
	default:
		return ErrQueueFull
	}
}

// Run keeps a connection to the backend open until ctx is cancelled,
// redialling with jittered exponential backoff. It blocks, so call it in its
// own goroutine.
func (c *Client) Run(ctx context.Context) {
	backoff := c.opts.minBackoff
	for {
		session, err := c.runSession(ctx)
		if ctx.Err() != nil {
			return
		}
		if session >= c.opts.stableAfter {
			backoff = c.opts.minBackoff
		}

		wait := jitter(backoff)
		log.Printf("Connection to monitoring server lost: %v (reconnecting in %s)", err, wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		backoff = min(backoff*2, c.opts.maxBackoff)
	}
}

// runSession dials once and pumps messages until the connection fails or ctx
// is cancelled. It returns how long the connection was up.
func (c *Client) runSession(ctx context.Context) (time.Duration, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Close()

	start := time.Now()
	c.connected.Store(true)
	defer c.connected.Store(false)
	log.Printf("Connected to monitoring server")

	readDone := make(chan struct{})
	var readErr error
	go func() {
		defer close(readDone)
		readErr = c.readLoop(conn)
	}()

	writeErr := c.writeLoop(ctx, conn, readDone)

	// Unblock the reader if it is still running, and wait for it so two
	// readers never overlap across reconnects.
	conn.Close()
	<-readDone

	if writeErr != nil {
		return time.Since(start), writeErr
	}
	return time.Since(start), readErr
}

func (c *Client) dial(ctx context.Context) (*websocket.Conn, error) {
	// Never log the query string: it carries the server token.
	log.Printf("Connecting to %s://%s%s", c.endpoint.Scheme, c.endpoint.Host, c.endpoint.Path)

	dialer := websocket.Dialer{
		Proxy:            http.ProxyFromEnvironment,
		HandshakeTimeout: c.opts.handshakeTimeout,
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+c.token)
	header.Set(agentVersionHeader, c.agentVersion)
	conn, resp, err := dialer.DialContext(ctx, c.endpoint.String(), header)
	if err != nil {
		if resp != nil {
			if resp.StatusCode == http.StatusUnauthorized {
				return nil, fmt.Errorf("server rejected the token (401), check \"token\" in config.json: %w", err)
			}
			return nil, fmt.Errorf("handshake failed with status %d: %w", resp.StatusCode, err)
		}
		return nil, fmt.Errorf("dial: %w", err)
	}
	return conn, nil
}

// writeLoop is the only place that writes data or pings to conn.
func (c *Client) writeLoop(ctx context.Context, conn *websocket.Conn, readDone <-chan struct{}) error {
	ticker := time.NewTicker(c.opts.pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			c.closeGracefully(conn, readDone)
			return ctx.Err()
		case <-readDone:
			return nil
		case payload := <-c.send:
			if err := c.write(conn, websocket.TextMessage, payload); err != nil {
				return fmt.Errorf("write: %w", err)
			}
		case <-ticker.C:
			if err := c.write(conn, websocket.PingMessage, nil); err != nil {
				return fmt.Errorf("ping: %w", err)
			}
		}
	}
}

func (c *Client) write(conn *websocket.Conn, messageType int, payload []byte) error {
	if err := conn.SetWriteDeadline(time.Now().Add(c.opts.writeWait)); err != nil {
		return err
	}
	return conn.WriteMessage(messageType, payload)
}

func (c *Client) closeGracefully(conn *websocket.Conn, readDone <-chan struct{}) {
	msg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, closeReason)
	if err := conn.WriteControl(websocket.CloseMessage, msg, time.Now().Add(c.opts.writeWait)); err != nil {
		return
	}
	select {
	case <-readDone:
	case <-time.After(closeGracePeriod):
	}
}

// readLoop drains incoming frames so control frames (pings from the backend,
// pongs to our pings) are processed, and treats silence longer than pongWait
// as a dead connection.
func (c *Client) readLoop(conn *websocket.Conn) error {
	extend := func() error {
		return conn.SetReadDeadline(time.Now().Add(c.opts.pongWait))
	}
	if err := extend(); err != nil {
		return err
	}

	conn.SetPongHandler(func(string) error { return extend() })
	// The default ping handler replies with a pong via WriteControl, which is
	// safe to call concurrently with the writer goroutine.
	replyPong := conn.PingHandler()
	conn.SetPingHandler(func(appData string) error {
		if err := extend(); err != nil {
			return err
		}
		return replyPong(appData)
	})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if err := extend(); err != nil {
			return err
		}
		c.handleServerMessage(data)
	}
}

func (c *Client) handleServerMessage(data []byte) {
	var message struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &message); err != nil {
		log.Printf("Ignoring malformed message from server: %v", err)
		return
	}

	switch message.Type {
	case configUpdateType:
		update, err := parseConfigUpdate(message.Data)
		if err != nil {
			log.Printf("Ignoring invalid config update: %v", err)
			return
		}
		c.publishConfig(update)
	case "command":
		log.Printf("Received command: %s", message.Data)
	default:
		log.Printf("Unknown message type: %s", message.Type)
	}
}

// parseConfigUpdate decodes the data of a config_update message:
// {"collection_interval": <whole seconds>}.
func parseConfigUpdate(data json.RawMessage) (ConfigUpdate, error) {
	var payload struct {
		CollectionInterval *int64 `json:"collection_interval"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return ConfigUpdate{}, fmt.Errorf("decode: %w", err)
	}
	if payload.CollectionInterval == nil {
		return ConfigUpdate{}, errors.New("collection_interval missing")
	}

	seconds := *payload.CollectionInterval
	maxSeconds := int64(maxPushedInterval / time.Second)
	if seconds <= 0 || seconds > maxSeconds {
		return ConfigUpdate{}, fmt.Errorf("collection_interval %d out of range 1..%d seconds", seconds, maxSeconds)
	}
	return ConfigUpdate{CollectionInterval: time.Duration(seconds) * time.Second}, nil
}

// publishConfig hands update to the consumer without ever blocking: if an
// older update is still unread it is dropped in favour of this one. Only the
// reader calls it, and runSession never runs two readers at once, so the
// loop finishes in at most two passes.
func (c *Client) publishConfig(update ConfigUpdate) {
	for {
		select {
		case c.configUpdates <- update:
			return
		default:
		}
		select {
		case <-c.configUpdates:
		default:
		}
	}
}

// jitter returns a duration in [d/2, d] so agents that lost the backend at
// the same moment do not all redial in lockstep.
func jitter(d time.Duration) time.Duration {
	half := d / 2
	if half <= 0 {
		return d
	}
	return half + rand.N(half+1)
}
