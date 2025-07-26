package client

import (
	"fmt"
	"log"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

type Client struct {
	conn       *websocket.Conn
	token      string
	endpoint   string
	serverName string

	// Reconnection
	reconnectInterval time.Duration
	maxReconnectDelay time.Duration
	reconnectAttempts int
}

type Message struct {
	Type       string      `json:"type"`
	Token      string      `json:"token"`
	ServerName string      `json:"server_name"`
	Data       interface{} `json:"data"`
	Timestamp  time.Time   `json:"timestamp"`
}

func NewClient(endpoint, token, serverName string) *Client {
	return &Client{
		endpoint:          endpoint,
		token:             token,
		serverName:        serverName,
		reconnectInterval: 5 * time.Second,
		maxReconnectDelay: 60 * time.Second,
	}
}

func (c *Client) Connect() error {
	u, err := url.Parse(c.endpoint)
	if err != nil {
		return fmt.Errorf("invalid endpoint URL: %w", err)
	}

	// Add token as query parameter
	q := u.Query()
	q.Set("token", c.token)
	q.Set("server_name", c.serverName)
	u.RawQuery = q.Encode()

	log.Printf("Connecting to %s", u.String())

	dialer := websocket.DefaultDialer
	dialer.HandshakeTimeout = 10 * time.Second

	conn, resp, err := dialer.Dial(u.String(), nil)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("connection failed with status %d: %w", resp.StatusCode, err)
		}
		return fmt.Errorf("connection failed: %w", err)
	}

	c.conn = conn
	c.reconnectAttempts = 0

	log.Printf("Connected to monitoring server")
	return nil
}

func (c *Client) SendMetrics(metrics interface{}) error {
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}

	message := Message{
		Type:       "metrics",
		Token:      c.token,
		ServerName: c.serverName,
		Data:       metrics,
		Timestamp:  time.Now(),
	}

	return c.conn.WriteJSON(message)
}

func (c *Client) SendAlert(alert interface{}) error {
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}

	message := Message{
		Type:       "alert",
		Token:      c.token,
		ServerName: c.serverName,
		Data:       alert,
		Timestamp:  time.Now(),
	}

	return c.conn.WriteJSON(message)
}

func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}

	// Send close message
	closeMessage := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "")
	c.conn.WriteMessage(websocket.CloseMessage, closeMessage)

	return c.conn.Close()
}

func (c *Client) StartHeartbeat() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		if c.conn == nil {
			continue
		}

		// Send ping
		if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
			log.Printf("Heartbeat failed: %v", err)
			c.handleDisconnection()
			return
		}
	}
}

func (c *Client) handleDisconnection() {
	log.Printf("Connection lost, attempting to reconnect...")

	c.conn = nil
	c.reconnectAttempts++

	// Calculate backoff delay
	delay := time.Duration(c.reconnectAttempts) * c.reconnectInterval
	if delay > c.maxReconnectDelay {
		delay = c.maxReconnectDelay
	}

	time.Sleep(delay)

	if err := c.Connect(); err != nil {
		log.Printf("Reconnection failed: %v", err)
		go func() {
			time.Sleep(delay)
			c.handleDisconnection()
		}()
	} else {
		go c.StartHeartbeat()
	}
}

func (c *Client) IsConnected() bool {
	return c.conn != nil
}

// ListenForMessages handles incoming messages from server
func (c *Client) ListenForMessages() {
	if c.conn == nil {
		return
	}

	for {
		var message map[string]interface{}
		err := c.conn.ReadJSON(&message)
		if err != nil {
			log.Printf("Read error: %v", err)
			c.handleDisconnection()
			return
		}

		// Handle different message types
		msgType, ok := message["type"].(string)
		if !ok {
			continue
		}

		switch msgType {
		case "config_update":
			log.Printf("Received config update: %v", message["data"])
		case "command":
			log.Printf("Received command: %v", message["data"])
		default:
			log.Printf("Unknown message type: %s", msgType)
		}
	}
}
