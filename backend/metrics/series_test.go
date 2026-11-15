package metrics

import (
	"context"
	"slices"
	"testing"
	"time"
)

func pointAt(t *testing.T, s Series, at time.Time) SeriesPoint {
	t.Helper()
	for _, p := range s.Points {
		if p.T.Equal(at) {
			return p
		}
	}
	t.Fatalf("no point at %s in %s series [%s, %s]", at.Format(time.DateTime), s.Range, s.From.Format(time.DateTime), s.To.Format(time.DateTime))
	return SeriesPoint{}
}

func mustSeries(t *testing.T, s *Store, id int64, r Range) Series {
	t.Helper()
	out, err := s.Series(context.Background(), id, r)
	if err != nil {
		t.Fatalf("Series(%d, %s): %v", id, r, err)
	}
	return out
}

func TestSeriesStepsAndAlignment(t *testing.T) {
	now := t0.Add(7*time.Minute + 23*time.Second + 500*time.Millisecond)
	tests := []struct {
		r           Range
		stepSeconds int
		points      int
	}{
		{RangeLive, 5, 180},
		{Range1h, 10, 360},
		{Range6h, 60, 360},
		{Range24h, 240, 360},
		{Range7d, 3600, 168},
		{Range30d, 7200, 360},
	}
	clock := newClock(now)
	s := newTestStore(t, Config{}, clock, nil, &fakeHistory{})
	for _, tc := range tests {
		t.Run(string(tc.r), func(t *testing.T) {
			got := mustSeries(t, s, 1, tc.r)
			step := time.Duration(tc.stepSeconds) * time.Second
			if got.Range != tc.r || got.StepSeconds != tc.stepSeconds || len(got.Points) != tc.points {
				t.Fatalf("range %s step %d points %d; want %s %d %d", got.Range, got.StepSeconds, len(got.Points), tc.r, tc.stepSeconds, tc.points)
			}
			first, last := got.Points[0].T, got.Points[len(got.Points)-1].T
			if !got.From.Equal(first) || !got.To.Equal(last) {
				t.Fatalf("From/To %s/%s do not match first/last point %s/%s", got.From, got.To, first, last)
			}
			if last.After(now) || !now.Before(last.Add(step)) {
				t.Fatalf("last step %s does not contain now %s", last, now)
			}
			for i, p := range got.Points {
				if p.T.UnixNano()%int64(step) != 0 {
					t.Fatalf("point %d at %s not aligned to %s", i, p.T, step)
				}
				if i > 0 && p.T.Sub(got.Points[i-1].T) != step {
					t.Fatalf("point %d is %s after the previous, want %s", i, p.T.Sub(got.Points[i-1].T), step)
				}
				if p.CPU != nil || p.NetInBps != nil {
					t.Fatalf("point %d has data for a server with no samples", i)
				}
			}
			for _, key := range []string{SeriesCPU, SeriesMem, SeriesDisk, SeriesNetIn, SeriesNetOut} {
				if _, ok := got.Stats[key]; !ok {
					t.Fatalf("stats missing key %q", key)
				}
			}
		})
	}
	if _, err := s.Series(context.Background(), 1, Range("2y")); err == nil {
		t.Fatal("unknown range accepted")
	}
}

func TestSeriesGapsAreNil(t *testing.T) {
	tests := []struct {
		name     string
		r        Range
		samples  []time.Duration // offsets from t0
		now      time.Duration
		withData []time.Duration // step starts (offsets) that must be non-nil
		gaps     []time.Duration // step starts that must be nil
	}{
		{
			name:     "minute buckets with missing minutes",
			r:        Range6h,
			samples:  []time.Duration{30 * time.Second, 90 * time.Second, 150 * time.Second, 390 * time.Second, 450 * time.Second},
			now:      460 * time.Second,
			withData: []time.Duration{0, time.Minute, 2 * time.Minute, 6 * time.Minute, 7 * time.Minute},
			gaps:     []time.Duration{3 * time.Minute, 4 * time.Minute, 5 * time.Minute},
		},
		{
			name:     "raw points with missing steps",
			r:        RangeLive,
			samples:  []time.Duration{0, 5 * time.Second, 20 * time.Second},
			now:      22 * time.Second,
			withData: []time.Duration{0, 5 * time.Second, 20 * time.Second},
			gaps:     []time.Duration{10 * time.Second, 15 * time.Second},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := newClock(t0)
			s := newTestStore(t, Config{}, clock, nil, nil)
			for _, off := range tc.samples {
				ingestAt(t, s, clock, 1, t0.Add(off), 10)
			}
			clock.Set(t0.Add(tc.now))
			got := mustSeries(t, s, 1, tc.r)
			for _, off := range tc.withData {
				if p := pointAt(t, got, t0.Add(off)); p.CPU == nil || p.Mem == nil || p.Disk == nil || p.NetInBps == nil || p.NetOutBps == nil {
					t.Errorf("step +%s has nil fields, want data", off)
				}
			}
			for _, off := range tc.gaps {
				if p := pointAt(t, got, t0.Add(off)); p.CPU != nil || p.Mem != nil || p.Disk != nil || p.NetInBps != nil || p.NetOutBps != nil {
					t.Errorf("step +%s has data, want a nil gap", off)
				}
			}
		})
	}
}

