package alerting

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"backend/metrics"
)

const (
	testOrg  int64 = 1
	otherOrg int64 = 2
	step           = 5 * time.Second // agent send interval
)

var (
	t0      = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	errFake = errors.New("fake store failure")
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

func (c *fakeClock) Advance(d time.Duration) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
	return c.t
}

type resolveCall struct {
	ID          int64
	At          time.Time
	How         ResolveHow
	Peak        float64
	SamplesOver int
}

type saveCall struct {
	ID             int64
	Peak           float64
	LastValue      float64
	SamplesOver    int
	LastNotifiedAt *time.Time
}

type pair struct{ rule, server int64 }

// fakeStore is an in-memory IncidentStore that also checks the engine never
// holds two open incidents for one (rule, server) pair.
type fakeStore struct {
	mu          sync.Mutex
	nextID      int64
	incidents   map[int64]Incident
	openByPair  map[pair]map[int64]bool
	opens       []Incident
	resolves    []resolveCall
	saves       []saveCall
	failOpen    int // fail the next n OpenIncident calls
	failResolve int
	violations  []string

	// When gate is set, OpenIncident signals entered and blocks until gate
	// is closed, to hold an open in flight.
	gate    chan struct{}
	entered chan struct{}
	// resolveGate does the same for ResolveIncident.
	resolveGate    chan struct{}
	resolveEntered chan struct{}
}

func newFakeStore() *fakeStore {
	return &fakeStore{incidents: make(map[int64]Incident), openByPair: make(map[pair]map[int64]bool)}
}

func (s *fakeStore) addOpenLocked(inc Incident) Incident {
	s.nextID++
	inc.ID = s.nextID
	s.incidents[inc.ID] = inc
	k := pair{inc.RuleID, inc.ServerID}
	if s.openByPair[k] == nil {
		s.openByPair[k] = make(map[int64]bool)
	}
	s.openByPair[k][inc.ID] = true
	return inc
}

// preload stores an already-open incident, as if left by a previous process.
func (s *fakeStore) preload(inc Incident) Incident {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addOpenLocked(inc)
}

