package checks

import (
	"cmp"
	"context"
	"crypto/x509"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"slices"
	"sort"
	"sync"
	"time"
)

const (
	failuresToOpen     = 2
	successesToResolve = 2
	resultsWindow      = 24 * time.Hour
	sparkLen           = 30
	// compactAfter batches the trimming of expired results, so appending
	// stays O(1) amortised.
	compactAfter = 64

	defaultWorkers   = 8
	defaultQueueSize = 256
	defaultTick      = time.Second
	// newCheckMaxDelay bounds the first probe of a check created (or
	// re-targeted) at runtime; at startup the first probe is spread over a
	// whole interval instead, so a restart does not fire every check at once.
	newCheckMaxDelay = 5 * time.Second
	// intervalJitterDivisor keeps later probes within +-5% of the interval,
	// so checks created together drift apart instead of staying aligned.
	intervalJitterDivisor = 20
	transitionTimeout     = 10 * time.Second
	queueFullLogEvery     = time.Minute
	percent               = 100
)

// ProbeFunc runs one probe; tests replace the network with a fake.
type ProbeFunc func(ctx context.Context, c Check) Result

type Config struct {
	Workers      int           // concurrent probes; default 8
	QueueSize    int           // due probes waiting for a worker; default 256
	Tick         time.Duration // how often due checks are queued; default 1 s
	AllowPrivate bool          // checks.allow_private_targets
	RootCAs      *x509.CertPool
	Now          func() time.Time
	Probe        ProbeFunc // nil: real network probes through the SSRF guard
}

// Scheduler owns every check's live state. One mutex guards all of it and is
// never held across I/O: store writes for transitions run outside it, with a
// busy flag per incident slot so a transition is never started twice.
type Scheduler struct {
	cfg      Config
	store    Store
	notifier Notifier
	log      *slog.Logger
	now      func() time.Time
	probe    ProbeFunc
	jitter   func(max time.Duration) time.Duration

	mu         sync.Mutex
	states     map[int64]*state
	byIncident map[int64]int64 // incident id -> check id
	hours      map[rollupKey]*agg
	days       map[rollupKey]*agg
	lastFull   time.Time

	flushMu sync.Mutex

	cacheMu  sync.Mutex
	cache    map[cacheKey][]HourRollup
	cacheGen uint64
}

type rollupKey struct {
	checkID int64
	start   time.Time
}

type cacheKey struct {
	checkID int64
	rng     Range
}

// agg accumulates results; latency sums cover successful probes only.
type agg struct {
	total, ok int
	latSumMS  float64
	latMaxMS  float64
}

func (a *agg) add(o agg) {
	a.total += o.total
	a.ok += o.ok
	a.latSumMS += o.latSumMS
	a.latMaxMS = max(a.latMaxMS, o.latMaxMS)
}

func aggOf(r Result) agg {
	a := agg{total: 1}
	if r.OK {
		ms := latencyMS(r.Latency)
		a.ok, a.latSumMS, a.latMaxMS = 1, ms, ms
	}
	return a
}