func TestSeriesWeightedMinuteAverage(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	// Two samples (avg 15) in one minute and one sample (60) in the next, in
	// the same 4-minute step: weighted by samples it is 30, not 37.5.
	ingestAt(t, s, clock, 1, t0.Add(10*time.Second), 10)
	ingestAt(t, s, clock, 1, t0.Add(20*time.Second), 20)
	ingestAt(t, s, clock, 1, t0.Add(70*time.Second), 60)
	clock.Set(t0.Add(2*time.Minute + 6*time.Second))
	s.tick()

	got := mustSeries(t, s, 1, Range24h)
	p := pointAt(t, got, t0)
	if p.CPU == nil || *p.CPU != 30 {
		t.Fatalf("4m step cpu = %v, want 30", p.CPU)
	}
	if st := got.Stats[SeriesCPU]; st != (Stat{Min: 30, Avg: 30, Max: 30, Now: 30}) {
		t.Fatalf("cpu stats = %+v", st)
	}
}

func TestSeriesStats(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	for i, cpu := range []float64{10, 30, 20} {
		ingestAt(t, s, clock, 1, t0.Add(time.Duration(i)*10*time.Second), cpu)
	}
	got := mustSeries(t, s, 1, RangeLive)
	want := Stat{Min: 10, Avg: 20, Max: 30, Now: 20}
	if st := got.Stats[SeriesCPU]; st != want {
		t.Fatalf("cpu stats = %+v, want %+v", st, want)
	}
	if st := got.Stats[SeriesMem]; st != (Stat{Min: 50, Avg: 50, Max: 50, Now: 50}) {
		t.Fatalf("mem stats = %+v", st)
	}
}

func TestSeries7dHistoryCache(t *testing.T) {
	clock := newClock(t0.Add(10 * time.Minute))
	hist := &fakeHistory{buckets: []Bucket{
		{ServerID: 1, Res: Hour, Start: t0.Add(-48 * time.Hour), Samples: 720, CPUAvg: 33},
		{ServerID: 1, Res: Hour, Start: t0.Add(-24 * time.Hour), Samples: 720, CPUAvg: 44},
	}}
	sink := &fakeSink{}
	s := newTestStore(t, Config{}, clock, sink, hist)

	got := mustSeries(t, s, 1, Range7d)
	if p := pointAt(t, got, t0.Add(-48*time.Hour)); p.CPU == nil || *p.CPU != 33 {
		t.Fatalf("history hour cpu = %v, want 33", p.CPU)
	}
	if hist.callCount() != 1 {
		t.Fatalf("History calls = %d, want 1", hist.callCount())
	}
	call := hist.calls[0]
	if call.res != Hour || !call.from.Equal(got.From) || !call.to.Equal(got.To.Add(time.Hour)) {
		t.Fatalf("History called with %+v, want Hour [%s, %s)", call, got.From, got.To.Add(time.Hour))
	}

	mustSeries(t, s, 1, Range7d)
	if hist.callCount() != 1 {
		t.Fatalf("second read went to History: %d calls", hist.callCount())
	}

	s.enqueue(syntheticBuckets(1, 2)) // something to write, so the Sink is called and fails
	sink.fail(1)
	if err := s.Flush(context.Background()); err == nil {
		t.Fatal("flush with a failing sink succeeded")
	}
	mustSeries(t, s, 1, Range7d)
	if hist.callCount() != 1 {
		t.Fatalf("a failed flush cleared the cache: %d calls", hist.callCount())
	}

	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	mustSeries(t, s, 1, Range7d)
	if hist.callCount() != 2 {
		t.Fatalf("History calls after a successful flush = %d, want 2", hist.callCount())
	}

	mustSeries(t, s, 1, Range30d)
	if hist.callCount() != 3 {
		t.Fatalf("30d did not get its own cache entry: %d calls", hist.callCount())
	}
}

