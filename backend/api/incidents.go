package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"backend/auth"
	"backend/store"
)

type incidentJSON struct {
	store.Incident
	State        string     `json:"state"`
	Unit         string     `json:"unit"`
	NextNotifyAt *time.Time `json:"next_notify_at"`
}

func (a *API) incidentJSON(orgID int64, i store.Incident) incidentJSON {
	out := incidentJSON{Incident: i, State: i.State(), Unit: UnitFor(i.Metric)}
	if i.State() != "open" || i.RuleID == nil {
		return out
	}
	for _, r := range a.Dir.OrgRules(orgID) {
		if r.ID == *i.RuleID && r.CooldownSeconds > 0 {
			base := i.StartedAt
			if i.LastNotifiedAt != nil {
				base = *i.LastNotifiedAt
			}
			next := base.Add(time.Duration(r.CooldownSeconds) * time.Second)
			out.NextNotifyAt = &next
		}
	}
	return out
}

func (a *API) listIncidents(c *gin.Context) {
	p := auth.MustPrincipal(c)
	f := store.IncidentFilter{
		State:    c.DefaultQuery("state", "all"),
		Severity: c.Query("severity"),
		Metric:   c.Query("metric"),
	}
	switch f.State {
	case "open", "acked", "resolved", "all":
	default:
		invalid(c, "state must be open, acked, resolved or all")
		return
	}
	for name, dst := range map[string]*int64{"server_id": &f.ServerID, "before": &f.BeforeID} {
		if v := c.Query(name); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n <= 0 {
				invalid(c, "invalid "+name)
				return
			}
			*dst = n
		}
	}
	if v := c.Query("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			invalid(c, "invalid limit")
			return
		}
		f.Limit = n
	}
	list, counts, err := a.Store.ListIncidents(c.Request.Context(), p.OrgID, f)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	out := make([]incidentJSON, 0, len(list))
	for _, i := range list {
		out = append(out, a.incidentJSON(p.OrgID, i))
	}
	c.JSON(http.StatusOK, gin.H{"incidents": out, "counts": counts})
}

func (a *API) ackIncident(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	now := a.Now()
	inc, err := a.Store.AckIncident(c.Request.Context(), p.OrgID, id, p.User.ID, now)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	a.Engine.Ack(id, now)
	out := a.incidentJSON(p.OrgID, inc)
	a.Broker.Publish(p.OrgID, eventIncident, gin.H{"action": "updated", "incident": out})
	c.JSON(http.StatusOK, gin.H{"incident": out})
}

func (a *API) resolveIncident(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	ctx := c.Request.Context()
	inc, err := a.Store.GetIncident(ctx, p.OrgID, id)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	if inc.ResolvedAt == nil {
		now := a.Now()
		if err := a.Engine.Resolve(ctx, id, now); err != nil {
			// Not tracked by the engine (e.g. its rule was deleted): close it
			// in the database directly.
			if err := a.Store.ResolveIncident(ctx, id, now, "manual", inc.Peak, inc.SamplesOver, &p.User.ID); err != nil {
				a.handleErr(c, err)
				return
			}
		}
		_ = a.Store.SetResolvedBy(ctx, id, p.User.ID)
		if inc, err = a.Store.GetIncident(ctx, p.OrgID, id); err != nil {
			a.handleErr(c, err)
			return
		}
	}
	out := a.incidentJSON(p.OrgID, inc)
	a.Broker.Publish(p.OrgID, eventIncident, gin.H{"action": "resolved", "incident": out})
	c.JSON(http.StatusOK, gin.H{"incident": out})
}
