package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend/auth"
	"backend/metrics"
	"backend/store"
)

const (
	exportIncidentDays = 90
	exportMetricsDays  = 30
	hoursPerDay        = 24
	maxDisplayName     = 80
)

func contextWithTimeout(c *gin.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.Request.Context(), d)
}

func (a *API) getMe(c *gin.Context) {
	id := auth.MustIdentity(c)
	orgs, err := a.Store.ListUserOrgs(c.Request.Context(), id.User.ID)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	out := make([]gin.H, 0, len(orgs))
	for _, o := range orgs {
		out = append(out, gin.H{"id": o.ID, "name": o.Name, "role": o.Role, "personal": o.Personal(), "plan_id": o.PlanID})
	}
	c.JSON(http.StatusOK, gin.H{
		"user": gin.H{
			"id": id.User.ID, "email": id.User.Email, "display_name": id.User.DisplayName,
			"email_verified": id.User.EmailVerified, "provider": id.Provider,
		},
		"orgs":           out,
		"current_org_id": id.PersonalOrgID,
	})
}

func (a *API) patchMe(c *gin.Context) {
	id := auth.MustIdentity(c)
	var req struct {
		DisplayName *string `json:"display_name"`
	}
	if !bind(c, &req) {
		return
	}
	if req.DisplayName == nil {
		c.JSON(http.StatusOK, gin.H{"user": id.User})
		return
	}
	if n := strings.TrimSpace(*req.DisplayName); len([]rune(n)) > maxDisplayName {
		invalid(c, "display name must be at most 80 characters")
		return
	}
	u, err := a.Store.UpdateDisplayName(c.Request.Context(), id.User.ID, *req.DisplayName)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	a.Auth.UpdateCachedUser(id.User.FirebaseUID, u)
	c.JSON(http.StatusOK, gin.H{"user": u})
}

// deleteMe removes the account and every org the user solely owns. Their
// agents are disconnected and rejected from then on.
func (a *API) deleteMe(c *gin.Context) {
	id := auth.MustIdentity(c)
	ctx := c.Request.Context()
	deleted, err := a.Store.DeleteUser(ctx, id.User.ID)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	for _, d := range deleted {
		for _, sid := range a.Dir.RemoveOrg(d.OrgID) {
			a.Metrics.Forget(sid)
			a.Engine.RemoveServer(ctx, sid)
			a.Hub.Disconnect(sid)
		}
		a.Engine.SetOrgRules(d.OrgID, nil)
		a.Auth.InvalidateOrg(d.OrgID)
	}
	a.Dir.ForgetUser(id.User.ID)
	a.Auth.InvalidateUser(id.User.FirebaseUID)
	if err := a.Auth.Verifier().DeleteUser(ctx, id.User.FirebaseUID); err != nil {
		// Data is already gone; a lingering Firebase login just recreates an
		// empty account on next sign-in.
		a.Log.Warn("delete firebase user", "err", err)
	}
	c.Status(http.StatusNoContent)
}

func (a *API) revokeSessions(c *gin.Context) {
	id := auth.MustIdentity(c)
	if err := a.Auth.Verifier().RevokeSessions(c.Request.Context(), id.User.FirebaseUID); err != nil {
		a.handleErr(c, err)
		return
	}
	a.Auth.InvalidateUser(id.User.FirebaseUID)
	c.Status(http.StatusNoContent)
}

// export returns the org's configuration and recent history as JSON.
func (a *API) export(c *gin.Context) {
	p := auth.MustPrincipal(c)
	ctx := c.Request.Context()
	now := a.Now()
	org, _ := a.Dir.Org(p.OrgID)

	servers := a.Dir.OrgServers(p.OrgID)
	type serverExport struct {
		ID           int64            `json:"id"`
		Name         string           `json:"name"`
		Tags         []string         `json:"tags"`
		AgentVersion string           `json:"agent_version"`
		CreatedAt    time.Time        `json:"created_at"`
		LastSeen     *time.Time       `json:"last_seen"`
		Hourly       []metrics.Bucket `json:"hourly_metrics"`
	}
	exported := make([]serverExport, 0, len(servers))
	for _, s := range servers {
		hourly, err := a.Store.ReadBuckets(ctx, s.ID, metrics.Hour, now.Add(-exportMetricsDays*hoursPerDay*time.Hour), now)
		if err != nil {
			a.handleErr(c, err)
			return
		}
		exported = append(exported, serverExport{ID: s.ID, Name: s.Name, Tags: s.Tags, AgentVersion: s.AgentVersion,
			CreatedAt: s.CreatedAt, LastSeen: s.LastSeen, Hourly: nonNil(hourly)})
	}
	incidents, err := a.Store.ExportIncidents(ctx, p.OrgID, now.Add(-exportIncidentDays*hoursPerDay*time.Hour))
	if err != nil {
		a.handleErr(c, err)
		return
	}
	rules := a.Dir.OrgRules(p.OrgID)
	ruleOut := make([]ruleJSON, 0, len(rules))
	for _, r := range rules {
		ruleOut = append(ruleOut, toRuleJSON(r))
	}
	chs := a.Dir.OrgChannels(p.OrgID)
	chOut := make([]channelJSON, 0, len(chs))
	for _, ch := range chs {
		chOut = append(chOut, toChannelJSON(ch))
	}
	c.Header("Content-Disposition", `attachment; filename="monitaur-export-`+strconv.FormatInt(p.OrgID, 10)+`-`+now.UTC().Format("20060102")+`.json"`)
	c.JSON(http.StatusOK, gin.H{
		"exported_at": now.UTC(), "org": orgJSON(org, p.Role), "plan": a.Dir.Plan(p.OrgID),
		"servers": exported, "rules": ruleOut, "channels": chOut, "incidents": nonNil(incidents),
	})
}

var _ = store.RoleOwner