func latencyMS(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// sample is the compact form of a result kept for 24 h (16 bytes).
type sample struct {
	at        int64 // unix ms
	latencyMS float32
	ok        bool
}

type slot struct {
	inc   *Incident
	busy  bool // an open or resolve write is in flight
	saved progress
}

type progress struct {
	peak, last float64
	samples    int
}

func progressOf(i Incident) progress {
	return progress{peak: i.Peak, last: i.LastValue, samples: i.SamplesOver}
}

type slotKind int

const (
	slotDown slotKind = iota
	slotExpiry
)

type state struct {
	check   Check
	version uint64 // bumped on target, type or pause changes: in-flight results are dropped
	next    time.Time
	running bool
	since   time.Time // start of in-memory coverage
	samples []sample
	last    *Result
	seeded  []HourRollup // flushed hours from before since, within 24 h

	tlsDaysLeft  *int
	consecFail   int
	consecOK     int
	failingSince time.Time

	down, expiry slot
}

func (st *state) slot(k slotKind) *slot {
	if k == slotExpiry {
		return &st.expiry
	}
	return &st.down
}

func NewScheduler(cfg Config, store Store, notifier Notifier, log *slog.Logger) *Scheduler {
	if cfg.Workers <= 0 {
		cfg.Workers = defaultWorkers
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = defaultQueueSize
	}
	if cfg.Tick <= 0 {
		cfg.Tick = defaultTick
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if log == nil {
		log = slog.Default()
	}
	s := &Scheduler{
		cfg: cfg, store: store, notifier: notifier, log: log.With("component", "checks"), now: cfg.Now,
		probe: cfg.Probe,
		jitter: func(d time.Duration) time.Duration {
			if d <= 0 {
				return 0
			}
			return time.Duration(rand.Int64N(int64(d)))
		},
		states: map[int64]*state{}, byIncident: map[int64]int64{},
		hours: map[rollupKey]*agg{}, days: map[rollupKey]*agg{}, cache: map[cacheKey][]HourRollup{},
	}
	if s.probe == nil {
		s.probe = NewProber(cfg.AllowPrivate, cfg.RootCAs, cfg.Now).Probe
	}
	return s
}

func (s *Scheduler) newStateLocked(c Check, now time.Time, firstWithin time.Duration) *state {
	st := &state{check: c.clone(), since: now}
	st.next = now.Add(s.jitter(min(c.Interval, firstWithin)))
	return st
}

// Load restores checks and their open incidents at startup. Stored open
// incidents resume as open (a check that was down stays down until two
// successes), and the last 24 h of flushed hours seed the in-memory view.
func (s *Scheduler) Load(ctx context.Context, checks []Check) error {
	open, err := s.store.LoadOpenIncidents(ctx)
	if err != nil {
		return fmt.Errorf("checks: load open incidents: %w", err)
	}
	now := s.now()
	seed, err := s.store.RecentHours(ctx, now.Add(-resultsWindow).Truncate(time.Hour))
	if err != nil {
		return fmt.Errorf("checks: load recent results: %w", err)
	}
	slices.SortFunc(open, func(a, b Incident) int {
		if c := a.StartedAt.Compare(b.StartedAt); c != 0 {
			return c
		}
		return cmp.Compare(a.ID, b.ID)
	})
	slices.SortFunc(seed, func(a, b HourRollup) int { return a.Start.Compare(b.Start) })

	type stale struct {
		inc Incident
		how ResolveHow
	}
	var closeNow []stale
	s.mu.Lock()
	for _, c := range checks {
		s.states[c.ID] = s.newStateLocked(c, now, c.Interval)
	}
	for _, h := range seed {
		if st, ok := s.states[h.CheckID]; ok {
			st.seeded = append(st.seeded, h)
		}
	}
	for _, inc := range open {
		st, ok := s.states[inc.CheckID]
		switch {
		case !ok:
			closeNow = append(closeNow, stale{inc, ResolvedCheckChanged})
			continue
		case !st.check.Enabled:
			closeNow = append(closeNow, stale{inc, ResolvedCheckPaused})
			continue
		case inc.Metric != MetricTLSExpiry && inc.Metric != string(st.check.Type):
			closeNow = append(closeNow, stale{inc, ResolvedCheckChanged})
			continue
		}
		kind := slotDown
		if inc.Metric == MetricTLSExpiry {
			kind = slotExpiry
		}
		sl := st.slot(kind)
		if sl.inc != nil {
			// Two open incidents of one kind (a resolve write that failed
			// and was overtaken): keep the original.
			closeNow = append(closeNow, stale{inc, ResolvedAuto})
			continue
		}
		sl.inc, sl.saved = &inc, progressOf(inc)
		s.byIncident[inc.ID] = inc.CheckID
		if kind == slotDown {
			st.consecFail, st.failingSince = failuresToOpen, inc.StartedAt
		} else {
			days := int(inc.LastValue)
			st.tlsDaysLeft = &days
		}
	}
	s.mu.Unlock()

	for _, c := range closeNow {
		s.log.Info("resolving stale check incident on load", "incident_id", c.inc.ID, "check_id", c.inc.CheckID, "how", c.how)
		if err := s.store.ResolveIncident(ctx, c.inc.ID, now, c.how, c.inc.Peak, c.inc.SamplesOver); err != nil {
			s.log.Warn("resolve stale check incident", "incident_id", c.inc.ID, "err", err)
		}
	}
	return nil
}

// Upsert adds a check or applies an edit. Changing the type or target, or
// pausing, starts over: in-flight results are dropped and open incidents
// close quietly (no notification; the condition never cleared). It reports
// whether incidents were closed, so the caller can tell live clients.
func (s *Scheduler) Upsert(ctx context.Context, c Check) bool {
	now := s.now()
	s.mu.Lock()
	st, ok := s.states[c.ID]
	if !ok {
		s.states[c.ID] = s.newStateLocked(c, now, newCheckMaxDelay)
		s.mu.Unlock()
		return false
	}
	old := st.check
	st.check = c.clone()
	var closing []Incident
	var how ResolveHow
	detach := func(k slotKind) {
		sl := st.slot(k)
		if sl.inc != nil {
			closing = append(closing, *sl.inc)
			delete(s.byIncident, sl.inc.ID)
		}
		*sl = slot{}
	}
	switch {
	case old.Type != c.Type || old.Target != c.Target:
		how = ResolvedCheckChanged
		detach(slotDown)
		detach(slotExpiry)
		st.version++
		st.samples, st.last, st.seeded, st.tlsDaysLeft = nil, nil, nil, nil
		st.consecFail, st.consecOK, st.since = 0, 0, now
		st.next = now.Add(s.jitter(min(c.Interval, newCheckMaxDelay)))
	case old.Enabled && !c.Enabled:
		how = ResolvedCheckPaused
		detach(slotDown)
		detach(slotExpiry)
		st.version++
		st.consecFail, st.consecOK = 0, 0
	case c.TLSWarnDays == 0 && st.expiry.inc != nil:
		how = ResolvedCheckChanged
		detach(slotExpiry)
	}
	if c.Enabled && !old.Enabled {
		st.next = now.Add(s.jitter(min(c.Interval, newCheckMaxDelay)))
	}
	if limit := now.Add(c.Interval); st.next.After(limit) {
		st.next = now.Add(s.jitter(c.Interval))
	}
	s.mu.Unlock()

	for _, inc := range closing {
		wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), transitionTimeout)
		if err := s.store.ResolveIncident(wctx, inc.ID, now, how, inc.Peak, inc.SamplesOver); err != nil {
			s.log.Warn("resolve check incident after edit", "incident_id", inc.ID, "err", err)
		}
		cancel()
	}
	return len(closing) > 0
}

