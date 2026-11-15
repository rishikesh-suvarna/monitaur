package alerting

import (
	"math"
	"strings"
	"testing"
	"time"

	"backend/metrics"
)

func TestRuleValidate(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(r *Rule)
		wantErr string // substring; "" means valid
	}{
		{"valid cpu rule", func(r *Rule) {}, ""},
		{"valid heartbeat ignores comparison and threshold", func(r *Rule) {
			*r = heartbeatRule(1, 5*time.Minute)
			r.Comparison, r.Threshold = "", -5
		}, ""},
		{"name required", func(r *Rule) { r.Name = "" }, "name is required"},
		{"blank name", func(r *Rule) { r.Name = "   " }, "name is required"},
		{"name at limit", func(r *Rule) { r.Name = strings.Repeat("a", maxRuleNameRunes) }, ""},
		{"name limit counts characters not bytes", func(r *Rule) { r.Name = strings.Repeat("é", maxRuleNameRunes) }, ""},
		{"name too long", func(r *Rule) { r.Name = strings.Repeat("a", maxRuleNameRunes+1) }, "maximum is 80"},
		{"unknown metric", func(r *Rule) { r.Metric = "load" }, `unknown metric "load"`},
		{"unknown comparison", func(r *Rule) { r.Comparison = "equals" }, `unknown comparison "equals"`},
		{"missing comparison", func(r *Rule) { r.Comparison = "" }, "unknown comparison"},
		{"unknown severity", func(r *Rule) { r.Severity = "info" }, `unknown severity "info"`},
		{"percent at 0", func(r *Rule) { r.Threshold = 0 }, ""},
		{"percent at 100", func(r *Rule) { r.Threshold = 100 }, ""},
		{"percent below 0", func(r *Rule) { r.Threshold = -1 }, "between 0 and 100 percent"},
		{"percent above 100", func(r *Rule) { r.Metric, r.Threshold = MetricDisk, 101 }, "disk threshold must be between 0 and 100"},
		{"NaN threshold", func(r *Rule) { r.Threshold = math.NaN() }, "finite"},
		{"Inf threshold", func(r *Rule) { r.Metric, r.Threshold = MetricNetIn, math.Inf(1) }, "finite"},
		{"net above 100 is fine", func(r *Rule) { r.Metric, r.Threshold = MetricNetOut, 125e6 }, ""},
		{"net negative", func(r *Rule) { r.Metric, r.Threshold = MetricNetIn, -1 }, "net_in threshold must be 0 bytes/s or more"},
		{"for negative", func(r *Rule) { r.For = -time.Second }, "duration (for) must be between"},
		{"for at 24h", func(r *Rule) { r.For = 24 * time.Hour }, ""},
		{"for over 24h", func(r *Rule) { r.For = 24*time.Hour + time.Second }, "duration (for) must be between"},
		{"cooldown negative", func(r *Rule) { r.Cooldown = -time.Minute }, "cooldown must be between"},
		{"cooldown over 24h", func(r *Rule) { r.Cooldown = 25 * time.Hour }, "cooldown must be between"},
		{"auto-resolve negative", func(r *Rule) { r.AutoResolve = -time.Minute }, "auto-resolve delay must be between"},
		{"auto-resolve over 24h", func(r *Rule) { r.AutoResolve = 25 * time.Hour }, "auto-resolve delay must be between"},
		{"heartbeat window too short", func(r *Rule) { *r = heartbeatRule(1, 10*time.Second) }, "at least 30s"},
		{"heartbeat window over 24h", func(r *Rule) { *r = heartbeatRule(1, 25*time.Hour) }, "duration (for) must be between"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := cpuRule(1, 80, 5*time.Minute, 0)
			tc.mutate(&r)
			err := r.Validate()
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("Validate() = %v, want nil", err)
			case tc.wantErr != "" && err == nil:
				t.Fatalf("Validate() = nil, want error containing %q", tc.wantErr)
			case tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr):
				t.Fatalf("Validate() = %q, want it to contain %q", err, tc.wantErr)
			}
		})
	}
}

