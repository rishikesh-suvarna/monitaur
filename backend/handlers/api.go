package handlers

import (
	"net/http"
	"strconv"
	"time"

	"backend/auth"
	"backend/database"
	"backend/models"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type APIHandler struct {
	db   *database.Database
	auth *auth.FirebaseAuth
	ws   *WebSocketHandler
}

func NewAPIHandler(db *database.Database, firebaseAuth *auth.FirebaseAuth, ws *WebSocketHandler) *APIHandler {
	return &APIHandler{
		db:   db,
		auth: firebaseAuth,
		ws:   ws,
	}
}

// GetUserProfile returns the current user's profile
func (h *APIHandler) GetUserProfile(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	user, err := h.db.GetOrCreateUser(userClaims.UID, userClaims.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get user profile"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"user": user})
}

// GetUserServers returns all servers for the current user
func (h *APIHandler) GetUserServers(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	servers, err := h.db.GetUserServers(userClaims.UID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get servers"})
		return
	}

	// Add connection status
	for i := range servers {
		servers[i].Status = "offline"
		if h.ws.IsAgentConnected(servers[i].ID) {
			servers[i].Status = "online"
		}
	}

	c.JSON(http.StatusOK, gin.H{"servers": servers})
}

// CreateServer creates a new server for the current user
func (h *APIHandler) CreateServer(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	var req struct {
		Name string `json:"name" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get or create user to get the internal ID
	user, err := h.db.GetOrCreateUser(userClaims.UID, userClaims.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get user"})
		return
	}

	// Generate unique token for the server
	token := uuid.New().String()

	server := &models.Server{
		UserID: user.ID, // Use internal user ID
		Token:  token,
		Name:   req.Name,
		Status: "offline",
	}

	if err := h.db.CreateServer(server); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create server"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"server": server})
}

// DeleteServer deletes a server
func (h *APIHandler) DeleteServer(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	serverID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid server ID"})
		return
	}

	// Get user to get internal ID
	user, err := h.db.GetUserByUID(userClaims.UID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "User not found"})
		return
	}

	// Check if server belongs to user
	var server models.Server
	err = h.db.DB.Where("id = ? AND user_id = ?", serverID, user.ID).First(&server).Error
	if err == gorm.ErrRecordNotFound {
		c.JSON(http.StatusNotFound, gin.H{"error": "Server not found"})
		return
	} else if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Delete server and related data
	tx := h.db.DB.Begin()
	if err := tx.Where("server_id = ?", serverID).Delete(&models.Metric{}).Error; err != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete metrics"})
		return
	}
	if err := tx.Where("server_id = ?", serverID).Delete(&models.Alert{}).Error; err != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete alerts"})
		return
	}
	if err := tx.Delete(&server).Error; err != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete server"})
		return
	}
	tx.Commit()

	c.JSON(http.StatusOK, gin.H{"message": "Server deleted successfully"})
}

// GetServerMetrics returns metrics for a specific server
func (h *APIHandler) GetServerMetrics(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	serverID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid server ID"})
		return
	}

	// Get user to get internal ID
	user, err := h.db.GetUserByUID(userClaims.UID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "User not found"})
		return
	}

	// Check if server belongs to user
	var server models.Server
	err = h.db.DB.Where("id = ? AND user_id = ?", serverID, user.ID).First(&server).Error
	if err == gorm.ErrRecordNotFound {
		c.JSON(http.StatusNotFound, gin.H{"error": "Server not found"})
		return
	} else if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Get time range (default to last 24 hours)
	hoursParam := c.DefaultQuery("hours", "24")
	hours, err := strconv.Atoi(hoursParam)
	if err != nil || hours < 1 {
		hours = 24
	}

	since := time.Now().Add(-time.Duration(hours) * time.Hour)
	metrics, err := h.db.GetServerMetrics(uint(serverID), since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get metrics"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"server":  server,
		"metrics": metrics,
		"since":   since,
	})
}

// GetServerAlerts returns alerts for a specific server
func (h *APIHandler) GetServerAlerts(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	serverID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid server ID"})
		return
	}

	// Check if server belongs to user
	var server models.Server
	err = h.db.DB.Where("id = ? AND user_id = ?", serverID, userClaims.UID).First(&server).Error
	if err == gorm.ErrRecordNotFound {
		c.JSON(http.StatusNotFound, gin.H{"error": "Server not found"})
		return
	} else if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	limitParam := c.DefaultQuery("limit", "50")
	limit, err := strconv.Atoi(limitParam)
	if err != nil || limit < 1 {
		limit = 50
	}

	alerts, err := h.db.GetServerAlerts(uint(serverID), limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get alerts"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"server": server,
		"alerts": alerts,
	})
}

// ResolveAlert marks an alert as resolved
func (h *APIHandler) ResolveAlert(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	alertID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid alert ID"})
		return
	}

	// Check if alert belongs to user's server
	var alert models.Alert
	err = h.db.DB.Joins("JOIN servers ON alerts.server_id = servers.id").
		Where("alerts.id = ? AND servers.user_id = ?", alertID, userClaims.UID).
		First(&alert).Error
	if err == gorm.ErrRecordNotFound {
		c.JSON(http.StatusNotFound, gin.H{"error": "Alert not found"})
		return
	} else if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	if err := h.db.ResolveAlert(uint(alertID)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to resolve alert"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Alert resolved successfully"})
}

// GetDashboardData returns aggregated data for the dashboard
// Note: This method has been moved to DashboardHandler for better organization
// Keeping this for backward compatibility
func (h *APIHandler) GetDashboardData(c *gin.Context) {
	dashboardHandler := NewDashboardHandler(h.db, h.ws)
	dashboardHandler.GetDashboardData(c)
}

// Health check endpoint
func (h *APIHandler) HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":    "ok",
		"timestamp": time.Now(),
		"version":   "1.0.0",
	})
}
