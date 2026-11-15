// Package directory is the in-memory copy of the control plane: orgs, plans,
// servers (with token hashes), rules, channels, uptime checks and pins. It is loaded once at
// startup and updated on every write, so agent connects and dashboard polls
// never touch the database (PLAN.md 2.3.2 item 7). The backend is a single
// process, so write-through is enough to stay consistent.
package directory

import (
	"context"
	"slices"
	"sync"
	"time"

	"backend/store"
)

// Loader is the subset of store.Store used to fill the directory.
type Loader interface {
	ListAllOrgs(ctx context.Context) ([]store.Org, error)
	ListPlans(ctx context.Context) ([]store.Plan, error)
	ListAllServers(ctx context.Context) ([]store.Server, error)
	ListAllRules(ctx context.Context) ([]store.Rule, error)
	ListAllChannels(ctx context.Context) ([]store.Channel, error)
	ListAllChecks(ctx context.Context) ([]store.Check, error)
	ListPins(ctx context.Context, userID int64) ([]int64, error)
	ListAllMaintenanceWindows(ctx context.Context) ([]store.MaintenanceWindow, error)
}

type Directory struct {
	loader Loader
	now    func() time.Time

	mu       sync.RWMutex
	orgs     map[int64]store.Org
	plans    map[string]store.Plan
	servers  map[int64]store.Server
	byToken  map[string]int64
	byPrev   map[string]int64
	rules    map[int64][]store.Rule    // by org
	channels map[int64][]store.Channel // by org
	checks   map[int64][]store.Check   // by org
	pins     map[int64]map[int64]bool  // user -> server set, loaded lazily
	touches  map[int64]store.ServerTouch
	// Maintenance windows by org. Slices are replaced, never modified in
	// place, so readers can scan them without copying.
	maintenance map[int64][]store.MaintenanceWindow
}

func New(loader Loader) *Directory {
	return &Directory{
		loader:   loader,
		now:      time.Now,
		orgs:     map[int64]store.Org{},
		plans:    map[string]store.Plan{},
		servers:  map[int64]store.Server{},
		byToken:  map[string]int64{},
		byPrev:   map[string]int64{},
		rules:    map[int64][]store.Rule{},
		channels: map[int64][]store.Channel{},
		checks:   map[int64][]store.Check{},
		pins:     map[int64]map[int64]bool{},
		touches:  map[int64]store.ServerTouch{},

		maintenance: map[int64][]store.MaintenanceWindow{},
	}
}

// Load fills the directory; a few queries at startup instead of per request.
func (d *Directory) Load(ctx context.Context) error {
	orgs, err := d.loader.ListAllOrgs(ctx)
	if err != nil {
		return err
	}
	plans, err := d.loader.ListPlans(ctx)
	if err != nil {
		return err
	}
	servers, err := d.loader.ListAllServers(ctx)
	if err != nil {
		return err
	}
	rules, err := d.loader.ListAllRules(ctx)
	if err != nil {
		return err
	}
	channels, err := d.loader.ListAllChannels(ctx)
	if err != nil {
		return err
	}
	windows, err := d.loader.ListAllMaintenanceWindows(ctx)
	if err != nil {
		return err
	}
	checks, err := d.loader.ListAllChecks(ctx)
	if err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, o := range orgs {
		d.orgs[o.ID] = o
	}
	for _, p := range plans {
		d.plans[p.ID] = p
	}
	for _, s := range servers {
		d.putServerLocked(s)
	}
	for _, r := range rules {
		d.rules[r.OrgID] = append(d.rules[r.OrgID], r)
	}
	for _, c := range channels {
		d.channels[c.OrgID] = append(d.channels[c.OrgID], c)
	}
	for _, w := range windows {
		d.maintenance[w.OrgID] = append(d.maintenance[w.OrgID], w)
	}
	for _, c := range checks {
		d.checks[c.OrgID] = append(d.checks[c.OrgID], c)
	}
	return nil
}

// --- orgs and plans

func (d *Directory) Org(id int64) (store.Org, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	o, ok := d.orgs[id]
	return o, ok
}