// Remove forgets a deleted check (its rows and incidents cascade in the DB).
func (s *Scheduler) Remove(checkID int64) {
	s.mu.Lock()
	s.removeLocked(checkID)
	s.mu.Unlock()
	s.dropCache(checkID)
}

// RemoveOrg forgets every check of a deleted org.
func (s *Scheduler) RemoveOrg(orgID int64) {
	s.mu.Lock()
	var ids []int64
	for id, st := range s.states {
		if st.check.OrgID == orgID {
			ids = append(ids, id)
		}
	}
	for _, id := range ids {
		s.removeLocked(id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.dropCache(id)
	}
}

func (s *Scheduler) removeLocked(checkID int64) {
	st, ok := s.states[checkID]
	if !ok {
		return
	}
	for _, sl := range []*slot{&st.down, &st.expiry} {
		if sl.inc != nil {
			delete(s.byIncident, sl.inc.ID)
		}
	}
	delete(s.states, checkID)
	for k := range s.hours {
		if k.checkID == checkID {
			delete(s.hours, k)
		}
	}
	for k := range s.days {
		if k.checkID == checkID {
			delete(s.days, k)
		}
	}
}

// Run queues due checks every tick to a bounded worker pool until ctx ends.
func (s *Scheduler) Run(ctx context.Context) {
	type job struct {
		id      int64
		version uint64
		check   Check
	}
	jobs := make(chan job, s.cfg.QueueSize)
	var wg sync.WaitGroup
	for range s.cfg.Workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				if ctx.Err() == nil {
					res := s.probe(ctx, j.check)
					// A probe cut short by shutdown says nothing about the target.
					if ctx.Err() == nil {
						s.record(ctx, j.id, j.version, res)
					}
				}
				s.mu.Lock()
				if st, ok := s.states[j.id]; ok {
					st.running = false
				}
				s.mu.Unlock()
			}
		}()
	}
	tick := time.NewTicker(s.cfg.Tick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return
		case <-tick.C:
			now := s.now()
			full := false
			s.mu.Lock()
			for id, st := range s.states {
				if !st.check.Enabled || st.running || now.Before(st.next) {
					continue
				}
				select {
				case jobs <- job{id: id, version: st.version, check: st.check.clone()}:
					st.running = true
					st.next = s.nextRun(st.next, now, st.check.Interval)
				default:
					full = true // retried next tick
				}
			}
			if full && now.Sub(s.lastFull) >= queueFullLogEvery {
				s.lastFull = now
				s.log.Warn("check queue full; probes are running late", "workers", s.cfg.Workers, "queue", s.cfg.QueueSize)
			}
			s.mu.Unlock()
		}
	}
}

