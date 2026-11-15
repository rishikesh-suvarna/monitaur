package api

import (
	"cmp"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"backend/auth"
	"backend/store"
)

const (
	maxMaintenanceNameRunes = 80
	maxMaintenanceDays      = 30
	maxMaintenanceDuration  = maxMaintenanceDays * 24 * time.Hour
	// Check IDs are only shape-checked (checks may not exist yet), so the
	// list gets a bound of its own; server IDs are bounded by the org.
	maxMaintenanceCheckIDs = 200
)

type maintenanceScopeJSON struct {
	All       bool     `json:"all"`
	ServerIDs []int64  `json:"server_ids"`
	Tags      []string `json:"tags"`
	CheckIDs  []int64  `json:"check_ids"`
}

type maintenanceJSON struct {
	ID        int64                `json:"id"`
	Name      string               `json:"name"`
	Scope     maintenanceScopeJSON `json:"scope"`
	StartsAt  time.Time            `json:"starts_at"`
	EndsAt    time.Time            `json:"ends_at"`
	CreatedBy *string              `json:"created_by"`
	CreatedAt time.Time            `json:"created_at"`
	State     string               `json:"state"`
}

func toMaintenanceJSON(w store.MaintenanceWindow, now time.Time) maintenanceJSON {
	return maintenanceJSON{
		ID: w.ID, Name: w.Name,
		Scope: maintenanceScopeJSON{All: w.ScopeAll, ServerIDs: nonNil(w.ScopeServerIDs), Tags: nonNil(w.ScopeTags),
			CheckIDs: nonNil(w.ScopeCheckIDs)},
		StartsAt: w.StartsAt, EndsAt: w.EndsAt, CreatedBy: w.CreatedBy, CreatedAt: w.CreatedAt, State: w.State(now),
	}
}

// maintenanceInput is the create/patch body; pointers distinguish "absent" in
// PATCH. "End now" is a PATCH of {ends_at: now}.
type maintenanceInput struct {
	Name     *string               `json:"name"`
	Scope    *maintenanceScopeJSON `json:"scope"`
	StartsAt *time.Time            `json:"starts_at"`
	EndsAt   *time.Time            `json:"ends_at"`
}

// applyMaintenance merges the input into w and validates the result, with
// tenant checks on every scoped server. It returns a message for 400 or "".
func (a *API) applyMaintenance(orgID int64, in maintenanceInput, w store.MaintenanceWindow) (store.MaintenanceWindow, string) {
	if in.Name != nil {
		w.Name = strings.TrimSpace(*in.Name)
	}
	if in.StartsAt != nil {
		w.StartsAt = in.StartsAt.UTC()
	}
	if in.EndsAt != nil {
		w.EndsAt = in.EndsAt.UTC()
	}
	if in.Scope != nil {
		var msg string
		if w, msg = a.applyMaintenanceScope(orgID, *in.Scope, w); msg != "" {
			return w, msg
		}
	}

	if n := utf8.RuneCountInString(w.Name); n == 0 || n > maxMaintenanceNameRunes {
		return w, fmt.Sprintf("name must be 1 to %d characters", maxMaintenanceNameRunes)
	}
	if !w.ScopeAll && len(w.ScopeServerIDs) == 0 && len(w.ScopeTags) == 0 && len(w.ScopeCheckIDs) == 0 {
		return w, "scope must be all, or list servers, tags or checks"
	}
	if w.StartsAt.IsZero() || w.EndsAt.IsZero() {
		return w, "starts_at and ends_at are required"
	}
	if !w.EndsAt.After(w.StartsAt) {
		return w, "ends_at must be after starts_at"
	}
	if w.EndsAt.Sub(w.StartsAt) > maxMaintenanceDuration {
		return w, fmt.Sprintf("a maintenance window can last at most %d days", maxMaintenanceDays)
	}
	return w, ""
}

