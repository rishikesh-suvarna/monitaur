package checks

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type resolved struct {
	id  int64
	how ResolveHow
}

type fakeStore struct {
	mu        sync.Mutex
	nextID    int64
	opened    []Incident
	resolved  []resolved
	progress  map[int64]Incident
	open      []Incident // returned by LoadOpenIncidents
	recent    []HourRollup
	history   []HourRollup
	hours     []HourRollup
	days      []DayRollup
	failWrite bool
	reads     int
}

func newFakeStore() *fakeStore { return &fakeStore{nextID: 100, progress: map[int64]Incident{}} }

func (f *fakeStore) OpenIncident(_ context.Context, inc Incident) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	inc.ID = f.nextID
	f.opened = append(f.opened, inc)
	return inc.ID, nil
}

func (f *fakeStore) ResolveIncident(_ context.Context, id int64, _ time.Time, how ResolveHow, _ float64, _ int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resolved = append(f.resolved, resolved{id, how})
	return nil
}

func (f *fakeStore) SaveProgress(_ context.Context, id int64, peak, last float64, samples int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.progress[id] = Incident{ID: id, Peak: peak, LastValue: last, SamplesOver: samples}
	return nil
}

func (f *fakeStore) LoadOpenIncidents(context.Context) ([]Incident, error) { return f.open, nil }

func (f *fakeStore) WriteRollups(_ context.Context, hours []HourRollup, days []DayRollup) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWrite {
		return errors.New("database asleep")
	}
	f.hours, f.days = append(f.hours, hours...), append(f.days, days...)
	return nil
}

func (f *fakeStore) ReadHours(context.Context, int64, time.Time, time.Time) ([]HourRollup, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	return f.history, nil
}

func (f *fakeStore) RecentHours(context.Context, time.Time) ([]HourRollup, error) {
	return f.recent, nil
}

type fakeNotifier struct {
	mu     sync.Mutex
	events []Event
}

func (n *fakeNotifier) Notify(_ context.Context, ev Event) {
	n.mu.Lock()
	n.events = append(n.events, ev)
	n.mu.Unlock()
}

func (n *fakeNotifier) kinds() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []string
	for _, e := range n.events {
		out = append(out, string(e.Kind)+":"+e.Incident.Metric)
	}
	return out
}

var t0 = time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)

