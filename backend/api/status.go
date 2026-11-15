package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"backend/alerting"
	"backend/checks"
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
	var chks []store.Check
	for _, id := range org.StatusPage.CheckIDs {
		if ck, ok := a.Dir.OrgCheck(org.ID, id); ok {
			chks = append(chks, ck)
		}
	}
	checkIDs := make([]int64, len(chks))
	for i, ck := range chks {
		checkIDs[i] = ck.ID
	}
	today := now.UTC().Truncate(24 * time.Hour)
	since := today.AddDate(0, 0, -(statusDays - 1))
	days, err := a.Store.UptimeDays(c.Request.Context(), ids, since)
	if err != nil {
		a.handleErr(c, err)
		return 0, nil
	}
	var checkDays []store.CheckUptimeDay
	if len(checkIDs) > 0 {
		if checkDays, err = a.Store.CheckUptimeDays(c.Request.Context(), checkIDs, since); err != nil {
			a.handleErr(c, err)
			return 0, nil
		}
	}
	incidents, err := a.Store.IncidentsForServices(c.Request.Context(), org.ID, ids, checkIDs, since, statusIncidentLimit)
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
	probesByCheck := map[int64]map[string]store.CheckUptimeDay{}
	for _, d := range checkDays {
		if probesByCheck[d.CheckID] == nil {
			probesByCheck[d.CheckID] = map[string]store.CheckUptimeDay{}
		}
		probesByCheck[d.CheckID][d.Day.UTC().Format(time.DateOnly)] = d
	}
	worstByDay := map[serviceKey]map[string]string{}
	for _, inc := range incidents {
		key := incidentService(inc)
		end := now
		if inc.ResolvedAt != nil {
			end = *inc.ResolvedAt
		}
		for d := inc.StartedAt.UTC().Truncate(24 * time.Hour); !d.After(end); d = d.AddDate(0, 0, 1) {
			if worstByDay[key] == nil {
				worstByDay[key] = map[string]string{}
			}
			day := d.Format(time.DateOnly)
			if worstByDay[key][day] != string(alerting.Critical) {
				worstByDay[key][day] = inc.Severity
			}
		}
	}

	flushedThrough := a.Metrics.Stats().LastFlush
	overall := statusHealthy
	rank := map[string]int{statusHealthy: 0, statusWarning: 1, statusOffline: 2, statusCritical: 3}
	services := make([]gin.H, 0, len(servers)+len(chks))
	nameByService := map[serviceKey]string{}
	for _, s := range servers {
		key := serviceKey{kindServer, s.ID}
		nameByService[key] = s.Name
		st, _, _ := a.status(s.ID)
		if rank[st] > rank[overall] {
			overall = st
		}
		var upTotal, expectedTotal int
		dayList := make([]gin.H, 0, statusDays)
		for d := since; !d.After(today); d = d.AddDate(0, 0, 1) {
			day := d.Format(time.DateOnly)
			// Uptime minutes reach the database at each flush, so a day is
			// measured from when the server existed until the last flush.
			start, end := maxTime(d, s.CreatedAt.UTC()), minTime(d.Add(24*time.Hour), flushedThrough)
			expected := int(end.Sub(start) / time.Minute)
			if expected < 1 {
				dayList = append(dayList, gin.H{"day": day, "pct": nil, "worst": worstOrNil(worstByDay[key], day)})
				continue
			}
			up := min(minutesByServer[s.ID][day], expected)
			upTotal += up
			expectedTotal += expected
			dayList = append(dayList, gin.H{"day": day, "pct": float64(up) * 100 / float64(expected), "worst": worstOrNil(worstByDay[key], day)})
		}
		var pct any // null until the first flush has measured anything
		if expectedTotal > 0 {
			pct = float64(upTotal) * 100 / float64(expectedTotal)
		}
		services = append(services, gin.H{"name": s.Name, "kind": kindServer, "status": st, "uptime_pct": pct, "days": dayList})
	}

	snaps := a.Checks.Snapshots(checkIDs)
	for _, ck := range chks {
		key := serviceKey{kindCheck, ck.ID}
		nameByService[key] = ck.Name
		st := publicCheckStatus(snapshotOr(snaps, ck).Status)
		if rank[st] > rank[overall] {
			overall = st
		}
		// Probe counts reach the database at each flush; a day without
		// flushed probes (before the check existed, or not flushed yet) is null.
		var okTotal, probeTotal int
		dayList := make([]gin.H, 0, statusDays)
		for d := since; !d.After(today); d = d.AddDate(0, 0, 1) {
			day := d.Format(time.DateOnly)
			row := probesByCheck[ck.ID][day]
			if row.Total <= 0 {
				dayList = append(dayList, gin.H{"day": day, "pct": nil, "worst": worstOrNil(worstByDay[key], day)})
				continue
			}
			okTotal += row.OK
			probeTotal += row.Total
			dayList = append(dayList, gin.H{"day": day, "pct": float64(row.OK) * 100 / float64(row.Total), "worst": worstOrNil(worstByDay[key], day)})
		}
		var pct any
		if probeTotal > 0 {
			pct = float64(okTotal) * 100 / float64(probeTotal)
		}
		services = append(services, gin.H{"name": ck.Name, "kind": kindCheck, "status": st, "uptime_pct": pct, "days": dayList})
	}

	recent := make([]gin.H, 0, len(incidents))
	for _, inc := range incidents {
		recent = append(recent, gin.H{
			"service": nameByService[incidentService(inc)], "metric": inc.Metric, "severity": inc.Severity,
			"started_at": inc.StartedAt, "resolved_at": inc.ResolvedAt,
		})
	}
	title := org.StatusPage.Title
	if title == "" {
		title = org.Name
	}
	return http.StatusOK, gin.H{"title": title, "overall": overall, "updated_at": now.UTC(), "services": services, "incidents": recent}
}

const (
	kindServer = "server"
	kindCheck  = "check"
)

// serviceKey identifies a status page service: a server or a check.
type serviceKey struct {
	kind string
	id   int64
}

func incidentService(inc store.Incident) serviceKey {
	if inc.CheckID != nil {
		return serviceKey{kindCheck, *inc.CheckID}
	}
	if inc.ServerID != nil {
		return serviceKey{kindServer, *inc.ServerID}
	}
	return serviceKey{}
}

// publicCheckStatus maps a check's status onto the status page's server
// vocabulary, so overall ranks servers and checks together. A pending check
// (not probed since a restart) has no evidence of a problem.
func publicCheckStatus(s checks.Status) string {
	switch s {
	case checks.StatusDown:
		return statusCritical
	case checks.StatusDegraded:
		return statusWarning
	case checks.StatusPaused:
		return statusOffline
	default:
		return statusHealthy
	}
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func worstOrNil(byDay map[string]string, key string) any {
	if w, ok := byDay[key]; ok {
		return w
	}
	return nil
}
