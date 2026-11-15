package alerting

import (
	"context"
	"errors"
	"math/rand/v2"
	"slices"
	"sync"
	"testing"
	"time"

	"backend/metrics"
)

func TestEnginePendingFiresOnlyAfterFor(t *testing.T) {
	tests := []struct {
		name   string
		forDur time.Duration
	}{
		{"for zero fires on first breach", 0},
		{"for 30s", 30 * time.Second},
		{"for 5m", 5 * time.Minute},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, []Rule{cpuRule(1, 80, tc.forDur, time.Minute)}, []ServerInfo{srv(10)})
			for {
				h.observe(10, 90)
				elapsed := h.clock.Now().Sub(t0)
				want := 0
				if elapsed >= tc.forDur {
					want = 1
				}
				if got := len(h.opens()); got != want {
					t.Fatalf("after %s of breach: %d incidents opened, want %d", elapsed, got, want)
				}
				if elapsed >= tc.forDur+2*step {
					break
				}
				h.clock.Advance(step)
			}

			inc := h.opens()[0]
			if !inc.StartedAt.Equal(t0.Add(tc.forDur)) {
				t.Errorf("StartedAt = %s, want %s", inc.StartedAt, t0.Add(tc.forDur))
			}
			if wantSamples := int(tc.forDur/step) + 1; inc.SamplesOver != wantSamples {
				t.Errorf("SamplesOver = %d, want %d (pending samples count)", inc.SamplesOver, wantSamples)
			}
			if inc.LastNotifiedAt == nil || !inc.LastNotifiedAt.Equal(inc.StartedAt) {
				t.Errorf("LastNotifiedAt = %v, want the fire time", inc.LastNotifiedAt)
			}
			evs := h.notes.all()
			if len(evs) != 1 || evs[0].Kind != EventFired || evs[0].Incident.ID != inc.ID ||
				evs[0].Rule.ID != 1 || evs[0].Server.ID != 10 || !evs[0].At.Equal(inc.StartedAt) {
				t.Fatalf("events = %+v, want one fired event for incident %d", evs, inc.ID)
			}
			h.noViolations()
		})
	}
}

func TestEngineFlappingUnderForNeverFires(t *testing.T) {
	const forDur = 5 * time.Minute
	tests := []struct {
		name    string
		valueAt func(i int) float32 // value of the i-th sample
	}{
		{"alternating every sample", func(i int) float32 {
			if i%2 == 0 {
				return 95
			}
			return 50
		}},
		{"one dip just before For", func(i int) float32 {
			samplesPerCycle := int(forDur / step) // breaching for For minus one step, then one dip
			if i%samplesPerCycle == samplesPerCycle-1 {
				return 50
			}
			return 95
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, []Rule{cpuRule(1, 80, forDur, 0)}, []ServerInfo{srv(10)})
			for i := 0; i < int(time.Hour/step); i++ {
				h.observe(10, tc.valueAt(i))
				h.clock.Advance(step)
				h.eng.Tick(h.ctx)
			}
			if n := len(h.opens()); n != 0 {
				t.Fatalf("%d incidents opened while flapping under For", n)
			}
			if len(h.notes.all()) != 0 {
				t.Fatal("notifications sent while flapping under For")
			}
		})
	}
}

func TestEngineRecoveringBackToFiringKeepsOneIncident(t *testing.T) {
	h := newHarness(t, []Rule{cpuRule(1, 80, 0, 2*time.Minute)}, []ServerInfo{srv(10)})
	h.observe(10, 95)                          // fires
	h.hold(10, 50, time.Minute)                // recovering
	h.hold(10, 99, 30*time.Second)             // back to firing, new peak
	h.hold(10, 40, time.Minute+55*time.Second) // recovering again, just short of AutoResolve
	h.hold(10, 85, 2*step)                     // firing
	h.eng.Tick(h.ctx)
	if n, r := len(h.opens()), len(h.resolves()); n != 1 || r != 0 {
		t.Fatalf("opens %d resolves %d during flaps, want 1 and 0", n, r)
	}

	h.hold(10, 40, 2*time.Minute+step) // the first sample under starts the timer
	resolves := h.resolves()
	if len(h.opens()) != 1 || len(resolves) != 1 {
		t.Fatalf("opens %d resolves %d, want 1 and 1", len(h.opens()), len(resolves))
	}
	wantSamples := 1 + int(30*time.Second/step) + 2
	if r := resolves[0]; r.How != ResolvedAuto || r.Peak != 99 || r.SamplesOver != wantSamples {
		t.Fatalf("resolve = %+v, want auto, peak 99, %d samples", r, wantSamples)
	}
	if got := h.notes.kinds(); !slices.Equal(got, []EventKind{EventFired, EventResolved}) {
		t.Fatalf("events = %v, want fired then resolved", got)
	}
	h.noViolations()
}

