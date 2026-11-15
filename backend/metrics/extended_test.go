package metrics

import (
	"context"
	"math"
	"runtime"
	"testing"
	"time"
	"unsafe"
)

// extSampleAt is sampleAt from an F6 agent: load, swap and disk counters.
func extSampleAt(at time.Time, cpu, load1, swap float64, read, write uint64) Sample {
	smp := sampleAt(at, cpu)
	smp.Extended = true
	smp.Load1, smp.Load5, smp.Load15 = load1, load1/2, load1/4
	smp.SwapPercent, smp.SwapTotalBytes, smp.SwapUsedBytes = swap, 2<<30, uint64(swap/100*float64(2<<30))
	smp.DiskReadTotal, smp.DiskWriteTotal = read, write
	return smp
}

func ingestSample(t *testing.T, s *Store, clock *fakeClock, id int64, smp Sample) Point {
	t.Helper()
	clock.Set(smp.Time)
	p, err := s.Ingest(id, smp, 0)
	if err != nil {
		t.Fatalf("Ingest(%d, %s): %v", id, smp.Time.Format(time.TimeOnly), err)
	}
	return p
}

func near(a, b float32) bool { return math.Abs(float64(a-b)) < 1e-3 }

func TestExtendedDiskRates(t *testing.T) {
	steps := []struct {
		name              string
		at                time.Duration
		extended          bool
		read, write       uint64
		wantRead, wantWr  float32
		wantExtendedPoint bool
	}{
		{name: "older agent sample has no extended values", at: 0, extended: false},
		{name: "first extended sample has no disk baseline", at: 5 * time.Second, extended: true, read: 1_000_000, write: 2_000_000, wantExtendedPoint: true},
		{name: "delta over elapsed seconds", at: 10 * time.Second, extended: true, read: 1_050_000, write: 2_010_000, wantRead: 10_000, wantWr: 2_000, wantExtendedPoint: true},
		{name: "counter went backwards (reboot) gives 0", at: 15 * time.Second, extended: true, read: 4_000, write: 1_000, wantExtendedPoint: true},
		{name: "rate resumes from the new baseline", at: 25 * time.Second, extended: true, read: 24_000, write: 2_000, wantRead: 2_000, wantWr: 100, wantExtendedPoint: true},
		{name: "downgraded agent drops back to no extended values", at: 30 * time.Second, extended: false},
		{name: "re-upgraded agent does not diff against stale counters", at: 35 * time.Second, extended: true, read: 90_000_000, write: 90_000_000, wantExtendedPoint: true},
	}
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	for _, st := range steps {
		t.Run(st.name, func(t *testing.T) {
			at := t0.Add(st.at)
			smp := sampleAt(at, 1)
			if st.extended {
				smp = extSampleAt(at, 1, 0.5, 10, st.read, st.write)
			}
			p := ingestSample(t, s, clock, 1, smp)
			if p.Extended != st.wantExtendedPoint || p.DiskReadBps != st.wantRead || p.DiskWriteBps != st.wantWr {
				t.Fatalf("point extended %v read %v write %v, want %v %v %v",
					p.Extended, p.DiskReadBps, p.DiskWriteBps, st.wantExtendedPoint, st.wantRead, st.wantWr)
			}
			if !st.extended && (p.Load1 != 0 || p.Swap != 0) {
				t.Fatalf("older agent point carries load %v swap %v", p.Load1, p.Swap)
			}
		})
	}
}

