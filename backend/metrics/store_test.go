package metrics

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

// t0 is a minute- and hour-aligned base time for deterministic tests.
var t0 = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

var errSinkDown = errors.New("sink down")

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock(t time.Time) *fakeClock { return &fakeClock{t: t} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

// fakeSink records written buckets. failNext makes the next N calls fail.
type fakeSink struct {
	mu       sync.Mutex
	failNext int
	calls    int
	sizes    []int
	got      []Bucket
}

func (f *fakeSink) WriteBuckets(_ context.Context, bs []Bucket) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.failNext > 0 {
		f.failNext--
		return errSinkDown
	}
	f.sizes = append(f.sizes, len(bs))
	f.got = append(f.got, bs...)
	return nil
}

func (f *fakeSink) fail(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext = n
}

func (f *fakeSink) buckets() []Bucket {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Bucket(nil), f.got...)
}

type historyCall struct {
	server   int64
	res      Resolution
	from, to time.Time
}

type fakeHistory struct {
	mu      sync.Mutex
	buckets []Bucket
	calls   []historyCall
}

func (f *fakeHistory) ReadBuckets(_ context.Context, serverID int64, res Resolution, from, to time.Time) ([]Bucket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, historyCall{server: serverID, res: res, from: from, to: to})
	var out []Bucket
	for _, b := range f.buckets {
		if b.ServerID == serverID && b.Res == res && !b.Start.Before(from) && b.Start.Before(to) {
			out = append(out, b)
		}
	}
	return out, nil
}

func (f *fakeHistory) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func quietLog() *slog.Logger { return slog.New(slog.DiscardHandler) }