func (d *Directory) PutOrg(o store.Org) {
	d.mu.Lock()
	d.orgs[o.ID] = o
	d.mu.Unlock()
}

// RemoveOrg drops an org and everything it owns; returns its server IDs.
func (d *Directory) RemoveOrg(id int64) []int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.orgs, id)
	delete(d.rules, id)
	delete(d.channels, id)
	delete(d.maintenance, id)
	delete(d.checks, id)
	var removed []int64
	for sid, s := range d.servers {
		if s.OrgID == id {
			d.removeServerLocked(sid)
			removed = append(removed, sid)
		}
	}
	return removed
}

// Plan returns the plan for an org, falling back to the most restrictive
// known plan so a missing row never means "unlimited".
func (d *Directory) Plan(orgID int64) store.Plan {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if o, ok := d.orgs[orgID]; ok {
		if p, ok := d.plans[o.PlanID]; ok {
			return p
		}
	}
	if p, ok := d.plans["free"]; ok {
		return p
	}
	return store.Plan{ID: "free", MaxServers: 1, MinIntervalSeconds: 30, Retention1mDays: 1, Retention1hDays: 7,
		MaxMembers: 1, AlertEmailsPerDay: 5, MaxRules: 5, MaxChannels: 1, APIRPM: 60,
		MaxChecks: 1, MinCheckIntervalSeconds: 300}
}

func (d *Directory) PlanByID(id string) (store.Plan, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	p, ok := d.plans[id]
	return p, ok
}

// --- servers

func (d *Directory) putServerLocked(s store.Server) {
	if old, ok := d.servers[s.ID]; ok {
		delete(d.byToken, old.TokenHash)
		if old.PrevTokenHash != nil {
			delete(d.byPrev, *old.PrevTokenHash)
		}
	}
	d.servers[s.ID] = s
	d.byToken[s.TokenHash] = s.ID
	if s.PrevTokenHash != nil && s.PrevTokenExpiresAt != nil && d.now().Before(*s.PrevTokenExpiresAt) {
		d.byPrev[*s.PrevTokenHash] = s.ID
	}
}

func (d *Directory) removeServerLocked(id int64) {
	s, ok := d.servers[id]
	if !ok {
		return
	}
	delete(d.byToken, s.TokenHash)
	if s.PrevTokenHash != nil {
		delete(d.byPrev, *s.PrevTokenHash)
	}
	delete(d.servers, id)
	delete(d.touches, id)
	for _, set := range d.pins {
		delete(set, id)
	}
}

func (d *Directory) PutServer(s store.Server) {
	d.mu.Lock()
	d.putServerLocked(s)
	d.mu.Unlock()
}

func (d *Directory) RemoveServer(id int64) {
	d.mu.Lock()
	d.removeServerLocked(id)
	d.mu.Unlock()
}

func (d *Directory) Server(id int64) (store.Server, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	s, ok := d.servers[id]
	return s, ok
}

// OrgServer returns a server only if it belongs to orgID: every tenant-scoped
// lookup goes through here.
func (d *Directory) OrgServer(orgID, id int64) (store.Server, bool) {
	s, ok := d.Server(id)
	if !ok || s.OrgID != orgID {
		return store.Server{}, false
	}
	return s, true
}

func (d *Directory) OrgServers(orgID int64) []store.Server {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var out []store.Server
	for _, s := range d.servers {
		if s.OrgID == orgID {
			out = append(out, s)
		}
	}
	slices.SortFunc(out, func(a, b store.Server) int {
		if a.Name != b.Name {
			if a.Name < b.Name {
				return -1
			}
			return 1
		}
		return int(a.ID - b.ID)
	})
	return out
}

func (d *Directory) AllServers() []store.Server {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]store.Server, 0, len(d.servers))
	for _, s := range d.servers {
		out = append(out, s)
	}
	return out
}

func (d *Directory) ServerCount(orgID int64) int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	n := 0
	for _, s := range d.servers {
		if s.OrgID == orgID {
			n++
		}
	}
	return n
}