func TestEngineAutoResolveTiming(t *testing.T) {
	tests := []struct {
		name        string
		autoResolve time.Duration
		viaTick     bool // no samples after the first one under the threshold
	}{
		{"zero resolves on the first sample under", 0, false},
		{"2m of samples under", 2 * time.Minute, false},
		{"2m with no samples resolves from Tick", 2 * time.Minute, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, []Rule{cpuRule(1, 80, 0, tc.autoResolve)}, []ServerInfo{srv(10)})
			h.observe(10, 90)
			recoverAt := h.clock.Advance(step)
			h.observe(10, 10)
			wantAt := recoverAt.Add(tc.autoResolve)

			if tc.autoResolve > 0 {
				if tc.viaTick {
					h.clock.Advance(tc.autoResolve - time.Second)
					h.eng.Tick(h.ctx)
				} else {
					for d := step; d < tc.autoResolve; d += step {
						h.clock.Advance(step)
						h.observe(10, 10)
					}
				}
				if n := len(h.resolves()); n != 0 {
					t.Fatalf("resolved %s early", tc.autoResolve)
				}
				h.clock.Advance(wantAt.Sub(h.clock.Now()))
				if tc.viaTick {
					h.eng.Tick(h.ctx)
				} else {
					h.observe(10, 10)
				}
			}

			resolves := h.resolves()
			if len(resolves) != 1 || resolves[0].How != ResolvedAuto || !resolves[0].At.Equal(wantAt) {
				t.Fatalf("resolves = %+v, want one auto resolve at %s", resolves, wantAt)
			}
			if len(h.eng.Open(testOrg)) != 0 {
				t.Fatal("incident still open in memory after auto-resolve")
			}
		})
	}
}

func TestEngineBelowTracksMinimumAsPeak(t *testing.T) {
	r := cpuRule(1, 20, 0, 0)
	r.Metric, r.Comparison = MetricMemory, Below
	h := newHarness(t, []Rule{r}, []ServerInfo{srv(10)})
	for _, v := range []float32{15, 5, 12} {
		h.eng.Observe(h.ctx, 10, metrics.Point{Mem: v})
		h.clock.Advance(step)
	}
	h.eng.Observe(h.ctx, 10, metrics.Point{Mem: 50})
	if res := h.resolves(); len(res) != 1 || res[0].Peak != 5 || res[0].SamplesOver != 3 {
		t.Fatalf("resolves = %+v, want peak 5 (the minimum) over 3 samples", res)
	}
}

func TestEngineHeartbeatFiresAndResolves(t *testing.T) {
	const forDur = 5 * time.Minute
	h := newHarness(t, []Rule{heartbeatRule(1, forDur)}, []ServerInfo{srv(10)})
	h.eng.Heartbeat(10, t0)

	h.clock.Advance(forDur - step)
	h.eng.Tick(h.ctx)
	if len(h.opens()) != 0 {
		t.Fatal("heartbeat fired before For elapsed")
	}

	h.clock.Advance(step)
	h.eng.Tick(h.ctx)
	opens := h.opens()
	if len(opens) != 1 {
		t.Fatalf("%d incidents opened at For, want 1", len(opens))
	}
	if inc := opens[0]; inc.Metric != MetricHeartbeat || inc.LastValue != forDur.Seconds() ||
		inc.Threshold != forDur.Seconds() || inc.Severity != Critical {
		t.Fatalf("incident = %+v, want heartbeat, value and threshold %gs", inc, forDur.Seconds())
	}

	h.clock.Advance(time.Minute)
	h.eng.Tick(h.ctx)
	if open := h.eng.Open(testOrg); len(open) != 1 || open[0].LastValue != 360 || len(h.opens()) != 1 {
		t.Fatalf("after another minute: open %+v, opens %d; want one incident at 360s", open, len(h.opens()))
	}

	back := h.clock.Advance(30 * time.Second)
	h.eng.Heartbeat(10, back)
	res := h.resolves()
	if len(res) != 1 || res[0].How != ResolvedAuto || !res[0].At.Equal(back) || res[0].Peak != 390 {
		t.Fatalf("resolves = %+v, want auto at %s with peak 390s", res, back)
	}
	if got := h.notes.kinds(); !slices.Equal(got, []EventKind{EventFired, EventResolved}) {
		t.Fatalf("events = %v", got)
	}

	h.clock.Advance(time.Minute)
	h.eng.Tick(h.ctx)
	if len(h.opens()) != 1 {
		t.Fatal("heartbeat re-fired right after the host came back")
	}
	h.noViolations()
}

