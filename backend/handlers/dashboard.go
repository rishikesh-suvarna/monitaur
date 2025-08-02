package handlers

import (
	"fmt"
	"net/http"
	"time"

	"backend/auth"
	"backend/database"
	"backend/models"

	"github.com/gin-gonic/gin"
)

type DashboardHandler struct {
	db *database.Database
	ws *WebSocketHandler
}

func NewDashboardHandler(db *database.Database, ws *WebSocketHandler) *DashboardHandler {
	return &DashboardHandler{
		db: db,
		ws: ws,
	}
}

type DashboardSummary struct {
	TotalServers   int `json:"total_servers"`
	OnlineServers  int `json:"online_servers"`
	OfflineServers int `json:"offline_servers"`
	WarningServers int `json:"warning_servers"`
	CriticalAlerts int `json:"critical_alerts"`
}

type ServerSummary struct {
	*models.Server
	IsConnected      bool           `json:"is_connected"`
	LatestMetrics    *models.Metric `json:"latest_metrics,omitempty"`
	UnresolvedAlerts []models.Alert `json:"unresolved_alerts,omitempty"`
}

type DashboardResponse struct {
	Summary      DashboardSummary `json:"summary"`
	Servers      []ServerSummary  `json:"servers"`
	RecentAlerts []models.Alert   `json:"recent_alerts"`
	SystemHealth SystemHealth     `json:"system_health"`
}

type SystemHealth struct {
	AverageCPU    float64 `json:"average_cpu"`
	AverageMemory float64 `json:"average_memory"`
	AverageDisk   float64 `json:"average_disk"`
	TotalUptime   int64   `json:"total_uptime"`
}

// GetDashboardData returns comprehensive dashboard data
func (h *DashboardHandler) GetDashboardData(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	// Get user's servers
	servers, err := h.db.GetUserServers(userClaims.UID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get servers"})
		return
	}

	// Initialize response
	response := DashboardResponse{
		Summary: DashboardSummary{
			TotalServers: len(servers),
		},
		Servers:      make([]ServerSummary, 0, len(servers)),
		RecentAlerts: []models.Alert{},
		SystemHealth: SystemHealth{},
	}

	if len(servers) == 0 {
		c.JSON(http.StatusOK, response)
		return
	}

	// Process each server
	var totalCPU, totalMemory, totalDisk float64
	var totalUptime int64
	var metricsCount int

	for _, server := range servers {
		serverSummary := ServerSummary{
			Server:      &server,
			IsConnected: h.ws.IsAgentConnected(server.ID),
		}

		// Count online/offline servers
		if serverSummary.IsConnected {
			response.Summary.OnlineServers++
		} else {
			response.Summary.OfflineServers++
		}

		// Get latest metrics for connected servers
		if serverSummary.IsConnected {
			latestMetrics, err := h.db.GetLatestMetrics(server.ID)
			if err == nil {
				serverSummary.LatestMetrics = latestMetrics

				// Add to system health calculations
				totalCPU += latestMetrics.CPUUsage
				totalMemory += latestMetrics.MemoryPercent
				totalDisk += latestMetrics.DiskPercent
				totalUptime += latestMetrics.Uptime
				metricsCount++

				// Check for warning status
				if latestMetrics.CPUUsage > 80 || latestMetrics.MemoryPercent > 85 || latestMetrics.DiskPercent > 90 {
					response.Summary.WarningServers++
				}
			}
		}

		// Get unresolved alerts
		unresolvedAlerts, err := h.db.GetUnresolvedAlerts(server.ID)
		if err == nil {
			serverSummary.UnresolvedAlerts = unresolvedAlerts

			// Count critical alerts
			for _, alert := range unresolvedAlerts {
				if alert.Level == "critical" {
					response.Summary.CriticalAlerts++
				}
			}
		}

		response.Servers = append(response.Servers, serverSummary)
	}

	// Calculate average system health
	if metricsCount > 0 {
		response.SystemHealth = SystemHealth{
			AverageCPU:    totalCPU / float64(metricsCount),
			AverageMemory: totalMemory / float64(metricsCount),
			AverageDisk:   totalDisk / float64(metricsCount),
			TotalUptime:   totalUptime / int64(metricsCount),
		}
	}

	// Get recent alerts across all servers (last 24 hours)
	serverIDs := make([]uint, len(servers))
	for i, server := range servers {
		serverIDs[i] = server.ID
	}

	var recentAlerts []models.Alert
	err = h.db.DB.Where("server_id IN ? AND created_at > ?", serverIDs, time.Now().Add(-24*time.Hour)).
		Order("created_at DESC").
		Limit(10).
		Preload("Server").
		Find(&recentAlerts).Error
	if err == nil {
		response.RecentAlerts = recentAlerts
	}

	c.JSON(http.StatusOK, response)
}

