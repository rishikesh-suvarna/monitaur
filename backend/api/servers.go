package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend/alerting"
	"backend/auth"
	"backend/metrics"
	"backend/secrets"
	"backend/store"
)

const (
	sparkMinutes    = 30
	maxTags         = 10
	tokenGrace      = 10 * time.Minute
	installCommand  = "curl -sSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/main/install.sh | sudo bash"
	agentConfigPath = "/etc/monitaur/config.json"
	defaultInterval = 10

	statusHealthy  = "healthy"
	statusWarning  = "warning"
	statusCritical = "critical"
	statusOffline  = "offline"
)

var (
	serverNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	tagPattern        = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
)

type latestJSON struct {
	CPU       float32   `json:"cpu"`
	Mem       float32   `json:"mem"`
	Disk      float32   `json:"disk"`
	NetIn     float32   `json:"net_in"`
	NetOut    float32   `json:"net_out"`
	MemTotal  uint64    `json:"mem_total"`
	MemUsed   uint64    `json:"mem_used"`
	DiskTotal uint64    `json:"disk_total"`
	DiskUsed  uint64    `json:"disk_used"`
	CPUCores  int       `json:"cpu_cores"`
	UptimeS   int64     `json:"uptime_s"`
	At        time.Time `json:"at"`
}

type sparkJSON struct {
	CPU  []float32 `json:"cpu"`
	Mem  []float32 `json:"mem"`
	Disk []float32 `json:"disk"`
}

type serverJSON struct {
	ID            int64       `json:"id"`
	Name          string      `json:"name"`
	Tags          []string    `json:"tags"`
	Pinned        bool        `json:"pinned"`
	Status        string      `json:"status"`
	Connected     bool        `json:"connected"`
	LastSeen      *time.Time  `json:"last_seen"`
	AgentVersion  string      `json:"agent_version"`
	Latest        *latestJSON `json:"latest"`
	Spark         sparkJSON   `json:"spark"`
	OpenIncidents int         `json:"open_incidents"`
	// Thresholds of enabled "above" rules that apply to this server, keyed
	// like latest (cpu, mem, disk, net_in, net_out), so lists can colour values.
	Thresholds map[string]thresholdJSON `json:"thresholds"`
	CreatedAt  time.Time                `json:"created_at"`
}

// liveJSON is the slimmer per-server payload pushed over SSE every 3 s.
type liveJSON struct {
	ID        int64       `json:"id"`
	Status    string      `json:"status"`
	Connected bool        `json:"connected"`
	LastSeen  *time.Time  `json:"last_seen"`
	Latest    *latestJSON `json:"latest"`
}

func toLatestJSON(l metrics.Latest) *latestJSON {
	return &latestJSON{
		CPU: l.CPU, Mem: l.Mem, Disk: l.Disk, NetIn: l.NetInBps, NetOut: l.NetOutBps,
		MemTotal: l.MemTotalBytes, MemUsed: l.MemUsedBytes, DiskTotal: l.DiskTotalBytes, DiskUsed: l.DiskUsedBytes,
		CPUCores: l.CPUCores, UptimeS: l.UptimeSeconds, At: l.ReceivedAt,
	}
}

// status follows the design's encoding: critical (incl. unreachable > 5 min,
// which the heartbeat rule raises), then offline (no fresh data), then
// warning, else healthy.
func (a *API) status(serverID int64) (string, bool, *metrics.Latest) {
	connected := a.Hub.IsConnected(serverID)
	var latest *metrics.Latest
	if l, ok := a.Metrics.Latest(serverID); ok {
		latest = &l
	}
	fresh := latest != nil && a.Now().Sub(latest.ReceivedAt) < staleAfter
	sev, firing := a.Engine.ServerSeverity(serverID)
	switch {
	case firing && sev == alerting.Critical:
		return statusCritical, connected, latest
	case !connected && !fresh:
		return statusOffline, connected, latest
	case firing && sev == alerting.Warning:
		return statusWarning, connected, latest
	default:
		return statusHealthy, connected, latest
	}
}

