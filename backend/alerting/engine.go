package alerting

import (
	"cmp"
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"backend/metrics"
)

// storeCallTimeout bounds each transition write. Neon can take a few seconds
// to resume a suspended compute; past this the write counts as failed so an
// agent connection never hangs on the store.
const storeCallTimeout = 15 * time.Second

// Engine evaluates rules against live points and heartbeats.
//
// The mutex guards in-memory state only. Every method computes its
// transitions under the lock, releases it, and then talks to the store and
// the notifier, so one slow write never stalls the other agent connections.
type Engine struct {
	store    IncidentStore
	notifier Notifier
	now      func() time.Time
	log      *slog.Logger

	mu         sync.Mutex
	rules      map[int64]Rule                  // enabled, valid rules by ID
	orgRules   map[int64][]Rule                // same rules by org, sorted by ID
	servers    map[int64]ServerInfo            // by server ID
	lastBeat   map[int64]time.Time             // last heartbeat by server ID
	states     map[int64]map[int64]*alertState // server ID -> rule ID -> state; absent means ok
	byIncident map[int64]*alertState           // incidents open in the store
	// resolving counts resolve writes in flight per pair. A new incident for
	// a pair is not opened until they land, so the store never holds two
	// open incidents for one pair and "resolved" always goes out before the
	// next "fired".
	resolving map[pairKey]int
}

type pairKey struct{ serverID, ruleID int64 }

// alertState is a (rule, server) pair that is not ok.
type alertState struct {
	tracker
	rule   Rule
	server ServerInfo
	// inc holds the incident's identity and fixed fields; Peak, LastValue
	// and SamplesOver live in the tracker and incident() merges them in.
	inc Incident
	// breachStart is when the pending breach began, so a failed OpenIncident
	// can drop back to pending without forgetting how long it has held.
	breachStart time.Time
	// opening is true while OpenIncident is in flight and inc.ID is unknown.
	// A resolution that happens meanwhile is parked in abandoned and applied
	// by the goroutine doing the open once it has the ID.
	opening   bool
	abandoned *abandonment
	// saved is what the store last holds for this incident, so SaveProgress
	// skips incidents that did not change.
	saved progress
}

type abandonment struct {
	at     time.Time
	how    ResolveHow
	notify bool
	// counted is true when the parked resolution was added to resolving.
	counted bool
}

func (st *alertState) incident() Incident {
	inc := st.inc
	inc.Peak, inc.LastValue, inc.SamplesOver = st.peak, st.last, st.samplesOver
	inc.LastNotifiedAt = copyTime(st.inc.LastNotifiedAt)
	inc.AckedAt = copyTime(st.inc.AckedAt)
	return inc
}

func (st *alertState) renotifyDue(now time.Time) bool {
	if st.phase != phaseFiring || st.opening || st.inc.ID == 0 || st.inc.AckedAt != nil || st.rule.Cooldown <= 0 {
		return false
	}
	ref := st.inc.StartedAt
	if st.inc.LastNotifiedAt != nil {
		ref = *st.inc.LastNotifiedAt
	}
	return now.Sub(ref) >= st.rule.Cooldown
}

type progress struct {
	peak, last     float64
	samplesOver    int
	lastNotifiedAt time.Time // zero = never notified
}

func progressOf(inc Incident) progress {
	p := progress{peak: inc.Peak, last: inc.LastValue, samplesOver: inc.SamplesOver}
	if inc.LastNotifiedAt != nil {
		p.lastNotifiedAt = *inc.LastNotifiedAt
	}
	return p
}

func (p progress) equal(o progress) bool {
	return p.peak == o.peak && p.last == o.last && p.samplesOver == o.samplesOver &&
		p.lastNotifiedAt.Equal(o.lastNotifiedAt)
}

func copyTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	c := *t
	return &c
}

type actionKind uint8

const (
	actOpen actionKind = iota + 1
	actResolve
	actRenotify
)

// action is store or notifier work computed under the lock and run after it
// is released.
type action struct {
	kind   actionKind
	state  *alertState // nil for incidents restored only to be resolved
	inc    Incident
	rule   Rule
	server ServerInfo
	at     time.Time
	how    ResolveHow // actResolve
	notify bool       // actResolve: emit EventResolved on success
	// counted: actResolve was added to resolving for pair and must be
	// released once the write finishes.
	counted bool
	pair    pairKey
}