func TestExtendedLatest(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)

	first := extSampleAt(t0, 10, 1.5, 25, 0, 0)
	first.Mounts = []Mount{{Path: "/", FSType: "ext4", TotalBytes: 100, UsedBytes: 40, UsedPercent: 40}}
	first.Interfaces = []IfaceCounters{{Name: "eth0", RxTotal: 1000, TxTotal: 500}, {Name: "eth1", RxTotal: 70, TxTotal: 70}}
	ingestSample(t, s, clock, 1, first)

	second := extSampleAt(t0.Add(10*time.Second), 10, 2, 30, 0, 0)
	second.Mounts = []Mount{
		{Path: "/", FSType: "ext4", TotalBytes: 100, UsedBytes: 40, UsedPercent: 40},
		{Path: "/data", FSType: "xfs", UsedPercent: 100.004}, // gopsutil rounding, clamped
	}
	second.Interfaces = []IfaceCounters{
		{Name: "eth0", RxTotal: 11_000, TxTotal: 1_500}, // 1000 B/s in, 100 B/s out
		{Name: "eth1", RxTotal: 10, TxTotal: 10},        // reset: 0
		{Name: "wg0", RxTotal: 9_999, TxTotal: 9_999},   // new: no baseline
	}
	ingestSample(t, s, clock, 1, second)
	// The caller's slices are copied: later writes must not leak into Latest.
	second.Mounts[0].Path = "/mutated"
	second.Interfaces[0].Name = "mutated"

	l, ok := s.Latest(1)
	if !ok {
		t.Fatal("no latest")
	}
	if !l.Extended || l.Load1 != 2 || l.Load5 != 1 || l.Load15 != 0.5 || l.Swap != 30 || l.SwapTotalBytes != 2<<30 {
		t.Fatalf("extended latest = %+v", l)
	}
	if len(l.Mounts) != 2 || l.Mounts[0].Path != "/" || l.Mounts[1].UsedPercent != 100 {
		t.Fatalf("mounts = %+v", l.Mounts)
	}
	wantIfaces := []Iface{{Name: "eth0", InBps: 1000, OutBps: 100}, {Name: "eth1"}, {Name: "wg0"}}
	if len(l.Interfaces) != len(wantIfaces) {
		t.Fatalf("interfaces = %+v, want %+v", l.Interfaces, wantIfaces)
	}
	for i, w := range wantIfaces {
		if l.Interfaces[i] != w {
			t.Errorf("interface %d = %+v, want %+v", i, l.Interfaces[i], w)
		}
	}

	// An older agent on another server: no extended values, nil lists.
	ingestSample(t, s, clock, 2, sampleAt(t0.Add(10*time.Second), 5))
	old, _ := s.Latest(2)
	if old.Extended || old.Load5 != 0 || old.SwapTotalBytes != 0 || old.Mounts != nil || old.Interfaces != nil {
		t.Fatalf("older agent latest = %+v, want no extended values and nil lists", old)
	}
}

func TestExtendedValidation(t *testing.T) {
	tests := []struct {
		name         string
		mutate       func(*Sample)
		wantExtended bool
	}{
		{"valid", func(*Sample) {}, true},
		{"negative load", func(s *Sample) { s.Load5 = -1 }, false},
		{"NaN load", func(s *Sample) { s.Load1 = math.NaN() }, false},
		{"infinite load", func(s *Sample) { s.Load15 = math.Inf(1) }, false},
		{"swap over 100", func(s *Sample) { s.SwapPercent = 120 }, false},
		{"swap rounding just over 100 is clamped", func(s *Sample) { s.SwapPercent = 100.001 }, true},
		{"load has no upper bound", func(s *Sample) { s.Load1 = 512 }, true},
	}
	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := newClock(t0)
			s := newTestStore(t, Config{}, clock, nil, nil)
			smp := extSampleAt(t0, 33, 1, 50, 10, 10)
			tc.mutate(&smp)
			p := ingestSample(t, s, clock, int64(i+1), smp)
			// A bad extended block never costs the base reading.
			if p.CPU != 33 || p.Extended != tc.wantExtended {
				t.Fatalf("point cpu %v extended %v, want 33 and %v", p.CPU, p.Extended, tc.wantExtended)
			}
			l, _ := s.Latest(int64(i + 1))
			if !tc.wantExtended && (l.Load1 != 0 || l.Load5 != 0 || l.Swap != 0 || l.SwapUsedBytes != 0) {
				t.Fatalf("rejected extended values leaked into latest: %+v", l)
			}
			if tc.wantExtended && l.Swap > maxPercent {
				t.Fatalf("swap %v not clamped", l.Swap)
			}
		})
	}
}

func TestExtendedListsAreBounded(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	smp := extSampleAt(t0, 1, 1, 1, 0, 0)
	for range MaxMounts + 5 {
		smp.Mounts = append(smp.Mounts, Mount{Path: "/m"})
	}
	for range MaxInterfaces + 5 {
		smp.Interfaces = append(smp.Interfaces, IfaceCounters{Name: "if"})
	}
	ingestSample(t, s, clock, 1, smp)
	l, _ := s.Latest(1)
	if len(l.Mounts) != MaxMounts || len(l.Interfaces) != MaxInterfaces || len(s.lookup(1).lastIfaces) != MaxInterfaces {
		t.Fatalf("mounts %d interfaces %d kept %d, want %d/%d", len(l.Mounts), len(l.Interfaces), len(s.lookup(1).lastIfaces), MaxMounts, MaxInterfaces)
	}
}

