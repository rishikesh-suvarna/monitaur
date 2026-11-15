// Package app wires the backend together: stores, caches, metrics, alerting,
// notifications, ingest and the HTTP API, plus the background loops.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"backend/alerting"
	"backend/api"
	"backend/auth"
	"backend/checks"
	"backend/config"
	"backend/directory"
	"backend/ingest"
	"backend/limits"
	"backend/metrics"
	"backend/notify"
	"backend/processes"
	"backend/secrets"
	"backend/store"
)

const (
	engineTickEvery    = 5 * time.Second
	sweepEvery         = time.Minute
	limiterSweepEvery  = 5 * time.Minute
	retentionEvery     = 6 * time.Hour
	backgroundTimeout  = 30 * time.Second
	backfillPause      = 200 * time.Millisecond
	webhookTimeout     = 10 * time.Second
	dispatchWorkers    = 4
	dispatchQueue      = 256
	dispatchTimeout    = 15 * time.Second
	telegramAPIBase    = "https://api.telegram.org"
	defaultEmailName   = "Email (owner)"
	notifyWriteTimeout = 10 * time.Second
)

type App struct {
	cfg        *config.Config
	log        *slog.Logger
	store      *store.Store
	dir        *directory.Directory
	auth       *auth.Service
	metrics    *metrics.Store
	processes  *processes.Store
	engine     *alerting.Engine
	checks     *checks.Scheduler
	dispatcher *notify.Dispatcher
	hub        *ingest.Hub
	broker     *api.Broker
	limiter    *limits.RateLimiter
	budget     *limits.EmailBudget
	api        *api.API

	ctx           context.Context // app lifetime, for engine work triggered by ingest
	seedMu        sync.Mutex
	lastRetention time.Time

	// Maintenance bookkeeping: which open incidents were announced to a
	// channel, and which fired inside a window and still need announcing if
	// they outlive it.
	announceMu         sync.Mutex
	announced          map[int64]bool
	unannounced        map[int64]alerting.Event
	unannouncedChecks  map[int64]checks.Event
	lastCheckRetention time.Time
}

