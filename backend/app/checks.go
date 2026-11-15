package app

import (
	"context"
	"fmt"
	"time"

	"backend/api"
	"backend/checks"
	"backend/notify"
	"backend/store"
)

const checkWorkers = 8

// checksHousekeeping is the uptime checks' flush-window hook: rollups,
// incident progress and (every retentionEvery) retention of check results.
func (a *App) checksHousekeeping(ctx context.Context) {
	a.checks.Flush(ctx)
	if time.Since(a.lastCheckRetention) < retentionEvery {
		return
	}
	if n, err := a.store.ApplyCheckRetention(ctx); err != nil {
		a.log.Warn("check retention", "err", err)
	} else {
		a.lastCheckRetention = time.Now()
		a.log.Info("check retention applied", "rows_deleted", n)
	}
}

// checkStore adapts store.Store to checks.Store.
type checkStore struct{ st *store.Store }

func (s checkStore) OpenIncident(ctx context.Context, inc checks.Incident) (int64, error) {
	return s.st.OpenCheckIncident(ctx, store.NewCheckIncident{
		OrgID: inc.OrgID, CheckID: inc.CheckID, RuleName: inc.RuleName, Metric: inc.Metric, Severity: inc.Severity,
		Threshold: inc.Threshold, Peak: inc.Peak, LastValue: inc.LastValue, SamplesOver: inc.SamplesOver, StartedAt: inc.StartedAt,
	})
}

func (s checkStore) ResolveIncident(ctx context.Context, id int64, at time.Time, how checks.ResolveHow, peak float64, samplesOver int) error {
	return s.st.ResolveIncident(ctx, id, at, string(how), peak, samplesOver, nil)
}

func (s checkStore) SaveProgress(ctx context.Context, id int64, peak, lastValue float64, samplesOver int) error {
	return s.st.SaveIncidentProgress(ctx, id, peak, lastValue, samplesOver, nil)
}

func (s checkStore) LoadOpenIncidents(ctx context.Context) ([]checks.Incident, error) {
	rows, err := s.st.LoadOpenCheckIncidents(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]checks.Incident, 0, len(rows))
	for _, r := range rows {
		if r.CheckID == nil {
			continue
		}
		out = append(out, checks.Incident{
			ID: r.ID, OrgID: r.OrgID, CheckID: *r.CheckID, RuleName: r.RuleName, Metric: r.Metric, Severity: r.Severity,
			Threshold: r.Threshold, Peak: r.Peak, LastValue: r.LastValue, SamplesOver: r.SamplesOver, StartedAt: r.StartedAt,
		})
	}
	return out, nil
}

func (s checkStore) WriteRollups(ctx context.Context, hours []checks.HourRollup, days []checks.DayRollup) error {
	return s.st.WriteCheckRollups(ctx, hours, days)
}

func (s checkStore) ReadHours(ctx context.Context, checkID int64, from, to time.Time) ([]checks.HourRollup, error) {
	return s.st.ReadCheckHours(ctx, checkID, from, to)
}

func (s checkStore) RecentHours(ctx context.Context, since time.Time) ([]checks.HourRollup, error) {
	return s.st.RecentCheckHours(ctx, since)
}

// checkNotifier turns check transitions into channel messages and live
// incident events. Incidents are always recorded; a maintenance window only
// mutes the channels.
type checkNotifier struct{ a *App }

