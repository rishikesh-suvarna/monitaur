package handlers

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"sync"
	"time"

	"backend/config"
	"backend/database"
	"backend/models"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"gorm.io/gorm"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Allow connections from any origin in development
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
	config      *config.Config
	connections map[uint]*AgentConnection // serverID -> connection
	mutex       sync.RWMutex
}

func NewWebSocketHandler(db *database.Database, cfg *config.Config) *WebSocketHandler {
	handler := &WebSocketHandler{
		db:          db,
		config:      cfg,
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

	// log server connection
	log.Printf("Agent connecting for server: %s (ID: %d)", server.Name, server.ID)

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

	// Send email alert
	go h.sendEmailAlert(agentConn.server, alert)
}

// sendEmailAlert sends an email notification for alerts
func (h *WebSocketHandler) sendEmailAlert(server *models.Server, alert *models.Alert) {
	// Get SMTP configuration from config
	smtpConfig := h.config.SMTP

	// Validate required SMTP configuration
	if smtpConfig.Username == "" || smtpConfig.Password == "" {
		log.Printf("SMTP configuration incomplete: missing username or password")
		return
	}

	// Get recipients
	recipients := h.getAlertRecipients(server.ID)
	if len(recipients) == 0 {
		log.Printf("No recipients found for server %s alerts", server.Name)
		return
	}

	// Create email content
	subject := fmt.Sprintf("[ALERT] %s - %s Alert on Server %s",
		strings.ToUpper(alert.Level), strings.ToUpper(alert.Type), server.Name)

	body := h.buildEmailBody(server, alert)

	// Send email to each recipient
	for _, recipient := range recipients {
		if err := h.sendEmail(smtpConfig, recipient, subject, body); err != nil {
			log.Printf("Failed to send alert email to %s: %v", recipient, err)
		} else {
			log.Printf("Alert email sent to %s for server %s", recipient, server.Name)
		}
	}
}

// sendEmail sends an email using SMTP
func (h *WebSocketHandler) sendEmail(smtpConfig config.SMTPConfig, to, subject, body string) error {
	// Set up authentication
	auth := smtp.PlainAuth("", smtpConfig.Username, smtpConfig.Password, smtpConfig.Host)

	// Create message
	msg := []byte("To: " + to + "\r\n" +
		"From: " + smtpConfig.From + "\r\n" +
		"Subject: " + subject + "\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/html; charset=\"UTF-8\"\r\n" +
		"\r\n" +
		body + "\r\n")

	// Connect to server
	serverAddr := smtpConfig.Host + ":" + smtpConfig.Port

	// Connect with plain TCP first
	conn, err := net.Dial("tcp", serverAddr)
	if err != nil {
		return fmt.Errorf("failed to connect to SMTP server: %v", err)
	}
	defer conn.Close()

	// Create SMTP client
	client, err := smtp.NewClient(conn, smtpConfig.Host)
	if err != nil {
		return fmt.Errorf("failed to create SMTP client: %v", err)
	}
	defer client.Quit()

	// Start TLS if supported
	if ok, _ := client.Extension("STARTTLS"); ok {
		tlsConfig := &tls.Config{
			InsecureSkipVerify: false,
			ServerName:         smtpConfig.Host,
		}
		if err = client.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("failed to start TLS: %v", err)
		}
	}

	// Authenticate
	if err = client.Auth(auth); err != nil {
		return fmt.Errorf("SMTP authentication failed: %v", err)
	}

	// Set sender
	if err = client.Mail(smtpConfig.From); err != nil {
		return fmt.Errorf("failed to set sender: %v", err)
	}

	// Set recipient
	if err = client.Rcpt(to); err != nil {
		return fmt.Errorf("failed to set recipient: %v", err)
	}

	// Send message
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("failed to initiate data transfer: %v", err)
	}
	defer w.Close()

	_, err = w.Write(msg)
	if err != nil {
		return fmt.Errorf("failed to write message: %v", err)
	}

	return nil
}