func New(ctx context.Context, cfg *config.Config, log *slog.Logger, pool *pgxpool.Pool, verifier auth.Verifier) (*App, error) {
	key, err := cfg.Secrets.Key()
	if err != nil {
		return nil, err
	}
	box, err := secrets.NewBox(key)
	if err != nil {
		return nil, err
	}
	a := &App{cfg: cfg, log: log, ctx: ctx, announced: map[int64]bool{}, unannounced: map[int64]alerting.Event{},
		unannouncedChecks: map[int64]checks.Event{}}
	a.store = store.New(pool, box)
	a.dir = directory.New(a.store)
	if err := a.dir.Load(ctx); err != nil {
		return nil, fmt.Errorf("load directory: %w", err)
	}
	a.limiter = limits.NewRateLimiter(nil)
	a.budget = limits.NewEmailBudget(func(orgID int64) int { return a.dir.Plan(orgID).AlertEmailsPerDay })
	a.broker = api.NewBroker()

	httpClient := notify.SafeHTTPClient(webhookTimeout, cfg.Notify.AllowPrivateWebhooks)
	senders := map[notify.ChannelType]notify.Sender{
		notify.Slack:    notify.NewSlackSender(httpClient),
		notify.Discord:  notify.NewDiscordSender(httpClient),
		notify.Telegram: notify.NewTelegramSender(httpClient, telegramAPIBase),
		notify.Webhook:  notify.NewWebhookSender(httpClient),
	}
	if cfg.SMTP.Enabled() {
		senders[notify.Email] = notify.NewSMTPSender(notify.SMTPConfig{
			Host: cfg.SMTP.Host, Port: cfg.SMTP.Port, Username: cfg.SMTP.Username, Password: cfg.SMTP.Password,
			From: cfg.SMTP.From, RequireTLS: cfg.SMTP.RequireTLS,
		})
	} else {
		log.Warn("smtp not configured: email channels will fail until smtp.host and smtp.from are set")
	}
	a.dispatcher = notify.NewDispatcher(notify.DispatcherConfig{Workers: dispatchWorkers, QueueSize: dispatchQueue, SendTimeout: dispatchTimeout},
		senders, deliveryRecorder{a}, a.budget, log)

	a.engine = alerting.NewEngine(incidentStore{a.store}, &notifier{app: a}, time.Now, log)
	servers := a.dir.AllServers()
	infos := make([]alerting.ServerInfo, 0, len(servers))
	for _, s := range servers {
		infos = append(infos, alerting.ServerInfo{ID: s.ID, OrgID: s.OrgID, Name: s.Name, Tags: s.Tags})
	}
	if err := a.engine.Load(ctx, api.RulesToAlerting(a.dir.AllRules()), infos); err != nil {
		return nil, fmt.Errorf("load alerting engine: %w", err)
	}
	// Incidents announced before a restart keep getting their "resolved".
	for _, load := range []func(context.Context) ([]store.Incident, error){a.store.LoadOpenIncidents, a.store.LoadOpenCheckIncidents} {
		open, err := load(ctx)
		if err != nil {
			continue
		}
		for _, inc := range open {
			if len(inc.NotifiedChannels) > 0 {
				a.announced[inc.ID] = true
			}
		}
	}
	a.checks = checks.NewScheduler(checks.Config{Workers: checkWorkers, AllowPrivate: cfg.Checks.AllowPrivateTargets},
		checkStore{a.store}, checkNotifier{a}, log)
	if err := a.checks.Load(ctx, api.ChecksToScheduler(a.dir.AllChecks())); err != nil {
		return nil, fmt.Errorf("load uptime checks: %w", err)
	}

	mcfg := metrics.DefaultConfig()
	mcfg.FlushInterval, mcfg.RawWindow, mcfg.RecentWindow, mcfg.JournalDir =
		cfg.Metrics.FlushInterval, cfg.Metrics.RawWindow, cfg.Metrics.RecentWindow, cfg.Metrics.JournalDir
	if a.metrics, err = metrics.New(mcfg, a.store, a.store, log); err != nil {
		return nil, fmt.Errorf("init metrics store: %w", err)
	}
	a.metrics.OnFlush(a.housekeeping)
	a.metrics.OnFlush(a.checksHousekeeping)

	a.processes = processes.New()
	a.hub = ingest.NewHub(a.dir, recorder{a}, a.limiter, cfg.Server.Origins(), log)
	a.auth = auth.NewService(verifier, a.store, auth.Config{
		DefaultPlan:     cfg.Limits.DefaultPlan,
		RequireAppCheck: cfg.Firebase.RequireAppCheck,
		OnPersonalOrg: func(ctx context.Context, org store.Org, owner store.User) {
			a.seedDefaults(ctx, org, owner.Email)
		},
	}, log)

	a.api = api.New(api.Deps{
		Config: cfg, Store: a.store, Auth: a.auth, Dir: a.dir, Metrics: a.metrics, Processes: a.processes, Engine: a.engine,
		Dispatcher: a.dispatcher, Hub: a.hub, Broker: a.broker, Limiter: a.limiter, Budget: a.budget, Log: log,
		Checks: a.checks, Silenced: a.silenced,
	})
	return a, nil
}

func (a *App) Handler() http.Handler { return a.api.Router() }

// Run starts the background loops and blocks until ctx is cancelled and the
// metrics store has made its final flush.
func (a *App) Run(ctx context.Context) {
	var wg sync.WaitGroup
	start := func(fn func()) {
		wg.Add(1)
		go func() { defer wg.Done(); fn() }()
	}
	start(func() {
		if err := a.metrics.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			a.log.Error("metrics store stopped", "err", err)
		}
	})
	start(func() { a.dispatcher.Run(ctx) })
	start(func() { a.checks.Run(ctx) })
	start(func() {
		a.every(ctx, engineTickEvery, func() {
			a.engine.Tick(ctx)
			a.announceAfterMaintenance()
		})
	})
	start(func() { a.every(ctx, sweepEvery, a.hub.SweepTokens) })
	start(func() { a.every(ctx, limiterSweepEvery, a.limiter.Sweep) })
	start(func() { a.seedUnseededOrgs(ctx) })
	start(func() { a.backfillLegacy(ctx) })
	wg.Wait()
}

// Shutdown closes agent connections so they reconnect to the next process.
func (a *App) Shutdown() { a.hub.CloseAll() }

func (a *App) every(ctx context.Context, d time.Duration, fn func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}

// housekeeping runs right after each metrics flush, while the database is
// already awake, so periodic writes never cause extra wake-ups (PLAN.md 2.3.2).
func (a *App) housekeeping(ctx context.Context) {
	touches := a.dir.DrainTouches(a.metrics.LastSeen())
	if err := a.store.TouchServers(ctx, touches); err != nil {
		a.log.Warn("persist server activity", "err", err)
		a.dir.RequeueTouches(touches)
	}
	a.engine.SaveProgress(ctx)
	if time.Since(a.lastRetention) >= retentionEvery {
		if n, err := a.store.ApplyRetention(ctx); err != nil {
			a.log.Warn("retention", "err", err)
		} else {
			a.lastRetention = time.Now()
			a.log.Info("retention applied", "rows_deleted", n)
		}
	}
}