// TestExtendedRollups mixes older and F6 samples in one minute (an agent
// upgraded mid-minute): extended averages use only the extended samples.
func TestExtendedRollups(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)

	// Minute 12:00: one old sample, then three extended ones 10 s apart.
	ingestSample(t, s, clock, 1, sampleAt(t0.Add(5*time.Second), 10))
	ingestSample(t, s, clock, 1, extSampleAt(t0.Add(15*time.Second), 10, 1, 20, 0, 0))
	ingestSample(t, s, clock, 1, extSampleAt(t0.Add(25*time.Second), 10, 2, 30, 10_000, 0))
	ingestSample(t, s, clock, 1, extSampleAt(t0.Add(35*time.Second), 10, 3, 40, 30_000, 5_000))
	// Minute 12:01: old samples only. Minute 12:02: one extended sample.
	ingestSample(t, s, clock, 1, sampleAt(t0.Add(65*time.Second), 10))
	ingestSample(t, s, clock, 1, extSampleAt(t0.Add(125*time.Second), 10, 6, 60, 30_000, 5_000))
	clock.Set(t0.Add(time.Hour + time.Minute))
	s.tick()

	var minutes []Bucket
	var hour *Bucket
	for _, b := range pendingOf(s) {
		switch b.Res {
		case Minute:
			minutes = append(minutes, b)
		case Hour:
			hour = &b
		}
	}
	if len(minutes) != 3 || hour == nil {
		t.Fatalf("closed %d minutes and hour %v, want 3 and one hour", len(minutes), hour)
	}

	m := minutes[0]
	checks := []struct {
		name      string
		got, want float32
	}{
		{"load1 avg", m.Load1Avg, 2},
		{"load1 max", m.Load1Max, 3},
		{"swap avg", m.SwapAvg, 30},
		{"disk read avg", m.DiskReadAvg, (0 + 1000 + 2000) / 3.0},
		{"disk read max", m.DiskReadMax, 2000},
		{"disk write avg", m.DiskWriteAvg, 500 / 3.0},
		{"disk write max", m.DiskWriteMax, 500},
	}
	for _, c := range checks {
		if !near(c.got, c.want) {
			t.Errorf("minute %s = %v, want %v", c.name, c.got, c.want)
		}
	}
	if m.Samples != 4 || m.ExtSamples != 3 {
		t.Errorf("minute samples %d ext %d, want 4 and 3", m.Samples, m.ExtSamples)
	}
	if old := minutes[1]; old.ExtSamples != 0 || old.Load1Avg != 0 || old.SwapAvg != 0 || old.DiskReadMax != 0 {
		t.Errorf("old-agent minute carries extended values: %+v", old)
	}

	// The hour weights each minute's extended averages by its ext samples:
	// load (1+2+3+6)/4, not the mean of the minute averages (2+6)/2.
	if hour.Samples != 6 || hour.ExtSamples != 4 || !near(hour.Load1Avg, 3) || hour.Load1Max != 6 || !near(hour.SwapAvg, 37.5) {
		t.Errorf("hour = samples %d ext %d load %v/%v swap %v, want 6, 4, 3/6, 37.5",
			hour.Samples, hour.ExtSamples, hour.Load1Avg, hour.Load1Max, hour.SwapAvg)
	}
}

