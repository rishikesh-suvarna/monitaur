package api

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend/alerting"
	"backend/auth"
	"backend/metrics"
	"backend/store"
)

const (
	previewWindow     = 7 * 24 * time.Hour
	previewMaxServers = 10
)

type ruleScopeJSON struct {
	All       bool     `json:"all"`
	ServerIDs []int64  `json:"server_ids"`
	Tags      []string `json:"tags"`
}

type ruleJSON struct {
	store.Rule
	Scope ruleScopeJSON `json:"scope"`
}

func toRuleJSON(r store.Rule) ruleJSON {
	return ruleJSON{Rule: r, Scope: ruleScopeJSON{All: r.ScopeAll, ServerIDs: nonNil(r.ScopeServerIDs), Tags: nonNil(r.ScopeTags)}}
}

// ruleInput is the create/patch body; pointers distinguish "absent" in PATCH.
type ruleInput struct {
	Name               *string        `json:"name"`
	Enabled            *bool          `json:"enabled"`
	Scope              *ruleScopeJSON `json:"scope"`
	Metric             *string        `json:"metric"`
	Comparison         *string        `json:"comparison"`
	Threshold          *float64       `json:"threshold"`
	ForSeconds         *int           `json:"for_seconds"`
	Severity           *string        `json:"severity"`
	ChannelIDs         []int64        `json:"channel_ids"`
	CooldownSeconds    *int           `json:"cooldown_seconds"`
	AutoResolveSeconds *int           `json:"auto_resolve_seconds"`
}

func (in ruleInput) apply(r store.Rule) store.Rule {
	if in.Name != nil {
		r.Name = strings.TrimSpace(*in.Name)
	}
	if in.Enabled != nil {
		r.Enabled = *in.Enabled
	}
	if in.Scope != nil {
		r.ScopeAll, r.ScopeServerIDs = in.Scope.All, in.Scope.ServerIDs
		r.ScopeTags = make([]string, 0, len(in.Scope.Tags))
		for _, t := range in.Scope.Tags {
			r.ScopeTags = append(r.ScopeTags, strings.ToLower(strings.TrimSpace(t)))
		}
		if r.ScopeAll {
			r.ScopeServerIDs, r.ScopeTags = []int64{}, []string{}
		}
	}
	if in.Metric != nil {
		r.Metric = *in.Metric
	}
	if in.Comparison != nil {
		r.Comparison = *in.Comparison
	}
	if in.Threshold != nil {
		r.Threshold = *in.Threshold
	}
	if in.ForSeconds != nil {
		r.ForSeconds = *in.ForSeconds
	}
	if in.Severity != nil {
		r.Severity = *in.Severity
	}
	if in.ChannelIDs != nil {
		r.ChannelIDs = in.ChannelIDs
	}
	if in.CooldownSeconds != nil {
		r.CooldownSeconds = *in.CooldownSeconds
	}
	if in.AutoResolveSeconds != nil {
		r.AutoResolveSeconds = *in.AutoResolveSeconds
	}
	if r.Comparison == "" {
		r.Comparison = string(alerting.Above)
	}
	return r
}

// validateRule runs the engine's checks plus tenant checks: every scoped
// server and channel must belong to the caller's org.
func (a *API) validateRule(orgID int64, r store.Rule) string {
	if !r.ScopeAll && len(r.ScopeServerIDs) == 0 && len(r.ScopeTags) == 0 {
		return "scope must be all servers, or list servers or tags"
	}
	if _, ok := normalizeTags(r.ScopeTags); !ok {
		return "scope tags must be at most 10 lowercase words (letters, numbers, - and _)"
	}
	if err := RuleToAlerting(r).Validate(); err != nil {
		return err.Error()
	}
	for _, id := range r.ScopeServerIDs {
		if _, ok := a.Dir.OrgServer(orgID, id); !ok {
			return "scope includes a server that is not in this organization"
		}
	}
	chs := a.Dir.OrgChannels(orgID)
	for _, id := range r.ChannelIDs {
		if !slices.ContainsFunc(chs, func(c store.Channel) bool { return c.ID == id }) {
			return "rule routes to a channel that is not in this organization"
		}
	}
	return ""
}

func (a *API) matchedServers(orgID int64, r store.Rule) []store.Server {
	ar := RuleToAlerting(r)
	var out []store.Server
	for _, s := range a.Dir.OrgServers(orgID) {
		if ar.Matches(serverInfo(s)) {
			out = append(out, s)
		}
	}
	return out
}

