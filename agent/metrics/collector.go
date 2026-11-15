package metrics

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

const (
	// cpuSampleWindow is how long CPU usage is measured for each sample.
	cpuSampleWindow = time.Second

	// Bounds the backend enforces too (docs/platform-v2.md 6.1).
	MaxMounts     = 16
	MaxInterfaces = 16
)

type SystemMetrics struct {
	Timestamp  time.Time `json:"timestamp"`
	ServerName string    `json:"server_name"`
	CPU        CPUInfo   `json:"cpu"`
	Memory     MemInfo   `json:"memory"`
	Disk       DiskInfo  `json:"disk"`
	Network    NetInfo   `json:"network"`
	Uptime     int64     `json:"uptime"`

	// Host metrics added in F6. Each is omitted when the platform cannot
	// report it, so the backend shows null instead of a made-up 0.
	Load       *LoadInfo   `json:"load,omitempty"`
	Swap       *SwapInfo   `json:"swap,omitempty"`
	DiskIO     *DiskIOInfo `json:"disk_io,omitempty"`
	Mounts     []MountInfo `json:"mounts,omitempty"`
	Interfaces []IfaceInfo `json:"interfaces,omitempty"`
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

type LoadInfo struct {
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`
}

type SwapInfo struct {
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	UsedPercent float64 `json:"used_percent"`
}

// DiskIOInfo holds cumulative byte counters summed over physical disks; the
// backend turns them into rates.
type DiskIOInfo struct {
	ReadBytes  uint64 `json:"read_bytes"`
	WriteBytes uint64 `json:"write_bytes"`
}

type MountInfo struct {
	Path        string  `json:"path"`
	FSType      string  `json:"fstype"`
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	UsedPercent float64 `json:"used_percent"`
}

// IfaceInfo holds one interface's cumulative byte counters.
type IfaceInfo struct {
	Name      string `json:"name"`
	BytesSent uint64 `json:"bytes_sent"`
	BytesRecv uint64 `json:"bytes_recv"`
}

type Collector struct {
	serverName string

	// warned remembers which optional sources already logged a failure, so
	// a platform without (say) disk IO counters logs once, not every sample.
	warnMu sync.Mutex
	warned map[string]bool
}

func NewCollector(serverName string) *Collector {
	return &Collector{
		serverName: serverName,
		warned:     make(map[string]bool),
	}
}

// CollectMetrics takes one sample. ctx must live as long as the agent: on
// Windows gopsutil starts its load-average sampler with the first ctx it is
// given and stops it when that ctx ends.
func (c *Collector) CollectMetrics(ctx context.Context) (*SystemMetrics, error) {
	metrics := &SystemMetrics{
		Timestamp:  time.Now(),
		ServerName: c.serverName,
	}

	// Host uptime, not agent process uptime: an agent restart must not look
	// like a reboot on the dashboard.
	uptimeSeconds, err := host.UptimeWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("host uptime: %w", err)
	}
	metrics.Uptime = int64(uptimeSeconds)

	cpuPercent, err := cpu.PercentWithContext(ctx, cpuSampleWindow, false)
	if err != nil {
		return nil, fmt.Errorf("cpu percent: %w", err)
	}
	if len(cpuPercent) == 0 {
		return nil, fmt.Errorf("cpu percent: no value")
	}
	metrics.CPU = CPUInfo{
		Usage: cpuPercent[0],
		Cores: runtime.NumCPU(),
	}

	memInfo, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}
	metrics.Memory = MemInfo{
		Total:       memInfo.Total,
		Available:   memInfo.Available,
		Used:        memInfo.Used,
		UsedPercent: memInfo.UsedPercent,
	}

	// Disk metrics (root partition)
	diskInfo, err := disk.UsageWithContext(ctx, "/")
	if err != nil {
		return nil, fmt.Errorf("root disk usage: %w", err)
	}
	metrics.Disk = DiskInfo{
		Total:       diskInfo.Total,
		Free:        diskInfo.Free,
		Used:        diskInfo.Used,
		UsedPercent: diskInfo.UsedPercent,
	}

	// One per-interface read feeds both the host total and the interface
	// list. The total sums every interface, loopback included, exactly as
	// IOCounters(false) does, so existing charts keep their meaning.
	nics, err := net.IOCountersWithContext(ctx, true)
	if err != nil {
		return nil, fmt.Errorf("network counters: %w", err)
	}
	for _, n := range nics {
		metrics.Network.BytesSent += n.BytesSent
		metrics.Network.BytesRecv += n.BytesRecv
		metrics.Network.PacketsSent += n.PacketsSent
		metrics.Network.PacketsRecv += n.PacketsRecv
	}
	metrics.Interfaces = selectInterfaces(nics, MaxInterfaces)

	c.collectExtended(ctx, metrics)
	return metrics, nil
}

// collectExtended fills the optional F6 fields. A source that fails is left
// out of this sample (and logged once) instead of failing the whole sample.
func (c *Collector) collectExtended(ctx context.Context, m *SystemMetrics) {
	if avg, err := load.AvgWithContext(ctx); err != nil {
		c.warnOnce("load average", err)
	} else {
		m.Load = &LoadInfo{Load1: avg.Load1, Load5: avg.Load5, Load15: avg.Load15}
	}

	if swap, err := mem.SwapMemoryWithContext(ctx); err != nil {
		c.warnOnce("swap", err)
	} else {
		m.Swap = &SwapInfo{Total: swap.Total, Used: swap.Used, UsedPercent: swap.UsedPercent}
	}

	if counters, err := disk.IOCountersWithContext(ctx); err != nil {
		c.warnOnce("disk IO counters", err)
	} else {
		io := sumPhysicalDiskIO(counters)
		m.DiskIO = &io
	}

	if parts, err := disk.PartitionsWithContext(ctx, false); err != nil {
		c.warnOnce("mounts", err)
	} else {
		for _, p := range selectMounts(parts, MaxMounts) {
			usage, err := disk.UsageWithContext(ctx, p.Mountpoint)
			if err != nil {
				continue // unmounted between the two calls, or not readable
			}
			m.Mounts = append(m.Mounts, MountInfo{
				Path: p.Mountpoint, FSType: p.Fstype, Total: usage.Total, Used: usage.Used, UsedPercent: usage.UsedPercent,
			})
		}
	}
}

func (c *Collector) warnOnce(source string, err error) {
	c.warnMu.Lock()
	defer c.warnMu.Unlock()
	if c.warned[source] {
		return
	}
	c.warned[source] = true
	log.Printf("Skipping %s: %v (not reported again)", source, err)
}

var (
	// Block devices that are not physical disks, or that sit on top of
	// physical disks and would count the same IO twice.
	virtualDiskPrefixes = []string{"loop", "ram", "zram", "dm-", "md", "sr", "fd", "nbd"}
	// Partitions of a disk listed on its own: sda1, vdb2, xvda1, hdc3 and
	// nvme0n1p1, mmcblk0p2.
	partitionName = regexp.MustCompile(`^(?:(?:s|h|v|xv)d[a-z]+\d+|(?:nvme\d+n\d+|mmcblk\d+)p\d+)$`)
)

// isPhysicalDisk reports whether an IO counter belongs to a whole physical
// disk. Linux lists partitions and virtual devices next to the disks they
// live on; other platforms (Windows drive letters, macOS disks) pass.
func isPhysicalDisk(name string) bool {
	for _, p := range virtualDiskPrefixes {
		if strings.HasPrefix(name, p) {
			return false
		}
	}
	return !partitionName.MatchString(name)
}

func sumPhysicalDiskIO(counters map[string]disk.IOCountersStat) DiskIOInfo {
	var out DiskIOInfo
	for name, c := range counters {
		if !isPhysicalDisk(name) {
			continue
		}
		out.ReadBytes += c.ReadBytes
		out.WriteBytes += c.WriteBytes
	}
	return out
}

// physicalFSTypes are filesystems backed by local storage. Anything else
// (tmpfs, overlay, squashfs, proc, network filesystems) is left out of the
// mount list. Lower case; Windows reports NTFS, ReFS, FAT32 and exFAT.
var physicalFSTypes = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true, "f2fs": true,
	"jfs": true, "reiserfs": true, "bcachefs": true, "vfat": true, "exfat": true, "ntfs": true, "ntfs3": true,
	"fuseblk": true, "hfs": true, "hfsplus": true, "apfs": true, "ufs": true,
	"refs": true, "fat": true, "fat32": true,
}

// selectMounts keeps physical filesystems, one mount per device (bind
// mounts and subvolumes of one filesystem report the same usage), in the
// platform's order, at most limit.
func selectMounts(parts []disk.PartitionStat, limit int) []disk.PartitionStat {
	var out []disk.PartitionStat
	seen := make(map[string]bool)
	for _, p := range parts {
		if len(out) == limit {
			break
		}
		if !physicalFSTypes[strings.ToLower(p.Fstype)] || seen[p.Device] {
			continue
		}
		seen[p.Device] = true
		out = append(out, p)
	}
	return out
}

// loopbackName matches loopback interfaces: lo (Linux), lo0 (BSD, macOS),
// "Loopback Pseudo-Interface 1" (Windows).
var loopbackName = regexp.MustCompile(`(?i)^(?:lo\d*|loopback.*)$`)

// selectInterfaces drops loopback and keeps the limit busiest interfaces,
// so a Docker host with dozens of veth pairs still lists eth0. The result
// is sorted by name for a stable display.
func selectInterfaces(nics []net.IOCountersStat, limit int) []IfaceInfo {
	out := make([]IfaceInfo, 0, min(len(nics), limit))
	for _, n := range nics {
		if loopbackName.MatchString(n.Name) {
			continue
		}
		out = append(out, IfaceInfo{Name: n.Name, BytesSent: n.BytesSent, BytesRecv: n.BytesRecv})
	}
	if len(out) > limit {
		slices.SortStableFunc(out, func(a, b IfaceInfo) int {
			at, bt := a.BytesSent+a.BytesRecv, b.BytesSent+b.BytesRecv
			switch {
			case at > bt:
				return -1
			case at < bt:
				return 1
			default:
				return strings.Compare(a.Name, b.Name)
			}
		})
		out = out[:limit]
	}
	slices.SortFunc(out, func(a, b IfaceInfo) int { return strings.Compare(a.Name, b.Name) })
	return out
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