func TestEngineLoadDoesNotFireHeartbeatsImmediately(t *testing.T) {
	const forDur = 5 * time.Minute
	rule := heartbeatRule(1, forDur)
	stale := Incident{OrgID: testOrg, ServerID: 12, RuleID: 1, RuleName: rule.Name, Metric: MetricHeartbeat,
		Severity: Critical, Threshold: forDur.Seconds(), Peak: 900, LastValue: 900, StartedAt: t0.Add(-time.Hour)}
	h := newHarness(t, []Rule{rule}, []ServerInfo{srv(10), srv(11), srv(12)}, stale)

	h.eng.Tick(h.ctx)
	h.clock.Advance(forDur - step)
	h.eng.Tick(h.ctx)
	if n := len(h.opens()); n != 0 {
		t.Fatalf("%d heartbeat incidents opened within For of Load", n)
	}
	open := h.eng.Open(testOrg)
	if len(open) != 1 || open[0].ServerID != 12 || open[0].Peak != 900 {
		t.Fatalf("Open = %+v, want the restored incident for server 12", open)
	}
	if sev, ok := h.eng.ServerSeverity(12); !ok || sev != Critical {
		t.Fatalf("ServerSeverity(12) = %q, %v; want critical", sev, ok)
	}

	h.clock.Advance(step)
	h.eng.Tick(h.ctx)
	var fired []int64
	for _, inc := range h.opens() {
		fired = append(fired, inc.ServerID)
	}
	slices.Sort(fired)
	if !slices.Equal(fired, []int64{10, 11}) {
		t.Fatalf("fired for servers %v, want [10 11] (12 was already open)", fired)
	}

	h.eng.Heartbeat(12, h.clock.Now())
	if res := h.resolves(); len(res) != 1 || res[0].ID != open[0].ID || res[0].How != ResolvedAuto {
		t.Fatalf("resolves = %+v, want the restored incident resolved by the heartbeat", res)
	}
	h.noViolations()
}

func TestEngineLoadResolvesStaleIncidents(t *testing.T) {
	disabled := cpuRule(2, 80, 0, 0)
	disabled.Enabled = false
	rules := []Rule{cpuRule(1, 80, 0, 0), disabled, cpuRule(3, 80, 0, 0)}
	base := Incident{OrgID: testOrg, ServerID: 10, RuleID: 1, Metric: MetricCPU, Severity: Warning, Threshold: 80,
		Peak: 97, LastValue: 91, SamplesOver: 40, StartedAt: t0.Add(-time.Hour)}
	with := func(f func(*Incident)) Incident {
		inc := base
		f(&inc)
		return inc
	}
	preload := []Incident{
		base, // id 1: restored
		with(func(i *Incident) { i.ServerID = 99 }),                                  // id 2: server gone
		with(func(i *Incident) { i.RuleID = 2 }),                                     // id 3: rule disabled
		with(func(i *Incident) { i.RuleID = 404 }),                                   // id 4: rule gone
		with(func(i *Incident) { i.RuleID, i.Severity = 3, Critical }),               // id 5: rule changed
		with(func(i *Incident) { i.StartedAt = t0.Add(-time.Minute) }),               // id 6: duplicate of 1
		with(func(i *Incident) { i.OrgID, i.ServerID = otherOrg, 10; i.RuleID = 1 }), // id 7: wrong org
	}
	h := newHarness(t, rules, []ServerInfo{srv(10)}, preload...)

	got := map[int64]ResolveHow{}
	for _, r := range h.resolves() {
		got[r.ID] = r.How
	}
	want := map[int64]ResolveHow{
		2: ResolvedServerDeleted, 3: ResolvedRuleDeleted, 4: ResolvedRuleDeleted,
		5: ResolvedRuleDeleted, 6: ResolvedAuto, 7: ResolvedRuleDeleted,
	}
	if len(got) != len(want) {
		t.Fatalf("resolved %v, want %v", got, want)
	}
	for id, how := range want {
		if got[id] != how {
			t.Errorf("incident %d resolved as %q, want %q", id, got[id], how)
		}
	}
	if len(h.notes.all()) != 0 {
		t.Fatalf("Load cleanup sent notifications: %v", h.notes.kinds())
	}
	open := h.eng.Open(testOrg)
	if len(open) != 1 || open[0].ID != 1 || open[0].Peak != 97 || open[0].SamplesOver != 40 {
		t.Fatalf("Open = %+v, want incident 1 with its stored progress", open)
	}

	h.observe(10, 99) // restored as firing: a breach is the same incident
	h.observe(10, 10)
	var restored *resolveCall
	for _, r := range h.resolves() {
		if r.ID == 1 {
			restored = &r
		}
	}
	if restored == nil || restored.How != ResolvedAuto || restored.Peak != 99 || restored.SamplesOver != 41 {
		t.Fatalf("resolve of incident 1 = %+v, want auto with peak 99 and 41 samples", restored)
	}
	for _, inc := range h.opens() {
		if inc.RuleID == 1 {
			t.Fatal("restored incident was opened again")
		}
	}
	h.noViolations()
}