func (a *API) lastSeen(s store.Server, latest *metrics.Latest) *time.Time {
	if latest != nil {
		t := latest.ReceivedAt
		return &t
	}
	return s.LastSeen
}

func (a *API) summary(s store.Server, pins map[int64]bool, open map[int64]int) serverJSON {
	status, connected, latest := a.status(s.ID)
	cpu, mem, disk := a.Metrics.Sparkline(s.ID, sparkMinutes)
	out := serverJSON{
		ID: s.ID, Name: s.Name, Tags: s.Tags, Pinned: pins[s.ID], Status: status, Connected: connected,
		LastSeen: a.lastSeen(s, latest), AgentVersion: s.AgentVersion, OpenIncidents: open[s.ID], CreatedAt: s.CreatedAt,
		Thresholds: a.thresholds(s),
		Spark:      sparkJSON{CPU: nonNil(cpu), Mem: nonNil(mem), Disk: nonNil(disk)},
	}
	if latest != nil {
		out.Latest = toLatestJSON(*latest)
	}
	return out
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func (a *API) openCounts(orgID int64) map[int64]int {
	out := map[int64]int{}
	for _, inc := range a.Engine.Open(orgID) {
		out[inc.ServerID]++
	}
	return out
}

func (a *API) liveServers(orgID int64) []liveJSON {
	servers := a.Dir.OrgServers(orgID)
	out := make([]liveJSON, 0, len(servers))
	for _, s := range servers {
		status, connected, latest := a.status(s.ID)
		l := liveJSON{ID: s.ID, Status: status, Connected: connected, LastSeen: a.lastSeen(s, latest)}
		if latest != nil {
			l.Latest = toLatestJSON(*latest)
		}
		out = append(out, l)
	}
	return out
}

func (a *API) listServers(c *gin.Context) {
	p := auth.MustPrincipal(c)
	pins, err := a.Dir.Pins(c.Request.Context(), p.User.ID)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	open := a.openCounts(p.OrgID)
	servers := a.Dir.OrgServers(p.OrgID)
	out := make([]serverJSON, 0, len(servers))
	for _, s := range servers {
		out = append(out, a.summary(s, pins, open))
	}
	c.JSON(http.StatusOK, gin.H{"servers": out})
}

func normalizeTags(in []string) ([]string, bool) {
	if len(in) > maxTags {
		return nil, false
	}
	out := make([]string, 0, len(in))
	for _, t := range in {
		t = strings.ToLower(strings.TrimSpace(t))
		if !tagPattern.MatchString(t) {
			return nil, false
		}
		if !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	slices.Sort(out)
	return out, true
}

type installJSON struct {
	Command    string `json:"command"`
	ConfigPath string `json:"config_path"`
	Config     string `json:"config"`
}

func (a *API) install(name, token string, plan store.Plan) installJSON {
	interval := plan.MinIntervalSeconds
	if interval <= 0 {
		interval = defaultInterval
	}
	cfg, _ := json.MarshalIndent(map[string]any{
		"token":               token,
		"api_endpoint":        a.Config.Public.IngestURL,
		"collection_interval": interval,
		"server_name":         name,
	}, "", "  ")
	return installJSON{Command: installCommand, ConfigPath: agentConfigPath, Config: string(cfg)}
}

func (a *API) createServer(c *gin.Context) {
	p := auth.MustPrincipal(c)
	var req struct {
		Name string   `json:"name"`
		Tags []string `json:"tags"`
	}
	if !bind(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if !serverNamePattern.MatchString(req.Name) {
		invalid(c, "name must be 1 to 64 letters, numbers, dots, dashes or underscores")
		return
	}
	tags, ok := normalizeTags(req.Tags)
	if !ok {
		invalid(c, "tags must be at most 10 lowercase words (letters, numbers, - and _)")
		return
	}
	token, err := secrets.NewAgentToken()
	if err != nil {
		a.handleErr(c, err)
		return
	}
	plan := a.Dir.Plan(p.OrgID)
	srv, err := a.Store.CreateServer(c.Request.Context(), store.NewServer{
		OrgID: p.OrgID, CreatedBy: p.User.ID, Name: req.Name, Tags: tags,
		TokenHash: secrets.HashToken(token), TokenPrefix: secrets.DisplayPrefix(token),
	}, plan.MaxServers)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	a.Dir.PutServer(srv)
	a.Engine.UpsertServer(serverInfo(srv))
	c.JSON(http.StatusCreated, gin.H{
		"server":  a.summary(srv, nil, nil),
		"token":   token,
		"install": a.install(srv.Name, token, plan),
	})
}

func serverInfo(s store.Server) alerting.ServerInfo {
	return alerting.ServerInfo{ID: s.ID, OrgID: s.OrgID, Name: s.Name, Tags: s.Tags}
}

func (a *API) orgServer(c *gin.Context) (store.Server, auth.Principal, bool) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return store.Server{}, p, false
	}
	srv, ok := a.Dir.OrgServer(p.OrgID, id)
	if !ok {
		fail(c, http.StatusNotFound, "not_found", "server not found")
		return store.Server{}, p, false
	}
	return srv, p, true
}

func (a *API) rulesFor(s store.Server) []store.Rule {
	var out []store.Rule
	for _, r := range a.Dir.OrgRules(s.OrgID) {
		if ruleToAlerting(r).Matches(serverInfo(s)) {
			out = append(out, r)
		}
	}
	return out
}

func (a *API) getServer(c *gin.Context) {
	srv, p, ok := a.orgServer(c)
	if !ok {
		return
	}
	counts, err := a.Store.ServerCounts(c.Request.Context(), srv.ID)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	pins, err := a.Dir.Pins(c.Request.Context(), p.User.ID)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"server": a.summary(srv, pins, a.openCounts(p.OrgID)),
		"token": gin.H{
			"prefix":       srv.TokenPrefix,
			"created_at":   srv.TokenCreatedAt,
			"last_used_at": srv.TokenLastUsedAt,
		},
		"counts": gin.H{"incidents": counts.Incidents, "rules": len(a.rulesFor(srv)), "metrics_days": counts.MetricsDays},
	})
}

