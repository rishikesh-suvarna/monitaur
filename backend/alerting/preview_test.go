package alerting

import (
	"slices"
	"testing"
	"time"

	"backend/metrics"
)

const samplesPerMinute = int(time.Minute / step)

func cpuAvg(b *metrics.Bucket) *float32   { return &b.CPUAvg }
func memAvg(b *metrics.Bucket) *float32   { return &b.MemAvg }
func netInAvg(b *metrics.Bucket) *float32 { return &b.NetInAvg }

// bucketsAt builds minute buckets starting at t0 plus the given minutes.
func bucketsAt(field func(*metrics.Bucket) *float32, minutes []int, values []float32) []metrics.Bucket {
	out := make([]metrics.Bucket, len(minutes))
	for i, m := range minutes {
		out[i] = metrics.Bucket{ServerID: 10, Res: metrics.Minute, Start: t0.Add(time.Duration(m) * time.Minute), Samples: samplesPerMinute}
		*field(&out[i]) = values[i]
	}
	return out
}

// consecutive builds one minute bucket per value with no gaps.
func consecutive(field func(*metrics.Bucket) *float32, values ...float32) []metrics.Bucket {
	minutes := make([]int, len(values))
	for i := range minutes {
		minutes[i] = i
	}
	return bucketsAt(field, minutes, values)
}

func at(minutes int) time.Time { return t0.Add(time.Duration(minutes) * time.Minute) }

func TestPreview(t *testing.T) {
	cpu5m := cpuRule(1, 80, 5*time.Minute, 2*time.Minute)
	cpuNow := cpuRule(1, 80, 0, 0)
	cpuDip := cpuRule(1, 80, 0, 2*time.Minute)
	memLow := cpuRule(1, 20, 0, 0)
	memLow.Metric, memLow.Comparison = MetricMemory, Below
	netIn := cpuRule(1, 1000, 0, 0)
	netIn.Metric = MetricNetIn
	hb := heartbeatRule(1, 5*time.Minute)

	held := consecutive(cpuAvg, 50, 50, 90, 95, 92, 91, 93, 85, 50, 50, 50)
	reversed := slices.Clone(held)
	slices.Reverse(reversed)
	var flapping []float32
	for range 30 {
		flapping = append(flapping, 90, 90, 90, 90, 50) // 4 minutes over, never 5
	}
	netBuckets := consecutive(netInAvg, 10, 5000, 10)
	for i := range netBuckets {
		netBuckets[i].CPUAvg, netBuckets[i].NetInMax = 99, 1e9 // other fields must not count
	}

	tests := []struct {
		name    string
		rule    Rule
		buckets []metrics.Bucket
		want    []PreviewIncident
	}{
		{"empty", cpu5m, nil, nil},
		{"fires after For and resolves after AutoResolve", cpu5m, held,
			[]PreviewIncident{{Start: at(7), End: at(10), Peak: 95}}},
		{"unsorted input is replayed oldest first", cpu5m, reversed,
			[]PreviewIncident{{Start: at(7), End: at(10), Peak: 95}}},
		{"flapping under For never fires", cpu5m, consecutive(cpuAvg, flapping...), nil},
		{"still open at the end has a zero End", cpuNow, consecutive(cpuAvg, 50, 90, 95),
			[]PreviewIncident{{Start: at(1), Peak: 95}}},
		{"dip shorter than AutoResolve keeps one incident", cpuDip, consecutive(cpuAvg, 90, 50, 90, 50, 50, 50),
			[]PreviewIncident{{Start: at(0), End: at(5), Peak: 90}}},
		{"gap while recovering resolves as Tick would", cpuDip, bucketsAt(cpuAvg, []int{0, 1, 30}, []float32{90, 50, 50}),
			[]PreviewIncident{{Start: at(0), End: at(3), Peak: 90}}},
		{"below keeps the minimum as peak", memLow, consecutive(memAvg, 50, 15, 5, 12, 50),
			[]PreviewIncident{{Start: at(1), End: at(4), Peak: 5}}},
		{"uses the rule's metric average", netIn, netBuckets,
			[]PreviewIncident{{Start: at(1), End: at(2), Peak: 5000}}},
		{"heartbeat counts gaps of at least For", hb,
			bucketsAt(cpuAvg, []int{0, 1, 2, 10, 11, 14, 21}, []float32{1, 1, 1, 1, 1, 1, 1}),
			[]PreviewIncident{
				{Start: at(8), End: at(10), Peak: 420},  // silent from 3m to 10m
				{Start: at(20), End: at(21), Peak: 360}, // silent from 15m to 21m; the 2m gap after 11m is not enough
			}},
		{"heartbeat without gaps", hb, consecutive(cpuAvg, 1, 1, 1, 1, 1, 1, 1, 1), nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Preview(tc.rule, tc.buckets)
			if !slices.EqualFunc(got, tc.want, func(a, b PreviewIncident) bool {
				return a.Start.Equal(b.Start) && a.End.Equal(b.End) && a.Peak == b.Peak
			}) {
				t.Fatalf("Preview =\n  %+v\nwant\n  %+v", got, tc.want)
			}
		})
	}

	if !slices.Equal(reversed[0:1], held[len(held)-1:]) {
		t.Fatal("Preview reordered the caller's slice")
	}
}

// TestPreviewMatchesEngine replays the same series through Preview (minute
// buckets) and through the engine (one point every 5 s holding the bucket's
// value): both must produce the same incidents at the same times.
func TestPreviewMatchesEngine(t *testing.T) {
	values := []float32{
		50, 90, 95, 92, 91, 93, 99, 50, 88, 50, 50, 50, // fires at 4m, dips, resolves at 11m
		90, 91, 50, // pending for 2m only: no incident
		90, 91, 92, 93, 50, 50, 50, // fires at 18m, resolves at 21m
	}
	rule := cpuRule(1, 80, 3*time.Minute, 2*time.Minute)
	want := []PreviewIncident{{Start: at(4), End: at(11), Peak: 99}, {Start: at(18), End: at(21), Peak: 93}}

	preview := Preview(rule, consecutive(cpuAvg, values...))
	if !slices.EqualFunc(preview, want, func(a, b PreviewIncident) bool {
		return a.Start.Equal(b.Start) && a.End.Equal(b.End) && a.Peak == b.Peak
	}) {
		t.Fatalf("Preview = %+v, want %+v", preview, want)
	}

	h := newHarness(t, []Rule{rule}, []ServerInfo{srv(10)})
	for _, v := range values {
		for range samplesPerMinute {
			h.observe(10, v)
			h.clock.Advance(step)
		}
	}
	opens, resolves := h.opens(), h.resolves()
	if len(opens) != len(want) || len(resolves) != len(want) {
		t.Fatalf("engine opened %d and resolved %d incidents, want %d", len(opens), len(resolves), len(want))
	}
	for i, w := range want {
		if !opens[i].StartedAt.Equal(w.Start) || !resolves[i].At.Equal(w.End) || resolves[i].Peak != w.Peak {
			t.Errorf("incident %d: engine %s to %s peak %g, Preview %s to %s peak %g", i,
				opens[i].StartedAt, resolves[i].At, resolves[i].Peak, w.Start, w.End, w.Peak)
		}
	}
}