func newTestScheduler(t *testing.T, st *fakeStore, checks ...Check) (*Scheduler, *fakeNotifier, *fakeClock) {
	t.Helper()
	clock := &fakeClock{t: t0}
	n := &fakeNotifier{}
	s := NewScheduler(Config{Now: clock.Now, Probe: func(context.Context, Check) Result {
		t.Fatal("unexpected network probe")
		return Result{}
	}}, st, n, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := s.Load(context.Background(), checks); err != nil {
		t.Fatal(err)
	}
	return s, n, clock
}

func ok(at time.Time, ms int) Result {
	return Result{At: at, OK: true, Latency: time.Duration(ms) * time.Millisecond, StatusCode: http.StatusOK}
}

func failed(at time.Time) Result {
	return Result{At: at, Latency: time.Second, Error: "connection refused"}
}

func withDays(r Result, days int) Result {
	r.CertDaysLeft = &days
	return r
}

func (s *Scheduler) snap(id int64) Snapshot { return s.Snapshots([]int64{id})[id] }

func TestStateMachineOpensAfterTwoFailuresAndResolvesAfterTwoSuccesses(t *testing.T) {
	st := newFakeStore()
	s, n, clock := newTestScheduler(t, st, httpCheck("https://example.com"))
	steps := []struct {
		name       string
		res        func(time.Time) Result
		wantStatus Status
		wantEvents []string
		wantOpen   int
	}{
		{"first success", func(at time.Time) Result { return ok(at, 20) }, StatusUp, nil, 0},
		{"one failure is degraded", failed, StatusDegraded, nil, 0},
		{"second failure opens", failed, StatusDown, []string{"fired:http"}, 1},
		{"still failing, no new incident", failed, StatusDown, []string{"fired:http"}, 1},
		{"one success is not enough", func(at time.Time) Result { return ok(at, 20) }, StatusDown, []string{"fired:http"}, 1},
		{"second success resolves", func(at time.Time) Result { return ok(at, 20) }, StatusUp, []string{"fired:http", "resolved:http"}, 0},
	}
	for _, step := range steps {
		clock.Advance(time.Minute)
		s.record(context.Background(), 1, 0, step.res(clock.Now()))
		snap := s.snap(1)
		if snap.Status != step.wantStatus || snap.OpenIncidents != step.wantOpen || !slices.Equal(n.kinds(), step.wantEvents) {
			t.Fatalf("%s: status %s open %d events %v, want %s %d %v", step.name, snap.Status, snap.OpenIncidents,
				n.kinds(), step.wantStatus, step.wantOpen, step.wantEvents)
		}
	}
	if len(st.opened) != 1 || len(st.resolved) != 1 || st.resolved[0] != (resolved{st.opened[0].ID, ResolvedAuto}) {
		t.Fatalf("opened %+v resolved %+v", st.opened, st.resolved)
	}
	inc := st.opened[0]
	if inc.Metric != "http" || inc.Severity != SeverityCritical || inc.CheckID != 1 || inc.OrgID != 1 ||
		!inc.StartedAt.Equal(t0.Add(2*time.Minute)) {
		t.Fatalf("incident = %+v (must start at the first failure)", inc)
	}
	// The resolve event carries the progress made while open.
	last := n.events[len(n.events)-1]
	if last.How != ResolvedAuto || last.Incident.Peak != 3 || last.Incident.SamplesOver != 3 {
		t.Fatalf("resolved event = %+v", last)
	}
	snap := s.snap(1)
	if snap.Uptime24h == nil || *snap.Uptime24h != 50 || len(snap.LatencySpark) != 6 || snap.Last == nil || !snap.Last.OK {
		t.Fatalf("snapshot = %+v", snap)
	}
}

func TestCertificateExpiryWarning(t *testing.T) {
	st := newFakeStore()
	c := Check{ID: 7, OrgID: 2, Name: "tls", Type: TypeTLS, Target: "example.com:443", Interval: time.Minute,
		Timeout: testTimeout, TLSWarnDays: 14, Enabled: true}
	s, n, clock := newTestScheduler(t, st, c)
	steps := []struct {
		days       int
		wantStatus Status
		wantEvents []string
	}{
		{30, StatusUp, nil},
		{10, StatusDegraded, []string{"fired:tls_expiry"}},
		{9, StatusDegraded, []string{"fired:tls_expiry"}},
		{90, StatusUp, []string{"fired:tls_expiry", "resolved:tls_expiry"}}, // renewed
	}
	for _, step := range steps {
		clock.Advance(time.Minute)
		s.record(context.Background(), 7, 0, withDays(ok(clock.Now(), 30), step.days))
		snap := s.snap(7)
		if snap.Status != step.wantStatus || !slices.Equal(n.kinds(), step.wantEvents) || *snap.TLSDaysLeft != step.days {
			t.Fatalf("days %d: status %s events %v days %v", step.days, snap.Status, n.kinds(), *snap.TLSDaysLeft)
		}
	}
	inc := st.opened[0]
	if inc.Severity != SeverityWarning || inc.LastValue != 10 || inc.Threshold != 14 || inc.RuleName != ExpiryRuleName {
		t.Fatalf("expiry incident = %+v", inc)
	}
	if fired := n.events[0]; fired.Incident.LastValue != 10 {
		t.Fatalf("fired value = %v, want days left", fired.Incident.LastValue)
	}
}

func TestLoadResumesOpenIncidents(t *testing.T) {
	st := newFakeStore()
	st.open = []Incident{
		{ID: 11, OrgID: 1, CheckID: 1, Metric: "http", Severity: SeverityCritical, Peak: 4, LastValue: 4, SamplesOver: 4, StartedAt: t0.Add(-time.Hour)},
		{ID: 12, OrgID: 1, CheckID: 1, Metric: "http", Severity: SeverityCritical, StartedAt: t0.Add(-time.Minute)}, // duplicate
		{ID: 13, OrgID: 1, CheckID: 99, Metric: "tcp", Severity: SeverityCritical, StartedAt: t0},                   // unknown check
	}
	// Hours flushed before the restart count toward the 24 h view.
	st.recent = []HourRollup{{CheckID: 1, Start: t0.Add(-2 * time.Hour), Total: 60, OK: 30, LatencyAvgMS: 10, LatencyMaxMS: 20}}
	s, n, clock := newTestScheduler(t, st, httpCheck("https://example.com"))

	snap := s.snap(1)
	if snap.Status != StatusDown || snap.OpenIncidents != 1 || snap.Uptime24h == nil || *snap.Uptime24h != 50 {
		t.Fatalf("after restart = %+v", snap)
	}
	if !slices.Equal(st.resolved, []resolved{{12, ResolvedAuto}, {13, ResolvedCheckChanged}}) {
		t.Fatalf("stale incidents resolved = %+v", st.resolved)
	}
	for range successesToResolve {
		clock.Advance(time.Minute)
		s.record(context.Background(), 1, 0, ok(clock.Now(), 15))
	}
	if snap := s.snap(1); snap.Status != StatusUp || len(st.opened) != 0 || st.resolved[2] != (resolved{11, ResolvedAuto}) {
		t.Fatalf("resume did not resolve the stored incident: %+v %+v", snap, st.resolved)
	}
	if n.kinds()[0] != "resolved:http" {
		t.Fatalf("events = %v", n.kinds())
	}
	series, err := s.Results(context.Background(), 1, Range24h)
	if err != nil {
		t.Fatal(err)
	}
	var seeded, live int
	for _, p := range series.Points {
		switch {
		case p.UpPct != nil && *p.UpPct == 50:
			seeded++
		case p.UpPct != nil && *p.UpPct == 100:
			live++
		}
	}
	if len(series.Points) != 96 || series.StepSeconds != 900 || seeded != 4 || live != 1 {
		t.Fatalf("24h series: %d points, step %d, seeded %d, live %d", len(series.Points), series.StepSeconds, seeded, live)
	}
}

func TestEditsAndManualResolve(t *testing.T) {
	st := newFakeStore()
	c := httpCheck("https://example.com")
	s, n, clock := newTestScheduler(t, st, c)
	fail := func() {
		clock.Advance(time.Minute)
		s.record(context.Background(), 1, s.version(1), failed(clock.Now()))
	}
	fail()
	fail()
	if s.snap(1).OpenIncidents != 1 {
		t.Fatal("no incident opened")
	}

	// Manual resolve: a still-failing check needs two new failures.
	if err := s.Resolve(context.Background(), st.opened[0].ID, clock.Now()); err != nil {
		t.Fatal(err)
	}
	if err := s.Resolve(context.Background(), st.opened[0].ID, clock.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second resolve error = %v", err)
	}
	fail()
	if len(st.opened) != 1 {
		t.Fatal("one failure after a manual resolve re-opened")
	}
	fail()
	if len(st.opened) != 2 {
		t.Fatal("two failures after a manual resolve did not re-open")
	}

	// Renaming keeps state; re-targeting starts over and closes quietly.
	c.Name = "renamed"
	if s.Upsert(context.Background(), c) || s.snap(1).Status != StatusDown {
		t.Fatal("rename changed state")
	}
	before := len(n.events)
	c.Target = "https://example.org"
	if !s.Upsert(context.Background(), c) {
		t.Fatal("re-target did not close incidents")
	}
	if snap := s.snap(1); snap.Status != StatusPending || snap.OpenIncidents != 0 || snap.Last != nil {
		t.Fatalf("after re-target = %+v", snap)
	}
	if got := st.resolved[len(st.resolved)-1]; got != (resolved{st.opened[1].ID, ResolvedCheckChanged}) || len(n.events) != before {
		t.Fatalf("re-target resolve = %+v, events %d -> %d", got, before, len(n.events))
	}
	// A result probed against the old target is dropped.
	s.record(context.Background(), 1, 0, failed(clock.Now()))
	if s.snap(1).Last != nil {
		t.Fatal("stale result recorded")
	}

	c.Enabled = false
	s.Upsert(context.Background(), c)
	if s.snap(1).Status != StatusPaused {
		t.Fatal("not paused")
	}
	s.Remove(1)
	if _, ok := s.Snapshots([]int64{1})[1]; ok {
		t.Fatal("removed check still known")
	}
}

func (s *Scheduler) version(id int64) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.states[id].version
}