// NewEngine returns an empty engine; call Load before feeding it data.
// now == nil uses the wall clock in UTC and log == nil uses slog.Default. A
// nil notifier drops events; a nil store makes every write fail (and log).
func NewEngine(store IncidentStore, notifier Notifier, now func() time.Time, log *slog.Logger) *Engine {
	if store == nil {
		store = missingStore{}
	}
	if notifier == nil {
		notifier = nopNotifier{}
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	if log == nil {
		log = slog.Default()
	}
	e := &Engine{store: store, notifier: notifier, now: now, log: log.With("component", "alerting")}
	e.resetLocked()
	return e
}

func (e *Engine) resetLocked() {
	e.rules = make(map[int64]Rule)
	e.orgRules = make(map[int64][]Rule)
	e.servers = make(map[int64]ServerInfo)
	e.lastBeat = make(map[int64]time.Time)
	e.states = make(map[int64]map[int64]*alertState)
	e.byIncident = make(map[int64]*alertState)
	e.resolving = make(map[pairKey]int)
}

func (e *Engine) beginResolveLocked(k pairKey) { e.resolving[k]++ }

func (e *Engine) endResolveLocked(k pairKey) {
	if n := e.resolving[k]; n > 1 {
		e.resolving[k] = n - 1
	} else {
		delete(e.resolving, k)
	}
}

func (e *Engine) endResolve(k pairKey) {
	e.mu.Lock()
	e.endResolveLocked(k)
	e.mu.Unlock()
}

func (e *Engine) resolvingLocked(serverID, ruleID int64) bool {
	return e.resolving[pairKey{serverID, ruleID}] > 0
}

// Load replaces all engine state at startup: rules, servers and the open
// incidents from the store, which come back as firing. Incidents whose
// server or rule is gone (or no longer applies) are resolved. Call it once,
// before Observe and Tick start.
func (e *Engine) Load(ctx context.Context, rules []Rule, servers []ServerInfo) error {
	open, err := e.store.LoadOpenIncidents(ctx)
	if err != nil {
		return fmt.Errorf("alerting: load open incidents: %w", err)
	}
	open = slices.Clone(open)
	// Oldest first, so if the store holds two open incidents for one pair
	// the original is the one kept.
	slices.SortFunc(open, compareIncidents)
	now := e.now()

	e.mu.Lock()
	e.resetLocked()
	for _, s := range servers {
		e.servers[s.ID] = s.clone()
		// Heartbeat times died with the previous process. Treat every server
		// as seen just now so a restart does not page for the whole fleet.
		e.lastBeat[s.ID] = now
	}
	byOrg := make(map[int64][]Rule)
	for _, r := range rules {
		byOrg[r.OrgID] = append(byOrg[r.OrgID], r)
	}
	for orgID, rs := range byOrg {
		e.indexOrgRulesLocked(orgID, rs)
	}
	var acts []action
	for _, inc := range open {
		if a, ok := e.restoreLocked(inc, now); ok {
			acts = append(acts, a)
		}
	}
	e.mu.Unlock()

	e.run(ctx, acts)
	return nil
}

// restoreLocked brings back one stored open incident as firing, or returns
// the action that resolves it when it can no longer be tracked.
func (e *Engine) restoreLocked(inc Incident, now time.Time) (action, bool) {
	orphan := func(how ResolveHow) (action, bool) {
		e.log.Info("resolving stale incident on load", "incident_id", inc.ID, "rule_id", inc.RuleID,
			"server_id", inc.ServerID, "how", how)
		k := pairKey{inc.ServerID, inc.RuleID}
		e.beginResolveLocked(k)
		return action{kind: actResolve, inc: inc, at: now, how: how, counted: true, pair: k}, true
	}
	srv, ok := e.servers[inc.ServerID]
	if !ok {
		return orphan(ResolvedServerDeleted)
	}
	rule, ok := e.rules[inc.RuleID]
	if !ok || rule.OrgID != inc.OrgID || rule.Metric != inc.Metric || rule.Severity != inc.Severity || !rule.Matches(srv) {
		return orphan(ResolvedRuleDeleted)
	}
	if e.stateLocked(srv.ID, rule.ID) != nil {
		// Two open incidents for one pair (a resolve write that failed and
		// was overtaken). Close the newer one quietly.
		return orphan(ResolvedAuto)
	}
	st := &alertState{rule: rule, server: srv, inc: inc, saved: progressOf(inc)}
	st.inc.LastNotifiedAt = copyTime(inc.LastNotifiedAt)
	st.inc.AckedAt = copyTime(inc.AckedAt)
	st.phase = phaseFiring
	st.peak, st.last, st.samplesOver = inc.Peak, inc.LastValue, inc.SamplesOver
	e.attachLocked(st)
	return action{}, false
}

// SetOrgRules replaces one org's rules after a CRUD change. Open incidents of
// rules that were removed, disabled or had their condition changed (metric,
// comparison, threshold, For, scope or severity) are resolved as
// ResolvedRuleDeleted. Edits to name, channels, cooldown or auto-resolve keep
// state and open incidents. Rules of another org, without an ID or failing
// Validate are skipped and logged.
func (e *Engine) SetOrgRules(orgID int64, rules []Rule) {
	now := e.now()
	e.mu.Lock()
	next := e.indexOrgRulesLocked(orgID, rules)
	var acts []action
	for _, byRule := range e.states {
		for _, st := range byRule {
			if st.rule.OrgID != orgID {
				continue
			}
			if r, ok := next[st.rule.ID]; ok && r.sameCondition(st.rule) {
				st.rule = r
				continue
			}
			if a, ok := e.detachLocked(st, now, ResolvedRuleDeleted); ok {
				acts = append(acts, a)
			}
		}
	}
	e.mu.Unlock()

	// The contract gives SetOrgRules no context; the writes still need one.
	e.run(context.Background(), acts)
}

// indexOrgRulesLocked swaps in an org's evaluable rules and returns them by ID.
func (e *Engine) indexOrgRulesLocked(orgID int64, rules []Rule) map[int64]Rule {
	for _, r := range e.orgRules[orgID] {
		delete(e.rules, r.ID)
	}
	next := make(map[int64]Rule, len(rules))
	for _, r := range rules {
		if r.OrgID != orgID {
			e.log.Warn("skipping rule of another org", "rule_id", r.ID, "rule_org_id", r.OrgID, "org_id", orgID)
			continue
		}
		if r.ID <= 0 {
			e.log.Warn("skipping rule without an id", "org_id", orgID, "name", r.Name)
			continue
		}
		if !r.Enabled {
			continue
		}
		if err := r.Validate(); err != nil {
			e.log.Warn("skipping invalid rule", "rule_id", r.ID, "org_id", orgID, "err", err)
			continue
		}
		next[r.ID] = r.clone()
	}
	list := make([]Rule, 0, len(next))
	for id, r := range next {
		e.rules[id] = r
		list = append(list, r)
	}
	slices.SortFunc(list, func(a, b Rule) int { return cmp.Compare(a.ID, b.ID) })
	if len(list) == 0 {
		delete(e.orgRules, orgID)
	} else {
		e.orgRules[orgID] = list
	}
	return next
}

// UpsertServer adds or updates a server. A new server's heartbeat clock
// starts now. When a tag change takes a server out of a rule's scope, that
// rule's open incident on it is resolved as ResolvedRuleDeleted.
func (e *Engine) UpsertServer(s ServerInfo) {
	s = s.clone()
	now := e.now()
	e.mu.Lock()
	if _, known := e.servers[s.ID]; !known {
		e.lastBeat[s.ID] = now
	}
	e.servers[s.ID] = s
	var acts []action
	for _, st := range e.states[s.ID] {
		if st.rule.Matches(s) {
			st.server = s
			continue
		}
		if a, ok := e.detachLocked(st, now, ResolvedRuleDeleted); ok {
			acts = append(acts, a)
		}
	}
	e.mu.Unlock()

	// The contract gives UpsertServer no context; the writes still need one.
	e.run(context.Background(), acts)
}

// RemoveServer forgets a deleted server and resolves its incidents as
// ResolvedServerDeleted.
func (e *Engine) RemoveServer(ctx context.Context, serverID int64) {
	now := e.now()
	e.mu.Lock()
	var acts []action
	for _, st := range e.states[serverID] {
		if a, ok := e.detachLocked(st, now, ResolvedServerDeleted); ok {
			acts = append(acts, a)
		}
	}
	delete(e.servers, serverID)
	delete(e.lastBeat, serverID)
	e.mu.Unlock()

	e.run(ctx, acts)
}

// Observe evaluates the threshold rules that apply to the server against one
// live point. It does not count as a heartbeat; callers report liveness with
// Heartbeat. Points for unknown servers are ignored.
func (e *Engine) Observe(ctx context.Context, serverID int64, p metrics.Point) {
	now := e.now()
	e.mu.Lock()
	srv, ok := e.servers[serverID]
	if !ok {
		e.mu.Unlock()
		return
	}
	var acts []action
	for _, r := range e.orgRules[srv.OrgID] {
		if r.Metric == MetricHeartbeat || !r.Matches(srv) {
			continue
		}
		v, ok := r.pointValue(p)
		if !ok {
			continue
		}
		st := e.stateLocked(serverID, r.ID)
		if st == nil {
			if !r.breached(v) {
				continue // the common case: ok and staying ok, no allocation
			}
			st = e.newStateLocked(r, srv)
		}
		switch st.observe(r, v, now, now) {
		case fire:
			if e.resolvingLocked(serverID, r.ID) {
				// The previous incident's resolve has not landed yet: stay
				// pending (breach start and peak kept) and fire on the next
				// sample.
				st.phase = phasePending
				continue
			}
			acts = append(acts, e.fireLocked(st, now))
		case resolve:
			if a, ok := e.detachLocked(st, now, ResolvedAuto); ok {
				acts = append(acts, a)
			}
		default:
			if st.phase == phaseOK {
				e.removeLocked(st) // a pending breach that did not hold
			}
		}
	}
	e.mu.Unlock()

	e.run(ctx, acts)
}

// Heartbeat records that the server is alive at the given time and resolves
// its open heartbeat incidents. Heartbeats for unknown servers are ignored so
// a late call after RemoveServer does not resurrect the server.
func (e *Engine) Heartbeat(serverID int64, at time.Time) {
	e.mu.Lock()
	if _, ok := e.servers[serverID]; !ok {
		e.mu.Unlock()
		return
	}
	prev := e.lastBeat[serverID]
	if at.After(prev) {
		e.lastBeat[serverID] = at
	}
	var acts []action
	for _, st := range e.states[serverID] {
		if st.rule.Metric != MetricHeartbeat {
			continue
		}
		silent := max(at.Sub(prev), 0).Seconds()
		st.last = silent
		st.peak = max(st.peak, silent)
		st.phase = phaseOK
		if a, ok := e.detachLocked(st, at, ResolvedAuto); ok {
			acts = append(acts, a)
		}
	}
	e.mu.Unlock()

	// The contract gives Heartbeat no context; the writes still need one.
	e.run(context.Background(), acts)
}

// Tick runs the time-driven part of the state machine: heartbeat rules,
// auto-resolve of incidents that stopped receiving samples while recovering,
// and cooldown renotify. Call it every 5 s.
func (e *Engine) Tick(ctx context.Context) {
	now := e.now()
	e.mu.Lock()
	var acts []action
	for id, srv := range e.servers {
		last, ok := e.lastBeat[id]
		if !ok {
			continue
		}
		silent := now.Sub(last)
		for _, r := range e.orgRules[srv.OrgID] {
			if r.Metric != MetricHeartbeat || !r.Matches(srv) {
				continue
			}
			secs := max(silent, 0).Seconds()
			if st := e.stateLocked(id, r.ID); st != nil {
				st.last = secs
				st.peak = max(st.peak, secs)
				continue
			}
			if silent < r.For || e.resolvingLocked(id, r.ID) {
				continue // not silent long enough, or the last one is still resolving
			}
			st := e.newStateLocked(r, srv)
			// Heartbeat rules skip pending: For is measured from the last
			// heartbeat, which already happened.
			st.phase, st.since, st.peak, st.last = phaseFiring, last, secs, secs
			acts = append(acts, e.fireLocked(st, now))
		}
	}
	for _, byRule := range e.states {
		for _, st := range byRule {
			if st.rule.Metric != MetricHeartbeat && st.recovered(st.rule, now) {
				st.phase = phaseOK
				if a, ok := e.detachLocked(st, now, ResolvedAuto); ok {
					acts = append(acts, a)
				}
				continue
			}
			if st.renotifyDue(now) {
				notifiedAt := now
				st.inc.LastNotifiedAt = &notifiedAt
				acts = append(acts, action{kind: actRenotify, inc: st.incident(), rule: st.rule, server: st.server, at: now})
			}
		}
	}
	e.mu.Unlock()

	e.run(ctx, acts)
}

// Ack stops renotify for an open incident. The caller persists the ack
// itself; unknown incidents are ignored.
func (e *Engine) Ack(incidentID int64, at time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	st, ok := e.byIncident[incidentID]
	if !ok || st.inc.AckedAt != nil {
		return
	}
	ackedAt := at
	st.inc.AckedAt = &ackedAt
}

// Resolve closes an open incident by hand and resets its pair to ok, so a
// breach that continues afterwards starts a new pending cycle. It returns
// ErrIncidentNotFound (wrapped) when the engine does not hold the incident.
// If the store write fails the incident stays open and the error is returned.
func (e *Engine) Resolve(ctx context.Context, incidentID int64, at time.Time) error {
	e.mu.Lock()
	st, ok := e.byIncident[incidentID]
	if !ok {
		e.mu.Unlock()
		return fmt.Errorf("resolve incident %d: %w", incidentID, ErrIncidentNotFound)
	}
	prevPhase := st.phase
	a, _ := e.detachLocked(st, at, ResolvedManual)
	if st.rule.Metric == MetricHeartbeat && at.After(e.lastBeat[st.server.ID]) {
		// Restart the silence clock, the heartbeat version of a new pending
		// cycle; otherwise the next Tick re-fires at once for a host that is
		// still down.
		e.lastBeat[st.server.ID] = at
	}
	e.mu.Unlock()

	err := e.store.ResolveIncident(ctx, incidentID, at, ResolvedManual, a.inc.Peak, a.inc.SamplesOver)
	e.mu.Lock()
	if a.counted {
		e.endResolveLocked(a.pair)
	}
	if err != nil {
		e.reattachLocked(st, prevPhase)
		e.mu.Unlock()
		return fmt.Errorf("resolve incident %d: %w", incidentID, err)
	}
	e.mu.Unlock()
	e.notifier.Notify(context.WithoutCancel(ctx), Event{Kind: EventResolved, Incident: a.inc, Rule: a.rule, Server: a.server, At: at})
	return nil
}

// SaveProgress persists peak, last value, samples over and last-notified of
// every open incident that changed since the last successful save. It is the
// flush-window hook; failed writes are logged and retried on the next call.
func (e *Engine) SaveProgress(ctx context.Context) {
	type write struct {
		st  *alertState
		inc Incident
	}
	e.mu.Lock()
	var writes []write
	for _, st := range e.byIncident {
		inc := st.incident()
		if progressOf(inc).equal(st.saved) {
			continue
		}
		writes = append(writes, write{st: st, inc: inc})
	}
	e.mu.Unlock()

	slices.SortFunc(writes, func(a, b write) int { return cmp.Compare(a.inc.ID, b.inc.ID) })
	for i, w := range writes {
		if err := ctx.Err(); err != nil {
			e.log.Warn("save progress interrupted", "unsaved", len(writes)-i, "err", err)
			return
		}
		inc := w.inc
		if err := e.store.SaveProgress(ctx, inc.ID, inc.Peak, inc.LastValue, inc.SamplesOver, inc.LastNotifiedAt); err != nil {
			e.log.Error("save incident progress failed", "incident_id", inc.ID, "err", err)
			continue
		}
		e.mu.Lock()
		w.st.saved = progressOf(inc)
		e.mu.Unlock()
	}
}

// Open returns copies of the org's open incidents, oldest first.
func (e *Engine) Open(orgID int64) []Incident {
	e.mu.Lock()
	var out []Incident
	for _, st := range e.byIncident {
		if st.inc.OrgID == orgID {
			out = append(out, st.incident())
		}
	}
	e.mu.Unlock()
	slices.SortFunc(out, compareIncidents)
	return out
}

// ServerSeverity returns the worst severity among the server's open
// incidents; ok is false when it has none.
func (e *Engine) ServerSeverity(serverID int64) (Severity, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var worst Severity
	for _, st := range e.states[serverID] {
		if st.inc.ID == 0 || st.opening {
			continue
		}
		if st.inc.Severity.rank() > worst.rank() {
			worst = st.inc.Severity
		}
	}
	return worst, worst != ""
}

func compareIncidents(a, b Incident) int {
	if c := a.StartedAt.Compare(b.StartedAt); c != 0 {
		return c
	}
	return cmp.Compare(a.ID, b.ID)
}

func (e *Engine) stateLocked(serverID, ruleID int64) *alertState {
	return e.states[serverID][ruleID]
}

func (e *Engine) newStateLocked(r Rule, srv ServerInfo) *alertState {
	st := &alertState{rule: r, server: srv}
	e.attachLocked(st)
	return st
}

func (e *Engine) attachLocked(st *alertState) {
	byRule := e.states[st.server.ID]
	if byRule == nil {
		byRule = make(map[int64]*alertState)
		e.states[st.server.ID] = byRule
	}
	byRule[st.rule.ID] = st
	if st.inc.ID != 0 && !st.opening {
		e.byIncident[st.inc.ID] = st
	}
}

func (e *Engine) attachedLocked(st *alertState) bool {
	return e.stateLocked(st.server.ID, st.rule.ID) == st
}

func (e *Engine) removeLocked(st *alertState) {
	if byRule := e.states[st.server.ID]; byRule[st.rule.ID] == st {
		delete(byRule, st.rule.ID)
		if len(byRule) == 0 {
			delete(e.states, st.server.ID)
		}
	}
	if st.inc.ID != 0 && e.byIncident[st.inc.ID] == st {
		delete(e.byIncident, st.inc.ID)
	}
}

// detachLocked returns the pair to ok and, when its incident is in the
// store, the action that resolves it. An incident still being opened is
// parked so the opener resolves it once the ID is known.
func (e *Engine) detachLocked(st *alertState, at time.Time, how ResolveHow) (action, bool) {
	e.removeLocked(st)
	k := pairKey{st.server.ID, st.rule.ID}
	if st.opening {
		e.beginResolveLocked(k)
		st.abandoned = &abandonment{at: at, how: how, notify: how.notifies(), counted: true}
		return action{}, false
	}
	if st.inc.ID == 0 {
		return action{}, false // pending: nothing in the store
	}
	e.beginResolveLocked(k)
	return action{
		kind: actResolve, state: st, inc: st.incident(), rule: st.rule, server: st.server,
		at: at, how: how, notify: how.notifies(), counted: true, pair: k,
	}, true
}

// reattachLocked puts a detached incident back when its resolve write failed,
// so the engine keeps agreeing with the store and the write is retried. It
// refuses when the rule or server changed meanwhile or the pair is in use.
func (e *Engine) reattachLocked(st *alertState, ph phase) bool {
	rule, ok := e.rules[st.rule.ID]
	if !ok || !rule.sameCondition(st.rule) {
		return false
	}
	srv, ok := e.servers[st.server.ID]
	if !ok || !rule.Matches(srv) || e.stateLocked(srv.ID, rule.ID) != nil {
		return false
	}
	st.rule, st.server, st.phase = rule, srv, ph
	e.attachLocked(st)
	return true
}

func (e *Engine) fireLocked(st *alertState, now time.Time) action {
	notifiedAt := now
	st.breachStart = st.since
	st.inc = Incident{
		OrgID:          st.rule.OrgID,
		ServerID:       st.server.ID,
		RuleID:         st.rule.ID,
		RuleName:       st.rule.Name,
		Metric:         st.rule.Metric,
		Severity:       st.rule.Severity,
		Threshold:      st.rule.incidentThreshold(),
		StartedAt:      now,
		LastNotifiedAt: &notifiedAt, // EventFired is the first notification
	}
	st.opening = true
	return action{kind: actOpen, state: st, inc: st.incident(), rule: st.rule, server: st.server, at: now}
}

// failOpenLocked rolls a pair back after OpenIncident failed so the next
// breach (or Tick, for heartbeat rules) retries the open.
func (e *Engine) failOpenLocked(st *alertState) {
	st.opening = false
	if st.abandoned != nil || !e.attachedLocked(st) {
		return // resolved meanwhile; nothing reached the store
	}
	if st.rule.Metric == MetricHeartbeat {
		e.removeLocked(st)
		return
	}
	st.phase, st.since = phasePending, st.breachStart
	st.inc = Incident{}
}

func (e *Engine) run(ctx context.Context, acts []action) {
	if len(acts) == 0 {
		return
	}
	// Transitions must reach the store even if the agent connection or the
	// request that triggered them goes away mid-call; a cancelled resolve
	// would leave the incident open in the database.
	ctx = context.WithoutCancel(ctx)
	for _, a := range acts {
		switch a.kind {
		case actOpen:
			e.open(ctx, a)
		case actResolve:
			e.resolve(ctx, a)
		case actRenotify:
			e.notifier.Notify(ctx, Event{Kind: EventRenotify, Incident: a.inc, Rule: a.rule, Server: a.server, At: a.at})
		}
	}
}

func (e *Engine) open(ctx context.Context, a action) {
	sctx, cancel := context.WithTimeout(ctx, storeCallTimeout)
	id, err := e.store.OpenIncident(sctx, a.inc)
	cancel()
	if err == nil && id <= 0 {
		err = fmt.Errorf("store returned invalid incident id %d", id)
	}
	st := a.state
	if err != nil {
		e.mu.Lock()
		if st.abandoned != nil && st.abandoned.counted {
			// Nothing reached the store, so there is nothing to resolve.
			e.endResolveLocked(pairKey{st.server.ID, st.rule.ID})
		}
		e.failOpenLocked(st)
		e.mu.Unlock()
		e.log.Error("open incident failed; retrying on the next breach", "rule_id", a.rule.ID,
			"server_id", a.server.ID, "err", err)
		return
	}

	inc := a.inc
	inc.ID = id
	e.mu.Lock()
	st.inc.ID = id
	ab := st.abandoned
	e.mu.Unlock()

	// Still marked opening, so any resolution racing with this is parked
	// rather than run: EventFired always goes out before EventResolved.
	if ab == nil || ab.notify {
		e.notifier.Notify(ctx, Event{Kind: EventFired, Incident: inc, Rule: a.rule, Server: a.server, At: a.at})
	}

	e.mu.Lock()
	st.opening = false
	st.saved = progressOf(inc)
	ab = st.abandoned
	if ab == nil && !e.attachedLocked(st) {
		// Only a second Load can drop a state without parking a resolution.
		ab = &abandonment{at: e.now(), how: ResolvedRuleDeleted}
	}
	if ab == nil {
		e.byIncident[id] = st
		e.mu.Unlock()
		return
	}
	k := pairKey{st.server.ID, st.rule.ID}
	if !ab.counted {
		e.beginResolveLocked(k)
	}
	final := action{
		kind: actResolve, state: st, inc: st.incident(), rule: st.rule, server: st.server,
		at: ab.at, how: ab.how, notify: ab.notify, counted: true, pair: k,
	}
	e.mu.Unlock()
	e.resolve(ctx, final)
}

func (e *Engine) resolve(ctx context.Context, a action) {
	sctx, cancel := context.WithTimeout(ctx, storeCallTimeout)
	err := e.store.ResolveIncident(sctx, a.inc.ID, a.at, a.how, a.inc.Peak, a.inc.SamplesOver)
	cancel()
	if a.counted {
		// Released after EventResolved goes out, so a breach waiting on this
		// pair opens (and notifies) the next incident strictly afterwards.
		defer e.endResolve(a.pair)
	}
	if err != nil {
		retry := false
		if a.how == ResolvedAuto && a.state != nil {
			// Back to where the next Tick (recovering) or Heartbeat (firing)
			// resolves it again.
			ph := phaseRecovering
			if a.state.rule.Metric == MetricHeartbeat {
				ph = phaseFiring
			}
			e.mu.Lock()
			a.state.abandoned = nil
			retry = e.reattachLocked(a.state, ph)
			e.mu.Unlock()
		}
		e.log.Error("resolve incident failed", "incident_id", a.inc.ID, "how", a.how, "will_retry", retry, "err", err)
		return
	}
	if a.notify {
		e.notifier.Notify(ctx, Event{Kind: EventResolved, Incident: a.inc, Rule: a.rule, Server: a.server, At: a.at})
	}
}
