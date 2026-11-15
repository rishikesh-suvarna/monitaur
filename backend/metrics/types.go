// Package metrics holds per-server metric state in memory and writes 1-minute
// and 1-hour rollups to the database in batches (PLAN.md 2.3, B2 write-behind).
// This file defines the shared types; the Store lives in store.go.
package metrics

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type Resolution int

const (
	Minute Resolution = iota + 1
	Hour
)

func (r Resolution) Duration() time.Duration {
	switch r {
	case Minute:
		return time.Minute
	case Hour:
		return time.Hour
	default:
		return 0
	}
}

// Sample is one validated agent reading. Network values are cumulative counters.
type Sample struct {
	Time           time.Time
	CPUPercent     float64
	CPUCores       int
	MemTotalBytes  uint64
	MemUsedBytes   uint64
	MemPercent     float64
	DiskTotalBytes uint64
	DiskUsedBytes  uint64
	DiskPercent    float64
	NetRxTotal     uint64
	NetTxTotal     uint64
	UptimeSeconds  int64
}

// Point is the derived value kept in memory and fed to alerting and live views.
// Net rates are bytes/second from counter deltas, clamped to 0 on counter reset.
type Point struct {
	Time      time.Time
	CPU       float32
	Mem       float32
	Disk      float32
	NetInBps  float32
	NetOutBps float32
}

// Latest is the most recent point plus the absolute values from that sample.
type Latest struct {
	Point
	CPUCores       int
	MemTotalBytes  uint64
	MemUsedBytes   uint64
	DiskTotalBytes uint64
	DiskUsedBytes  uint64
	UptimeSeconds  int64
	ReceivedAt     time.Time
}

// Bucket is a closed rollup. Start is truncated to the minute or hour (UTC).
type Bucket struct {
	ServerID       int64      `json:"server_id"`
	Res            Resolution `json:"res"`
	Start          time.Time  `json:"start"`
	Samples        int        `json:"samples"`
	CPUAvg         float32    `json:"cpu_avg"`
	CPUMax         float32    `json:"cpu_max"`
	MemAvg         float32    `json:"mem_avg"`
	MemMax         float32    `json:"mem_max"`
	DiskAvg        float32    `json:"disk_avg"`
	NetInAvg       float32    `json:"net_in_avg"`
	NetInMax       float32    `json:"net_in_max"`
	NetOutAvg      float32    `json:"net_out_avg"`
	NetOutMax      float32    `json:"net_out_max"`
	MemTotalBytes  uint64     `json:"mem_total"`
	DiskTotalBytes uint64     `json:"disk_total"`
	DiskUsedBytes  uint64     `json:"disk_used"`
	UptimeSeconds  int64      `json:"uptime_s"`
}

// Sink persists closed buckets.
type Sink interface {
	// WriteBuckets must be idempotent (ON CONFLICT DO NOTHING on (server_id, bucket)).
	WriteBuckets(ctx context.Context, buckets []Bucket) error
}

// History reads persisted buckets for ranges not held in memory.
type History interface {
	ReadBuckets(ctx context.Context, serverID int64, res Resolution, from, to time.Time) ([]Bucket, error)
}

type Range string

const (
	RangeLive Range = "live" // last 15 min, raw, 5 s step
	Range1h   Range = "1h"   // raw ring, 10 s step
	Range6h   Range = "6h"   // recent ring, 1 m step
	Range24h  Range = "24h"  // recent ring, 4 m step
	Range7d   Range = "7d"   // history (hour) + current hour from memory, 1 h step
	Range30d  Range = "30d"  // history (hour), 2 h step
)

var ErrUnknownRange = errors.New("unknown range")

func ParseRange(s string) (Range, error) {
	switch r := Range(s); r {
	case RangeLive, Range1h, Range6h, Range24h, Range7d, Range30d:
		return r, nil
	default:
		return "", fmt.Errorf("%w: %q", ErrUnknownRange, s)
	}
}

// SeriesPoint fields are nil for a gap (no samples in that step).
type SeriesPoint struct {
	T         time.Time `json:"t"`
	CPU       *float32  `json:"cpu"`
	Mem       *float32  `json:"mem"`
	Disk      *float32  `json:"disk"`
	NetInBps  *float32  `json:"net_in"`
	NetOutBps *float32  `json:"net_out"`
}

type Stat struct {
	Min float32 `json:"min"`
	Avg float32 `json:"avg"`
	Max float32 `json:"max"`
	Now float32 `json:"now"`
}

// Series keys for Stats.
const (
	SeriesCPU    = "cpu"
	SeriesMem    = "mem"
	SeriesDisk   = "disk"
	SeriesNetIn  = "net_in"
	SeriesNetOut = "net_out"
)

type Series struct {
	Range       Range           `json:"range"`
	StepSeconds int             `json:"step_seconds"`
	From        time.Time       `json:"from"`
	To          time.Time       `json:"to"`
	Points      []SeriesPoint   `json:"points"`
	Stats       map[string]Stat `json:"stats"`
}

var ErrTooFrequent = errors.New("sample arrived faster than the minimum interval")