func TestFlushWritesMergedRollupsAndRetries(t *testing.T) {
	st := newFakeStore()
	s, _, clock := newTestScheduler(t, st, httpCheck("https://example.com"))
	clock.Advance(50 * time.Minute)
	s.record(context.Background(), 1, 0, ok(clock.Now(), 10))
	s.record(context.Background(), 1, 0, ok(clock.Now(), 30))
	s.record(context.Background(), 1, 0, failed(clock.Now()))
	clock.Advance(20 * time.Minute) // next hour
	s.record(context.Background(), 1, 0, ok(clock.Now(), 40))

	st.failWrite = true
	s.Flush(context.Background())
	if len(st.hours) != 0 {
		t.Fatal("failed write recorded")
	}
	s.record(context.Background(), 1, 0, ok(clock.Now(), 60)) // arrives before the retry
	st.failWrite = false
	s.Flush(context.Background())

	slices.SortFunc(st.hours, func(a, b HourRollup) int { return a.Start.Compare(b.Start) })
	want := []HourRollup{
		{CheckID: 1, Start: t0, Total: 3, OK: 2, LatencyAvgMS: 20, LatencyMaxMS: 30}, // failures do not count toward latency
		{CheckID: 1, Start: t0.Add(time.Hour), Total: 2, OK: 2, LatencyAvgMS: 50, LatencyMaxMS: 60},
	}
	if !slices.Equal(st.hours, want) {
		t.Fatalf("hours = %+v, want %+v", st.hours, want)
	}
	if len(st.days) != 1 || st.days[0] != (DayRollup{CheckID: 1, Day: t0.Truncate(hoursInDay), Total: 5, OK: 4}) {
		t.Fatalf("days = %+v", st.days)
	}
	// Nothing pending: the next flush writes nothing.
	s.Flush(context.Background())
	if len(st.hours) != 2 {
		t.Fatalf("re-flushed: %+v", st.hours)
	}
}

