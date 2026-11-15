package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"backend/alerting"
	"backend/store"
)

const (
	statusCacheTTL      = time.Minute
	statusDays          = 90
	statusIncidentLimit = 10
)

type cachedStatus struct {
	body    gin.H
	status  int
	expires time.Time
}

func (a *API) invalidateStatus(slug string) {
	a.statusMu.Lock()
	delete(a.statusCache, slug)
	a.statusMu.Unlock()
}

// publicStatus serves /status/:slug. Responses are cached for a minute so
// public traffic cannot keep the database awake.
func (a *API) publicStatus(c *gin.Context) {
	slug := c.Param("slug")
	now := a.Now()
	a.statusMu.Lock()
	cached, ok := a.statusCache[slug]
	a.statusMu.Unlock()
	if ok && now.Before(cached.expires) {
		c.Header("Cache-Control", "public, max-age=60")
		c.JSON(cached.status, cached.body)
		return
	}

	status, body := a.buildStatus(c, slug, now)
	if status == 0 {
		return // handleErr already responded
	}
	a.statusMu.Lock()
	a.statusCache[slug] = cachedStatus{body: body, status: status, expires: now.Add(statusCacheTTL)}
	a.statusMu.Unlock()
	c.Header("Cache-Control", "public, max-age=60")
	c.JSON(status, body)
}

func (a *API) buildStatus(c *gin.Context, slug string, now time.Time) (int, gin.H) {
	notFound := gin.H{"error": "status page not found", "code": "not_found"}
	org, err := a.Store.OrgBySlug(c.Request.Context(), slug)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !org.StatusPage.Enabled) {
		return http.StatusNotFound, notFound
	}
	if err != nil {
		a.handleErr(c, err)
		return 0, nil
	}

	var servers []store.Server
	for _, id := range org.StatusPage.ServerIDs {
		if s, ok := a.Dir.OrgServer(org.ID, id); ok {
			servers = append(servers, s)
		}
	}
	ids := make([]int64, len(servers))
	for i, s := range servers {
		ids[i] = s.ID
	}
	today := now.UTC().Truncate(24 * time.Hour)
	since := today.AddDate(0, 0, -(statusDays - 1))
	days, err := a.Store.UptimeDays(c.Request.Context(), ids, since)
	if err != nil {
		a.handleErr(c, err)
		return 0, nil
	}
	incidents, err := a.Store.IncidentsForServers(c.Request.Context(), org.ID, ids, since, statusIncidentLimit)
	if err != nil {
		a.handleErr(c, err)
		return 0, nil
	}

	minutesByServer := map[int64]map[string]int{}
	for _, d := range days {
		if minutesByServer[d.ServerID] == nil {
			minutesByServer[d.ServerID] = map[string]int{}
		}
		minutesByServer[d.ServerID][d.Day.UTC().Format(time.DateOnly)] = d.MinutesUp
	}
	worstByDay := map[int64]map[string]string{}
	for _, inc := range incidents {
		end := now
		if inc.ResolvedAt != nil {
			end = *inc.ResolvedAt
		}
		for d := inc.StartedAt.UTC().Truncate(24 * time.Hour); !d.After(end); d = d.AddDate(0, 0, 1) {
			if worstByDay[inc.ServerID] == nil {
				worstByDay[inc.ServerID] = map[string]string{}
			}
			key := d.Format(time.DateOnly)
			if worstByDay[inc.ServerID][key] != string(alerting.Critical) {
				worstByDay[inc.ServerID][key] = inc.Severity
			}
		}
	}

	overall := statusHealthy
	rank := map[string]int{statusHealthy: 0, statusWarning: 1, statusOffline: 2, statusCritical: 3}
	services := make([]gin.H, 0, len(servers))
	for _, s := range servers {
		st, _, _ := a.status(s.ID)
		if rank[st] > rank[overall] {
			overall = st
		}
		var upTotal, expectedTotal int
		dayList := make([]gin.H, 0, statusDays)
		for d := since; !d.After(today); d = d.AddDate(0, 0, 1) {
			key := d.Format(time.DateOnly)
			expected := minutesPerDay
			if d.Equal(today) {
				expected = max(1, int(now.Sub(today).Minutes()))
			}
			createdDay := s.CreatedAt.UTC().Truncate(24 * time.Hour)
			if d.Before(createdDay) {
				dayList = append(dayList, gin.H{"day": key, "pct": nil, "worst": nil})
				continue
			}
			up := min(minutesByServer[s.ID][key], expected)
			upTotal += up
			expectedTotal += expected
			var worst any
			if w, ok := worstByDay[s.ID][key]; ok {
				worst = w
			}
			dayList = append(dayList, gin.H{"day": key, "pct": float64(up) * 100 / float64(expected), "worst": worst})
		}
		pct := 100.0
		if expectedTotal > 0 {
			pct = float64(upTotal) * 100 / float64(expectedTotal)
		}
		services = append(services, gin.H{"name": s.Name, "status": st, "uptime_pct": pct, "days": dayList})
	}

	nameByID := map[int64]string{}
	for _, s := range servers {
		nameByID[s.ID] = s.Name
	}
	recent := make([]gin.H, 0, len(incidents))
	for _, inc := range incidents {
		recent = append(recent, gin.H{
			"service": nameByID[inc.ServerID], "metric": inc.Metric, "severity": inc.Severity,
			"started_at": inc.StartedAt, "resolved_at": inc.ResolvedAt,
		})
	}
	title := org.StatusPage.Title
	if title == "" {
		title = org.Name
	}
	return http.StatusOK, gin.H{"title": title, "overall": overall, "updated_at": now.UTC(), "services": services, "incidents": recent}
}

const minutesPerDay = 24 * 60