// seedDefaults gives a new org an owner email channel and the default rules
// (F1 server-down alerts included). Runs once per org.
func (a *App) seedDefaults(ctx context.Context, org store.Org, ownerEmail string) {
	a.seedMu.Lock()
	defer a.seedMu.Unlock()
	current, ok := a.dir.Org(org.ID)
	if ok && current.DefaultsSeeded {
		return
	}
	if !ok {
		// A brand-new org must be resolvable even if seeding fails below.
		a.dir.PutOrg(org)
	}
	var channelIDs []int64
	if a.cfg.SMTP.Enabled() && ownerEmail != "" {
		cfg := fmt.Appendf(nil, `{"email_to":[%q]}`, ownerEmail)
		ch, err := a.store.CreateChannel(ctx, org.ID, string(notify.Email), defaultEmailName, true, cfg, 0)
		if err != nil {
			a.log.Error("seed email channel", "org_id", org.ID, "err", err)
			return
		}
		channelIDs = append(channelIDs, ch.ID)
	}
	defaults := alerting.DefaultRules(org.ID, channelIDs)
	rules := make([]store.Rule, 0, len(defaults))
	for _, r := range defaults {
		rules = append(rules, api.RuleFromAlerting(r))
	}
	if _, err := a.store.CreateRules(ctx, org.ID, rules, 0); err != nil {
		a.log.Error("seed rules", "org_id", org.ID, "err", err)
		return
	}
	if err := a.store.MarkDefaultsSeeded(ctx, org.ID); err != nil {
		a.log.Error("mark seeded", "org_id", org.ID, "err", err)
	}
	org.DefaultsSeeded = true
	a.dir.PutOrg(org)
	if chs, err := a.store.ListOrgChannels(ctx, org.ID); err == nil {
		a.dir.SetOrgChannels(org.ID, chs)
	}
	if rs, err := a.store.ListOrgRules(ctx, org.ID); err == nil {
		a.dir.SetOrgRules(org.ID, rs)
		a.engine.SetOrgRules(org.ID, api.RulesToAlerting(rs))
	}
	a.log.Info("seeded default rules", "org_id", org.ID, "channels", len(channelIDs))
}

// seedUnseededOrgs covers orgs created by the v2 migration (existing users).
func (a *App) seedUnseededOrgs(ctx context.Context) {
	orgs, err := a.store.ListAllOrgs(ctx)
	if err != nil {
		a.log.Warn("list orgs for seeding", "err", err)
		return
	}
	for _, o := range orgs {
		if o.DefaultsSeeded {
			continue
		}
		email, err := a.store.OwnerEmail(ctx, o.ID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			a.log.Warn("owner email", "org_id", o.ID, "err", err)
			continue
		}
		a.seedDefaults(ctx, o, email)
	}
}

// backfillLegacy rolls the last 7 days of v1 raw metrics into rollups once,
// one server-day at a time, outside startup so deploy health checks pass.
func (a *App) backfillLegacy(ctx context.Context) {
	pending, err := a.store.LegacyBackfillPending(ctx)
	if err != nil || !pending {
		if err != nil {
			a.log.Warn("check legacy backfill", "err", err)
		}
		return
	}
	targets, err := a.store.LegacyBackfillTargets(ctx)
	if err != nil {
		a.log.Warn("legacy backfill targets", "err", err)
		return
	}
	for i, t := range targets {
		if ctx.Err() != nil {
			return
		}
		if err := a.store.BackfillLegacyDay(ctx, t); err != nil {
			a.log.Warn("legacy backfill day", "server_id", t.ServerID, "day", t.Day, "err", err)
			return // retried on next start
		}
		a.log.Info("legacy backfill progress", "done", i+1, "total", len(targets))
		time.Sleep(backfillPause)
	}
	if err := a.store.MarkJobDone(ctx, store.LegacyBackfillJob()); err != nil {
		a.log.Warn("mark legacy backfill done", "err", err)
	}
}

// --- adapters

// recorder feeds agent data to metrics and alerting (ingest.Recorder).
type recorder struct{ a *App }

func (r recorder) Sample(serverID int64, s metrics.Sample, minInterval time.Duration) error {
	p, err := r.a.metrics.Ingest(serverID, s, minInterval)
	if err != nil {
		return err
	}
	r.a.engine.Heartbeat(serverID, s.Time)
	r.a.engine.Observe(r.a.ctx, serverID, p)
	return nil
}