// buildEmailBody creates the HTML email body for alerts
func (h *WebSocketHandler) buildEmailBody(server *models.Server, alert *models.Alert) string {
	timestamp := time.Now().Format("2006-01-02 15:04:05 MST")

	// Determine alert color based on level
	alertColor := "#fbbf24" // warning yellow
	switch strings.ToLower(alert.Level) {
	case "critical":
		alertColor = "#ef4444" // red
	case "error":
		alertColor = "#ef4444" // red
	case "warning":
		alertColor = "#fbbf24" // yellow
	case "info":
		alertColor = "#3b82f6" // blue
	}

	return fmt.Sprintf(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Server Alert | Monitaur</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: %s; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">Server Alert</h1>
        <p style="margin: 5px 0 0 0; font-size: 18px; font-weight: bold;">%s</p>
    </div>

    <div style="background-color: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; border-top: none; border-radius: 0 0 8px 8px;">
        <h2 style="color: #495057; margin-top: 0;">Alert Details</h2>

        <table style="width: 100%%; border-collapse: collapse; margin: 15px 0;">
            <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #6c757d;">Server:</td>
                <td style="padding: 8px 0;">%s</td>
            </tr>
            <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #6c757d;">Alert Type:</td>
                <td style="padding: 8px 0;">%s</td>
            </tr>
            <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #6c757d;">Level:</td>
                <td style="padding: 8px 0; color: %s; font-weight: bold;">%s</td>
            </tr>
            <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #6c757d;">Message:</td>
                <td style="padding: 8px 0;">%s</td>
            </tr>
            %s
            <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #6c757d;">Time:</td>
                <td style="padding: 8px 0;">%s</td>
            </tr>
        </table>

        <div style="margin-top: 20px; padding: 15px; background-color: #fff; border-left: 4px solid %s; border-radius: 4px;">
            <p style="margin: 0; color: #6c757d;">
                <strong>Action Required:</strong> Please check your Monitaur dashboard for more details and take appropriate action to resolve this alert.
            </p>
        </div>

        <hr style="margin: 20px 0; border: none; border-top: 1px solid #dee2e6;">

        <p style="font-size: 12px; color: #6c757d; margin: 0;">
            This alert was automatically generated by Monitaur.
        </p>
    </div>
</body>
</html>`,
		alertColor,
		strings.ToUpper(alert.Level),
		strings.ToUpper(server.Name),
		strings.ToUpper(alert.Type),
		alertColor,
		strings.ToUpper(alert.Level),
		alert.Message,
		h.buildValueThresholdRow(alert),
		timestamp,
		alertColor,
	)
}

// buildValueThresholdRow creates table rows for value and threshold if they exist
func (h *WebSocketHandler) buildValueThresholdRow(alert *models.Alert) string {
	var rows strings.Builder

	// Check if Value is not zero (assuming 0 means not set)
	if alert.Value != 0 {
		rows.WriteString(fmt.Sprintf(`
            <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #6c757d;">Current Value:</td>
                <td style="padding: 8px 0;">%.2f</td>
            </tr>`, alert.Value))
	}

	// Check if Threshold is not zero (assuming 0 means not set)
	if alert.Threshold != 0 {
		rows.WriteString(fmt.Sprintf(`
            <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #6c757d;">Threshold:</td>
                <td style="padding: 8px 0;">%.2f</td>
            </tr>`, alert.Threshold))
	}

	return rows.String()
}

// getAlertRecipients returns email addresses that should receive alerts for a server
func (h *WebSocketHandler) getAlertRecipients(serverID uint) []string {
	// Get the server to find the owner (user_id)
	server, err := h.db.GetServerByID(serverID)
	if err != nil {
		log.Printf("Error fetching server %d: %v", serverID, err)
		return []string{}
	}

	// Get the user who owns this server
	user, err := h.db.GetUserByID(server.UserID)
	if err != nil {
		log.Printf("Error fetching user %d for server %d: %v", server.UserID, serverID, err)
		return []string{}
	}

	// Return the owner's email
	recipients := []string{user.Email}

	// Optional:

	// 1. Admin users who should receive all alerts
	// adminUsers, err := h.db.GetAdminUsers()
	// if err == nil {
	//     for _, admin := range adminUsers {
	//         if admin.Email != user.Email { // Avoid duplicates
	//             recipients = append(recipients, admin.Email)
	//         }
	//     }
	// }

	// 2. Users who have subscribed to this specific server's alerts
	// subscribers, err := h.db.GetServerSubscribers(serverID)
	// if err == nil {
	//     for _, subscriber := range subscribers {
	//         if subscriber.Email != user.Email { // Avoid duplicates
	//             recipients = append(recipients, subscriber.Email)
	//         }
	//     }
	// }

	log.Printf("Alert recipients for server %s (ID: %d): %v", server.Name, serverID, recipients)
	return recipients
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