func TestEngineRenotifyCooldownAndAck(t *testing.T) {
	const never = -1
	tests := []struct {
		name     string
		cooldown time.Duration
		ackAfter time.Duration
		want     []time.Duration // renotify times after the fire
	}{
		{"every cooldown while firing", 30 * time.Minute, never, []time.Duration{30 * time.Minute, 60 * time.Minute, 90 * time.Minute, 120 * time.Minute}},
		{"acked right away", 30 * time.Minute, 0, nil},
		{"acked after the first renotify", 30 * time.Minute, 45 * time.Minute, []time.Duration{30 * time.Minute}},
		{"cooldown zero never renotifies", 0, never, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := cpuRule(1, 80, 0, 0)
			r.Cooldown = tc.cooldown
			h := newHarness(t, []Rule{r}, []ServerInfo{srv(10)})
			h.observe(10, 90)
			id := h.opens()[0].ID
			if tc.ackAfter == 0 {
				h.eng.Ack(id, t0)
			}
			for elapsed := time.Minute; elapsed <= 2*time.Hour; elapsed += time.Minute {
				h.clock.Advance(time.Minute)
				if tc.ackAfter > 0 && elapsed == tc.ackAfter {
					h.eng.Ack(id, h.clock.Now())
				}
				h.observe(10, 90)
				h.eng.Tick(h.ctx)
			}

			var got []time.Duration
			for _, ev := range h.notes.all() {
				if ev.Kind != EventRenotify {
					continue
				}
				got = append(got, ev.At.Sub(t0))
				if ev.Incident.LastNotifiedAt == nil || !ev.Incident.LastNotifiedAt.Equal(ev.At) {
					t.Errorf("renotify at %s carries LastNotifiedAt %v", ev.At, ev.Incident.LastNotifiedAt)
				}
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("renotified at %v, want %v", got, tc.want)
			}
			if tc.ackAfter >= 0 {
				if open := h.eng.Open(testOrg); len(open) != 1 || open[0].AckedAt == nil {
					t.Fatalf("Open = %+v, want the incident acked", open)
				}
			}
		})
	}
}

func TestEngineManualResolve(t *testing.T) {
	t.Run("resets to ok and a continuing breach starts a new cycle", func(t *testing.T) {
		const forDur = time.Minute
		h := newHarness(t, []Rule{cpuRule(1, 80, forDur, 0)}, []ServerInfo{srv(10)})
		h.observe(10, 90)
		h.hold(10, 90, forDur)
		first := h.opens()[0].ID

		at := h.clock.Now()
		if err := h.eng.Resolve(h.ctx, first, at); err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if res := h.resolves(); len(res) != 1 || res[0].ID != first || res[0].How != ResolvedManual || !res[0].At.Equal(at) {
			t.Fatalf("resolves = %+v, want manual resolve of %d at %s", res, first, at)
		}
		if got := h.notes.kinds(); !slices.Equal(got, []EventKind{EventFired, EventResolved}) {
			t.Fatalf("events = %v", got)
		}
		if len(h.eng.Open(testOrg)) != 0 {
			t.Fatal("still open after manual resolve")
		}

		// The new pending cycle starts at the first breach after the resolve.
		h.hold(10, 90, forDur)
		if len(h.opens()) != 1 {
			t.Fatal("re-fired before a new For elapsed")
		}
		h.hold(10, 90, step)
		if opens := h.opens(); len(opens) != 2 || opens[1].ID == first {
			t.Fatalf("opens = %+v, want a second, new incident", opens)
		}

		for _, id := range []int64{first, 12345} {
			if err := h.eng.Resolve(h.ctx, id, at); !errors.Is(err, ErrIncidentNotFound) {
				t.Errorf("Resolve(%d) = %v, want ErrIncidentNotFound", id, err)
			}
		}
		h.noViolations()
	})

	t.Run("store failure keeps the incident open", func(t *testing.T) {
		h := newHarness(t, []Rule{cpuRule(1, 80, 0, 0)}, []ServerInfo{srv(10)})
		h.observe(10, 90)
		id := h.opens()[0].ID
		h.store.mu.Lock()
		h.store.failResolve = 1
		h.store.mu.Unlock()

		if err := h.eng.Resolve(h.ctx, id, h.clock.Now()); !errors.Is(err, errFake) {
			t.Fatalf("Resolve = %v, want the store error", err)
		}
		if open := h.eng.Open(testOrg); len(open) != 1 || open[0].ID != id {
			t.Fatalf("Open = %+v, want incident %d still open", open, id)
		}
		if err := h.eng.Resolve(h.ctx, id, h.clock.Now()); err != nil {
			t.Fatalf("retry: %v", err)
		}
		h.noViolations()
	})

	t.Run("heartbeat restarts the silence clock", func(t *testing.T) {
		const forDur = 5 * time.Minute
		h := newHarness(t, []Rule{heartbeatRule(1, forDur)}, []ServerInfo{srv(10)})
		h.clock.Advance(forDur)
		h.eng.Tick(h.ctx)
		id := h.opens()[0].ID
		if err := h.eng.Resolve(h.ctx, id, h.clock.Now()); err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		h.clock.Advance(forDur - step)
		h.eng.Tick(h.ctx)
		if len(h.opens()) != 1 {
			t.Fatal("heartbeat re-fired right after a manual resolve")
		}
		h.clock.Advance(step)
		h.eng.Tick(h.ctx)
		if len(h.opens()) != 2 {
			t.Fatal("heartbeat did not fire again after another silent For")
		}
	})
}