func (a *API) patchServer(c *gin.Context) {
	srv, p, ok := a.orgServer(c)
	if !ok {
		return
	}
	var req struct {
		Name *string  `json:"name"`
		Tags []string `json:"tags"`
	}
	if !bind(c, &req) {
		return
	}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if !serverNamePattern.MatchString(n) {
			invalid(c, "name must be 1 to 64 letters, numbers, dots, dashes or underscores")
			return
		}
		req.Name = &n
	}
	var tags []string
	if req.Tags != nil {
		var ok bool
		if tags, ok = normalizeTags(req.Tags); !ok {
			invalid(c, "tags must be at most 10 lowercase words (letters, numbers, - and _)")
			return
		}
	}
	updated, err := a.Store.UpdateServer(c.Request.Context(), p.OrgID, srv.ID, req.Name, tags)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	// Activity fields in memory are newer than the DB between flushes.
	updated.LastSeen, updated.TokenLastUsedAt, updated.AgentVersion = srv.LastSeen, srv.TokenLastUsedAt, srv.AgentVersion
	a.Dir.PutServer(updated)
	a.Engine.UpsertServer(serverInfo(updated))
	pins, _ := a.Dir.Pins(c.Request.Context(), p.User.ID)
	c.JSON(http.StatusOK, gin.H{"server": a.summary(updated, pins, a.openCounts(p.OrgID))})
}