func TestFlushSavesIncidentProgressOnce(t *testing.T) {
	st := newFakeStore()
	s, _, clock := newTestScheduler(t, st, httpCheck("https://example.com"))
	for range 3 {
		clock.Advance(time.Minute)
		s.record(context.Background(), 1, 0, failed(clock.Now()))
	}
	s.Flush(context.Background())
	id := st.opened[0].ID
	if got := st.progress[id]; got.LastValue != 3 || got.SamplesOver != 3 {
		t.Fatalf("progress = %+v", got)
	}
	delete(st.progress, id)
	s.Flush(context.Background())
	if _, ok := st.progress[id]; ok {
		t.Fatal("unchanged progress written again")
	}
}

func TestResultsHistoryMergesFlushedAndPending(t *testing.T) {
	st := newFakeStore()
	st.history = []HourRollup{{CheckID: 1, Start: t0.Add(-3 * time.Hour), Total: 60, OK: 45, LatencyAvgMS: 100, LatencyMaxMS: 400}}
	s, _, clock := newTestScheduler(t, st, httpCheck("https://example.com"))
	clock.Advance(10 * time.Minute)
	s.record(context.Background(), 1, 0, ok(clock.Now(), 80))

	for _, tt := range []struct {
		rng       Range
		steps     int
		stepSecs  int
		wantReads int
	}{{Range7d, 168, 3600, 1}, {Range7d, 168, 3600, 1}, {Range30d, 360, 7200, 2}} {
		series, err := s.Results(context.Background(), 1, tt.rng)
		if err != nil {
			t.Fatal(err)
		}
		if len(series.Points) != tt.steps || series.StepSeconds != tt.stepSecs || st.reads != tt.wantReads {
			t.Fatalf("%s: %d points step %d reads %d", tt.rng, len(series.Points), series.StepSeconds, st.reads)
		}
		var withData []Point
		for _, p := range series.Points {
			if p.UpPct != nil {
				withData = append(withData, p)
			}
		}
		if len(withData) != 2 || *withData[0].UpPct != 75 || *withData[0].LatencyMax != 400 || *withData[1].UpPct != 100 {
			t.Fatalf("%s points = %+v", tt.rng, withData)
		}
	}
	s.Flush(context.Background()) // invalidates the cache
	if _, err := s.Results(context.Background(), 1, Range7d); err != nil || st.reads != 3 {
		t.Fatalf("reads after flush = %d, %v", st.reads, err)
	}
	if _, err := s.Results(context.Background(), 404, Range7d); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown check error = %v", err)
	}
}