func (s *Scheduler) nextRun(prev, now time.Time, interval time.Duration) time.Time {
	spread := interval / intervalJitterDivisor
	next := prev.Add(interval - spread + s.jitter(2*spread))
	if !next.After(now) {
		// Fell behind (queue full, or a long pause): restart from now
		// rather than firing a burst of catch-up probes.
		next = now.Add(interval - spread + s.jitter(2*spread))
	}
	return next
}

// RunNow probes a check immediately and returns the result. An enabled
// check's result counts like a scheduled one; a paused check is only probed.
func (s *Scheduler) RunNow(ctx context.Context, checkID int64) (Result, error) {
	s.mu.Lock()
	st, ok := s.states[checkID]
	if !ok {
		s.mu.Unlock()
		return Result{}, ErrNotFound
	}
	c, version := st.check.clone(), st.version
	s.mu.Unlock()

	res := s.probe(ctx, c)
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if c.Enabled {
		s.record(ctx, checkID, version, res)
	}
	return res, nil
}

type actionKind int

const (
	actOpen actionKind = iota
	actResolve
)

type action struct {
	kind    actionKind
	slot    slotKind
	version uint64
	check   Check
	inc     Incident
	result  Result
	at      time.Time
}

// record applies one result: memory, pending rollups, and state machine
// transitions (written and notified outside the lock).
func (s *Scheduler) record(ctx context.Context, checkID int64, version uint64, res Result) {
	s.mu.Lock()
	st, ok := s.states[checkID]
	if !ok || st.version != version {
		s.mu.Unlock()
		return
	}
	s.addResultLocked(st, res)
	acts := s.evaluateLocked(st, res)
	s.mu.Unlock()
	s.apply(ctx, acts)
}

func (s *Scheduler) addResultLocked(st *state, res Result) {
	r := res
	st.last = &r
	st.samples = append(st.samples, sample{at: res.At.UnixMilli(), latencyMS: float32(latencyMS(res.Latency)), ok: res.OK})
	cutoff := res.At.Add(-resultsWindow).UnixMilli()
	if expired := sort.Search(len(st.samples), func(i int) bool { return st.samples[i].at >= cutoff }); expired >= compactAfter {
		st.samples = slices.Delete(st.samples, 0, expired)
	}
	if res.CertDaysLeft != nil {
		d := *res.CertDaysLeft
		st.tlsDaysLeft = &d
	}
	a := aggOf(res)
	hk := rollupKey{st.check.ID, res.At.UTC().Truncate(time.Hour)}
	if s.hours[hk] == nil {
		s.hours[hk] = &agg{}
	}
	s.hours[hk].add(a)
	dk := rollupKey{st.check.ID, res.At.UTC().Truncate(hoursPerDay * time.Hour)}
	if s.days[dk] == nil {
		s.days[dk] = &agg{}
	}
	s.days[dk].add(agg{total: a.total, ok: a.ok})
}