func TestSeries7dMergesMemoryHours(t *testing.T) {
	clock := newClock(t0)
	hist := &fakeHistory{buckets: []Bucket{
		// A thinner copy of an hour memory also holds: memory (fuller) wins.
		{ServerID: 1, Res: Hour, Start: t0, Samples: 1, CPUAvg: 99},
	}}
	s := newTestStore(t, Config{}, clock, nil, hist)

	// Hour 12 closes in memory but is never flushed; hour 13 is still open
	// with one closed minute and one open minute.
	ingestAt(t, s, clock, 1, t0.Add(5*time.Minute), 20)
	ingestAt(t, s, clock, 1, t0.Add(6*time.Minute), 20)
	ingestAt(t, s, clock, 1, t0.Add(time.Hour+10*time.Second), 40)
	ingestAt(t, s, clock, 1, t0.Add(time.Hour+70*time.Second), 80)
	clock.Set(t0.Add(time.Hour + 90*time.Second))
	s.tick()

	got := mustSeries(t, s, 1, Range7d)
	if p := pointAt(t, got, t0); p.CPU == nil || *p.CPU != 20 {
		t.Fatalf("unflushed hour cpu = %v, want 20 from memory", p.CPU)
	}
	if p := pointAt(t, got, t0.Add(time.Hour)); p.CPU == nil || *p.CPU != 60 {
		t.Fatalf("current hour cpu = %v, want 60 (closed minute 40 + open minute 80)", p.CPU)
	}
}

func TestMinuteBackfillAfterRestart(t *testing.T) {
	var buckets []Bucket
	for m := -120; m < 0; m++ {
		buckets = append(buckets, Bucket{ServerID: 1, Res: Minute, Start: t0.Add(time.Duration(m) * time.Minute), Samples: 12, CPUAvg: 70})
	}
	// The restart minute was partly written by the previous process.
	buckets = append(buckets, Bucket{ServerID: 1, Res: Minute, Start: t0, Samples: 6, CPUAvg: 70})
	hist := &fakeHistory{buckets: buckets}
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, hist)

	ingestAt(t, s, clock, 1, t0.Add(40*time.Second), 10)
	for m := 1; m <= 4; m++ {
		ingestAt(t, s, clock, 1, t0.Add(time.Duration(m)*time.Minute+10*time.Second), 10)
	}
	clock.Set(t0.Add(5 * time.Minute))

	got := mustSeries(t, s, 1, Range6h)
	if hist.callCount() != 1 {
		t.Fatalf("History calls = %d, want 1", hist.callCount())
	}
	if c := hist.calls[0]; c.res != Minute || !c.to.Equal(t0.Add(time.Minute)) {
		t.Fatalf("backfill call %+v, want Minute up to the first fully observed minute", c)
	}
	tests := []struct {
		name string
		at   time.Time
		cpu  float32
	}{
		{"before the restart comes from History", t0.Add(-90 * time.Minute), 70},
		{"restart minute keeps the fuller copy", t0, 70},
		{"after the restart comes from memory", t0.Add(2 * time.Minute), 10},
	}
	for _, tc := range tests {
		if p := pointAt(t, got, tc.at); p.CPU == nil || *p.CPU != tc.cpu {
			t.Errorf("%s: cpu = %v, want %v", tc.name, p.CPU, tc.cpu)
		}
	}
	if p := pointAt(t, got, t0.Add(-121*time.Minute)); p.CPU != nil {
		t.Error("minute with no data anywhere is not nil")
	}

	mustSeries(t, s, 1, Range6h)
	if hist.callCount() != 1 {
		t.Fatalf("backfill not cached: %d calls", hist.callCount())
	}

	// Once the range starts after this process began, memory covers it all.
	clock.Set(t0.Add(7 * time.Hour))
	mustSeries(t, s, 1, Range6h)
	if hist.callCount() != 1 {
		t.Fatalf("steady-state 6h read hit History: %d calls", hist.callCount())
	}
}

func TestSparkline(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	ingestAt(t, s, clock, 1, t0.Add(10*time.Second), 10)
	ingestAt(t, s, clock, 1, t0.Add(70*time.Second), 20)
	// 12:02 has no sample.
	ingestAt(t, s, clock, 1, t0.Add(190*time.Second), 40)
	clock.Set(t0.Add(210 * time.Second))

	tests := []struct {
		name    string
		id      int64
		n       int
		wantCPU []float32
	}{
		{name: "gaps skipped, partial minute included", id: 1, n: 30, wantCPU: []float32{10, 20, 40}},
		{name: "window limits to the last n minutes", id: 1, n: 2, wantCPU: []float32{40}},
		{name: "zero n", id: 1, n: 0, wantCPU: nil},
		{name: "unknown server", id: 7, n: 30, wantCPU: nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cpu, mem, disk := s.Sparkline(tc.id, tc.n)
			if !slices.Equal(cpu, tc.wantCPU) {
				t.Fatalf("cpu = %v, want %v", cpu, tc.wantCPU)
			}
			if len(mem) != len(cpu) || len(disk) != len(cpu) {
				t.Fatalf("slice lengths cpu %d mem %d disk %d differ", len(cpu), len(mem), len(disk))
			}
			for i := range mem {
				if mem[i] != 50 || disk[i] != 40 {
					t.Fatalf("mem/disk at %d = %v/%v, want 50/40", i, mem[i], disk[i])
				}
			}
		})
	}
}