// ServerByTokenHash authenticates an agent. The previous token stays valid
// until its rotation grace period ends.
func (d *Directory) ServerByTokenHash(hash string) (store.Server, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if id, ok := d.byToken[hash]; ok {
		return d.servers[id], true
	}
	if id, ok := d.byPrev[hash]; ok {
		s := d.servers[id]
		if s.PrevTokenExpiresAt != nil && d.now().Before(*s.PrevTokenExpiresAt) {
			return s, true
		}
	}
	return store.Server{}, false
}

// RecordConnect notes token use and agent version in memory; the flush
// window persists it, so a flapping agent costs no writes.
func (d *Directory) RecordConnect(serverID int64, version string, at time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s, ok := d.servers[serverID]
	if !ok {
		return
	}
	t := d.touches[serverID]
	t.ID, t.TokenUsedAt = serverID, at
	if version != "" && version != s.AgentVersion {
		t.AgentVersion = version
		s.AgentVersion = version
	}
	s.TokenLastUsedAt = &at
	d.servers[serverID] = s
	d.touches[serverID] = t
}

// DrainTouches merges pending connect data with last-seen times from the
// metrics store, for one batched UPDATE in the flush window.
func (d *Directory) DrainTouches(lastSeen map[int64]time.Time) []store.ServerTouch {
	d.mu.Lock()
	defer d.mu.Unlock()
	for id, at := range lastSeen {
		s, ok := d.servers[id]
		if !ok || (s.LastSeen != nil && !at.After(*s.LastSeen)) {
			continue
		}
		t := d.touches[id]
		t.ID, t.LastSeen = id, at
		d.touches[id] = t
		at := at
		s.LastSeen = &at
		d.servers[id] = s
	}
	out := make([]store.ServerTouch, 0, len(d.touches))
	for _, t := range d.touches {
		out = append(out, t)
	}
	d.touches = map[int64]store.ServerTouch{}
	return out
}

// RequeueTouches puts back touches whose write failed.
func (d *Directory) RequeueTouches(ts []store.ServerTouch) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, t := range ts {
		if _, ok := d.servers[t.ID]; !ok {
			continue
		}
		cur := d.touches[t.ID]
		if cur.LastSeen.Before(t.LastSeen) {
			cur.LastSeen = t.LastSeen
		}
		if cur.TokenUsedAt.Before(t.TokenUsedAt) {
			cur.TokenUsedAt = t.TokenUsedAt
		}
		if cur.AgentVersion == "" {
			cur.AgentVersion = t.AgentVersion
		}
		cur.ID = t.ID
		d.touches[t.ID] = cur
	}
}

// --- rules and channels

func (d *Directory) OrgRules(orgID int64) []store.Rule {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return slices.Clone(d.rules[orgID])
}

func (d *Directory) AllRules() []store.Rule {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var out []store.Rule
	for _, rs := range d.rules {
		out = append(out, rs...)
	}
	return out
}

func (d *Directory) SetOrgRules(orgID int64, rules []store.Rule) {
	d.mu.Lock()
	d.rules[orgID] = slices.Clone(rules)
	d.mu.Unlock()
}

func (d *Directory) OrgChannels(orgID int64) []store.Channel {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return slices.Clone(d.channels[orgID])
}

func (d *Directory) SetOrgChannels(orgID int64, chs []store.Channel) {
	d.mu.Lock()
	d.channels[orgID] = slices.Clone(chs)
	d.mu.Unlock()
}

// UpdateChannelDelivery mirrors RecordDelivery so the Channels page shows the
// latest result without a reload.
func (d *Directory) UpdateChannelDelivery(channelID int64, at time.Time, deliveryErr error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for orgID, chs := range d.channels {
		for i := range chs {
			if chs[i].ID != channelID {
				continue
			}
			ok := deliveryErr == nil
			chs[i].LastDeliveryAt, chs[i].LastDeliveryOK = &at, &ok
			chs[i].LastError = ""
			if deliveryErr != nil {
				chs[i].LastError = deliveryErr.Error()
			}
			d.channels[orgID] = chs
			return
		}
	}
}

// --- uptime checks (write-through after every store write)

func (d *Directory) OrgChecks(orgID int64) []store.Check {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return slices.Clone(d.checks[orgID])
}