// evaluateLocked is the state machine: two consecutive failures open a
// critical incident and two consecutive successes resolve it; a certificate
// within tls_warn_days opens a warning that resolves once renewed.
func (s *Scheduler) evaluateLocked(st *state, res Result) []action {
	if res.OK {
		st.consecFail, st.consecOK = 0, st.consecOK+1
	} else {
		if st.consecFail == 0 {
			st.failingSince = res.At
		}
		st.consecFail, st.consecOK = st.consecFail+1, 0
	}
	base := action{version: st.version, check: st.check.clone(), result: res, at: res.At}
	var acts []action

	down := &st.down
	switch {
	case down.inc != nil && !res.OK:
		down.inc.SamplesOver++
		down.inc.LastValue = float64(st.consecFail)
		down.inc.Peak = max(down.inc.Peak, down.inc.LastValue)
	case down.inc != nil && st.consecOK >= successesToResolve && !down.busy:
		down.busy = true
		a := base
		a.kind, a.slot, a.inc = actResolve, slotDown, *down.inc
		acts = append(acts, a)
	case down.inc == nil && st.consecFail >= failuresToOpen && !down.busy:
		down.busy = true
		a := base
		a.kind, a.slot = actOpen, slotDown
		a.inc = Incident{
			OrgID: st.check.OrgID, CheckID: st.check.ID, RuleName: DownRuleName, Metric: string(st.check.Type),
			Severity: SeverityCritical, Threshold: failuresToOpen, Peak: float64(st.consecFail),
			LastValue: float64(st.consecFail), SamplesOver: st.consecFail, StartedAt: st.failingSince,
		}
		acts = append(acts, a)
	}

	if res.CertDaysLeft == nil || st.check.TLSWarnDays <= 0 {
		return acts
	}
	days := float64(*res.CertDaysLeft)
	within := *res.CertDaysLeft <= st.check.TLSWarnDays
	exp := &st.expiry
	switch {
	case exp.inc != nil && within:
		exp.inc.SamplesOver++
		exp.inc.LastValue = days
		exp.inc.Peak = min(exp.inc.Peak, days)
	case exp.inc != nil && !within && !exp.busy:
		exp.busy = true
		a := base
		a.kind, a.slot, a.inc = actResolve, slotExpiry, *exp.inc
		a.inc.LastValue = days
		acts = append(acts, a)
	case exp.inc == nil && within && !exp.busy:
		exp.busy = true
		a := base
		a.kind, a.slot = actOpen, slotExpiry
		a.inc = Incident{
			OrgID: st.check.OrgID, CheckID: st.check.ID, RuleName: ExpiryRuleName, Metric: MetricTLSExpiry,
			Severity: SeverityWarning, Threshold: float64(st.check.TLSWarnDays), Peak: days, LastValue: days,
			SamplesOver: 1, StartedAt: res.At,
		}
		acts = append(acts, a)
	}
	return acts
}

func (s *Scheduler) apply(ctx context.Context, acts []action) {
	for _, a := range acts {
		// Transitions get their own budget so a probe that used most of its
		// context, or a shutdown in progress, cannot lose the write.
		wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), transitionTimeout)
		switch a.kind {
		case actOpen:
			s.open(wctx, a)
		case actResolve:
			s.resolve(wctx, a, ResolvedAuto)
		}
		cancel()
	}
}

func (s *Scheduler) open(ctx context.Context, a action) {
	id, err := s.store.OpenIncident(ctx, a.inc)
	s.mu.Lock()
	st, ok := s.states[a.check.ID]
	if ok {
		st.slot(a.slot).busy = false
	}
	if err != nil {
		s.mu.Unlock()
		s.log.Error("open check incident", "check_id", a.check.ID, "metric", a.inc.Metric, "err", err)
		return // the next probe retries while the condition holds
	}
	if !ok || st.version != a.version {
		// Deleted, re-targeted or paused while the write was in flight.
		s.mu.Unlock()
		if err := s.store.ResolveIncident(ctx, id, a.at, ResolvedCheckChanged, a.inc.Peak, a.inc.SamplesOver); err != nil {
			s.log.Warn("close check incident opened during an edit", "incident_id", id, "err", err)
		}
		return
	}
	sl := st.slot(a.slot)
	inc := a.inc
	inc.ID = id
	sl.inc, sl.saved = &inc, progressOf(inc)
	s.byIncident[id] = a.check.ID
	s.mu.Unlock()
	s.notifier.Notify(ctx, Event{Kind: EventFired, Check: a.check, Incident: inc, Result: a.result, At: a.at})
}