func TestEngineSetOrgRules(t *testing.T) {
	base := cpuRule(1, 80, 0, 2*time.Minute)
	base.Cooldown = 30 * time.Minute
	base.ChannelIDs = []int64{1}
	base.Scope = Scope{ServerIDs: []int64{10, 11}, Tags: []string{"web"}}

	tests := []struct {
		name         string
		edit         func(r *Rule)
		remove       bool
		wantResolved bool
	}{
		{"rename keeps", func(r *Rule) { r.Name = "renamed" }, false, false},
		{"channels keep", func(r *Rule) { r.ChannelIDs = []int64{1, 2} }, false, false},
		{"cooldown keeps", func(r *Rule) { r.Cooldown = time.Hour }, false, false},
		{"auto-resolve keeps", func(r *Rule) { r.AutoResolve = 0 }, false, false},
		{"reordered scope keeps", func(r *Rule) { r.Scope = Scope{ServerIDs: []int64{11, 10}, Tags: []string{"WEB"}} }, false, false},
		{"threshold resolves", func(r *Rule) { r.Threshold = 85 }, false, true},
		{"for resolves", func(r *Rule) { r.For = time.Minute }, false, true},
		{"comparison resolves", func(r *Rule) { r.Comparison, r.Threshold = Below, 95 }, false, true},
		{"severity resolves", func(r *Rule) { r.Severity = Critical }, false, true},
		{"metric resolves", func(r *Rule) { r.Metric = MetricMemory }, false, true},
		{"scope resolves", func(r *Rule) { r.Scope.ServerIDs = append(r.Scope.ServerIDs, 12) }, false, true},
		{"disable resolves", func(r *Rule) { r.Enabled = false }, false, true},
		{"delete resolves", nil, true, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, []Rule{base.clone()}, []ServerInfo{srv(10)})
			h.observe(10, 90)
			id := h.opens()[0].ID

			var next []Rule
			if !tc.remove {
				r := base.clone()
				tc.edit(&r)
				next = []Rule{r}
			}
			h.eng.SetOrgRules(testOrg, next)

			res := h.resolves()
			open := h.eng.Open(testOrg)
			if tc.wantResolved {
				if len(res) != 1 || res[0].ID != id || res[0].How != ResolvedRuleDeleted || len(open) != 0 {
					t.Fatalf("resolves %+v, open %+v; want incident %d resolved as rule_changed", res, open, id)
				}
				if len(h.notes.all()) != 1 {
					t.Fatalf("events = %v, want only the fired event", h.notes.kinds())
				}
				return
			}
			if len(res) != 0 || len(open) != 1 || open[0].ID != id {
				t.Fatalf("resolves %+v, open %+v; want incident %d kept", res, open, id)
			}
			h.noViolations()
		})
	}

	t.Run("cosmetic edit applies to the kept incident", func(t *testing.T) {
		h := newHarness(t, []Rule{base.clone()}, []ServerInfo{srv(10)})
		h.observe(10, 90)
		r := base.clone()
		r.Name, r.AutoResolve = "renamed", 0
		h.eng.SetOrgRules(testOrg, []Rule{r})

		h.clock.Advance(step)
		h.observe(10, 10) // AutoResolve is now 0: resolves at once
		evs := h.notes.all()
		if len(evs) != 2 || evs[1].Kind != EventResolved || evs[1].Rule.Name != "renamed" {
			t.Fatalf("events = %+v, want a resolved event carrying the renamed rule", evs)
		}
	})

	t.Run("another org's update leaves this org alone", func(t *testing.T) {
		h := newHarness(t, []Rule{base.clone()}, []ServerInfo{srv(10)})
		h.observe(10, 90)
		stray := base.clone()
		stray.OrgID = otherOrg
		h.eng.SetOrgRules(otherOrg, nil)
		h.eng.SetOrgRules(otherOrg, []Rule{stray})
		if len(h.resolves()) != 0 || len(h.eng.Open(testOrg)) != 1 {
			t.Fatal("an update for another org touched this org's incident")
		}
	})
}

func TestEngineScopeMatching(t *testing.T) {
	byID := cpuRule(1, 80, 0, 0)
	byID.Scope = Scope{ServerIDs: []int64{10, 20}}
	byTag := cpuRule(2, 80, 0, 0)
	byTag.Scope = Scope{Tags: []string{"Web"}}
	servers := []ServerInfo{srv(10), srv(11, "web"), srv(12, "db"), {ID: 20, OrgID: otherOrg}}
	h := newHarness(t, []Rule{byID, byTag}, servers)

	for _, s := range servers {
		h.observe(s.ID, 90)
	}
	var got []pair
	for _, inc := range h.opens() {
		got = append(got, pair{inc.RuleID, inc.ServerID})
	}
	want := []pair{{1, 10}, {2, 11}}
	if !slices.Equal(got, want) {
		t.Fatalf("fired pairs %v, want %v (server 20 is another org's)", got, want)
	}

	h.eng.UpsertServer(srv(11, "db"))
	if res := h.resolves(); len(res) != 1 || res[0].How != ResolvedRuleDeleted {
		t.Fatalf("resolves = %+v, want the tag rule's incident closed when the tag is removed", res)
	}
	h.eng.UpsertServer(srv(12, "WEB"))
	h.observe(12, 90)
	if opens := h.opens(); len(opens) != 3 || opens[2].RuleID != 2 || opens[2].ServerID != 12 {
		t.Fatalf("opens = %+v, want the tag rule firing on newly tagged server 12", opens)
	}
	h.noViolations()
}

