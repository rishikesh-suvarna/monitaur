package models

import (
	"time"
)

// User represents a user account (minimal, Firebase handles auth)
type User struct {
	ID          uint      `json:"id" gorm:"primaryKey"`
	FirebaseUID string    `json:"firebase_uid" gorm:"unique;not null;index"`
	Email       string    `json:"email" gorm:"not null"`
	CreatedAt   time.Time `json:"created_at" gorm:"default:CURRENT_TIMESTAMP"`
	UpdatedAt   time.Time `json:"updated_at"`

	// Relationships
	Servers []Server `json:"servers,omitempty" gorm:"foreignKey:UserID"`
}

// Server represents a monitored server
type Server struct {
	ID        uint       `json:"id" gorm:"primaryKey"`
	UserID    uint       `json:"user_id" gorm:"not null;index"`
	Token     string     `json:"token" gorm:"unique;not null"`
	Name      string     `json:"name" gorm:"not null"`
	LastSeen  *time.Time `json:"last_seen"`
	Status    string     `json:"status" gorm:"default:'offline'"` // online, offline, warning
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`

	// Relationships
	User    User     `json:"user,omitempty" gorm:"foreignKey:UserID"`
	Metrics []Metric `json:"metrics,omitempty" gorm:"foreignKey:ServerID"`
	Alerts  []Alert  `json:"alerts,omitempty" gorm:"foreignKey:ServerID"`
}

// Metric represents system metrics at a point in time
type Metric struct {
	ID       uint      `json:"id" gorm:"primaryKey"`
	Time     time.Time `json:"time" gorm:"not null;index"`
	ServerID uint      `json:"server_id" gorm:"not null;index"`

	// CPU metrics
	CPUUsage float64 `json:"cpu_usage"`
	CPUCores int     `json:"cpu_cores"`

	// Memory metrics
	MemoryTotal     uint64  `json:"memory_total"`
	MemoryUsed      uint64  `json:"memory_used"`
	MemoryAvailable uint64  `json:"memory_available"`
	MemoryPercent   float64 `json:"memory_percent"`

	// Disk metrics
	DiskTotal   uint64  `json:"disk_total"`
	DiskUsed    uint64  `json:"disk_used"`
	DiskFree    uint64  `json:"disk_free"`
	DiskPercent float64 `json:"disk_percent"`

	// Network metrics
	NetworkBytesIn  uint64 `json:"network_bytes_in"`
	NetworkBytesOut uint64 `json:"network_bytes_out"`

	// System info
	Uptime int64 `json:"uptime"`

	// Relationships
	Server Server `json:"server,omitempty" gorm:"foreignKey:ServerID"`
}

// Alert represents system alerts
type Alert struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	ServerID  uint      `json:"server_id" gorm:"not null;index"`
	Type      string    `json:"type" gorm:"not null"`  // cpu, memory, disk, network
	Level     string    `json:"level" gorm:"not null"` // warning, critical
	Message   string    `json:"message" gorm:"not null"`
	Value     float64   `json:"value"`
	Threshold float64   `json:"threshold"`
	Resolved  bool      `json:"resolved" gorm:"default:false"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// Relationships
	Server Server `json:"server,omitempty" gorm:"foreignKey:ServerID"`
}

// AgentMessage represents WebSocket messages from agents
type AgentMessage struct {
	Type       string      `json:"type"`
	Token      string      `json:"token"`
	ServerName string      `json:"server_name"`
	Data       interface{} `json:"data"`
	Timestamp  time.Time   `json:"timestamp"`
}

// MetricData represents the metrics data structure from agents
type MetricData struct {
	Timestamp  time.Time `json:"timestamp"`
	ServerName string    `json:"server_name"`
	CPU        struct {
		Usage float64 `json:"usage"`
		Cores int     `json:"cores"`
	} `json:"cpu"`
	Memory struct {
		Total       uint64  `json:"total"`
		Available   uint64  `json:"available"`
		Used        uint64  `json:"used"`
		UsedPercent float64 `json:"used_percent"`
	} `json:"memory"`
	Disk struct {
		Total       uint64  `json:"total"`
		Free        uint64  `json:"free"`
		Used        uint64  `json:"used"`
		UsedPercent float64 `json:"used_percent"`
	} `json:"disk"`
	Network struct {
		BytesSent   uint64 `json:"bytes_sent"`
		BytesRecv   uint64 `json:"bytes_recv"`
		PacketsSent uint64 `json:"packets_sent"`
		PacketsRecv uint64 `json:"packets_recv"`
	} `json:"network"`
	Uptime int64 `json:"uptime"`
}

// AlertData represents alert data from agents
type AlertData struct {
	Type      string    `json:"type"`
	Level     string    `json:"level"`
	Message   string    `json:"message"`
	Value     float64   `json:"value"`
	Threshold float64   `json:"threshold"`
	Timestamp time.Time `json:"timestamp"`
}

// TableName methods for custom table names
func (User) TableName() string {
	return "users"
}

func (Server) TableName() string {
	return "servers"
}

func (Metric) TableName() string {
	return "metrics"
}

func (Alert) TableName() string {
	return "alerts"
}
