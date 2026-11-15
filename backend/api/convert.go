package api

import (
	"encoding/json"
	"fmt"
	"time"

	"backend/alerting"
	"backend/notify"
	"backend/store"
)

const (
	unitPercent = "%"
	unitRate    = "B/s"
)

// RuleToAlerting converts a stored rule for the engine.
func RuleToAlerting(r store.Rule) alerting.Rule {
	return alerting.Rule{
		ID: r.ID, OrgID: r.OrgID, Name: r.Name, Enabled: r.Enabled,
		Scope:       alerting.Scope{All: r.ScopeAll, ServerIDs: r.ScopeServerIDs, Tags: r.ScopeTags},
		Metric:      alerting.Metric(r.Metric),
		Comparison:  alerting.Comparison(r.Comparison),
		Threshold:   r.Threshold,
		For:         time.Duration(r.ForSeconds) * time.Second,
		Severity:    alerting.Severity(r.Severity),
		ChannelIDs:  r.ChannelIDs,
		Cooldown:    time.Duration(r.CooldownSeconds) * time.Second,
		AutoResolve: time.Duration(r.AutoResolveSeconds) * time.Second,
	}
}

func ruleToAlerting(r store.Rule) alerting.Rule { return RuleToAlerting(r) }

// RuleFromAlerting converts an engine rule (e.g. DefaultRules) for storage.
func RuleFromAlerting(r alerting.Rule) store.Rule {
	return store.Rule{
		ID: r.ID, OrgID: r.OrgID, Name: r.Name, Enabled: r.Enabled,
		ScopeAll: r.Scope.All, ScopeServerIDs: r.Scope.ServerIDs, ScopeTags: r.Scope.Tags,
		Metric: string(r.Metric), Comparison: string(r.Comparison), Threshold: r.Threshold,
		ForSeconds: int(r.For / time.Second), Severity: string(r.Severity), ChannelIDs: r.ChannelIDs,
		CooldownSeconds: int(r.Cooldown / time.Second), AutoResolveSeconds: int(r.AutoResolve / time.Second),
	}
}

func RulesToAlerting(rs []store.Rule) []alerting.Rule {
	out := make([]alerting.Rule, 0, len(rs))
	for _, r := range rs {
		out = append(out, RuleToAlerting(r))
	}
	return out
}

func IncidentToAlerting(i store.Incident) alerting.Incident {
	out := alerting.Incident{
		ID: i.ID, OrgID: i.OrgID, RuleName: i.RuleName,
		Metric: alerting.Metric(i.Metric), Severity: alerting.Severity(i.Severity),
		Threshold: i.Threshold, Peak: i.Peak, LastValue: i.LastValue, SamplesOver: i.SamplesOver,
		StartedAt: i.StartedAt, LastNotifiedAt: i.LastNotifiedAt, AckedAt: i.AckedAt,
	}
	if i.RuleID != nil {
		out.RuleID = *i.RuleID
	}
	if i.ServerID != nil {
		out.ServerID = *i.ServerID
	}
	return out
}

func ChannelToNotify(c store.Channel) (notify.Channel, error) {
	var cfg notify.ChannelConfig
	if err := json.Unmarshal(c.Config, &cfg); err != nil {
		return notify.Channel{}, fmt.Errorf("decode channel %d config: %w", c.ID, err)
	}
	return notify.Channel{ID: c.ID, OrgID: c.OrgID, Type: notify.ChannelType(c.Type), Name: c.Name, Enabled: c.Enabled, Config: cfg}, nil
}

// UnitFor is how a metric's values are displayed.
func UnitFor(metric string) string {
	switch alerting.Metric(metric) {
	case alerting.MetricCPU, alerting.MetricMemory, alerting.MetricDisk:
		return unitPercent
	case alerting.MetricNetIn, alerting.MetricNetOut:
		return unitRate
	default:
		return ""
	}
}