func TestEngineOpenIncidentFailureRetries(t *testing.T) {
	t.Run("threshold retries on the next breach", func(t *testing.T) {
		const forDur = time.Minute
		h := newHarness(t, []Rule{cpuRule(1, 80, forDur, 0)}, []ServerInfo{srv(10)})
		h.store.failOpen = 1
		h.observe(10, 90)
		h.hold(10, 90, forDur)
		if len(h.opens()) != 0 || len(h.notes.all()) != 0 || len(h.eng.Open(testOrg)) != 0 {
			t.Fatal("a failed open left an incident or sent a notification")
		}
		if _, ok := h.eng.ServerSeverity(10); ok {
			t.Fatal("a failed open counts toward server severity")
		}

		retryAt := h.clock.Advance(step)
		h.observe(10, 90)
		opens := h.opens()
		if len(opens) != 1 || !opens[0].StartedAt.Equal(retryAt) {
			t.Fatalf("opens = %+v, want the retry to open at once at %s", opens, retryAt)
		}
		if got := h.notes.kinds(); !slices.Equal(got, []EventKind{EventFired}) {
			t.Fatalf("events = %v", got)
		}
	})

	t.Run("heartbeat retries on the next tick", func(t *testing.T) {
		const forDur = 5 * time.Minute
		h := newHarness(t, []Rule{heartbeatRule(1, forDur)}, []ServerInfo{srv(10)})
		h.store.failOpen = 1
		h.clock.Advance(forDur)
		h.eng.Tick(h.ctx)
		if len(h.opens()) != 0 {
			t.Fatal("open recorded despite failure")
		}
		h.clock.Advance(step)
		h.eng.Tick(h.ctx)
		if len(h.opens()) != 1 {
			t.Fatal("heartbeat open was not retried")
		}
	})
}

func TestEngineAutoResolveFailureRetries(t *testing.T) {
	h := newHarness(t, []Rule{cpuRule(1, 80, 0, 0)}, []ServerInfo{srv(10)})
	h.observe(10, 90)
	h.store.mu.Lock()
	h.store.failResolve = 1
	h.store.mu.Unlock()

	h.clock.Advance(step)
	h.observe(10, 10)
	if len(h.resolves()) != 0 || len(h.eng.Open(testOrg)) != 1 {
		t.Fatal("a failed auto-resolve dropped the incident from memory")
	}
	h.eng.Tick(h.ctx)
	if len(h.resolves()) != 1 || len(h.eng.Open(testOrg)) != 0 {
		t.Fatal("the next Tick did not retry the resolve")
	}
	h.noViolations()
}

func TestEngineSaveProgressWritesOnlyChanged(t *testing.T) {
	r := cpuRule(1, 80, 0, 0)
	r.Cooldown = 10 * time.Minute
	h := newHarness(t, []Rule{r}, []ServerInfo{srv(10), srv(11)})
	h.observe(10, 90)
	h.observe(11, 90)

	h.eng.SaveProgress(h.ctx)
	if n := len(h.saves()); n != 0 {
		t.Fatalf("%d saves right after open, want 0", n)
	}

	h.observe(10, 95)
	h.eng.SaveProgress(h.ctx)
	saves := h.saves()
	id10 := h.opens()[0].ID
	if len(saves) != 1 || saves[0].ID != id10 || saves[0].Peak != 95 || saves[0].LastValue != 95 || saves[0].SamplesOver != 2 {
		t.Fatalf("saves = %+v, want one save of incident %d with peak 95 over 2 samples", saves, id10)
	}

	h.eng.SaveProgress(h.ctx)
	if n := len(h.saves()); n != 1 {
		t.Fatalf("%d saves after an unchanged flush, want still 1", n)
	}

	now := h.clock.Advance(r.Cooldown)
	h.eng.Tick(h.ctx) // renotify both: lastNotified changes
	h.eng.SaveProgress(h.ctx)
	saves = h.saves()
	if len(saves) != 3 {
		t.Fatalf("%d saves after renotify, want 3", len(saves))
	}
	for _, s := range saves[1:] {
		if s.LastNotifiedAt == nil || !s.LastNotifiedAt.Equal(now) {
			t.Errorf("save %+v, want LastNotifiedAt %s", s, now)
		}
	}
}

