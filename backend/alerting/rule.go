// Package alerting evaluates alert rules against live metrics on the server
// and tracks one incident per (rule, server) through a small state machine.
//
// It replaces the agent-side alerts that re-sent the same alert every 5 s
// while a host stayed over a threshold (PLAN.md 2.2 item 2). The store is
// written only on state transitions; peaks and counters of open incidents are
// persisted from the metrics flush window through Engine.SaveProgress.
package alerting

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"backend/metrics"
)

// Metric is the value a rule watches.
type Metric string

const (
	MetricCPU       Metric = "cpu"       // percent
	MetricMemory    Metric = "memory"    // percent
	MetricDisk      Metric = "disk"      // percent
	MetricNetIn     Metric = "net_in"    // bytes/s
	MetricNetOut    Metric = "net_out"   // bytes/s
	MetricHeartbeat Metric = "heartbeat" // seconds since the last heartbeat
	// F6 metrics, only reported by newer agents. Points and buckets without
	// extended values are skipped for these, so an older agent neither
	// breaches nor recovers them.
	MetricLoad1 Metric = "load1" // 1-minute load average, absolute
	MetricSwap  Metric = "swap"  // percent
)

func (m Metric) valid() bool {
	switch m {
	case MetricCPU, MetricMemory, MetricDisk, MetricNetIn, MetricNetOut, MetricHeartbeat, MetricLoad1, MetricSwap:
		return true
	default:
		return false
	}
}

func (m Metric) percent() bool {
	return m == MetricCPU || m == MetricMemory || m == MetricDisk || m == MetricSwap
}

// extended reports whether only F6 agents report the metric.
func (m Metric) extended() bool {
	return m == MetricLoad1 || m == MetricSwap
}

// Comparison is how a value is compared with a rule's threshold.
type Comparison string

const (
	Above Comparison = "above" // breach when value > threshold
	Below Comparison = "below" // breach when value < threshold
)

// Severity ranks incidents; critical is worse than warning.
type Severity string

const (
	Warning  Severity = "warning"
	Critical Severity = "critical"
)

const (
	rankNone = iota
	rankWarning
	rankCritical
)

func (s Severity) rank() int {
	switch s {
	case Critical:
		return rankCritical
	case Warning:
		return rankWarning
	default:
		return rankNone
	}
}

// Scope selects the servers a rule applies to. A server matches when All is
// set, its ID is listed, or any of its tags is listed (case-insensitive).
type Scope struct {
	All       bool
	ServerIDs []int64
	Tags      []string
}

func (s Scope) clone() Scope {
	return Scope{All: s.All, ServerIDs: slices.Clone(s.ServerIDs), Tags: slices.Clone(s.Tags)}
}

// equal compares scopes as sets, so reordering IDs or changing tag case in an
// edit does not count as a condition change.
func (s Scope) equal(o Scope) bool {
	if s.All != o.All {
		return false
	}
	if s.All {
		return true
	}
	return sameSet(s.ServerIDs, o.ServerIDs, func(id int64) int64 { return id }) &&
		sameSet(s.Tags, o.Tags, strings.ToLower)
}

func sameSet[T any, K comparable](a, b []T, key func(T) K) bool {
	sa := make(map[K]struct{}, len(a))
	for _, v := range a {
		sa[key(v)] = struct{}{}
	}
	sb := make(map[K]struct{}, len(b))
	for _, v := range b {
		sb[key(v)] = struct{}{}
	}
	if len(sa) != len(sb) {
		return false
	}
	for k := range sa {
		if _, ok := sb[k]; !ok {
			return false
		}
	}
	return true
}

// Rule is one alert condition owned by an org.
type Rule struct {
	ID, OrgID   int64
	Name        string
	Enabled     bool
	Scope       Scope
	Metric      Metric
	Comparison  Comparison // ignored for heartbeat ("is missing")
	Threshold   float64    // percent for cpu/mem/disk/swap, bytes/s for net, absolute for load1; ignored for heartbeat
	For         time.Duration
	Severity    Severity
	ChannelIDs  []int64
	Cooldown    time.Duration // re-notify interval while firing and not acked; 0 = never
	AutoResolve time.Duration // must be under threshold this long before resolving; 0 = immediately
}

// ServerInfo is what the engine needs to know about a monitored server.
type ServerInfo struct {
	ID, OrgID int64
	Name      string
	Tags      []string
}