// Processes keeps the agent's latest top-processes list in memory only. It
// is not a heartbeat: liveness comes from samples and the socket.
func (r recorder) Processes(serverID int64, snap processes.Snapshot) {
	r.a.processes.Put(serverID, snap)
}

func (r recorder) Connected(serverID int64, version string, at time.Time) {
	r.a.dir.RecordConnect(serverID, version, at)
	r.a.engine.Heartbeat(serverID, at)
}

func (r recorder) Disconnected(int64, time.Time) {
	// Nothing to do: the heartbeat rule raises "unreachable" after its For.
}

// incidentStore adapts store.Store to alerting.IncidentStore.
type incidentStore struct{ st *store.Store }

func (s incidentStore) OpenIncident(ctx context.Context, inc alerting.Incident) (int64, error) {
	return s.st.OpenIncident(ctx, store.NewIncident{
		OrgID: inc.OrgID, ServerID: inc.ServerID, RuleID: inc.RuleID, RuleName: inc.RuleName,
		Metric: string(inc.Metric), Severity: string(inc.Severity), Threshold: inc.Threshold,
		Peak: inc.Peak, LastValue: inc.LastValue, SamplesOver: inc.SamplesOver, StartedAt: inc.StartedAt,
	})
}

func (s incidentStore) ResolveIncident(ctx context.Context, id int64, at time.Time, how alerting.ResolveHow, peak float64, samplesOver int) error {
	return s.st.ResolveIncident(ctx, id, at, string(how), peak, samplesOver, nil)
}

func (s incidentStore) SaveProgress(ctx context.Context, id int64, peak, lastValue float64, samplesOver int, lastNotifiedAt *time.Time) error {
	return s.st.SaveIncidentProgress(ctx, id, peak, lastValue, samplesOver, lastNotifiedAt)
}

func (s incidentStore) LoadOpenIncidents(ctx context.Context) ([]alerting.Incident, error) {
	rows, err := s.st.LoadOpenIncidents(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]alerting.Incident, 0, len(rows))
	for _, r := range rows {
		out = append(out, api.IncidentToAlerting(r))
	}
	return out, nil
}

// deliveryRecorder keeps the DB and the directory's copy in step.
type deliveryRecorder struct{ a *App }

func (d deliveryRecorder) RecordDelivery(ctx context.Context, channelID int64, at time.Time, err error) {
	d.a.store.RecordDelivery(ctx, channelID, at, err)
	d.a.dir.UpdateChannelDelivery(channelID, at, err)
}

// notifier turns engine events into channel messages and live updates.
type notifier struct{ app *App }

func (n *notifier) Notify(_ context.Context, ev alerting.Event) {
	a := n.app
	kind := map[alerting.EventKind]notify.MessageKind{
		alerting.EventFired: notify.KindFired, alerting.EventRenotify: notify.KindRenotify, alerting.EventResolved: notify.KindResolved,
	}[ev.Kind]

	// A maintenance window silences fired, renotify and resolved alike; the
	// incident is still recorded and live clients still get the event.
	silenced := a.silenced(ev.Server.OrgID, ev.Server.ID, 0, ev.At)
	var channels []store.Channel
	if !silenced {
		channels = a.dir.OrgChannels(ev.Server.OrgID)
	}
	var targets []notify.Channel
	var names []string
	for _, c := range channels {
		if !c.Enabled || !containsID(ev.Rule.ChannelIDs, c.ID) {
			continue
		}
		nc, err := api.ChannelToNotify(c)
		if err != nil {
			a.log.Error("decode channel", "channel_id", c.ID, "err", err)
			continue
		}
		targets = append(targets, nc)
		names = append(names, c.Name)
	}

	msg := notify.Message{
		Kind: kind, OrgID: ev.Server.OrgID, IncidentID: ev.Incident.ID, Source: notify.SourceServer, ServerName: ev.Server.Name,
		RuleName: ev.Rule.Name, Metric: string(ev.Rule.Metric), Severity: string(ev.Rule.Severity),
		Value: ev.Incident.LastValue, Threshold: ev.Rule.Threshold, Unit: api.UnitFor(string(ev.Rule.Metric)),
		StartedAt:    ev.Incident.StartedAt,
		DashboardURL: fmt.Sprintf("%s/servers/%d", trimSlash(a.cfg.Public.AppURL), ev.Server.ID),
	}
	if ev.Kind == alerting.EventResolved {
		at := ev.At
		msg.ResolvedAt, msg.Value = &at, ev.Incident.Peak
	}
	a.announceMu.Lock()
	switch ev.Kind {
	case alerting.EventFired, alerting.EventRenotify:
		if silenced && ev.Kind == alerting.EventFired {
			a.unannounced[ev.Incident.ID] = ev // announce if it outlives the window
		} else if len(targets) > 0 {
			a.announced[ev.Incident.ID] = true
			delete(a.unannounced, ev.Incident.ID)
		}
	case alerting.EventResolved:
		// Nobody was told it fired (silenced, or no channels), so a
		// "resolved" message would be the first anyone hears of it.
		if !a.announced[ev.Incident.ID] {
			targets, names = nil, nil
		}
		delete(a.announced, ev.Incident.ID)
		delete(a.unannounced, ev.Incident.ID)
	}
	a.announceMu.Unlock()
	if len(targets) > 0 {
		a.dispatcher.Dispatch(targets, msg)
	}
	if ev.Kind == alerting.EventFired && len(names) > 0 {
		go func(id int64, at time.Time) {
			ctx, cancel := context.WithTimeout(a.ctx, notifyWriteTimeout)
			defer cancel()
			if err := a.store.AppendNotified(ctx, id, names, at); err != nil {
				a.log.Warn("record notified channels", "incident_id", id, "err", err)
			}
		}(ev.Incident.ID, ev.At)
	}
	if ev.Kind == alerting.EventFired && silenced {
		a.markSilenced(ev.Incident.ID)
	}

	action := map[alerting.EventKind]string{alerting.EventFired: "opened", alerting.EventRenotify: "updated", alerting.EventResolved: "resolved"}[ev.Kind]
	live := liveIncident(ev, names)
	// Mirrors incidents.silenced, which is set when the incident opens.
	live["silenced"] = a.silenced(ev.Server.OrgID, ev.Server.ID, 0, ev.Incident.StartedAt)
	a.broker.Publish(ev.Server.OrgID, "incident", map[string]any{
		"action":   action,
		"incident": live,
	})
}

