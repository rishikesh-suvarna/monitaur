package api

import (
	"net/http"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend/auth"
	"backend/notify"
	"backend/secrets"
	"backend/store"
)

const (
	inviteTTL            = 7 * 24 * time.Hour
	invitesPerHour       = 20
	invitesPerHourBurst  = 5
	maxOrgNameLen        = 60
	maxStatusTitleLen    = 80
	minutesPerHour       = 60
	inviteSendTimeout    = 20 * time.Second
)

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,39}$`)

func (a *API) getOrg(c *gin.Context) {
	p := auth.MustPrincipal(c)
	org, ok := a.Dir.Org(p.OrgID)
	if !ok {
		fail(c, http.StatusNotFound, "not_found", "organization not found")
		return
	}
	usage, err := a.Store.Usage(c.Request.Context(), p.OrgID)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"org":  orgJSON(org, p.Role),
		"plan": a.Dir.Plan(p.OrgID),
		"usage": gin.H{
			"servers": usage.Servers, "members": usage.Members, "rules": usage.Rules, "channels": usage.Channels,
			"alert_emails_today": a.Budget.SentToday(p.OrgID, a.Now()),
		},
	})
}

func orgJSON(o store.Org, role store.Role) gin.H {
	sp := o.StatusPage
	if sp.ServerIDs == nil {
		sp.ServerIDs = []int64{}
	}
	return gin.H{
		"id": o.ID, "name": o.Name, "slug": o.Slug, "plan_id": o.PlanID, "personal": o.Personal(), "role": role,
		"status_page": gin.H{"enabled": sp.Enabled, "slug": o.Slug, "title": sp.Title, "server_ids": sp.ServerIDs},
		"created_at": o.CreatedAt,
	}
}

func (a *API) patchOrg(c *gin.Context) {
	p := auth.MustPrincipal(c)
	var req struct {
		Name       *string           `json:"name"`
		Slug       *string           `json:"slug"`
		StatusPage *store.StatusPage `json:"status_page"`
	}
	if !bind(c, &req) {
		return
	}
	patch := store.OrgPatch{StatusPage: req.StatusPage}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" || len([]rune(n)) > maxOrgNameLen {
			invalid(c, "name must be 1 to 60 characters")
			return
		}
		patch.Name = &n
	}
	if req.Slug != nil {
		s := strings.ToLower(strings.TrimSpace(*req.Slug))
		if !slugPattern.MatchString(s) {
			invalid(c, "status page address must be 3 to 40 lowercase letters, numbers or dashes")
			return
		}
		patch.Slug = &s
	}
	if sp := req.StatusPage; sp != nil {
		sp.Title = strings.TrimSpace(sp.Title)
		if len([]rune(sp.Title)) > maxStatusTitleLen {
			invalid(c, "status page title must be at most 80 characters")
			return
		}
	}
	old, _ := a.Dir.Org(p.OrgID)
	org, err := a.Store.UpdateOrg(c.Request.Context(), p.OrgID, patch)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	a.Dir.PutOrg(org)
	a.invalidateStatus(old.Slug)
	a.invalidateStatus(org.Slug)
	c.JSON(http.StatusOK, gin.H{"org": orgJSON(org, p.Role)})
}

func (a *API) listMembers(c *gin.Context) {
	p := auth.MustPrincipal(c)
	members, invites, err := a.Store.ListMembers(c.Request.Context(), p.OrgID)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"members": nonNil(members), "invites": nonNil(invites)})
}

func (a *API) createInvite(c *gin.Context) {
	p := auth.MustPrincipal(c)
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !bind(c, &req) {
		return
	}
	addr, err := mail.ParseAddress(strings.TrimSpace(req.Email))
	if err != nil || addr.Name != "" {
		invalid(c, "enter a single valid email address")
		return
	}
	role, err := store.ParseRole(req.Role)
	if err != nil || role == store.RoleOwner {
		invalid(c, "role must be admin, member or viewer")
		return
	}
	// Invite emails bypass the alert-email budget: limit them separately.
	if !a.Limiter.Allow("invite:"+strconv.FormatInt(p.OrgID, 10), invitesPerHour/minutesPerHour+1, invitesPerHourBurst) {
		fail(c, http.StatusTooManyRequests, "rate_limited", "too many invites, try again later")
		return
	}
	token, err := secrets.NewInviteToken()
	if err != nil {
		a.handleErr(c, err)
		return
	}
	inv, err := a.Store.CreateInvite(c.Request.Context(), p.OrgID, p.User.ID, addr.Address, role, secrets.HashToken(token), inviteTTL, a.Dir.Plan(p.OrgID).MaxMembers)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	org, _ := a.Dir.Org(p.OrgID)
	inviteURL := strings.TrimRight(a.Config.Public.AppURL, "/") + "/invite/" + token
	emailed := false
	if a.Config.SMTP.Enabled() {
		ctx, cancel := contextWithTimeout(c, inviteSendTimeout)
		defer cancel()
		err := a.Dispatcher.SendDirect(ctx, inv.Email, notify.Message{Kind: notify.KindInvite, OrgID: p.OrgID,
			InviteOrgName: org.Name, InviteURL: inviteURL, DashboardURL: a.Config.Public.AppURL})
		if err != nil {
			a.Log.Warn("invite email failed", "org_id", p.OrgID, "err", err)
		}
		emailed = err == nil
	}
	// Admins get the link too, so self-hosters without SMTP can share it.
	c.JSON(http.StatusCreated, gin.H{"invite": inv, "invite_url": inviteURL, "emailed": emailed})
}

func (a *API) deleteInvite(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	if err := a.Store.DeleteInvite(c.Request.Context(), p.OrgID, id); err != nil {
		a.handleErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *API) patchMember(c *gin.Context) {
	p := auth.MustPrincipal(c)
	userID, ok := pathID(c, "userId")
	if !ok {
		return
	}
	var req struct {
		Role string `json:"role"`
	}
	if !bind(c, &req) {
		return
	}
	role, err := store.ParseRole(req.Role)
	if err != nil {
		invalid(c, "role must be owner, admin, member or viewer")
		return
	}
	m, err := a.Store.UpdateMemberRole(c.Request.Context(), p.OrgID, userID, role)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	a.Auth.InvalidateMembership(p.OrgID, userID)
	c.JSON(http.StatusOK, gin.H{"member": m})
}

func (a *API) removeMember(c *gin.Context) {
	p := auth.MustPrincipal(c)
	userID, ok := pathID(c, "userId")
	if !ok {
		return
	}
	if userID != p.User.ID && !p.Role.AtLeast(store.RoleAdmin) {
		fail(c, http.StatusForbidden, "forbidden", "only admins can remove other members")
		return
	}
	if err := a.Store.RemoveMember(c.Request.Context(), p.OrgID, userID); err != nil {
		a.handleErr(c, err)
		return
	}
	a.Auth.InvalidateMembership(p.OrgID, userID)
	c.Status(http.StatusNoContent)
}

func (a *API) acceptInvite(c *gin.Context) {
	id := auth.MustIdentity(c)
	var req struct {
		Token string `json:"token"`
	}
	if !bind(c, &req) || req.Token == "" {
		if !c.IsAborted() {
			invalid(c, "token is required")
		}
		return
	}
	org, err := a.Store.AcceptInvite(c.Request.Context(), secrets.HashToken(req.Token), id.User, func(planID string) int {
		if p, ok := a.Dir.PlanByID(planID); ok {
			return p.MaxMembers
		}
		return 1
	})
	if err != nil {
		a.handleErr(c, err)
		return
	}
	a.Auth.InvalidateMembership(org.ID, id.User.ID)
	c.JSON(http.StatusOK, gin.H{"org": orgJSON(org, "")})
}