func (s ServerInfo) clone() ServerInfo {
	s.Tags = slices.Clone(s.Tags)
	return s
}

const (
	maxRuleNameRunes    = 80
	minPercentThreshold = 0.0
	maxPercentThreshold = 100.0
	minRateThreshold    = 0.0
	minLoadThreshold    = 0.0 // load has no upper bound: it scales with cores
	maxRuleDuration     = 24 * time.Hour

	// minHeartbeatFor keeps heartbeat rules well above the agent send
	// interval (5 s default, 10 s minimum on the free plan) and the 5 s Tick.
	// A shorter window pages on every slow sample, and For == 0 would fire
	// on every Tick and resolve on every Heartbeat.
	minHeartbeatFor = 30 * time.Second
)

// Validate reports the first problem that would stop the rule from being
// evaluated sensibly. The error text is meant to be shown to the user.
func (r Rule) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return errors.New("rule name is required")
	}
	if n := utf8.RuneCountInString(r.Name); n > maxRuleNameRunes {
		return fmt.Errorf("rule name is %d characters, the maximum is %d", n, maxRuleNameRunes)
	}
	if !r.Metric.valid() {
		return fmt.Errorf("unknown metric %q: want cpu, memory, disk, swap, load1, net_in, net_out or heartbeat", r.Metric)
	}
	if r.Severity != Warning && r.Severity != Critical {
		return fmt.Errorf("unknown severity %q: want warning or critical", r.Severity)
	}
	if err := r.validateCondition(); err != nil {
		return err
	}
	durations := []struct {
		name string
		d    time.Duration
	}{
		{"duration (for)", r.For},
		{"cooldown", r.Cooldown},
		{"auto-resolve delay", r.AutoResolve},
	}
	for _, f := range durations {
		if f.d < 0 || f.d > maxRuleDuration {
			return fmt.Errorf("%s must be between 0s and %s, got %s", f.name, maxRuleDuration, f.d)
		}
	}
	return nil
}

func (r Rule) validateCondition() error {
	if r.Metric == MetricHeartbeat {
		if r.For < minHeartbeatFor {
			return fmt.Errorf("heartbeat rules need a duration (for) of at least %s, got %s", minHeartbeatFor, r.For)
		}
		return nil
	}
	if r.Comparison != Above && r.Comparison != Below {
		return fmt.Errorf("unknown comparison %q: want above or below", r.Comparison)
	}
	if math.IsNaN(r.Threshold) || math.IsInf(r.Threshold, 0) {
		return fmt.Errorf("%s threshold must be a finite number", r.Metric)
	}
	if r.Metric.percent() {
		if r.Threshold < minPercentThreshold || r.Threshold > maxPercentThreshold {
			return fmt.Errorf("%s threshold must be between %g and %g percent, got %g",
				r.Metric, minPercentThreshold, maxPercentThreshold, r.Threshold)
		}
		return nil
	}
	if r.Metric == MetricLoad1 {
		if r.Threshold < minLoadThreshold {
			return fmt.Errorf("%s threshold must be %g or more, got %g", r.Metric, minLoadThreshold, r.Threshold)
		}
		return nil
	}
	if r.Threshold < minRateThreshold {
		return fmt.Errorf("%s threshold must be %g bytes/s or more, got %g", r.Metric, minRateThreshold, r.Threshold)
	}
	return nil
}

// Matches reports whether the rule applies to the server. A rule never
// matches a server of another org, whatever its scope lists, so a stray
// server ID in a scope cannot cross tenants.
func (r Rule) Matches(s ServerInfo) bool {
	if r.OrgID != s.OrgID {
		return false
	}
	if r.Scope.All || slices.Contains(r.Scope.ServerIDs, s.ID) {
		return true
	}
	for _, want := range r.Scope.Tags {
		for _, have := range s.Tags {
			if strings.EqualFold(want, have) {
				return true
			}
		}
	}
	return false
}

func (r Rule) clone() Rule {
	r.Scope = r.Scope.clone()
	r.ChannelIDs = slices.Clone(r.ChannelIDs)
	return r
}

