package metrics

import (
	"fmt"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
)

type SystemMetrics struct {
	Timestamp  time.Time `json:"timestamp"`
	ServerName string    `json:"server_name"`
	CPU        CPUInfo   `json:"cpu"`
	Memory     MemInfo   `json:"memory"`
	Disk       DiskInfo  `json:"disk"`
	Network    NetInfo   `json:"network"`
	Uptime     int64     `json:"uptime"`
}

type CPUInfo struct {
	Usage float64 `json:"usage"`
	Cores int     `json:"cores"`
}

type MemInfo struct {
	Total       uint64  `json:"total"`
	Available   uint64  `json:"available"`
	Used        uint64  `json:"used"`
	UsedPercent float64 `json:"used_percent"`
}

type DiskInfo struct {
	Total       uint64  `json:"total"`
	Free        uint64  `json:"free"`
	Used        uint64  `json:"used"`
	UsedPercent float64 `json:"used_percent"`
}

type NetInfo struct {
	BytesSent   uint64 `json:"bytes_sent"`
	BytesRecv   uint64 `json:"bytes_recv"`
	PacketsSent uint64 `json:"packets_sent"`
	PacketsRecv uint64 `json:"packets_recv"`
}

type Collector struct {
	serverName string
	startTime  time.Time
}

func NewCollector(serverName string) *Collector {
	return &Collector{
		serverName: serverName,
		startTime:  time.Now(),
	}
}

func (c *Collector) CollectMetrics() (*SystemMetrics, error) {
	metrics := &SystemMetrics{
		Timestamp:  time.Now(),
		ServerName: c.serverName,
		Uptime:     int64(time.Since(c.startTime).Seconds()),
	}

	// CPU metrics
	cpuPercent, err := cpu.Percent(time.Second, false)
	if err != nil {
		return nil, err
	}
	metrics.CPU = CPUInfo{
		Usage: cpuPercent[0],
		Cores: runtime.NumCPU(),
	}

	// Memory metrics
	memInfo, err := mem.VirtualMemory()
	if err != nil {
		return nil, err
	}
	metrics.Memory = MemInfo{
		Total:       memInfo.Total,
		Available:   memInfo.Available,
		Used:        memInfo.Used,
		UsedPercent: memInfo.UsedPercent,
	}

	// Disk metrics (root partition)
	diskInfo, err := disk.Usage("/")
	if err != nil {
		return nil, err
	}
	metrics.Disk = DiskInfo{
		Total:       diskInfo.Total,
		Free:        diskInfo.Free,
		Used:        diskInfo.Used,
		UsedPercent: diskInfo.UsedPercent,
	}

	// Network metrics
	netStats, err := net.IOCounters(false)
	if err != nil {
		return nil, err
	}
	if len(netStats) > 0 {
		metrics.Network = NetInfo{
			BytesSent:   netStats[0].BytesSent,
			BytesRecv:   netStats[0].BytesRecv,
			PacketsSent: netStats[0].PacketsSent,
			PacketsRecv: netStats[0].PacketsRecv,
		}
	}

	return metrics, nil
}

// CheckAlerts checks if any metrics exceed thresholds
func (c *Collector) CheckAlerts(metrics *SystemMetrics, thresholds AlertThresholds) []Alert {
	var alerts []Alert

	if metrics.CPU.Usage > thresholds.CPU {
		alerts = append(alerts, Alert{
			Type:      "cpu",
			Level:     "warning",
			Message:   fmt.Sprintf("CPU usage is %.1f%% (threshold: %.1f%%)", metrics.CPU.Usage, thresholds.CPU),
			Value:     metrics.CPU.Usage,
			Threshold: thresholds.CPU,
			Timestamp: metrics.Timestamp,
		})
	}

	if metrics.Memory.UsedPercent > thresholds.Memory {
		alerts = append(alerts, Alert{
			Type:      "memory",
			Level:     "warning",
			Message:   fmt.Sprintf("Memory usage is %.1f%% (threshold: %.1f%%)", metrics.Memory.UsedPercent, thresholds.Memory),
			Value:     metrics.Memory.UsedPercent,
			Threshold: thresholds.Memory,
			Timestamp: metrics.Timestamp,
		})
	}

	if metrics.Disk.UsedPercent > thresholds.Disk {
		alerts = append(alerts, Alert{
			Type:      "disk",
			Level:     "warning",
			Message:   fmt.Sprintf("Disk usage is %.1f%% (threshold: %.1f%%)", metrics.Disk.UsedPercent, thresholds.Disk),
			Value:     metrics.Disk.UsedPercent,
			Threshold: thresholds.Disk,
			Timestamp: metrics.Timestamp,
		})
	}

	return alerts
}

type AlertThresholds struct {
	CPU    float64 `json:"cpu"`
	Memory float64 `json:"memory"`
	Disk   float64 `json:"disk"`
}

type Alert struct {
	Type      string    `json:"type"`
	Level     string    `json:"level"`
	Message   string    `json:"message"`
	Value     float64   `json:"value"`
	Threshold float64   `json:"threshold"`
	Timestamp time.Time `json:"timestamp"`
}