func TestExtendedSeriesNulls(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	ingestSample(t, s, clock, 1, sampleAt(t0, 10))                                    // old agent
	ingestSample(t, s, clock, 1, extSampleAt(t0.Add(2*time.Minute), 10, 4, 50, 0, 0)) // upgraded
	ingestSample(t, s, clock, 1, extSampleAt(t0.Add(2*time.Minute+5*time.Second), 10, 2, 70, 5_000, 0))
	clock.Set(t0.Add(3*time.Minute + 10*time.Second))
	s.tick()

	tests := []struct {
		r        Range
		oldStep  time.Time
		newStep  time.Time
		load     float32
		swap     float32
		diskRead float32
		loadMax  float32
	}{
		{RangeLive, t0, t0.Add(2*time.Minute + 5*time.Second), 2, 70, 1000, 4},
		{Range6h, t0, t0.Add(2 * time.Minute), 3, 60, 500, 3},
	}
	for _, tc := range tests {
		t.Run(string(tc.r), func(t *testing.T) {
			got := mustSeries(t, s, 1, tc.r)
			old := pointAt(t, got, tc.oldStep)
			if old.CPU == nil || old.Load1 != nil || old.Swap != nil || old.DiskReadBps != nil || old.DiskWriteBps != nil {
				t.Fatalf("old-agent step = cpu %v load %v swap %v, want cpu and null extended values", old.CPU, old.Load1, old.Swap)
			}
			p := pointAt(t, got, tc.newStep)
			if p.Load1 == nil || p.Swap == nil || p.DiskReadBps == nil || p.DiskWriteBps == nil {
				t.Fatalf("extended step has nil fields: %+v", p)
			}
			if !near(*p.Load1, tc.load) || !near(*p.Swap, tc.swap) || !near(*p.DiskReadBps, tc.diskRead) {
				t.Fatalf("extended step = load %v swap %v read %v, want %v %v %v", *p.Load1, *p.Swap, *p.DiskReadBps, tc.load, tc.swap, tc.diskRead)
			}
			for _, key := range []string{SeriesLoad1, SeriesSwap, SeriesDiskRead, SeriesDiskWrite} {
				if _, ok := got.Stats[key]; !ok {
					t.Fatalf("stats missing key %q", key)
				}
			}
			if st := got.Stats[SeriesLoad1]; !near(st.Max, tc.loadMax) || !near(st.Now, tc.load) {
				t.Fatalf("load1 stats = %+v, want max %v and now %v", st, tc.loadMax, tc.load)
			}
		})
	}
}

func TestExtendedSeriesFromHistory(t *testing.T) {
	clock := newClock(t0.Add(10 * time.Minute))
	hist := &fakeHistory{buckets: []Bucket{
		// Written before the migration or by an older agent: no ext values.
		{ServerID: 1, Res: Hour, Start: t0.Add(-48 * time.Hour), Samples: 720, CPUAvg: 33},
		{ServerID: 1, Res: Hour, Start: t0.Add(-24 * time.Hour), Samples: 720, CPUAvg: 44,
			ExtSamples: 360, Load1Avg: 1.25, SwapAvg: 12, DiskReadAvg: 4096, DiskWriteAvg: 512},
	}}
	s := newTestStore(t, Config{}, clock, nil, hist)

	got := mustSeries(t, s, 1, Range7d)
	if p := pointAt(t, got, t0.Add(-48*time.Hour)); p.CPU == nil || p.Load1 != nil || p.Swap != nil {
		t.Fatalf("pre-F6 hour = cpu %v load %v swap %v, want cpu and null extended values", p.CPU, p.Load1, p.Swap)
	}
	p := pointAt(t, got, t0.Add(-24*time.Hour))
	if p.Load1 == nil || *p.Load1 != 1.25 || *p.Swap != 12 || *p.DiskReadBps != 4096 || *p.DiskWriteBps != 512 {
		t.Fatalf("F6 hour = %+v", p)
	}
}

func TestExtendedJournalReplay(t *testing.T) {
	dir := t.TempDir()
	// An old-format line (no ext fields) next to an F6 one.
	writeJournalFile(t, dir+"/1"+journalExt,
		`{"server_id":1,"res":1,"start":"2026-11-15T11:58:00Z","samples":12,"cpu_avg":10}`,
		bucketLine(t, Bucket{ServerID: 1, Res: Minute, Start: t0.Add(-time.Minute), Samples: 12, CPUAvg: 20,
			ExtSamples: 6, Load1Avg: 0.75, Load1Max: 1, SwapAvg: 5, DiskReadAvg: 100, DiskReadMax: 200, DiskWriteAvg: 300, DiskWriteMax: 400}),
	)
	clock := newClock(t0)
	sink := &fakeSink{}
	s := newTestStore(t, Config{JournalDir: dir}, clock, sink, nil)
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := sink.buckets()
	if len(got) != 2 {
		t.Fatalf("replayed %d buckets, want 2", len(got))
	}
	if got[0].ExtSamples != 0 || got[0].Load1Avg != 0 {
		t.Fatalf("old journal line = %+v, want no extended values", got[0])
	}
	want := Bucket{ServerID: 1, Res: Minute, Start: t0.Add(-time.Minute), Samples: 12, CPUAvg: 20,
		ExtSamples: 6, Load1Avg: 0.75, Load1Max: 1, SwapAvg: 5, DiskReadAvg: 100, DiskReadMax: 200, DiskWriteAvg: 300, DiskWriteMax: 400}
	if !got[1].Start.Equal(want.Start) {
		t.Fatalf("F6 journal line start = %s, want %s", got[1].Start, want.Start)
	}
	got[1].Start = want.Start
	if got[1] != want {
		t.Fatalf("F6 journal line = %+v, want %+v", got[1], want)
	}
	// The replayed minute also feeds the recent ring with its extended part.
	clock.Set(t0.Add(time.Minute))
	series := mustSeries(t, s, 1, Range6h)
	if p := pointAt(t, series, t0.Add(-time.Minute)); p.Load1 == nil || *p.Load1 != 0.75 {
		t.Fatalf("6h series after replay = load %v, want 0.75", p.Load1)
	}
}