func TestRunProbesOnScheduleWithBoundedWorkers(t *testing.T) {
	var running, peak, probes atomic.Int32
	probe := func(ctx context.Context, c Check) Result {
		n := running.Add(1)
		defer running.Add(-1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		probes.Add(1)
		time.Sleep(5 * time.Millisecond)
		return ok(time.Now(), 5)
	}
	var cs []Check
	for i := range 5 {
		c := httpCheck("https://example.com")
		c.ID, c.Interval = int64(i+1), 20*time.Millisecond
		cs = append(cs, c)
	}
	paused := httpCheck("https://example.com")
	paused.ID, paused.Enabled, paused.Interval = 99, false, 20*time.Millisecond
	cs = append(cs, paused)
	s := NewScheduler(Config{Workers: 2, Tick: 2 * time.Millisecond, Probe: probe}, newFakeStore(), &fakeNotifier{},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := s.Load(context.Background(), cs); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); s.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for probes.Load() < 20 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if probes.Load() < 20 || peak.Load() > 2 {
		t.Fatalf("probes %d, peak concurrency %d (workers 2)", probes.Load(), peak.Load())
	}
	snaps := s.Snapshots([]int64{1, 99})
	if snaps[1].Status != StatusUp || snaps[99].Status != StatusPaused || snaps[99].Last != nil {
		t.Fatalf("snapshots = %+v", snaps)
	}
}

func TestRunNowAgainstHTTPServer(t *testing.T) {
	var healthy atomic.Bool
	healthy.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !healthy.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer srv.Close()
	st, n := newFakeStore(), &fakeNotifier{}
	s := NewScheduler(Config{AllowPrivate: true}, st, n, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := s.Load(context.Background(), []Check{httpCheck(srv.URL)}); err != nil {
		t.Fatal(err)
	}
	res, err := s.RunNow(context.Background(), 1)
	if err != nil || !res.OK || res.StatusCode != http.StatusOK {
		t.Fatalf("run = %+v, %v", res, err)
	}
	healthy.Store(false)
	for range failuresToOpen {
		if res, _ = s.RunNow(context.Background(), 1); res.OK || res.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("run while down = %+v", res)
		}
	}
	if s.snap(1).Status != StatusDown || len(st.opened) != 1 || n.kinds()[0] != "fired:http" {
		t.Fatalf("status %s opened %d events %v", s.snap(1).Status, len(st.opened), n.kinds())
	}
	if _, err := s.RunNow(context.Background(), 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown check error = %v", err)
	}
}
