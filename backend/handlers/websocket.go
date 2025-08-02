package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"backend/database"
	"backend/models"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"gorm.io/gorm"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Allow connections from any origin in development
		// In production, you should check the origin properly
		return true
	},
}

type AgentConnection struct {
	conn     *websocket.Conn
	server   *models.Server
	lastPing time.Time
	send     chan []byte
}

type WebSocketHandler struct {
	db          *database.Database
	connections map[uint]*AgentConnection // serverID -> connection
	mutex       sync.RWMutex
}

func NewWebSocketHandler(db *database.Database) *WebSocketHandler {
	handler := &WebSocketHandler{
		db:          db,
		connections: make(map[uint]*AgentConnection),
	}

	// Start cleanup routine for stale connections
	go handler.cleanupRoutine()

	return handler
}

// HandleAgentConnection handles WebSocket connections from monitoring agents
func (h *WebSocketHandler) HandleAgentConnection(c *gin.Context) {
	// Get authentication token from query params
	token := c.Query("token")
	serverName := c.Query("server_name")

	if token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token required"})
		return
	}

	// Verify server token
	server, err := h.db.GetServerByToken(token)
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		}
		return
	}

	// Update server name if provided and different
	if serverName != "" && server.Name != serverName {
		server.Name = serverName
		h.db.DB.Save(server)
	}

	// Upgrade HTTP connection to WebSocket
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Failed to upgrade connection: %v", err)
		return
	}

	// Create agent connection
	agentConn := &AgentConnection{
		conn:     conn,
		server:   server,
		lastPing: time.Now(),
		send:     make(chan []byte, 256),
	}

	// Register connection
	h.mutex.Lock()
	h.connections[server.ID] = agentConn
	h.mutex.Unlock()

	// Update server status to online
	h.db.UpdateServerLastSeen(server.ID)

	log.Printf("Agent connected: %s (ID: %d)", server.Name, server.ID)

	// Start goroutines for handling the connection
	go h.handleAgentMessages(agentConn)
	go h.handleAgentWrites(agentConn)
}

// handleAgentMessages processes incoming messages from agents
func (h *WebSocketHandler) handleAgentMessages(agentConn *AgentConnection) {
	defer func() {
		h.unregisterConnection(agentConn)
		agentConn.conn.Close()
	}()

	// Set read deadline and pong handler
	agentConn.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	agentConn.conn.SetPongHandler(func(string) error {
		agentConn.lastPing = time.Now()
		agentConn.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		var message models.AgentMessage
		err := agentConn.conn.ReadJSON(&message)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		// Process message based on type
		switch message.Type {
		case "metrics":
			h.handleMetricsMessage(agentConn, message)
		case "alert":
			h.handleAlertMessage(agentConn, message)
		default:
			log.Printf("Unknown message type: %s", message.Type)
		}

		// Update last seen
		h.db.UpdateServerLastSeen(agentConn.server.ID)
	}
}

// handleAgentWrites handles outgoing messages to agents
func (h *WebSocketHandler) handleAgentWrites(agentConn *AgentConnection) {
	ticker := time.NewTicker(54 * time.Second) // Send ping every 54 seconds
	defer ticker.Stop()

	for {
		select {
		case message, ok := <-agentConn.send:
			agentConn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				agentConn.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := agentConn.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				log.Printf("Write error: %v", err)
				return
			}

		case <-ticker.C:
			agentConn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := agentConn.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("Ping error: %v", err)
				return
			}
		}
	}
}

// handleMetricsMessage processes metrics data from agents
func (h *WebSocketHandler) handleMetricsMessage(agentConn *AgentConnection, message models.AgentMessage) {
	// Parse metrics data
	metricsData, ok := message.Data.(map[string]interface{})
	if !ok {
		log.Printf("Invalid metrics data format")
		return
	}

	// Convert to MetricData struct
	var metricData models.MetricData
	jsonData, err := json.Marshal(metricsData)
	if err != nil {
		log.Printf("Error marshaling metrics data: %v", err)
		return
	}

	if err := json.Unmarshal(jsonData, &metricData); err != nil {
		log.Printf("Error unmarshaling metrics data: %v", err)
		return
	}

	// Create metric record
	metric := &models.Metric{
		Time:     metricData.Timestamp,
		ServerID: agentConn.server.ID,

		CPUUsage: metricData.CPU.Usage,
		CPUCores: metricData.CPU.Cores,

		MemoryTotal:     metricData.Memory.Total,
		MemoryUsed:      metricData.Memory.Used,
		MemoryAvailable: metricData.Memory.Available,
		MemoryPercent:   metricData.Memory.UsedPercent,

		DiskTotal:   metricData.Disk.Total,
		DiskUsed:    metricData.Disk.Used,
		DiskFree:    metricData.Disk.Free,
		DiskPercent: metricData.Disk.UsedPercent,

		NetworkBytesIn:  metricData.Network.BytesRecv,
		NetworkBytesOut: metricData.Network.BytesSent,

		Uptime: metricData.Uptime,
	}

	// Save to database
	if err := h.db.CreateMetric(metric); err != nil {
		log.Printf("Error saving metric: %v", err)
		return
	}

	// Update server status based on metrics
	status := "online"
	if metricData.CPU.Usage > 90 || metricData.Memory.UsedPercent > 95 || metricData.Disk.UsedPercent > 95 {
		status = "warning"
	}
	h.db.UpdateServerStatus(agentConn.server.ID, status)

	log.Printf("Received metrics from %s: CPU=%.1f%%, Mem=%.1f%%, Disk=%.1f%%",
		agentConn.server.Name, metricData.CPU.Usage, metricData.Memory.UsedPercent, metricData.Disk.UsedPercent)
}

