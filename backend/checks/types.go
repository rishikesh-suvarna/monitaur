// Package checks runs uptime checks (http, tcp, tls) from the backend: a
// jittered scheduler over a bounded worker pool, SSRF-guarded probes, the
// last 24 h of results per check in memory, and the incident state machine.
// The database sees incident transitions only, plus hourly rollups and daily
// uptime written in the metrics flush window (docs/platform-v2.md 6.3).
package checks

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"
)

// Type is what a check probes.
type Type string

const (
	TypeHTTP Type = "http"
	TypeTCP  Type = "tcp"
	TypeTLS  Type = "tls"
)

func ParseType(s string) (Type, error) {
	switch t := Type(s); t {
	case TypeHTTP, TypeTCP, TypeTLS:
		return t, nil
	default:
		return "", fmt.Errorf("unknown check type %q", s)
	}
}

// Check is the scheduler's copy of a stored check.
type Check struct {
	ID, OrgID    int64
	Name         string
	Type         Type
	Target       string // http: URL; tcp and tls: host:port
	Interval     time.Duration
	Timeout      time.Duration
	ExpectStatus int // http only; 0 means any 2xx or 3xx
	Keyword      string
	TLSWarnDays  int // 0 disables the expiry warning
	Enabled      bool
	ChannelIDs   []int64
}

func (c Check) clone() Check {
	c.ChannelIDs = slices.Clone(c.ChannelIDs)
	return c
}

// Result is the outcome of one probe.
type Result struct {
	At         time.Time
	OK         bool
	Latency    time.Duration
	StatusCode int    // HTTP status of the final response; 0 when none was received
	Error      string // why the probe failed; "" when OK
	// CertDaysLeft is the number of whole days until the leaf certificate
	// expires (negative once expired). Set by tls checks and https checks.
	CertDaysLeft *int
}

// Status is what the API shows per check.
type Status string

const (
	StatusUp       Status = "up"
	StatusDown     Status = "down"
	StatusDegraded Status = "degraded" // a single failure, or a certificate expiring soon
	StatusPaused   Status = "paused"
	StatusPending  Status = "pending" // enabled but not probed yet
)

const (
	// MetricTLSExpiry is the metric of certificate warnings; outage incidents
	// use the check type (http, tcp, tls) as their metric.
	MetricTLSExpiry  = "tls_expiry"
	SeverityCritical = "critical"
	SeverityWarning  = "warning"
	// DownRuleName and ExpiryRuleName fill incidents.rule_name, which the
	// UI shows as what fired.
	DownRuleName   = "Check down"
	ExpiryRuleName = "Certificate expiring"
)

// ResolveHow records why a check incident was closed.
type ResolveHow string

const (
	ResolvedAuto         ResolveHow = "auto"
	ResolvedManual       ResolveHow = "manual"
	ResolvedCheckChanged ResolveHow = "check_changed" // type or target changed: old results no longer apply
	ResolvedCheckPaused  ResolveHow = "check_paused"
)

// Incident is one open outage or certificate warning of a check.
type Incident struct {
	ID          int64
	OrgID       int64
	CheckID     int64
	RuleName    string
	Metric      string
	Severity    string
	Threshold   float64 // failures to open, or tls_warn_days
	Peak        float64 // most consecutive failures, or fewest days left
	LastValue   float64 // current consecutive failures, or days left
	SamplesOver int     // failed probes, or probes inside the warning window
	StartedAt   time.Time
}

// HourRollup is one hour of results. Latency covers successful probes only
// (OK of them), so a refused connection does not look fast.
type HourRollup struct {
	CheckID      int64
	Start        time.Time
	Total, OK    int
	LatencyAvgMS float32
	LatencyMaxMS float32
}

// DayRollup is one UTC day of results, for status page bars.
type DayRollup struct {
	CheckID   int64
	Day       time.Time
	Total, OK int
}

// Store persists what the scheduler cannot keep in memory. Incident methods
// are called on transitions only; rollups and progress in the flush window.
type Store interface {
	OpenIncident(ctx context.Context, inc Incident) (int64, error)
	ResolveIncident(ctx context.Context, id int64, at time.Time, how ResolveHow, peak float64, samplesOver int) error
	SaveProgress(ctx context.Context, id int64, peak, lastValue float64, samplesOver int) error
	LoadOpenIncidents(ctx context.Context) ([]Incident, error)
	// WriteRollups merges deltas into existing rows (a bucket written twice
	// adds up), so the scheduler can flush partial hours and days.
	WriteRollups(ctx context.Context, hours []HourRollup, days []DayRollup) error
	ReadHours(ctx context.Context, checkID int64, from, to time.Time) ([]HourRollup, error)
	// RecentHours returns every check's hours since a time, to seed the 24 h
	// view after a restart.
	RecentHours(ctx context.Context, since time.Time) ([]HourRollup, error)
}

type EventKind string

const (
	EventFired    EventKind = "fired"
	EventResolved EventKind = "resolved"
)

// Event is handed to the Notifier after the matching store write succeeded.
type Event struct {
	Kind     EventKind
	Check    Check
	Incident Incident
	Result   Result     // the probe behind the transition; zero for manual resolves
	How      ResolveHow // resolved events only
	At       time.Time
}

// Notifier delivers events. Notify must not block: it runs on probe workers.
type Notifier interface {
	Notify(ctx context.Context, ev Event)
}

// ErrNotFound is returned for a check or incident the scheduler does not hold.
var ErrNotFound = errors.New("checks: not found")

// Range is a results history window.
type Range string

const (
	Range24h Range = "24h" // memory, 15 min steps
	Range7d  Range = "7d"  // hourly rollups + unflushed memory, 1 h steps
	Range30d Range = "30d" // hourly rollups + unflushed memory, 2 h steps
)

func ParseRange(s string) (Range, error) {
	switch r := Range(s); r {
	case Range24h, Range7d, Range30d:
		return r, nil
	default:
		return "", fmt.Errorf("unknown range %q", s)
	}
}

// Point is one step of a results series; fields are nil when the step has
// no probes (latency: no successful probes).
type Point struct {
	T          time.Time `json:"t"`
	UpPct      *float64  `json:"up_pct"`
	LatencyAvg *float64  `json:"latency_avg"`
	LatencyMax *float64  `json:"latency_max"`
}

type Series struct {
	Range       Range   `json:"range"`
	StepSeconds int     `json:"step_seconds"`
	Points      []Point `json:"points"`
}

// Snapshot is the live state of one check, served from memory.
type Snapshot struct {
	Status        Status
	Last          *Result
	Uptime24h     *float64
	LatencySpark  []float64 // last 30 results, ms, oldest first
	TLSDaysLeft   *int
	OpenIncidents int
}
