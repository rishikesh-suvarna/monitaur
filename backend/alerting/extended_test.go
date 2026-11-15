package alerting

import (
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"backend/metrics"
)

func extRule(id int64, m Metric, threshold float64, forDur, autoResolve time.Duration) Rule {
	r := cpuRule(id, threshold, forDur, autoResolve)
	r.Metric, r.Name = m, string(m)
	return r
}

func TestExtendedRuleValidate(t *testing.T) {
	tests := []struct {
		name      string
		metric    Metric
		threshold float64
		wantErr   string // substring; "" means valid
	}{
		{"load1 at 0", MetricLoad1, 0, ""},
		{"load1 has no upper bound", MetricLoad1, 512, ""},
		{"load1 fractional", MetricLoad1, 0.75, ""},
		{"load1 negative", MetricLoad1, -0.1, "load1 threshold must be 0 or more"},
		{"load1 NaN", MetricLoad1, math.NaN(), "finite"},
		{"swap at 0", MetricSwap, 0, ""},
		{"swap at 100", MetricSwap, 100, ""},
		{"swap over 100", MetricSwap, 101, "swap threshold must be between 0 and 100 percent"},
		{"swap negative", MetricSwap, -1, "swap threshold must be between 0 and 100 percent"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := extRule(1, tc.metric, tc.threshold, time.Minute, 0).Validate()
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("Validate() = %v, want nil", err)
			case tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)):
				t.Fatalf("Validate() = %v, want an error containing %q", err, tc.wantErr)
			}
		})
	}
	if err := extRule(1, "load5", 1, 0, 0).Validate(); err == nil || !strings.Contains(err.Error(), "load1") {
		t.Fatalf("unknown metric error = %v, want it to list load1", err)
	}
}

func TestExtendedValueExtraction(t *testing.T) {
	newPoint := metrics.Point{CPU: 1, Extended: true, Load1: 2.5, Swap: 40}
	// Garbage in the extended fields of an older agent's point must be ignored.
	oldPoint := metrics.Point{CPU: 1, Load1: 99, Swap: 99}
	newBucket := metrics.Bucket{CPUAvg: 1, ExtSamples: 12, Load1Avg: 2.5, Load1Max: 9, SwapAvg: 40}
	oldBucket := metrics.Bucket{CPUAvg: 1, Load1Avg: 99, SwapAvg: 99}
	tests := []struct {
		name   string
		metric Metric
		point  metrics.Point
		bucket metrics.Bucket
		want   float64
		ok     bool
	}{
		{"load1 from an F6 agent (bucket avg)", MetricLoad1, newPoint, newBucket, 2.5, true},
		{"swap from an F6 agent", MetricSwap, newPoint, newBucket, 40, true},
		{"load1 from an older agent", MetricLoad1, oldPoint, oldBucket, 0, false},
		{"swap from an older agent", MetricSwap, oldPoint, oldBucket, 0, false},
		{"cpu does not depend on extended values", MetricCPU, oldPoint, oldBucket, 1, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := Rule{Metric: tc.metric}
			if got, ok := r.pointValue(tc.point); got != tc.want || ok != tc.ok {
				t.Errorf("pointValue = %g, %v; want %g, %v", got, ok, tc.want, tc.ok)
			}
			if got, ok := r.bucketValue(tc.bucket); got != tc.want || ok != tc.ok {
				t.Errorf("bucketValue = %g, %v; want %g, %v", got, ok, tc.want, tc.ok)
			}
		})
	}
}

// TestEngineExtendedMetricsIgnoreOlderAgents: points without extended
// values neither open nor resolve load1 and swap incidents.
func TestEngineExtendedMetricsIgnoreOlderAgents(t *testing.T) {
	rules := []Rule{
		extRule(1, MetricLoad1, 4, 0, 0),
		extRule(2, MetricSwap, 50, 0, 0),
	}
	h := newHarness(t, rules, []ServerInfo{srv(10)})
	old := metrics.Point{CPU: 99, Load1: 99, Swap: 99} // Extended false
	steps := []struct {
		name         string
		point        metrics.Point
		wantOpens    int
		wantResolves int
	}{
		{"older agent cannot breach", old, 0, 0},
		{"F6 agent breaches both", metrics.Point{Extended: true, Load1: 8, Swap: 80}, 2, 0},
		{"older agent cannot recover", metrics.Point{CPU: 1}, 2, 0},
		{"F6 agent under threshold recovers", metrics.Point{Extended: true, Load1: 1, Swap: 10}, 2, 2},
	}
	for _, st := range steps {
		h.clock.Advance(step)
		h.eng.Observe(h.ctx, 10, st.point)
		if got, gotR := len(h.opens()), len(h.resolves()); got != st.wantOpens || gotR != st.wantResolves {
			t.Fatalf("%s: %d opened, %d resolved; want %d and %d", st.name, got, gotR, st.wantOpens, st.wantResolves)
		}
	}
	opens := h.opens()
	slices.SortFunc(opens, func(a, b Incident) int { return int(a.RuleID - b.RuleID) })
	if opens[0].Metric != MetricLoad1 || opens[0].Peak != 8 || opens[1].Metric != MetricSwap || opens[1].Peak != 80 {
		t.Fatalf("opened = %+v", opens)
	}
	h.noViolations()
}

func TestPreviewExtendedSkipsOlderBuckets(t *testing.T) {
	r := extRule(1, MetricLoad1, 4, 0, 0)
	minute := func(m, extSamples int, load float32) metrics.Bucket {
		return metrics.Bucket{ServerID: 10, Res: metrics.Minute, Start: at(m), Samples: samplesPerMinute,
			ExtSamples: extSamples, Load1Avg: load}
	}
	mixed := []metrics.Bucket{
		minute(0, 0, 0), // before the agent upgrade
		minute(1, samplesPerMinute, 9),
		minute(2, 0, 0), // an older agent briefly back: not a recovery
		minute(3, samplesPerMinute, 9),
		minute(4, samplesPerMinute, 1),
	}
	got := Preview(r, mixed)
	if len(got) != 1 || !got[0].Start.Equal(at(1)) || got[0].Peak != 9 {
		t.Fatalf("Preview = %+v, want one incident from minute 1 with peak 9", got)
	}
	onlyExtended := []metrics.Bucket{mixed[1], mixed[3], mixed[4]}
	if want := Preview(r, onlyExtended); !slices.Equal(got, want) {
		t.Fatalf("Preview with older buckets %+v differs from without them %+v", got, want)
	}

	// Control: had minute 2 really reported load 0, it would have resolved.
	control := slices.Clone(mixed)
	control[2].ExtSamples = samplesPerMinute
	if n := len(Preview(r, control)); n != 2 {
		t.Fatalf("control preview has %d incidents, want 2", n)
	}
}