func (a *API) listRules(c *gin.Context) {
	p := auth.MustPrincipal(c)
	rules := a.Dir.OrgRules(p.OrgID)
	out := make([]ruleJSON, 0, len(rules))
	matched := map[int64]int{}
	for _, r := range rules {
		out = append(out, toRuleJSON(r))
		matched[r.ID] = len(a.matchedServers(p.OrgID, r))
	}
	c.JSON(http.StatusOK, gin.H{"rules": out, "matched": matched})
}

// reloadOrgRules refreshes the directory and engine from the database after
// any change that touches rules.
func (a *API) reloadOrgRules(ctx context.Context, orgID int64) error {
	rules, err := a.Store.ListOrgRules(ctx, orgID)
	if err != nil {
		return err
	}
	a.Dir.SetOrgRules(orgID, rules)
	a.Engine.SetOrgRules(orgID, RulesToAlerting(rules))
	return nil
}

func (a *API) createRule(c *gin.Context) {
	p := auth.MustPrincipal(c)
	var in ruleInput
	if !bind(c, &in) {
		return
	}
	r := in.apply(store.Rule{OrgID: p.OrgID, Enabled: true, ScopeAll: in.Scope == nil})
	if msg := a.validateRule(p.OrgID, r); msg != "" {
		invalid(c, msg)
		return
	}
	created, err := a.Store.CreateRules(c.Request.Context(), p.OrgID, []store.Rule{r}, a.Dir.Plan(p.OrgID).MaxRules)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	if err := a.reloadOrgRules(c.Request.Context(), p.OrgID); err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"rule": toRuleJSON(created[0])})
}

func (a *API) patchRule(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	var in ruleInput
	if !bind(c, &in) {
		return
	}
	current, err := a.Store.GetRule(c.Request.Context(), p.OrgID, id)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	next := in.apply(current)
	if msg := a.validateRule(p.OrgID, next); msg != "" {
		invalid(c, msg)
		return
	}
	updated, err := a.Store.UpdateRule(c.Request.Context(), next)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	if err := a.reloadOrgRules(c.Request.Context(), p.OrgID); err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rule": toRuleJSON(updated)})
}

func (a *API) deleteRule(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	if err := a.Store.DeleteRule(c.Request.Context(), p.OrgID, id); err != nil {
		a.handleErr(c, err)
		return
	}
	if err := a.reloadOrgRules(c.Request.Context(), p.OrgID); err != nil {
		a.handleErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

type previewIncidentJSON struct {
	ServerID int64      `json:"server_id"`
	Start    time.Time  `json:"start"`
	End      *time.Time `json:"end"`
	Peak     float64    `json:"peak"`
}

// previewRule replays the last 7 days of minute rollups through the rule.
// User-initiated and capped, so it is the one place reading a lot of rollups.
func (a *API) previewRule(c *gin.Context) {
	p := auth.MustPrincipal(c)
	var in ruleInput
	if !bind(c, &in) {
		return
	}
	r := in.apply(store.Rule{OrgID: p.OrgID, Enabled: true, ScopeAll: in.Scope == nil})
	if r.Name == "" {
		r.Name = "preview"
	}
	if msg := a.validateRule(p.OrgID, r); msg != "" {
		invalid(c, msg)
		return
	}
	matched := a.matchedServers(p.OrgID, r)
	now := a.Now()
	ar := RuleToAlerting(r)
	incidents := []previewIncidentJSON{}
	for i, s := range matched {
		if i == previewMaxServers {
			break
		}
		buckets, err := a.Store.ReadBuckets(c.Request.Context(), s.ID, metrics.Minute, now.Add(-previewWindow), now)
		if err != nil {
			a.handleErr(c, err)
			return
		}
		for _, pi := range alerting.Preview(ar, buckets) {
			out := previewIncidentJSON{ServerID: s.ID, Start: pi.Start, Peak: pi.Peak}
			if !pi.End.IsZero() {
				end := pi.End
				out.End = &end
			}
			incidents = append(incidents, out)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"matched_servers":  len(matched),
		"previewed":        min(len(matched), previewMaxServers),
		"would_fire":       len(incidents),
		"incidents":        incidents,
		"window_hours":     int(previewWindow / time.Hour),
	})
}