func TestEngineRemoveServer(t *testing.T) {
	const forDur = 5 * time.Minute
	h := newHarness(t, []Rule{cpuRule(1, 80, 0, 0), heartbeatRule(2, forDur)}, []ServerInfo{srv(10)})
	h.observe(10, 90)
	id := h.opens()[0].ID

	h.eng.RemoveServer(h.ctx, 10)
	if res := h.resolves(); len(res) != 1 || res[0].ID != id || res[0].How != ResolvedServerDeleted {
		t.Fatalf("resolves = %+v, want incident %d resolved as server_deleted", res, id)
	}
	if got := h.notes.kinds(); !slices.Equal(got, []EventKind{EventFired}) {
		t.Fatalf("events = %v, want no resolved event for a deleted server", got)
	}

	h.eng.Heartbeat(10, h.clock.Now())
	h.observe(10, 99)
	h.clock.Advance(2 * forDur)
	h.eng.Tick(h.ctx)
	if len(h.opens()) != 1 {
		t.Fatal("a removed server kept being evaluated")
	}
}

// TestEngineResolveWhileOpening holds OpenIncident in flight and resolves the
// pair meanwhile: the opener must close the incident once it has the ID.
func TestEngineResolveWhileOpening(t *testing.T) {
	tests := []struct {
		name       string
		resolve    func(h *harness)
		wantHow    ResolveHow
		wantEvents []EventKind
	}{
		{"server removed", func(h *harness) { h.eng.RemoveServer(h.ctx, 10) }, ResolvedServerDeleted, nil},
		{"rule deleted", func(h *harness) { h.eng.SetOrgRules(testOrg, nil) }, ResolvedRuleDeleted, nil},
		{"recovered", func(h *harness) { h.observe(10, 10) }, ResolvedAuto, []EventKind{EventFired, EventResolved}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, []Rule{cpuRule(1, 80, 0, 0)}, []ServerInfo{srv(10)})
			gate := make(chan struct{})
			h.store.mu.Lock()
			h.store.gate, h.store.entered = gate, make(chan struct{}, 1)
			h.store.mu.Unlock()

			done := make(chan struct{})
			go func() {
				defer close(done)
				h.observe(10, 90)
			}()
			<-h.store.entered
			tc.resolve(h)
			if len(h.resolves()) != 0 {
				t.Fatal("resolved before the incident ID was known")
			}
			close(gate)
			<-done

			opens, res := h.opens(), h.resolves()
			if len(opens) != 1 || len(res) != 1 || res[0].ID != opens[0].ID || res[0].How != tc.wantHow {
				t.Fatalf("opens %+v resolves %+v, want the opened incident resolved as %q", opens, res, tc.wantHow)
			}
			if got := h.notes.kinds(); !slices.Equal(got, tc.wantEvents) {
				t.Fatalf("events = %v, want %v", got, tc.wantEvents)
			}
			if len(h.eng.Open(testOrg)) != 0 {
				t.Fatal("incident left open in memory")
			}
			h.noViolations()
		})
	}
}

func TestEngineOpenAndServerSeverity(t *testing.T) {
	warn := cpuRule(1, 80, 0, 0)
	crit := cpuRule(2, 90, 0, 0)
	crit.Severity = Critical
	other := cpuRule(3, 0, 0, 0)
	other.OrgID = otherOrg
	h := newHarness(t, []Rule{warn, crit, other}, []ServerInfo{srv(10), srv(11), {ID: 20, OrgID: otherOrg}})

	h.observe(10, 85)
	h.clock.Advance(step)
	h.observe(11, 95)
	h.observe(20, 50)

	for _, tc := range []struct {
		server int64
		want   Severity
		ok     bool
	}{
		{10, Warning, true},
		{11, Critical, true},
		{12, "", false},
	} {
		if got, ok := h.eng.ServerSeverity(tc.server); got != tc.want || ok != tc.ok {
			t.Errorf("ServerSeverity(%d) = %q, %v; want %q, %v", tc.server, got, ok, tc.want, tc.ok)
		}
	}

	open := h.eng.Open(testOrg)
	if len(open) != 3 || open[0].ServerID != 10 {
		t.Fatalf("Open(testOrg) = %+v, want 3 incidents, oldest first", open)
	}
	if o := h.eng.Open(otherOrg); len(o) != 1 || o[0].ServerID != 20 {
		t.Fatalf("Open(otherOrg) = %+v, want only server 20's incident", o)
	}

	ackedAt := h.clock.Now()
	open[0].Peak = -1
	open[0].AckedAt = &ackedAt
	*open[0].LastNotifiedAt = time.Time{}
	again := h.eng.Open(testOrg)
	if again[0].Peak == -1 || again[0].AckedAt != nil || again[0].LastNotifiedAt.IsZero() {
		t.Fatal("Open returned incidents that alias engine state")
	}

	h.eng.Ack(again[0].ID, ackedAt)
	if acked := h.eng.Open(testOrg)[0]; acked.AckedAt == nil || !acked.AckedAt.Equal(ackedAt) {
		t.Fatalf("after Ack, AckedAt = %v", acked.AckedAt)
	}
}