func liveIncident(ev alerting.Event, channels []string) map[string]any {
	state := "open"
	if ev.Incident.AckedAt != nil {
		state = "acked"
	}
	var resolvedAt *time.Time
	if ev.Kind == alerting.EventResolved {
		state = "resolved"
		at := ev.At
		resolvedAt = &at
	}
	if channels == nil {
		channels = []string{}
	}
	return map[string]any{
		"id": ev.Incident.ID, "server_id": ev.Server.ID, "server_name": ev.Server.Name, "rule_id": ev.Rule.ID,
		"rule_name": ev.Rule.Name, "metric": ev.Rule.Metric, "severity": ev.Rule.Severity, "state": state,
		"comparison": comparisonOf(ev.Rule),
		"threshold":  ev.Rule.Threshold, "peak": ev.Incident.Peak, "last_value": ev.Incident.LastValue,
		"unit": api.UnitFor(string(ev.Rule.Metric)), "samples_over": ev.Incident.SamplesOver,
		"started_at": ev.Incident.StartedAt, "resolved_at": resolvedAt, "acked_at": ev.Incident.AckedAt,
		"notified_channels": channels, "check_id": nil, "check_name": nil,
	}
}

func containsID(ids []int64, id int64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func comparisonOf(r alerting.Rule) alerting.Comparison {
	if r.Comparison == "" {
		return alerting.Above
	}
	return r.Comparison
}

// announceAfterMaintenance sends the "fired" notification for incidents that
// opened inside a maintenance window and are still open after it ended, so a
// problem that outlives planned work is not silently dropped. Runs on the
// engine tick; memory only.
func (a *App) announceAfterMaintenance() {
	now := time.Now()
	a.announceMu.Lock()
	var due []alerting.Event
	for id, ev := range a.unannounced {
		if !a.silenced(ev.Server.OrgID, ev.Server.ID, 0, now) {
			due = append(due, ev)
			delete(a.unannounced, id)
		}
	}
	// Pending check incidents are still open: a resolve removes them.
	var dueChecks []checks.Event
	for id, ev := range a.unannouncedChecks {
		if !a.silenced(ev.Check.OrgID, 0, ev.Check.ID, now) {
			dueChecks = append(dueChecks, ev)
			delete(a.unannouncedChecks, id)
		}
	}
	a.announceMu.Unlock()

	for _, ev := range dueChecks {
		ev.At = now
		checkNotifier{a}.Notify(a.ctx, ev)
	}

	for _, ev := range due {
		open := false
		for _, inc := range a.engine.Open(ev.Server.OrgID) {
			if inc.ID == ev.Incident.ID {
				ev.Incident, open = inc, true
				break
			}
		}
		if !open {
			continue // resolved meanwhile
		}
		ev.At = now
		(&notifier{app: a}).Notify(a.ctx, ev)
	}
}