// handleAlertMessage processes alert data from agents
func (h *WebSocketHandler) handleAlertMessage(agentConn *AgentConnection, message models.AgentMessage) {
	// Parse alert data
	alertData, ok := message.Data.(map[string]interface{})
	if !ok {
		log.Printf("Invalid alert data format")
		return
	}

	// Convert to AlertData struct
	var alertDataStruct models.AlertData
	jsonData, err := json.Marshal(alertData)
	if err != nil {
		log.Printf("Error marshaling alert data: %v", err)
		return
	}

	if err := json.Unmarshal(jsonData, &alertDataStruct); err != nil {
		log.Printf("Error unmarshaling alert data: %v", err)
		return
	}

	// Create alert record
	alert := &models.Alert{
		ServerID:  agentConn.server.ID,
		Type:      alertDataStruct.Type,
		Level:     alertDataStruct.Level,
		Message:   alertDataStruct.Message,
		Value:     alertDataStruct.Value,
		Threshold: alertDataStruct.Threshold,
		Resolved:  false,
	}

	// Save to database
	if err := h.db.CreateAlert(alert); err != nil {
		log.Printf("Error saving alert: %v", err)
		return
	}

	log.Printf("Received alert from %s: %s", agentConn.server.Name, alertDataStruct.Message)

	// TODO: Trigger email notifications here
	// h.sendEmailAlert(agentConn.server, alert)
}

// unregisterConnection removes a connection from the registry
func (h *WebSocketHandler) unregisterConnection(agentConn *AgentConnection) {
	h.mutex.Lock()
	defer h.mutex.Unlock()

	if _, exists := h.connections[agentConn.server.ID]; exists {
		delete(h.connections, agentConn.server.ID)
		close(agentConn.send)

		// Update server status to offline
		h.db.UpdateServerStatus(agentConn.server.ID, "offline")

		log.Printf("Agent disconnected: %s (ID: %d)", agentConn.server.Name, agentConn.server.ID)
	}
}

// cleanupRoutine periodically cleans up stale connections
func (h *WebSocketHandler) cleanupRoutine() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			h.cleanupStaleConnections()
		}
	}
}

// cleanupStaleConnections removes connections that haven't sent pings recently
func (h *WebSocketHandler) cleanupStaleConnections() {
	h.mutex.Lock()
	defer h.mutex.Unlock()

	now := time.Now()
	for serverID, conn := range h.connections {
		if now.Sub(conn.lastPing) > 2*time.Minute {
			log.Printf("Cleaning up stale connection for server ID: %d", serverID)
			conn.conn.Close()
			delete(h.connections, serverID)
			h.db.UpdateServerStatus(serverID, "offline")
		}
	}
}

// SendMessageToAgent sends a message to a specific agent
func (h *WebSocketHandler) SendMessageToAgent(serverID uint, messageType string, data interface{}) error {
	h.mutex.RLock()
	conn, exists := h.connections[serverID]
	h.mutex.RUnlock()

	if !exists {
		return ErrAgentNotConnected
	}

	message := map[string]interface{}{
		"type":      messageType,
		"data":      data,
		"timestamp": time.Now(),
	}

	jsonData, err := json.Marshal(message)
	if err != nil {
		return err
	}

	select {
	case conn.send <- jsonData:
		return nil
	default:
		// Channel is full, connection might be stale
		return ErrAgentNotResponding
	}
}

// GetConnectedAgents returns a list of currently connected agents
func (h *WebSocketHandler) GetConnectedAgents() []uint {
	h.mutex.RLock()
	defer h.mutex.RUnlock()

	agents := make([]uint, 0, len(h.connections))
	for serverID := range h.connections {
		agents = append(agents, serverID)
	}
	return agents
}

// IsAgentConnected checks if an agent is currently connected
func (h *WebSocketHandler) IsAgentConnected(serverID uint) bool {
	h.mutex.RLock()
	defer h.mutex.RUnlock()

	_, exists := h.connections[serverID]
	return exists
}

// Error definitions
var (
	ErrAgentNotConnected  = fmt.Errorf("agent not connected")
	ErrAgentNotResponding = fmt.Errorf("agent not responding")
)