func (a *API) deleteServer(c *gin.Context) {
	srv, p, ok := a.orgServer(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	if err := a.Store.DeleteServer(ctx, p.OrgID, srv.ID); err != nil {
		a.handleErr(c, err)
		return
	}
	a.purgeServer(c, srv.ID)
	// Rule scopes and the status page dropped the server in the same
	// transaction; refresh the cached copies.
	if err := a.reloadOrgRules(ctx, p.OrgID); err != nil {
		a.Log.Error("reload rules after server delete", "org_id", p.OrgID, "err", err)
	}
	if org, err := a.Store.GetOrg(ctx, p.OrgID); err == nil {
		a.Dir.PutOrg(org)
		a.invalidateStatus(org.Slug)
	}
	c.Status(http.StatusNoContent)
}

// purgeServer drops every in-memory trace of a deleted server and closes its
// agent connection, so the agent is rejected on reconnect.
func (a *API) purgeServer(c *gin.Context, serverID int64) {
	srv, _ := a.Dir.Server(serverID)
	a.Dir.RemoveServer(serverID)
	a.Metrics.Forget(serverID)
	a.Engine.RemoveServer(c.Request.Context(), serverID)
	a.Hub.Disconnect(serverID)
	a.Broker.Publish(srv.OrgID, eventIncident, map[string]string{"action": "refresh"})
}

func (a *API) rotateToken(c *gin.Context) {
	srv, p, ok := a.orgServer(c)
	if !ok {
		return
	}
	token, err := secrets.NewAgentToken()
	if err != nil {
		a.handleErr(c, err)
		return
	}
	updated, err := a.Store.RotateToken(c.Request.Context(), p.OrgID, srv.ID, secrets.HashToken(token), secrets.DisplayPrefix(token), tokenGrace)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	updated.LastSeen, updated.AgentVersion = srv.LastSeen, srv.AgentVersion
	a.Dir.PutServer(updated)
	c.JSON(http.StatusOK, gin.H{
		"token":                  token,
		"previous_valid_until":   updated.PrevTokenExpiresAt,
		"install":                a.install(updated.Name, token, a.Dir.Plan(p.OrgID)),
		"prefix":                 updated.TokenPrefix,
		"previous_token_revoked": false,
	})
}

func (a *API) pinServer(pinned bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		srv, p, ok := a.orgServer(c)
		if !ok {
			return
		}
		if err := a.Store.SetPin(c.Request.Context(), p.User.ID, srv.ID, pinned); err != nil {
			a.handleErr(c, err)
			return
		}
		a.Dir.SetPin(p.User.ID, srv.ID, pinned)
		c.Status(http.StatusNoContent)
	}
}

type thresholdJSON struct {
	Warning  *float64 `json:"warning"`
	Critical *float64 `json:"critical"`
}

// thresholds draws the lowest enabled "above" rule per metric and severity
// on the charts, matching what would actually fire first.
func (a *API) thresholds(s store.Server) map[string]thresholdJSON {
	keys := map[string]string{"cpu": metrics.SeriesCPU, "memory": metrics.SeriesMem, "disk": metrics.SeriesDisk,
		"net_in": metrics.SeriesNetIn, "net_out": metrics.SeriesNetOut}
	out := map[string]thresholdJSON{}
	for _, r := range a.rulesFor(s) {
		key, ok := keys[r.Metric]
		if !ok || !r.Enabled || r.Comparison != string(alerting.Above) {
			continue
		}
		t := out[key]
		v := r.Threshold
		switch alerting.Severity(r.Severity) {
		case alerting.Warning:
			if t.Warning == nil || v < *t.Warning {
				t.Warning = &v
			}
		case alerting.Critical:
			if t.Critical == nil || v < *t.Critical {
				t.Critical = &v
			}
		}
		out[key] = t
	}
	return out
}

func (a *API) series(c *gin.Context) {
	srv, _, ok := a.orgServer(c)
	if !ok {
		return
	}
	rng, err := metrics.ParseRange(c.DefaultQuery("range", string(metrics.Range1h)))
	if err != nil {
		invalid(c, "range must be one of live, 1h, 6h, 24h, 7d, 30d")
		return
	}
	s, err := a.Metrics.Series(c.Request.Context(), srv.ID, rng)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"range": s.Range, "step_seconds": s.StepSeconds, "from": s.From, "to": s.To,
		"points": nonNil(s.Points), "stats": s.Stats, "thresholds": a.thresholds(srv),
	})
}