func (s *Scheduler) resolve(ctx context.Context, a action, how ResolveHow) {
	err := s.store.ResolveIncident(ctx, a.inc.ID, a.at, how, a.inc.Peak, a.inc.SamplesOver)
	s.mu.Lock()
	st, ok := s.states[a.check.ID]
	if ok {
		sl := st.slot(a.slot)
		sl.busy = false
		if err == nil && sl.inc != nil && sl.inc.ID == a.inc.ID {
			sl.inc = nil
			delete(s.byIncident, a.inc.ID)
		}
	}
	s.mu.Unlock()
	if err != nil {
		s.log.Error("resolve check incident", "incident_id", a.inc.ID, "err", err)
		return // the next success retries
	}
	s.notifier.Notify(ctx, Event{Kind: EventResolved, Check: a.check, Incident: a.inc, Result: a.result, How: how, At: a.at})
}

// Resolve closes a check incident by hand. A check that keeps failing needs
// two new failures to open the next one. Returns ErrNotFound when the
// scheduler does not hold the incident open.
func (s *Scheduler) Resolve(ctx context.Context, incidentID int64, at time.Time) error {
	s.mu.Lock()
	checkID, ok := s.byIncident[incidentID]
	st := s.states[checkID]
	if !ok || st == nil {
		s.mu.Unlock()
		return ErrNotFound
	}
	kind := slotDown
	if st.expiry.inc != nil && st.expiry.inc.ID == incidentID {
		kind = slotExpiry
	}
	sl := st.slot(kind)
	if sl.inc == nil || sl.inc.ID != incidentID || sl.busy {
		s.mu.Unlock()
		return ErrNotFound
	}
	sl.busy = true
	a := action{kind: actResolve, slot: kind, version: st.version, check: st.check.clone(), inc: *sl.inc, at: at}
	if kind == slotDown {
		st.consecFail = 0
	}
	s.mu.Unlock()

	err := s.store.ResolveIncident(ctx, incidentID, at, ResolvedManual, a.inc.Peak, a.inc.SamplesOver)
	s.mu.Lock()
	if st, ok := s.states[checkID]; ok {
		sl := st.slot(kind)
		sl.busy = false
		if err == nil && sl.inc != nil && sl.inc.ID == incidentID {
			sl.inc = nil
			delete(s.byIncident, incidentID)
		}
	}
	s.mu.Unlock()
	if err != nil {
		return fmt.Errorf("resolve check incident %d: %w", incidentID, err)
	}
	s.notifier.Notify(context.WithoutCancel(ctx), Event{Kind: EventResolved, Check: a.check, Incident: a.inc, How: ResolvedManual, At: at})
	return nil
}

// Flush is the flush-window hook: it writes pending hourly and daily deltas
// in one batch (re-queued on failure) and persists the progress of open
// incidents that changed. It is the only periodic DB work of the package.
func (s *Scheduler) Flush(ctx context.Context) {
	s.flushMu.Lock()
	defer s.flushMu.Unlock()

	s.mu.Lock()
	pendingHours, pendingDays := s.hours, s.days
	s.hours, s.days = map[rollupKey]*agg{}, map[rollupKey]*agg{}
	type write struct {
		checkID int64
		kind    slotKind
		inc     Incident
	}
	var progressWrites []write
	for id, st := range s.states {
		for _, k := range []slotKind{slotDown, slotExpiry} {
			sl := st.slot(k)
			if sl.inc != nil && !sl.busy && progressOf(*sl.inc) != sl.saved {
				progressWrites = append(progressWrites, write{id, k, *sl.inc})
			}
		}
	}
	s.mu.Unlock()

	if len(pendingHours)+len(pendingDays) > 0 {
		hours := make([]HourRollup, 0, len(pendingHours))
		for k, a := range pendingHours {
			hours = append(hours, a.hourRollup(k))
		}
		days := make([]DayRollup, 0, len(pendingDays))
		for k, a := range pendingDays {
			days = append(days, DayRollup{CheckID: k.checkID, Day: k.start, Total: a.total, OK: a.ok})
		}
		if err := s.store.WriteRollups(ctx, hours, days); err != nil {
			s.log.Warn("write check rollups; will retry next flush", "hours", len(hours), "days", len(days), "err", err)
			s.requeue(pendingHours, pendingDays)
		}
	}
	// Rollup rows changed (or the write failed and pending holds the data
	// again): cached history is stale either way.
	s.invalidateCache()

	for _, w := range progressWrites {
		if err := ctx.Err(); err != nil {
			return
		}
		if err := s.store.SaveProgress(ctx, w.inc.ID, w.inc.Peak, w.inc.LastValue, w.inc.SamplesOver); err != nil {
			s.log.Warn("save check incident progress", "incident_id", w.inc.ID, "err", err)
			continue
		}
		s.mu.Lock()
		if st, ok := s.states[w.checkID]; ok {
			if sl := st.slot(w.kind); sl.inc != nil && sl.inc.ID == w.inc.ID {
				sl.saved = progressOf(w.inc)
			}
		}
		s.mu.Unlock()
	}
}