func (a *API) applyMaintenanceScope(orgID int64, in maintenanceScopeJSON, w store.MaintenanceWindow) (store.MaintenanceWindow, string) {
	if in.All {
		w.ScopeAll, w.ScopeServerIDs, w.ScopeTags, w.ScopeCheckIDs = true, []int64{}, []string{}, []int64{}
		return w, ""
	}
	tags, ok := normalizeTags(in.Tags)
	if !ok {
		return w, "scope tags must be at most 10 lowercase words (letters, numbers, - and _)"
	}
	for _, id := range in.ServerIDs {
		// A miss is the same message whether the server is absent or another
		// org's, so IDs cannot be probed across tenants.
		if _, ok := a.Dir.OrgServer(orgID, id); !ok {
			return w, "scope includes a server that is not in this organization"
		}
	}
	if len(in.CheckIDs) > maxMaintenanceCheckIDs {
		return w, fmt.Sprintf("scope can list at most %d checks", maxMaintenanceCheckIDs)
	}
	for _, id := range in.CheckIDs {
		if id <= 0 {
			return w, "scope check ids must be positive"
		}
	}
	w.ScopeAll, w.ScopeServerIDs, w.ScopeTags, w.ScopeCheckIDs = false, sortedUnique(in.ServerIDs), tags, sortedUnique(in.CheckIDs)
	return w, ""
}

func sortedUnique(ids []int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return nonNil(slices.Compact(out))
}

// inMaintenance feeds ServerSummary.maintenance and the live snapshot.
func (a *API) inMaintenance(s store.Server) bool {
	return a.Silenced != nil && a.Silenced(s.OrgID, s.ID, 0, a.Now())
}

func (a *API) listMaintenance(c *gin.Context) {
	p := auth.MustPrincipal(c)
	windows := slices.Clone(a.Dir.OrgMaintenance(p.OrgID))
	// Newest first, the order a schedule is read in.
	slices.SortFunc(windows, func(x, y store.MaintenanceWindow) int {
		if byStart := y.StartsAt.Compare(x.StartsAt); byStart != 0 {
			return byStart
		}
		return cmp.Compare(y.ID, x.ID)
	})
	now := a.Now()
	out := make([]maintenanceJSON, 0, len(windows))
	for _, w := range windows {
		out = append(out, toMaintenanceJSON(w, now))
	}
	c.JSON(http.StatusOK, gin.H{"windows": out})
}

func (a *API) createMaintenance(c *gin.Context) {
	p := auth.MustPrincipal(c)
	var in maintenanceInput
	if !bind(c, &in) {
		return
	}
	if in.Scope == nil {
		// No default: an implicit "all" would silence every alert.
		invalid(c, "scope is required")
		return
	}
	userID := p.User.ID
	w, msg := a.applyMaintenance(p.OrgID, in, store.MaintenanceWindow{OrgID: p.OrgID, CreatedByID: &userID})
	if msg != "" {
		invalid(c, msg)
		return
	}
	created, err := a.Store.CreateMaintenanceWindow(c.Request.Context(), w, store.MaxMaintenanceWindows)
	if err != nil {
		a.maintenanceErr(c, err)
		return
	}
	a.Dir.PutMaintenance(created)
	c.JSON(http.StatusCreated, gin.H{"window": toMaintenanceJSON(created, a.Now())})
}

func (a *API) patchMaintenance(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	var in maintenanceInput
	if !bind(c, &in) {
		return
	}
	current, ok := a.Dir.OrgMaintenanceWindow(p.OrgID, id)
	if !ok {
		fail(c, http.StatusNotFound, "not_found", "maintenance window not found")
		return
	}
	next, msg := a.applyMaintenance(p.OrgID, in, current)
	if msg != "" {
		invalid(c, msg)
		return
	}
	updated, err := a.Store.UpdateMaintenanceWindow(c.Request.Context(), next)
	if err != nil {
		a.maintenanceErr(c, err)
		return
	}
	a.Dir.PutMaintenance(updated)
	c.JSON(http.StatusOK, gin.H{"window": toMaintenanceJSON(updated, a.Now())})
}

func (a *API) deleteMaintenance(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	if err := a.Store.DeleteMaintenanceWindow(c.Request.Context(), p.OrgID, id); err != nil {
		a.maintenanceErr(c, err)
		return
	}
	a.Dir.RemoveMaintenance(p.OrgID, id)
	c.Status(http.StatusNoContent)
}

// maintenanceErr explains the window cap, which is not a plan limit the
// generic "your plan's limit" message would suggest.
func (a *API) maintenanceErr(c *gin.Context, err error) {
	if errors.Is(err, store.ErrLimitReached) {
		fail(c, http.StatusForbidden, "limit_reached",
			fmt.Sprintf("an organization can keep at most %d maintenance windows; delete ended ones first", store.MaxMaintenanceWindows))
		return
	}
	a.handleErr(c, err)
}