// TestEngineConcurrentObserve runs every entry point at once under -race and
// then checks the store and the engine agree on what is open.
func TestEngineConcurrentObserve(t *testing.T) {
	const (
		servers    = 16
		iterations = 400
	)
	cpu := cpuRule(1, 50, 10*time.Second, 0)
	cpu.Cooldown = 15 * time.Second
	mem := cpuRule(2, 60, 0, 5*time.Second)
	mem.Metric, mem.Severity = MetricMemory, Critical
	rules := []Rule{cpu, mem, heartbeatRule(3, time.Minute)}
	var infos []ServerInfo
	for id := int64(1); id <= servers; id++ {
		infos = append(infos, srv(id, "fleet"))
	}
	h := newHarness(t, rules, infos)
	ctx := context.Background()

	var agents sync.WaitGroup
	for _, s := range infos {
		agents.Add(1)
		go func(id int64) {
			defer agents.Done()
			rng := rand.New(rand.NewPCG(uint64(id), 7))
			for range iterations {
				if rng.IntN(4) > 0 { // some silence so heartbeat rules fire too
					h.eng.Heartbeat(id, h.clock.Now())
				}
				h.eng.Observe(ctx, id, metrics.Point{CPU: float32(rng.IntN(100)), Mem: float32(rng.IntN(100))})
			}
		}(s.ID)
	}

	stop := make(chan struct{})
	var background sync.WaitGroup
	background.Add(1)
	go func() {
		defer background.Done()
		rng := rand.New(rand.NewPCG(99, 7))
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			h.clock.Advance(time.Duration(rng.IntN(3000)) * time.Millisecond)
			h.eng.Tick(ctx)
			for _, s := range infos {
				h.eng.ServerSeverity(s.ID)
			}
			if open := h.eng.Open(testOrg); len(open) > 0 {
				pick := open[rng.IntN(len(open))]
				if i%3 == 0 {
					h.eng.Ack(pick.ID, h.clock.Now())
				}
				if i%7 == 0 {
					if err := h.eng.Resolve(ctx, pick.ID, h.clock.Now()); err != nil && !errors.Is(err, ErrIncidentNotFound) {
						t.Errorf("Resolve: %v", err)
					}
				}
			}
			if i%5 == 0 {
				renamed := slices.Clone(rules)
				renamed[0].Name = "cpu renamed"
				h.eng.SetOrgRules(testOrg, renamed)
				h.eng.UpsertServer(infos[rng.IntN(len(infos))])
			}
			h.eng.SaveProgress(ctx)
		}
	}()

	agents.Wait()
	close(stop)
	background.Wait()

	h.noViolations()
	var inEngine []int64
	for _, inc := range h.eng.Open(testOrg) {
		inEngine = append(inEngine, inc.ID)
	}
	slices.Sort(inEngine)
	if inStore := h.store.openIDs(); !slices.Equal(inEngine, inStore) {
		t.Fatalf("engine open %v, store open %v", inEngine, inStore)
	}
	if len(h.opens()) == 0 {
		t.Fatal("the run never fired; the test is not exercising transitions")
	}
}

// Regression: with For == 0, a breach right after an auto-resolve used to
// open the next incident while the previous resolve was still in flight, so
// the store briefly held two open incidents for one pair and "fired" could
// go out before "resolved".
func TestNextIncidentWaitsForPreviousResolve(t *testing.T) {
	r := cpuRule(1, 50, 0, 0)
	h := newHarness(t, []Rule{r}, []ServerInfo{srv(1)})
	breach, calm := metrics.Point{CPU: 90}, metrics.Point{CPU: 10}

	h.eng.Observe(h.ctx, 1, breach)
	if n := len(h.store.opens); n != 1 {
		t.Fatalf("opens after first breach = %d, want 1", n)
	}

	gate, entered := make(chan struct{}), make(chan struct{})
	h.store.mu.Lock()
	h.store.resolveGate, h.store.resolveEntered = gate, entered
	h.store.mu.Unlock()
	resolved := make(chan struct{})
	go func() {
		defer close(resolved)
		h.eng.Observe(h.ctx, 1, calm) // auto-resolve; blocks inside the store
	}()
	<-entered

	h.eng.Observe(h.ctx, 1, breach) // must wait: the resolve has not landed
	h.store.mu.Lock()
	opensWhileResolving := len(h.store.opens)
	h.store.mu.Unlock()
	if opensWhileResolving != 1 {
		t.Fatalf("opened a new incident while the previous resolve was in flight (opens = %d)", opensWhileResolving)
	}

	close(gate)
	<-resolved
	h.store.mu.Lock()
	h.store.resolveGate, h.store.resolveEntered = nil, nil
	h.store.mu.Unlock()

	h.eng.Observe(h.ctx, 1, breach) // now it fires
	if n := len(h.store.opens); n != 2 {
		t.Fatalf("opens after the resolve landed = %d, want 2", n)
	}
	h.noViolations()
}
