package metrics

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"
	"unicode/utf8"
)

func pidsOf(s []procSample) []int32 {
	out := make([]int32, 0, len(s))
	for _, p := range s {
		out = append(out, p.pid)
	}
	return out
}

func TestTopUnion(t *testing.T) {
	samples := []procSample{
		{pid: 1, cpu: 50, rss: 10},
		{pid: 2, cpu: 40, rss: 20},
		{pid: 3, cpu: 1, rss: 900},
		{pid: 4, cpu: 0, rss: 800},
		{pid: 5, cpu: 30, rss: 5},
		{pid: 6, cpu: 0, rss: 0},
	}
	tests := []struct {
		name    string
		samples []procSample
		n       int
		want    []int32
	}{
		{"top by cpu then top by memory", samples, 2, []int32{1, 2, 3, 4}},
		{"overlap is listed once", []procSample{{pid: 1, cpu: 90, rss: 900}, {pid: 2, cpu: 1, rss: 1}, {pid: 3, cpu: 2, rss: 2}}, 1, []int32{1}},
		{"fewer processes than n", samples[:2], 15, []int32{1, 2}},
		{"ties break by the other measure, then pid", []procSample{{pid: 9, cpu: 0, rss: 5}, {pid: 7, cpu: 0, rss: 5}, {pid: 8, cpu: 0, rss: 6}}, 1, []int32{8}},
		{"no processes", nil, 15, []int32{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := pidsOf(topUnion(tc.samples, tc.n)); !slices.Equal(got, tc.want) {
				t.Fatalf("topUnion = %v, want %v", got, tc.want)
			}
		})
	}

	// The union is bounded by 2n however many processes there are.
	var many []procSample
	for i := range 500 {
		many = append(many, procSample{pid: int32(i), cpu: float64(i % 97), rss: uint64(i * 7919 % 1000)})
	}
	if got := topUnion(many, TopProcesses); len(got) > 2*TopProcesses || len(got) < TopProcesses {
		t.Fatalf("union of %d processes has %d entries, want %d to %d", len(many), len(got), TopProcesses, 2*TopProcesses)
	}
}

func TestProcessInterval(t *testing.T) {
	tests := []struct{ collection, want time.Duration }{
		{5 * time.Second, MinProcessInterval},
		{30 * time.Second, 30 * time.Second},
		{2 * time.Minute, 2 * time.Minute},
	}
	for _, tc := range tests {
		if got := ProcessInterval(tc.collection); got != tc.want {
			t.Errorf("ProcessInterval(%s) = %s, want %s", tc.collection, got, tc.want)
		}
	}
}

func TestProcessCollectorOnThisHost(t *testing.T) {
	if testing.Short() {
		t.Skip("reads the real host")
	}
	ctx := context.Background()
	pc := NewProcessCollector()
	if _, err := pc.Collect(ctx); errors.Is(err, ErrProcessesUnsupported) {
		t.Skip(err)
	} else if err != nil {
		t.Fatal(err)
	}
	// Burn some CPU so a delta exists, then take the real list.
	deadline := time.Now().Add(50 * time.Millisecond)
	for time.Now().Before(deadline) {
	}
	list, err := pc.Collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Processes) == 0 || len(list.Processes) > 2*TopProcesses || list.Total < len(list.Processes) {
		t.Fatalf("list has %d processes of %d", len(list.Processes), list.Total)
	}
	seen := map[int32]bool{}
	for _, p := range list.Processes {
		if seen[p.PID] {
			t.Fatalf("pid %d listed twice", p.PID)
		}
		seen[p.PID] = true
		if p.CPU < 0 || p.Mem < 0 || p.Mem > 100 || utf8.RuneCountInString(p.Cmd) > MaxCmdLen || p.Name == "" {
			t.Fatalf("bad entry %+v", p)
		}
	}
	// Baselines are kept for live processes only.
	if len(pc.procs) > list.Total {
		t.Fatalf("collector tracks %d processes, host has %d", len(pc.procs), list.Total)
	}
	t.Logf("%d of %d processes listed; top: %+v", len(list.Processes), list.Total, list.Processes[0])
}