// sameCondition reports whether two versions of a rule evaluate the same way.
// Name, channels, cooldown and auto-resolve are left out on purpose: editing
// them must not reset open incidents.
func (r Rule) sameCondition(o Rule) bool {
	if r.Metric != o.Metric || r.For != o.For || r.Severity != o.Severity || !r.Scope.equal(o.Scope) {
		return false
	}
	if r.Metric == MetricHeartbeat {
		return true // comparison and threshold are ignored for heartbeat
	}
	return r.Comparison == o.Comparison && r.Threshold == o.Threshold
}

func (r Rule) breached(v float64) bool {
	switch r.Comparison {
	case Above:
		return v > r.Threshold
	case Below:
		return v < r.Threshold
	default:
		return false
	}
}

// worse returns the more extreme of two breaching values: the highest for an
// above rule, the lowest for a below rule.
func (r Rule) worse(a, b float64) float64 {
	if r.Comparison == Below {
		return min(a, b)
	}
	return max(a, b)
}

// incidentThreshold is the threshold recorded on an incident. Heartbeat
// incidents carry their window in seconds so "value" and "threshold" share a
// unit in notifications.
func (r Rule) incidentThreshold() float64 {
	if r.Metric == MetricHeartbeat {
		return r.For.Seconds()
	}
	return r.Threshold
}

// pointValue extracts the rule's metric from a live point. ok is false for
// heartbeat rules, for values that cannot be compared (NaN, Inf) and for F6
// metrics on a point from an older agent.
func (r Rule) pointValue(p metrics.Point) (float64, bool) {
	if r.Metric.extended() && !p.Extended {
		return 0, false
	}
	var v float32
	switch r.Metric {
	case MetricCPU:
		v = p.CPU
	case MetricMemory:
		v = p.Mem
	case MetricDisk:
		v = p.Disk
	case MetricNetIn:
		v = p.NetInBps
	case MetricNetOut:
		v = p.NetOutBps
	case MetricLoad1:
		v = p.Load1
	case MetricSwap:
		v = p.Swap
	default:
		return 0, false
	}
	return finite(float64(v))
}

// bucketValue extracts the rule's metric from a rollup, using the average so
// a replay matches what a sustained breach looks like. F6 metrics are only
// read from buckets that had extended samples.
func (r Rule) bucketValue(b metrics.Bucket) (float64, bool) {
	if r.Metric.extended() && b.ExtSamples <= 0 {
		return 0, false
	}
	var v float32
	switch r.Metric {
	case MetricCPU:
		v = b.CPUAvg
	case MetricMemory:
		v = b.MemAvg
	case MetricDisk:
		v = b.DiskAvg
	case MetricNetIn:
		v = b.NetInAvg
	case MetricNetOut:
		v = b.NetOutAvg
	case MetricLoad1:
		v = b.Load1Avg
	case MetricSwap:
		v = b.SwapAvg
	default:
		return 0, false
	}
	return finite(float64(v))
}

func finite(v float64) (float64, bool) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// Defaults seeded for new orgs.
const (
	defaultRuleFor         = 5 * time.Minute
	defaultRuleCooldown    = 30 * time.Minute
	defaultRuleAutoResolve = 2 * time.Minute

	defaultCPUWarning    = 80.0
	defaultMemoryWarning = 85.0
	defaultDiskWarning   = 90.0
	defaultDiskCritical  = 95.0
)

// DefaultRules returns the rules seeded for a new org. IDs are zero; the
// caller assigns them when saving.
func DefaultRules(orgID int64, channelIDs []int64) []Rule {
	rule := func(name string, m Metric, threshold float64, sev Severity) Rule {
		return Rule{
			OrgID:       orgID,
			Name:        name,
			Enabled:     true,
			Scope:       Scope{All: true},
			Metric:      m,
			Comparison:  Above,
			Threshold:   threshold,
			For:         defaultRuleFor,
			Severity:    sev,
			ChannelIDs:  slices.Clone(channelIDs),
			Cooldown:    defaultRuleCooldown,
			AutoResolve: defaultRuleAutoResolve,
		}
	}
	return []Rule{
		rule("cpu-warn", MetricCPU, defaultCPUWarning, Warning),
		rule("memory-warn", MetricMemory, defaultMemoryWarning, Warning),
		rule("disk-warn", MetricDisk, defaultDiskWarning, Warning),
		rule("disk-critical", MetricDisk, defaultDiskCritical, Critical),
		// Comparison stays Above (seconds since the last heartbeat above For)
		// so the stored rule always has a valid comparison value.
		rule("host-unreachable", MetricHeartbeat, 0, Critical),
	}
}