// OrgCheck returns a check only if it belongs to orgID: every tenant-scoped
// check lookup goes through here.
func (d *Directory) OrgCheck(orgID, id int64) (store.Check, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, c := range d.checks[orgID] {
		if c.ID == id {
			return c, true
		}
	}
	return store.Check{}, false
}

func (d *Directory) AllChecks() []store.Check {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var out []store.Check
	for _, cs := range d.checks {
		out = append(out, cs...)
	}
	return out
}

func (d *Directory) CheckCount(orgID int64) int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return len(d.checks[orgID])
}

func (d *Directory) SetOrgChecks(orgID int64, cs []store.Check) {
	d.mu.Lock()
	d.checks[orgID] = slices.Clone(cs)
	d.mu.Unlock()
}

// PutCheck inserts or replaces one check, keeping the org's list ordered by
// name like ListOrgChecks.
func (d *Directory) PutCheck(c store.Check) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cs := slices.DeleteFunc(slices.Clone(d.checks[c.OrgID]), func(x store.Check) bool { return x.ID == c.ID })
	cs = append(cs, c)
	slices.SortFunc(cs, func(a, b store.Check) int {
		if a.Name != b.Name {
			if a.Name < b.Name {
				return -1
			}
			return 1
		}
		return int(a.ID - b.ID)
	})
	d.checks[c.OrgID] = cs
}

func (d *Directory) RemoveCheck(orgID, id int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.checks[orgID] = slices.DeleteFunc(slices.Clone(d.checks[orgID]), func(x store.Check) bool { return x.ID == id })
}

// --- pins (per user, loaded on first use)

func (d *Directory) Pins(ctx context.Context, userID int64) (map[int64]bool, error) {
	d.mu.RLock()
	set, ok := d.pins[userID]
	d.mu.RUnlock()
	if ok {
		return set, nil
	}
	ids, err := d.loader.ListPins(ctx, userID)
	if err != nil {
		return nil, err
	}
	set = make(map[int64]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	d.mu.Lock()
	d.pins[userID] = set
	d.mu.Unlock()
	return set, nil
}

func (d *Directory) SetPin(userID, serverID int64, pinned bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	set, ok := d.pins[userID]
	if !ok {
		return // not loaded yet; the next read loads from the DB
	}
	next := make(map[int64]bool, len(set)+1)
	for k, v := range set {
		next[k] = v
	}
	if pinned {
		next[serverID] = true
	} else {
		delete(next, serverID)
	}
	d.pins[userID] = next
}

func (d *Directory) ForgetUser(userID int64) {
	d.mu.Lock()
	delete(d.pins, userID)
	d.mu.Unlock()
}

// --- maintenance windows

// OrgMaintenance returns the org's windows, ended ones included. The slice is
// shared with the directory and must not be modified: it is scanned on every
// alert event and every live server snapshot, so it is not copied.
func (d *Directory) OrgMaintenance(orgID int64) []store.MaintenanceWindow {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.maintenance[orgID]
}

// OrgMaintenanceWindow returns a window only if it belongs to orgID.
func (d *Directory) OrgMaintenanceWindow(orgID, id int64) (store.MaintenanceWindow, bool) {
	for _, w := range d.OrgMaintenance(orgID) {
		if w.ID == id {
			return w, true
		}
	}
	return store.MaintenanceWindow{}, false
}

// PutMaintenance adds or replaces a window after a store write.
func (d *Directory) PutMaintenance(w store.MaintenanceWindow) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cur := d.maintenance[w.OrgID]
	next := make([]store.MaintenanceWindow, 0, len(cur)+1)
	for _, c := range cur {
		if c.ID != w.ID {
			next = append(next, c)
		}
	}
	d.maintenance[w.OrgID] = append(next, w)
}

// RemoveMaintenance drops a window after a store delete.
func (d *Directory) RemoveMaintenance(orgID, id int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cur := d.maintenance[orgID]
	next := make([]store.MaintenanceWindow, 0, len(cur))
	for _, c := range cur {
		if c.ID != id {
			next = append(next, c)
		}
	}
	if len(next) == 0 {
		delete(d.maintenance, orgID)
		return
	}
	d.maintenance[orgID] = next
}