func TestExtRingAlignment(t *testing.T) {
	const limit = 4
	tests := []struct {
		name string
		// ext[i] is the extended value pushed with base value i; 0 means a
		// push without extended values.
		ext  []int
		want [][2]int // (base, ext) from oldest to newest
	}{
		{"never switched on", []int{0, 0, 0}, [][2]int{{0, 0}, {1, 0}, {2, 0}}},
		{"switched on midway", []int{0, 0, 7, 0}, [][2]int{{0, 0}, {1, 0}, {2, 7}, {3, 0}}},
		{"base wraps before ext fills", []int{0, 0, 0, 9, 8}, [][2]int{{1, 0}, {2, 0}, {3, 9}, {4, 8}}},
		{"both wrap", []int{5, 6, 0, 7, 8, 9}, [][2]int{{2, 0}, {3, 7}, {4, 8}, {5, 9}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newExtRing[int, int](limit)
			for i, x := range tc.ext {
				r.push(i, x, x != 0)
			}
			if r.size() != len(tc.want) {
				t.Fatalf("size = %d, want %d", r.size(), len(tc.want))
			}
			for i, w := range tc.want {
				if b, x := r.at(i); b != w[0] || x != w[1] {
					t.Errorf("at(%d) = (%d, %d), want (%d, %d)", i, b, x, w[0], w[1])
				}
			}
		})
	}
	if r := newExtRing[int, int](limit); r.ext.buf != nil {
		t.Fatal("extended ring allocated before any extended value")
	}
}

func TestExtendedLayout(t *testing.T) {
	if got := unsafe.Sizeof(xpoint{}); got != 20 {
		t.Errorf("xpoint is %d bytes, want 20", got)
	}
	if got := unsafe.Sizeof(xbucket{}); got != 32 {
		t.Errorf("xbucket is %d bytes, want 32", got)
	}
}

// TestMemoryPerServerExtended is TestMemoryPerServer for F6 agents, with
// full mount and interface lists. The extended rings add about 66 KB on top
// of the base ~140 KB; servers on older agents keep the base budget.
func TestMemoryPerServerExtended(t *testing.T) {
	if testing.Short() {
		t.Skip("memory measurement")
	}
	const (
		servers = 20
		budget  = 240 << 10 // ~210 KB measured plus slack for map and allocator overhead
	)
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, discardSink{}, nil)

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)

	minutes := s.recentCap + minutesPerHour + 1
	for id := int64(1); id <= servers; id++ {
		for m := range minutes {
			at := t0.Add(time.Duration(m) * time.Minute)
			smp := extSampleAt(at, 10, 1, 10, uint64(m)*1000, uint64(m)*1000)
			for i := range MaxMounts {
				smp.Mounts = append(smp.Mounts, Mount{Path: "/mnt/volume-" + string(rune('a'+i)), FSType: "ext4"})
			}
			for i := range MaxInterfaces {
				smp.Interfaces = append(smp.Interfaces, IfaceCounters{Name: "eth" + string(rune('a'+i))})
			}
			clock.Set(at)
			if _, err := s.Ingest(id, smp, 0); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(s)

	st := s.lookup(1)
	if st.raw.ext.size() != s.rawCap || st.recent.ext.size() != s.recentCap || st.hours.ext.size() != s.hourCap {
		t.Fatalf("extended rings not full: raw %d/%d recent %d/%d hours %d/%d",
			st.raw.ext.size(), s.rawCap, st.recent.ext.size(), s.recentCap, st.hours.ext.size(), s.hourCap)
	}
	perServer := (int64(after.HeapAlloc) - int64(before.HeapAlloc)) / servers
	t.Logf("retained heap per F6 server at default windows: %d bytes (%.1f KB)", perServer, float64(perServer)/1024)
	if perServer > budget {
		t.Fatalf("per-server memory %d bytes over budget %d", perServer, budget)
	}
}