// GetServerDashboard returns detailed dashboard data for a specific server
func (h *DashboardHandler) GetServerDashboard(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	serverID, err := parseServerID(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid server ID"})
		return
	}

	// Verify server ownership
	server, err := h.validateServerOwnership(serverID, userClaims.UID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Server not found"})
		return
	}

	// Get time range from query params
	hours := parseHours(c.DefaultQuery("hours", "24"))
	since := time.Now().Add(-time.Duration(hours) * time.Hour)

	// Get metrics
	metrics, err := h.db.GetServerMetrics(serverID, since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get metrics"})
		return
	}

	// Get alerts
	alerts, err := h.db.GetServerAlerts(serverID, 50)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get alerts"})
		return
	}

	// Calculate statistics
	stats := calculateMetricsStatistics(metrics)

	response := gin.H{
		"server": gin.H{
			"id":           server.ID,
			"name":         server.Name,
			"status":       server.Status,
			"last_seen":    server.LastSeen,
			"is_connected": h.ws.IsAgentConnected(serverID),
		},
		"metrics":    metrics,
		"alerts":     alerts,
		"statistics": stats,
		"time_range": gin.H{
			"since": since,
			"hours": hours,
		},
	}

	c.JSON(http.StatusOK, response)
}

// GetMetricsChart returns metrics data formatted for charts
func (h *DashboardHandler) GetMetricsChart(c *gin.Context) {
	userClaims, exists := auth.GetUserFromContext(c)
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	serverID, err := parseServerID(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid server ID"})
		return
	}

	// Verify server ownership
	_, err = h.validateServerOwnership(serverID, userClaims.UID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Server not found"})
		return
	}

	// Get parameters
	hours := parseHours(c.DefaultQuery("hours", "24"))
	metricType := c.DefaultQuery("type", "cpu") // cpu, memory, disk, network

	since := time.Now().Add(-time.Duration(hours) * time.Hour)
	metrics, err := h.db.GetServerMetrics(serverID, since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get metrics"})
		return
	}

	// Format data for charts
	chartData := formatChartData(metrics, metricType)

	c.JSON(http.StatusOK, gin.H{
		"type": metricType,
		"data": chartData,
		"time_range": gin.H{
			"since": since,
			"hours": hours,
		},
	})
}

// Helper functions

func parseServerID(param string) (uint, error) {
	// Implementation moved to utils or inline
	// For now, simple conversion
	var id uint
	if _, err := fmt.Sscanf(param, "%d", &id); err != nil {
		return 0, err
	}
	return id, nil
}

func parseHours(param string) int {
	var hours int
	if _, err := fmt.Sscanf(param, "%d", &hours); err != nil || hours < 1 {
		return 24
	}
	if hours > 168 { // Max 1 week
		return 168
	}
	return hours
}

func (h *DashboardHandler) validateServerOwnership(serverID uint, userUID string) (*models.Server, error) {
	// Get user to get internal ID
	user, err := h.db.GetUserByUID(userUID)
	if err != nil {
		return nil, err
	}

	var server models.Server
	err = h.db.DB.Where("id = ? AND user_id = ?", serverID, user.ID).First(&server).Error
	if err != nil {
		return nil, err
	}
	return &server, nil
}

func calculateMetricsStatistics(metrics []models.Metric) map[string]interface{} {
	if len(metrics) == 0 {
		return map[string]interface{}{}
	}

	var totalCPU, totalMemory, totalDisk float64
	var maxCPU, maxMemory, maxDisk float64
	var minCPU, minMemory, minDisk float64 = 100, 100, 100

	for _, metric := range metrics {
		// CPU
		totalCPU += metric.CPUUsage
		if metric.CPUUsage > maxCPU {
			maxCPU = metric.CPUUsage
		}
		if metric.CPUUsage < minCPU {
			minCPU = metric.CPUUsage
		}

		// Memory
		totalMemory += metric.MemoryPercent
		if metric.MemoryPercent > maxMemory {
			maxMemory = metric.MemoryPercent
		}
		if metric.MemoryPercent < minMemory {
			minMemory = metric.MemoryPercent
		}

		// Disk
		totalDisk += metric.DiskPercent
		if metric.DiskPercent > maxDisk {
			maxDisk = metric.DiskPercent
		}
		if metric.DiskPercent < minDisk {
			minDisk = metric.DiskPercent
		}
	}

	count := float64(len(metrics))
	return map[string]interface{}{
		"cpu": map[string]float64{
			"average": totalCPU / count,
			"max":     maxCPU,
			"min":     minCPU,
		},
		"memory": map[string]float64{
			"average": totalMemory / count,
			"max":     maxMemory,
			"min":     minMemory,
		},
		"disk": map[string]float64{
			"average": totalDisk / count,
			"max":     maxDisk,
			"min":     minDisk,
		},
	}
}

func formatChartData(metrics []models.Metric, metricType string) []map[string]interface{} {
	data := make([]map[string]interface{}, len(metrics))

	for i, metric := range metrics {
		point := map[string]interface{}{
			"timestamp": metric.Time,
		}

		switch metricType {
		case "cpu":
			point["value"] = metric.CPUUsage
		case "memory":
			point["value"] = metric.MemoryPercent
		case "disk":
			point["value"] = metric.DiskPercent
		case "network":
			point["bytes_in"] = metric.NetworkBytesIn
			point["bytes_out"] = metric.NetworkBytesOut
		default:
			point["cpu"] = metric.CPUUsage
			point["memory"] = metric.MemoryPercent
			point["disk"] = metric.DiskPercent
		}

		data[i] = point
	}

	return data
}