func (a agg) hourRollup(k rollupKey) HourRollup {
	h := HourRollup{CheckID: k.checkID, Start: k.start, Total: a.total, OK: a.ok, LatencyMaxMS: float32(a.latMaxMS)}
	if a.ok > 0 {
		h.LatencyAvgMS = float32(a.latSumMS / float64(a.ok))
	}
	return h
}

func (s *Scheduler) requeue(hours, days map[rollupKey]*agg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	merge := func(dst map[rollupKey]*agg, src map[rollupKey]*agg) {
		for k, a := range src {
			if _, ok := s.states[k.checkID]; !ok {
				continue // deleted meanwhile
			}
			if dst[k] == nil {
				dst[k] = &agg{}
			}
			dst[k].add(*a)
		}
	}
	merge(s.hours, hours)
	merge(s.days, days)
}

// Snapshots returns the live state of the given checks; unknown IDs are
// left out.
func (s *Scheduler) Snapshots(ids []int64) map[int64]Snapshot {
	now := s.now()
	out := make(map[int64]Snapshot, len(ids))
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		if st, ok := s.states[id]; ok {
			out[id] = st.snapshot(now)
		}
	}
	return out
}

func (st *state) status() Status {
	switch {
	case !st.check.Enabled:
		return StatusPaused
	// Down follows the probes, not the incident row: a failed incident
	// write must not make an outage look healthy.
	case st.consecFail >= failuresToOpen || (st.down.inc != nil && st.consecOK < successesToResolve):
		return StatusDown
	case st.last == nil:
		return StatusPending
	case !st.last.OK, st.expiry.inc != nil:
		return StatusDegraded
	case st.tlsDaysLeft != nil && st.check.TLSWarnDays > 0 && *st.tlsDaysLeft <= st.check.TLSWarnDays:
		return StatusDegraded
	default:
		return StatusUp
	}
}

func (st *state) snapshot(now time.Time) Snapshot {
	snap := Snapshot{Status: st.status(), LatencySpark: []float64{}}
	if st.last != nil {
		r := *st.last
		snap.Last = &r
	}
	if st.tlsDaysLeft != nil {
		d := *st.tlsDaysLeft
		snap.TLSDaysLeft = &d
	}
	for _, sl := range []slot{st.down, st.expiry} {
		if sl.inc != nil {
			snap.OpenIncidents++
		}
	}
	from := now.Add(-resultsWindow)
	var total, ok int
	for _, h := range st.seeded {
		if h.Start.Add(time.Hour).After(from) && h.Start.Before(st.since) {
			total, ok = total+h.Total, ok+h.OK
		}
	}
	cutoff := from.UnixMilli()
	for _, smp := range st.samples {
		if smp.at < cutoff {
			continue
		}
		total++
		if smp.ok {
			ok++
		}
	}
	if total > 0 {
		pct := float64(ok) * percent / float64(total)
		snap.Uptime24h = &pct
	}
	for _, smp := range st.samples[max(0, len(st.samples)-sparkLen):] {
		snap.LatencySpark = append(snap.LatencySpark, float64(smp.latencyMS))
	}
	return snap
}

func (s *Scheduler) invalidateCache() {
	s.cacheMu.Lock()
	s.cache = map[cacheKey][]HourRollup{}
	s.cacheGen++
	s.cacheMu.Unlock()
}

func (s *Scheduler) dropCache(checkID int64) {
	s.cacheMu.Lock()
	for k := range s.cache {
		if k.checkID == checkID {
			delete(s.cache, k)
		}
	}
	s.cacheMu.Unlock()
}