func (n checkNotifier) Notify(_ context.Context, ev checks.Event) {
	a := n.a
	orgID := ev.Check.OrgID
	kind := notify.KindFired
	if ev.Kind == checks.EventResolved {
		kind = notify.KindResolved
	}

	var targets []notify.Channel
	var names []string
	silenced := a.silenced(orgID, 0, ev.Check.ID, ev.At)
	if !silenced {
		for _, c := range a.dir.OrgChannels(orgID) {
			if !c.Enabled || !containsID(ev.Check.ChannelIDs, c.ID) {
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
	}

	ruleName := ev.Incident.RuleName
	if ev.Kind == checks.EventFired && ev.Result.Error != "" {
		ruleName += ": " + ev.Result.Error
	}
	msg := notify.Message{
		Kind: kind, OrgID: orgID, IncidentID: ev.Incident.ID, Source: notify.SourceCheck, ServerName: ev.Check.Name, RuleName: ruleName,
		Metric: ev.Incident.Metric, Severity: ev.Incident.Severity, Value: ev.Incident.LastValue,
		Threshold: ev.Incident.Threshold, StartedAt: ev.Incident.StartedAt,
		DashboardURL: fmt.Sprintf("%s/checks/%d", trimSlash(a.cfg.Public.AppURL), ev.Check.ID),
	}
	var resolvedAt *time.Time
	if ev.Kind == checks.EventResolved {
		at := ev.At
		resolvedAt, msg.ResolvedAt = &at, &at
		if ev.Incident.Metric != checks.MetricTLSExpiry {
			msg.Value = ev.Incident.Peak // most consecutive failures during the outage
		}
	}
	// Same maintenance bookkeeping as server incidents (App.announceAfterMaintenance).
	a.announceMu.Lock()
	switch ev.Kind {
	case checks.EventFired:
		if silenced {
			a.unannouncedChecks[ev.Incident.ID] = ev
		} else if len(targets) > 0 {
			a.announced[ev.Incident.ID] = true
			delete(a.unannouncedChecks, ev.Incident.ID)
		}
	case checks.EventResolved:
		if !a.announced[ev.Incident.ID] {
			targets, names = nil, nil // nobody was told it fired
		}
		delete(a.announced, ev.Incident.ID)
		delete(a.unannouncedChecks, ev.Incident.ID)
	}
	a.announceMu.Unlock()
	if ev.Kind == checks.EventFired && silenced {
		a.markSilenced(ev.Incident.ID)
	}
	if len(targets) > 0 {
		a.dispatcher.Dispatch(targets, msg)
	}
	if ev.Kind == checks.EventFired && len(names) > 0 {
		go func(id int64, at time.Time) {
			ctx, cancel := context.WithTimeout(a.ctx, notifyWriteTimeout)
			defer cancel()
			if err := a.store.AppendNotified(ctx, id, names, at); err != nil {
				a.log.Warn("record notified channels", "incident_id", id, "err", err)
			}
		}(ev.Incident.ID, ev.At)
	}

	action := "opened"
	if ev.Kind == checks.EventResolved {
		action = "resolved"
	}
	a.broker.Publish(orgID, "incident", map[string]any{
		"action":   action,
		"incident": liveCheckIncident(ev, names, resolvedAt),
	})
}

// liveCheckIncident has the API Incident shape for SSE.
func liveCheckIncident(ev checks.Event, channels []string, resolvedAt *time.Time) map[string]any {
	state, how := "open", any(nil)
	if resolvedAt != nil {
		state, how = "resolved", string(ev.How)
	}
	if channels == nil {
		channels = []string{}
	}
	comparison := "above"
	if ev.Incident.Metric == checks.MetricTLSExpiry {
		comparison = "below" // days left fell below tls_warn_days
	}
	return map[string]any{
		"id": ev.Incident.ID, "server_id": nil, "server_name": ev.Check.Name, "rule_id": nil,
		"rule_name": ev.Incident.RuleName, "metric": ev.Incident.Metric, "severity": ev.Incident.Severity,
		"state": state, "comparison": comparison, "threshold": ev.Incident.Threshold, "peak": ev.Incident.Peak,
		"last_value": ev.Incident.LastValue, "unit": "", "samples_over": ev.Incident.SamplesOver,
		"started_at": ev.Incident.StartedAt, "resolved_at": resolvedAt, "resolved_how": how,
		"acked_at": nil, "acked_by": nil, "last_notified_at": nil, "notified_channels": channels,
		"next_notify_at": nil, "check_id": ev.Check.ID, "check_name": ev.Check.Name,
	}
}