func TestRuleMatches(t *testing.T) {
	tests := []struct {
		name   string
		scope  Scope
		server ServerInfo
		want   bool
	}{
		{"all", Scope{All: true}, srv(7), true},
		{"listed id", Scope{ServerIDs: []int64{3, 7}}, srv(7), true},
		{"unlisted id", Scope{ServerIDs: []int64{3}}, srv(7), false},
		{"tag case-insensitive", Scope{Tags: []string{"Web"}}, srv(7, "db", "WEB"), true},
		{"tag mismatch", Scope{Tags: []string{"web"}}, srv(7, "db"), false},
		{"id or tag", Scope{ServerIDs: []int64{3}, Tags: []string{"db"}}, srv(7, "db"), true},
		{"empty scope", Scope{}, srv(7, "web"), false},
		{"other org even with all", Scope{All: true}, ServerInfo{ID: 7, OrgID: otherOrg}, false},
		{"other org even when listed", Scope{ServerIDs: []int64{7}}, ServerInfo{ID: 7, OrgID: otherOrg}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := cpuRule(1, 80, 0, 0)
			r.Scope = tc.scope
			if got := r.Matches(tc.server); got != tc.want {
				t.Fatalf("Matches() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDefaultRules(t *testing.T) {
	channels := []int64{4, 9}
	rules := DefaultRules(42, channels)

	want := []struct {
		name      string
		metric    Metric
		threshold float64
		severity  Severity
	}{
		{"cpu-warn", MetricCPU, 80, Warning},
		{"memory-warn", MetricMemory, 85, Warning},
		{"disk-warn", MetricDisk, 90, Warning},
		{"disk-critical", MetricDisk, 95, Critical},
		{"host-unreachable", MetricHeartbeat, 0, Critical},
	}
	if len(rules) != len(want) {
		t.Fatalf("got %d rules, want %d", len(rules), len(want))
	}
	for i, w := range want {
		r := rules[i]
		t.Run(w.name, func(t *testing.T) {
			if r.Name != w.name || r.Metric != w.metric || r.Threshold != w.threshold || r.Severity != w.severity {
				t.Fatalf("got %s %s %g %s, want %s %s %g %s", r.Name, r.Metric, r.Threshold, r.Severity,
					w.name, w.metric, w.threshold, w.severity)
			}
			if r.OrgID != 42 || !r.Enabled || !r.Scope.All || r.Comparison != Above {
				t.Fatalf("org/enabled/scope/comparison wrong: %+v", r)
			}
			if r.For != 5*time.Minute || r.Cooldown != 30*time.Minute || r.AutoResolve != 2*time.Minute {
				t.Fatalf("timings wrong: for %s cooldown %s auto-resolve %s", r.For, r.Cooldown, r.AutoResolve)
			}
			if len(r.ChannelIDs) != 2 || r.ChannelIDs[0] != 4 || r.ChannelIDs[1] != 9 {
				t.Fatalf("channels = %v", r.ChannelIDs)
			}
			if err := r.Validate(); err != nil {
				t.Fatalf("default rule does not validate: %v", err)
			}
		})
	}

	rules[0].ChannelIDs[0] = 99
	if channels[0] != 4 || rules[1].ChannelIDs[0] != 4 {
		t.Fatal("rules share the caller's channel slice")
	}
}

func TestRuleValueExtraction(t *testing.T) {
	p := metrics.Point{CPU: 1, Mem: 2, Disk: 3, NetInBps: 4, NetOutBps: 5}
	b := metrics.Bucket{CPUAvg: 1, CPUMax: 91, MemAvg: 2, MemMax: 92, DiskAvg: 3, NetInAvg: 4, NetInMax: 94, NetOutAvg: 5, NetOutMax: 95}
	tests := []struct {
		metric Metric
		want   float64
		ok     bool
	}{
		{MetricCPU, 1, true},
		{MetricMemory, 2, true},
		{MetricDisk, 3, true},
		{MetricNetIn, 4, true},
		{MetricNetOut, 5, true},
		{MetricHeartbeat, 0, false},
	}
	for _, tc := range tests {
		t.Run(string(tc.metric), func(t *testing.T) {
			r := Rule{Metric: tc.metric}
			if got, ok := r.pointValue(p); got != tc.want || ok != tc.ok {
				t.Fatalf("pointValue = %g, %v; want %g, %v", got, ok, tc.want, tc.ok)
			}
			if got, ok := r.bucketValue(b); got != tc.want || ok != tc.ok {
				t.Fatalf("bucketValue = %g, %v; want %g, %v (must use the avg field)", got, ok, tc.want, tc.ok)
			}
		})
	}
	if _, ok := (Rule{Metric: MetricCPU}).pointValue(metrics.Point{CPU: float32(math.NaN())}); ok {
		t.Fatal("NaN point value accepted")
	}
}