func (s *fakeStore) OpenIncident(_ context.Context, inc Incident) (int64, error) {
	s.mu.Lock()
	gate, entered := s.gate, s.entered
	s.mu.Unlock()
	if gate != nil {
		entered <- struct{}{}
		<-gate
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failOpen > 0 {
		s.failOpen--
		return 0, errFake
	}
	if inc.ID != 0 {
		s.violations = append(s.violations, fmt.Sprintf("OpenIncident got an incident with id %d", inc.ID))
	}
	if n := len(s.openByPair[pair{inc.RuleID, inc.ServerID}]); n > 0 {
		s.violations = append(s.violations, fmt.Sprintf("rule %d server %d opened while %d already open", inc.RuleID, inc.ServerID, n))
	}
	inc = s.addOpenLocked(inc)
	s.opens = append(s.opens, inc)
	return inc.ID, nil
}

func (s *fakeStore) ResolveIncident(_ context.Context, id int64, at time.Time, how ResolveHow, peak float64, samplesOver int) error {
	s.mu.Lock()
	gate, entered := s.resolveGate, s.resolveEntered
	s.mu.Unlock()
	if gate != nil {
		entered <- struct{}{}
		<-gate
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failResolve > 0 {
		s.failResolve--
		return errFake
	}
	inc, ok := s.incidents[id]
	k := pair{inc.RuleID, inc.ServerID}
	if !ok || !s.openByPair[k][id] {
		s.violations = append(s.violations, fmt.Sprintf("resolve of incident %d that is not open", id))
	}
	delete(s.openByPair[k], id)
	s.resolves = append(s.resolves, resolveCall{ID: id, At: at, How: how, Peak: peak, SamplesOver: samplesOver})
	return nil
}

func (s *fakeStore) SaveProgress(_ context.Context, id int64, peak, lastValue float64, samplesOver int, lastNotifiedAt *time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saves = append(s.saves, saveCall{ID: id, Peak: peak, LastValue: lastValue, SamplesOver: samplesOver, LastNotifiedAt: copyTime(lastNotifiedAt)})
	return nil
}

func (s *fakeStore) LoadOpenIncidents(context.Context) ([]Incident, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Incident
	for _, ids := range s.openByPair {
		for id := range ids {
			out = append(out, s.incidents[id])
		}
	}
	return out, nil
}

func (s *fakeStore) openIDs() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ids []int64
	for _, set := range s.openByPair {
		for id := range set {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return ids
}

func (s *fakeStore) snapshot() (opens []Incident, resolves []resolveCall, saves []saveCall, violations []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.opens), slices.Clone(s.resolves), slices.Clone(s.saves), slices.Clone(s.violations)
}

type fakeNotifier struct {
	mu     sync.Mutex
	events []Event
}

func (n *fakeNotifier) Notify(_ context.Context, ev Event) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.events = append(n.events, ev)
}

func (n *fakeNotifier) all() []Event {
	n.mu.Lock()
	defer n.mu.Unlock()
	return slices.Clone(n.events)
}

func (n *fakeNotifier) kinds() []EventKind {
	var out []EventKind
	for _, ev := range n.all() {
		out = append(out, ev.Kind)
	}
	return out
}

type harness struct {
	t     testing.TB
	ctx   context.Context
	clock *fakeClock
	store *fakeStore
	notes *fakeNotifier
	eng   *Engine
}

func newHarness(t testing.TB, rules []Rule, servers []ServerInfo, preload ...Incident) *harness {
	t.Helper()
	h := &harness{
		t:     t,
		ctx:   context.Background(),
		clock: &fakeClock{t: t0},
		store: newFakeStore(),
		notes: &fakeNotifier{},
	}
	for _, inc := range preload {
		h.store.preload(inc)
	}
	h.eng = NewEngine(h.store, h.notes, h.clock.Now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := h.eng.Load(h.ctx, rules, servers); err != nil {
		t.Fatalf("Load: %v", err)
	}
	return h
}

// observe feeds one CPU point to the server at the current clock.
func (h *harness) observe(serverID int64, cpu float32) {
	h.eng.Observe(h.ctx, serverID, metrics.Point{CPU: cpu})
}

// hold advances the clock one step at a time for d, observing cpu each step.
func (h *harness) hold(serverID int64, cpu float32, d time.Duration) {
	for elapsed := time.Duration(0); elapsed < d; elapsed += step {
		h.clock.Advance(step)
		h.observe(serverID, cpu)
	}
}

func (h *harness) opens() []Incident {
	opens, _, _, _ := h.store.snapshot()
	return opens
}

func (h *harness) resolves() []resolveCall {
	_, resolves, _, _ := h.store.snapshot()
	return resolves
}

func (h *harness) saves() []saveCall {
	_, _, saves, _ := h.store.snapshot()
	return saves
}

func (h *harness) noViolations() {
	h.t.Helper()
	if _, _, _, v := h.store.snapshot(); len(v) > 0 {
		h.t.Fatalf("store invariant violations: %v", v)
	}
}

func cpuRule(id int64, threshold float64, forDur, autoResolve time.Duration) Rule {
	return Rule{
		ID: id, OrgID: testOrg, Name: fmt.Sprintf("cpu-%d", id), Enabled: true, Scope: Scope{All: true},
		Metric: MetricCPU, Comparison: Above, Threshold: threshold, For: forDur,
		Severity: Warning, AutoResolve: autoResolve,
	}
}

func heartbeatRule(id int64, forDur time.Duration) Rule {
	return Rule{
		ID: id, OrgID: testOrg, Name: "host-unreachable", Enabled: true, Scope: Scope{All: true},
		Metric: MetricHeartbeat, Comparison: Above, For: forDur, Severity: Critical,
	}
}

func srv(id int64, tags ...string) ServerInfo {
	return ServerInfo{ID: id, OrgID: testOrg, Name: fmt.Sprintf("srv-%d", id), Tags: tags}
}