func newTestStore(t *testing.T, cfg Config, clock *fakeClock, sink Sink, hist History) *Store {
	t.Helper()
	cfg.Now = clock.Now
	if sink == nil {
		sink = &fakeSink{}
	}
	s, err := New(cfg, sink, hist, quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func sampleAt(at time.Time, cpu float64) Sample {
	return Sample{
		Time:           at,
		CPUPercent:     cpu,
		CPUCores:       4,
		MemTotalBytes:  8 << 30,
		MemUsedBytes:   4 << 30,
		MemPercent:     50,
		DiskTotalBytes: 100 << 30,
		DiskUsedBytes:  40 << 30,
		DiskPercent:    40,
		UptimeSeconds:  1000,
	}
}

// ingestAt moves the clock to at and ingests a sample stamped at the same time.
func ingestAt(t *testing.T, s *Store, clock *fakeClock, id int64, at time.Time, cpu float64) {
	t.Helper()
	clock.Set(at)
	if _, err := s.Ingest(id, sampleAt(at, cpu), 0); err != nil {
		t.Fatalf("Ingest(%d, %s): %v", id, at.Format(time.TimeOnly), err)
	}
}

func pendingOf(s *Store) []Bucket {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	return append([]Bucket(nil), s.pending...)
}

type bucketID struct {
	res     Resolution
	start   string
	samples int
}

func idsOf(bs []Bucket) []bucketID {
	out := make([]bucketID, 0, len(bs))
	for _, b := range bs {
		out = append(out, bucketID{res: b.Res, start: b.Start.Format(time.TimeOnly), samples: b.Samples})
	}
	return out
}

func equalIDs(a, b []bucketID) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestMinuteBoundaryAndGrace(t *testing.T) {
	type action struct {
		now      time.Duration // offset from t0 for the clock
		sampleAt time.Duration // offset for Sample.Time; ignored for ticks
		tick     bool
	}
	ingest := func(now, at time.Duration) action { return action{now: now, sampleAt: at} }
	tick := func(now time.Duration) action { return action{now: now, tick: true} }
	sec := time.Second

	tests := []struct {
		name    string
		actions []action
		want    []bucketID
	}{
		{
			name:    "minute stays open until grace has fully passed",
			actions: []action{ingest(10*sec, 10*sec), ingest(50*sec, 50*sec), tick(65 * sec)},
			want:    []bucketID{},
		},
		{
			name:    "minute closes once now is past end plus grace",
			actions: []action{ingest(10*sec, 10*sec), ingest(50*sec, 50*sec), tick(65*sec + time.Millisecond)},
			want:    []bucketID{{Minute, "12:00:00", 2}},
		},
		{
			name: "sample arriving inside the grace window joins its minute",
			actions: []action{
				ingest(58*sec, 58*sec),
				ingest(63*sec, 59*sec), // 4 s late, still within the 5 s grace
				tick(66 * sec),
			},
			want: []bucketID{{Minute, "12:00:00", 2}},
		},
		{
			name: "sample delayed beyond grace is restamped to receive time",
			actions: []action{
				ingest(10*sec, 10*sec),
				ingest(70*sec, 50*sec), // 20 s late: counted in 12:01, not the closed 12:00
				tick(126 * sec),
			},
			want: []bucketID{{Minute, "12:00:00", 1}, {Minute, "12:01:00", 1}},
		},
		{
			name:    "a sample for a later minute closes the open one without a tick",
			actions: []action{ingest(10*sec, 10*sec), ingest(60*sec, 60*sec)},
			want:    []bucketID{{Minute, "12:00:00", 1}},
		},
		{
			name:    "hour closes after its last minute, in the same tick",
			actions: []action{ingest(59*time.Minute+30*sec, 59*time.Minute+30*sec), tick(time.Hour + 6*sec)},
			want:    []bucketID{{Minute, "12:59:00", 1}, {Hour, "12:00:00", 1}},
		},
		{
			name: "hour rolls over lazily when a minute of the next hour closes",
			actions: []action{
				ingest(59*time.Minute, 59*time.Minute),
				ingest(time.Hour+sec, time.Hour+sec),
				ingest(time.Hour+61*sec, time.Hour+61*sec),
			},
			want: []bucketID{{Minute, "12:59:00", 1}, {Hour, "12:00:00", 1}, {Minute, "13:00:00", 1}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := newClock(t0)
			s := newTestStore(t, Config{}, clock, nil, nil)
			for _, a := range tc.actions {
				clock.Set(t0.Add(a.now))
				if a.tick {
					s.tick()
					continue
				}
				if _, err := s.Ingest(1, sampleAt(t0.Add(a.sampleAt), 10), 0); err != nil {
					t.Fatalf("Ingest: %v", err)
				}
			}
			if got := idsOf(pendingOf(s)); !equalIDs(got, tc.want) {
				t.Fatalf("pending = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMinuteAggregateValues(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	samples := []struct {
		at       time.Duration
		cpu, mem float64
		rx, tx   uint64
	}{
		{at: 0, cpu: 10, mem: 40, rx: 0, tx: 0},
		{at: 10 * time.Second, cpu: 30, mem: 60, rx: 10_000, tx: 1_000},
		{at: 20 * time.Second, cpu: 20, mem: 50, rx: 30_000, tx: 2_000},
	}
	for _, sm := range samples {
		at := t0.Add(sm.at)
		clock.Set(at)
		smp := sampleAt(at, sm.cpu)
		smp.MemPercent, smp.NetRxTotal, smp.NetTxTotal = sm.mem, sm.rx, sm.tx
		smp.UptimeSeconds = int64(sm.at / time.Second)
		if _, err := s.Ingest(1, smp, 0); err != nil {
			t.Fatal(err)
		}
	}
	clock.Set(t0.Add(time.Minute + 6*time.Second))
	s.tick()

	p := pendingOf(s)
	if len(p) != 1 {
		t.Fatalf("pending = %d buckets, want 1", len(p))
	}
	b := p[0]
	checks := []struct {
		name      string
		got, want float32
	}{
		{"cpu avg", b.CPUAvg, 20},
		{"cpu max", b.CPUMax, 30},
		{"mem avg", b.MemAvg, 50},
		{"mem max", b.MemMax, 60},
		{"disk avg", b.DiskAvg, 40},
		{"net in avg", b.NetInAvg, (0 + 1000 + 2000) / 3.0},
		{"net in max", b.NetInMax, 2000},
		{"net out avg", b.NetOutAvg, (0 + 100 + 100) / 3.0},
		{"net out max", b.NetOutMax, 100},
	}
	for _, c := range checks {
		if math.Abs(float64(c.got-c.want)) > 1e-3 {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}
	if b.Samples != 3 || b.UptimeSeconds != 20 || b.MemTotalBytes != 8<<30 {
		t.Errorf("samples/uptime/mem total = %d/%d/%d, want 3/20/%d", b.Samples, b.UptimeSeconds, b.MemTotalBytes, 8<<30)
	}
}

func TestNetRates(t *testing.T) {
	steps := []struct {
		name            string
		at              time.Duration
		rx, tx          uint64
		wantIn, wantOut float32
	}{
		{name: "first sample has no baseline", at: 0, rx: 1_000_000, tx: 500_000, wantIn: 0, wantOut: 0},
		{name: "delta over elapsed seconds", at: 5 * time.Second, rx: 1_050_000, tx: 510_000, wantIn: 10_000, wantOut: 2_000},
		{name: "counter went backwards (reboot) gives 0", at: 10 * time.Second, rx: 4_000, tx: 1_000, wantIn: 0, wantOut: 0},
		{name: "rate resumes from the new baseline", at: 20 * time.Second, rx: 24_000, tx: 2_000, wantIn: 2_000, wantOut: 100},
	}
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	for _, st := range steps {
		t.Run(st.name, func(t *testing.T) {
			at := t0.Add(st.at)
			clock.Set(at)
			smp := sampleAt(at, 1)
			smp.NetRxTotal, smp.NetTxTotal = st.rx, st.tx
			p, err := s.Ingest(1, smp, 0)
			if err != nil {
				t.Fatal(err)
			}
			if p.NetInBps != st.wantIn || p.NetOutBps != st.wantOut {
				t.Fatalf("rates = (%v, %v), want (%v, %v)", p.NetInBps, p.NetOutBps, st.wantIn, st.wantOut)
			}
		})
	}
}

func TestIngestValidation(t *testing.T) {
	tests := []struct {
		name    string
		id      int64
		mutate  func(*Sample)
		wantErr bool
		wantCPU float32
	}{
		{name: "valid", id: 1, mutate: func(*Sample) {}, wantCPU: 10},
		{name: "NaN cpu", id: 1, mutate: func(s *Sample) { s.CPUPercent = math.NaN() }, wantErr: true},
		{name: "infinite mem", id: 1, mutate: func(s *Sample) { s.MemPercent = math.Inf(1) }, wantErr: true},
		{name: "negative mem", id: 1, mutate: func(s *Sample) { s.MemPercent = -1 }, wantErr: true},
		{name: "disk over 100", id: 1, mutate: func(s *Sample) { s.DiskPercent = 101 }, wantErr: true},
		{name: "float rounding over 100 is clamped", id: 1, mutate: func(s *Sample) { s.CPUPercent = 100.000001 }, wantCPU: 100},
		{name: "negative cores", id: 1, mutate: func(s *Sample) { s.CPUCores = -1 }, wantErr: true},
		{name: "negative uptime", id: 1, mutate: func(s *Sample) { s.UptimeSeconds = -5 }, wantErr: true},
		{name: "non-positive server id", id: 0, mutate: func(*Sample) {}, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := newClock(t0)
			s := newTestStore(t, Config{}, clock, nil, nil)
			smp := sampleAt(t0, 10)
			tc.mutate(&smp)
			p, err := s.Ingest(tc.id, smp, 0)
			if tc.wantErr {
				if !errors.Is(err, errInvalidSample) {
					t.Fatalf("err = %v, want errInvalidSample", err)
				}
				if _, ok := s.Latest(tc.id); ok {
					t.Fatal("invalid sample was recorded")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if p.CPU != tc.wantCPU {
				t.Fatalf("cpu = %v, want %v", p.CPU, tc.wantCPU)
			}
		})
	}
}

func TestMinIntervalDrops(t *testing.T) {
	tests := []struct {
		name        string
		minInterval time.Duration
		second      time.Duration // offset of the second sample after the first
		wantDrop    bool
	}{
		{name: "faster than the minimum is dropped", minInterval: 10 * time.Second, second: 5 * time.Second, wantDrop: true},
		{name: "exactly the minimum is kept", minInterval: 10 * time.Second, second: 10 * time.Second},
		{name: "arrival jitter within slack is kept", minInterval: 5 * time.Second, second: 4980 * time.Millisecond},
		{name: "zero minimum keeps any later sample", minInterval: 0, second: time.Millisecond},
		{name: "same timestamp is always dropped", minInterval: 0, second: 0, wantDrop: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := newClock(t0)
			s := newTestStore(t, Config{}, clock, nil, nil)
			first := sampleAt(t0, 10)
			first.NetRxTotal = 1000
			if _, err := s.Ingest(1, first, tc.minInterval); err != nil {
				t.Fatal(err)
			}
			at := t0.Add(tc.second)
			clock.Set(at)
			second := sampleAt(at, 90)
			second.NetRxTotal = 2000
			_, err := s.Ingest(1, second, tc.minInterval)
			latest, _ := s.Latest(1)
			if tc.wantDrop {
				if !errors.Is(err, ErrTooFrequent) {
					t.Fatalf("err = %v, want ErrTooFrequent", err)
				}
				if latest.CPU != 10 {
					t.Fatalf("dropped sample was recorded: latest cpu %v", latest.CPU)
				}
				if s.lookup(1).raw.size() != 1 {
					t.Fatal("dropped sample reached the raw ring")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if latest.CPU != 90 {
				t.Fatalf("latest cpu = %v, want 90", latest.CPU)
			}
		})
	}
}

func TestLatestAndLastSeen(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	if _, ok := s.Latest(1); ok {
		t.Fatal("Latest for an unknown server reported ok")
	}
	ingestAt(t, s, clock, 1, t0.Add(3*time.Second), 42)
	ingestAt(t, s, clock, 2, t0.Add(4*time.Second), 7)

	l, ok := s.Latest(1)
	if !ok || l.CPU != 42 || l.CPUCores != 4 || l.MemUsedBytes != 4<<30 || !l.ReceivedAt.Equal(t0.Add(3*time.Second)) {
		t.Fatalf("Latest(1) = %+v, %v", l, ok)
	}
	seen := s.LastSeen()
	if len(seen) != 2 || !seen[2].Equal(t0.Add(4*time.Second)) {
		t.Fatalf("LastSeen = %v", seen)
	}
}

func TestFlushSuccess(t *testing.T) {
	clock := newClock(t0)
	sink := &fakeSink{}
	s := newTestStore(t, Config{}, clock, sink, nil)
	type ctxKey struct{}
	var hookCtxs []context.Context
	s.OnFlush(func(ctx context.Context) { hookCtxs = append(hookCtxs, ctx) })

	for m := range 3 {
		ingestAt(t, s, clock, 1, t0.Add(time.Duration(m)*time.Minute), 10)
	}
	clock.Set(t0.Add(3*time.Minute + 6*time.Second))
	s.tick()
	want := idsOf(pendingOf(s))

	ctx := context.WithValue(context.Background(), ctxKey{}, "flush")
	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if got := idsOf(sink.buckets()); !equalIDs(got, want) {
		t.Fatalf("sink got %v, want %v", got, want)
	}
	st := s.Stats()
	if st.PendingBuckets != 0 || st.Flushes != 1 || st.LastFlushErr != "" || !st.LastFlush.Equal(clock.Now()) {
		t.Fatalf("stats after flush = %+v", st)
	}
	if len(hookCtxs) != 1 || hookCtxs[0].Value(ctxKey{}) != "flush" {
		t.Fatalf("hooks ran %d times or without the flush ctx", len(hookCtxs))
	}

	// An empty flush still counts and still runs hooks, without calling the Sink.
	calls := sink.calls
	if err := s.Flush(ctx); err != nil {
		t.Fatalf("empty Flush: %v", err)
	}
	if sink.calls != calls || len(hookCtxs) != 2 || s.Stats().Flushes != 2 {
		t.Fatalf("empty flush: sink calls %d->%d, hooks %d, flushes %d", calls, sink.calls, len(hookCtxs), s.Stats().Flushes)
	}
}

func syntheticBuckets(n int, server int64) []Bucket {
	out := make([]Bucket, n)
	for i := range out {
		out[i] = Bucket{ServerID: server, Res: Minute, Start: t0.Add(time.Duration(i) * time.Minute), Samples: 1}
	}
	return out
}

func TestFlushBatches(t *testing.T) {
	clock := newClock(t0)
	sink := &fakeSink{}
	s := newTestStore(t, Config{}, clock, sink, nil)
	s.enqueue(syntheticBuckets(2500, 1))
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if want := []int{1000, 1000, 500}; len(sink.sizes) != len(want) || sink.sizes[0] != want[0] || sink.sizes[2] != want[2] {
		t.Fatalf("batch sizes = %v, want %v", sink.sizes, want)
	}
}

func TestFlushFailureRequeuesThenSucceeds(t *testing.T) {
	tests := []struct {
		name        string
		buckets     int
		failOnCall  int // 1-based Sink call that fails
		wantWritten int // buckets written by the failed attempt
	}{
		{name: "first batch fails", buckets: 3, failOnCall: 1, wantWritten: 0},
		{name: "second batch fails after the first was written", buckets: 2500, failOnCall: 2, wantWritten: 1000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := newClock(t0)
			sink := &failingOnCall{failOn: tc.failOnCall}
			s := newTestStore(t, Config{}, clock, sink, nil)
			hooks := 0
			s.OnFlush(func(context.Context) { hooks++ })
			all := syntheticBuckets(tc.buckets, 1)
			s.enqueue(all)

			err := s.Flush(context.Background())
			if !errors.Is(err, errSinkDown) {
				t.Fatalf("Flush err = %v, want errSinkDown", err)
			}
			st := s.Stats()
			if st.PendingBuckets != tc.buckets-tc.wantWritten || st.LastFlushErr == "" || st.Flushes != 0 || hooks != 1 {
				t.Fatalf("after failure: %+v, hooks %d", st, hooks)
			}
			// Buckets closed while the DB was down queue behind the requeued ones.
			late := Bucket{ServerID: 2, Res: Minute, Start: t0, Samples: 1}
			s.enqueue([]Bucket{late})
			p := pendingOf(s)
			if !p[0].Start.Equal(all[tc.wantWritten].Start) || p[len(p)-1].ServerID != 2 {
				t.Fatal("requeue did not keep order")
			}

			if err := s.Flush(context.Background()); err != nil {
				t.Fatalf("second Flush: %v", err)
			}
			got := sink.written()
			if len(got) != tc.buckets+1 {
				t.Fatalf("sink got %d buckets, want %d", len(got), tc.buckets+1)
			}
			for i := range all {
				if !got[i].Start.Equal(all[i].Start) {
					t.Fatalf("bucket %d out of order", i)
				}
			}
			st = s.Stats()
			if st.PendingBuckets != 0 || st.LastFlushErr != "" || st.Flushes != 1 || hooks != 2 {
				t.Fatalf("after recovery: %+v, hooks %d", st, hooks)
			}
		})
	}
}

// failingOnCall fails exactly one Sink call (1-based).
type failingOnCall struct {
	mu     sync.Mutex
	failOn int
	calls  int
	got    []Bucket
}

func (f *failingOnCall) WriteBuckets(_ context.Context, bs []Bucket) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.calls == f.failOn {
		return errSinkDown
	}
	f.got = append(f.got, bs...)
	return nil
}

func (f *failingOnCall) written() []Bucket {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Bucket(nil), f.got...)
}

func TestPendingCapDropsOldest(t *testing.T) {
	clock := newClock(t0)
	sink := &fakeSink{}
	s := newTestStore(t, Config{MaxPendingBuckets: 3}, clock, sink, nil)
	all := syntheticBuckets(5, 1)
	s.enqueue(all)

	p := pendingOf(s)
	if len(p) != 3 || !p[0].Start.Equal(all[2].Start) || s.Stats().DroppedBuckets != 2 {
		t.Fatalf("pending %d starting %s, dropped %d; want 3 starting %s, dropped 2",
			len(p), p[0].Start.Format(time.TimeOnly), s.Stats().DroppedBuckets, all[2].Start.Format(time.TimeOnly))
	}

	// A failed flush requeues in front of new arrivals, and the cap then drops
	// the oldest of the combined queue.
	sink.fail(1)
	_ = s.Flush(context.Background())
	s.enqueue(syntheticBuckets(2, 2))
	p = pendingOf(s)
	if len(p) != 3 || p[0].ServerID != 1 || p[1].ServerID != 2 || s.Stats().DroppedBuckets != 4 {
		t.Fatalf("after requeue: %v servers, dropped %d", idsOf(p), s.Stats().DroppedBuckets)
	}
}

func TestForget(t *testing.T) {
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, nil, nil)
	for _, id := range []int64{1, 2} {
		ingestAt(t, s, clock, id, t0, 10)
		ingestAt(t, s, clock, id, t0.Add(time.Minute), 10)
	}
	s.Forget(1)

	for _, b := range pendingOf(s) {
		if b.ServerID == 1 {
			t.Fatal("pending still holds buckets of the forgotten server")
		}
	}
	if _, ok := s.Latest(1); ok {
		t.Fatal("Latest still reports the forgotten server")
	}
	if cpu, _, _ := s.Sparkline(1, 30); cpu != nil {
		t.Fatal("Sparkline still reports the forgotten server")
	}
	if _, err := s.Ingest(1, sampleAt(clock.Now().Add(time.Minute), 1), 0); !errors.Is(err, errForgotten) {
		t.Fatalf("Ingest after Forget err = %v, want errForgotten", err)
	}
	if s.Stats().Servers != 1 {
		t.Fatalf("servers = %d, want 1", s.Stats().Servers)
	}
}

// blockingSink holds WriteBuckets until released, then fails, so a test can
// act while a flush is in flight.
type blockingSink struct {
	entered chan struct{}
	release chan struct{}
}

func (b *blockingSink) WriteBuckets(context.Context, []Bucket) error {
	b.entered <- struct{}{}
	<-b.release
	return errSinkDown
}

func TestForgetDuringFlushIsNotRequeued(t *testing.T) {
	clock := newClock(t0)
	sink := &blockingSink{entered: make(chan struct{}), release: make(chan struct{})}
	s := newTestStore(t, Config{}, clock, sink, nil)
	s.enqueue(syntheticBuckets(2, 1))
	s.enqueue(syntheticBuckets(2, 2))

	done := make(chan error, 1)
	go func() { done <- s.Flush(context.Background()) }()
	<-sink.entered
	s.Forget(1)
	close(sink.release)
	if err := <-done; !errors.Is(err, errSinkDown) {
		t.Fatalf("Flush err = %v", err)
	}
	for _, b := range pendingOf(s) {
		if b.ServerID == 1 {
			t.Fatal("bucket of a server forgotten mid-flush was requeued")
		}
	}
	if n := len(pendingOf(s)); n != 2 {
		t.Fatalf("pending = %d, want 2", n)
	}
}

func TestRunShutdownFlushesPartialBuckets(t *testing.T) {
	clock := newClock(t0.Add(10 * time.Second))
	sink := &fakeSink{}
	dir := t.TempDir()
	s := newTestStore(t, Config{JournalDir: dir}, clock, sink, nil)
	hooked := make(chan struct{}, 1)
	s.OnFlush(func(context.Context) { hooked <- struct{}{} })

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()

	ingestAt(t, s, clock, 1, t0.Add(10*time.Second), 25)
	ingestAt(t, s, clock, 1, t0.Add(20*time.Second), 75)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	want := []bucketID{{Minute, "12:00:00", 2}, {Hour, "12:00:00", 2}}
	if got := idsOf(sink.buckets()); !equalIDs(got, want) {
		t.Fatalf("final flush wrote %v, want %v", got, want)
	}
	if got := sink.buckets()[1].CPUAvg; got != 50 {
		t.Fatalf("partial hour cpu avg = %v, want 50", got)
	}
	select {
	case <-hooked:
	default:
		t.Fatal("OnFlush hook did not run on shutdown")
	}
	if files := journalFiles(t, dir); len(files) != 0 {
		t.Fatalf("journal files left after a clean shutdown: %v", files)
	}
}

// atomicClock is a lock-free clock for the concurrency test.
type atomicClock struct{ n atomic.Int64 }

func (c *atomicClock) Now() time.Time { return time.Unix(0, c.n.Load()).UTC() }

func TestConcurrentIngestAndRead(t *testing.T) {
	const (
		writers         = 8
		samplesPerWrite = 400
		sharedServer    = 99
	)
	clock := &atomicClock{}
	clock.n.Store(t0.UnixNano())
	sink := &fakeSink{}
	s, err := New(Config{JournalDir: t.TempDir(), Now: clock.Now}, sink, &fakeHistory{}, quietLog())
	if err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	var bg sync.WaitGroup
	loop := func(fn func()) {
		bg.Add(1)
		go func() {
			defer bg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					fn()
				}
			}
		}()
	}
	ranges := []Range{RangeLive, Range1h, Range6h, Range24h, Range7d, Range30d}
	var ri atomic.Int64
	loop(func() {
		r := ranges[int(ri.Add(1))%len(ranges)]
		if _, err := s.Series(context.Background(), 1, r); err != nil {
			t.Errorf("Series(%s): %v", r, err)
		}
	})
	loop(func() {
		s.Latest(sharedServer)
		s.Sparkline(2, 30)
		s.LastSeen()
		s.Stats()
	})
	loop(func() { s.tick() })
	loop(func() {
		if err := s.Flush(context.Background()); err != nil {
			t.Errorf("Flush: %v", err)
		}
	})

	var writersWG sync.WaitGroup
	for w := range writers {
		writersWG.Add(1)
		go func() {
			defer writersWG.Done()
			own := int64(w + 1)
			for i := range samplesPerWrite {
				clock.n.Add(int64(2 * time.Second)) // 8 writers x 400 x 2 s crosses an hour boundary
				_, err := s.Ingest(own, Sample{CPUPercent: float64(i % 100), NetRxTotal: uint64(i)}, 0)
				if err != nil && !errors.Is(err, ErrTooFrequent) && !(own == writers && errors.Is(err, errForgotten)) {
					t.Errorf("Ingest own: %v", err)
				}
				// Many writers on one server: same-timestamp collisions are fine.
				if _, err := s.Ingest(sharedServer, Sample{CPUPercent: 1}, 0); err != nil && !errors.Is(err, ErrTooFrequent) {
					t.Errorf("Ingest shared: %v", err)
				}
				if w == 0 && i == samplesPerWrite/2 {
					s.Forget(writers) // the last writer's server disappears mid-stream
				}
			}
		}()
	}
	writersWG.Wait()
	close(stop)
	bg.Wait()

	s.closeEverything()
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sink.buckets()) == 0 {
		t.Fatal("nothing was flushed")
	}
}

func TestCompactLayout(t *testing.T) {
	if got := unsafe.Sizeof(rawPoint{}); got != 32 {
		t.Errorf("rawPoint is %d bytes, want 32", got)
	}
	if got := unsafe.Sizeof(cbucket{}); got != 72 {
		t.Errorf("cbucket is %d bytes, want 72", got)
	}
}

// TestMemoryPerServer fills every ring to its default capacity and measures
// the retained heap per server against the ~140 KB budget in PLAN.md 2.3.2.
func TestMemoryPerServer(t *testing.T) {
	if testing.Short() {
		t.Skip("memory measurement")
	}
	const (
		servers = 20
		budget  = 160 << 10 // 140 KB target plus slack for map and allocator overhead
	)
	clock := newClock(t0)
	s := newTestStore(t, Config{}, clock, discardSink{}, nil)

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)

	// One sample per minute for a day and an hour fills the recent ring
	// (1440), the hour ring (24) and the raw ring (900, bounded by count).
	minutes := s.recentCap + minutesPerHour + 1
	for id := int64(1); id <= servers; id++ {
		for m := range minutes {
			at := t0.Add(time.Duration(m) * time.Minute)
			clock.Set(at)
			if _, err := s.Ingest(id, sampleAt(at, 10), 0); err != nil {
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
	if st.raw.size() != s.rawCap || st.recent.size() != s.recentCap || st.hours.size() != s.hourCap {
		t.Fatalf("rings not full: raw %d/%d recent %d/%d hours %d/%d",
			st.raw.size(), s.rawCap, st.recent.size(), s.recentCap, st.hours.size(), s.hourCap)
	}
	perServer := (int64(after.HeapAlloc) - int64(before.HeapAlloc)) / servers
	t.Logf("retained heap per server at default windows: %d bytes (%.1f KB)", perServer, float64(perServer)/1024)
	if perServer > budget {
		t.Fatalf("per-server memory %d bytes over budget %d", perServer, budget)
	}
}

type discardSink struct{}

func (discardSink) WriteBuckets(context.Context, []Bucket) error { return nil }

func TestNewRejectsBadConfig(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		sink Sink
	}{
		{name: "nil sink", cfg: Config{}, sink: nil},
		{name: "negative window", cfg: Config{RawWindow: -time.Second}, sink: discardSink{}},
		{name: "negative cap", cfg: Config{MaxPendingBuckets: -1}, sink: discardSink{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(tc.cfg, tc.sink, nil, quietLog()); err == nil {
				t.Fatal("New accepted an invalid config")
			}
		})
	}
}
