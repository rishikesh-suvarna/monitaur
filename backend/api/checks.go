package api

import (
	"context"
	"errors"
	"math"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend/auth"
	"backend/checks"
	"backend/notify"
	"backend/store"
)

const (
	eventChecks = "checks"

	maxCheckNameLen             = 60
	maxCheckTargetLen           = 2048
	maxKeywordLen               = 200
	defaultCheckIntervalSeconds = 60
	maxCheckIntervalSeconds     = 24 * 60 * 60
	// minCheckIntervalFloorSeconds applies even when a plan sets no minimum
	// (0), so no check can probe its target every second.
	minCheckIntervalFloorSeconds = 10
	defaultCheckTimeoutSeconds   = 10
	minCheckTimeoutSeconds       = 1
	maxCheckTimeoutSeconds       = 30
	defaultTLSWarnDays           = 14
	maxTLSWarnDays               = 365
	defaultTLSPort               = "443"
	minHTTPStatus                = 100
	maxHTTPStatus                = 599
	maxPort                      = 65535
	maxHostLen                   = 253
	// Run-now probes reach out to tenant targets on demand; cap them per org
	// so the endpoint cannot be used as a traffic generator.
	checkRunsPerMinute = 6
	checkRunBurst      = 3
	checkRunTimeout    = (maxCheckTimeoutSeconds + 5) * time.Second
	latencyDecimals    = 10 // latency is reported to 0.1 ms
)

// hostnamePattern accepts DNS names (labels of letters, digits, '-' and '_',
// optional trailing dot).
var hostnamePattern = regexp.MustCompile(`^([A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)*[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.?$`)

// CheckToScheduler converts a stored check for the scheduler.
func CheckToScheduler(c store.Check) checks.Check {
	return checks.Check{
		ID: c.ID, OrgID: c.OrgID, Name: c.Name, Type: checks.Type(c.Type), Target: c.Target,
		Interval: time.Duration(c.IntervalSeconds) * time.Second, Timeout: time.Duration(c.TimeoutSeconds) * time.Second,
		ExpectStatus: c.ExpectStatus, Keyword: c.Keyword, TLSWarnDays: c.TLSWarnDays, Enabled: c.Enabled,
		ChannelIDs: slices.Clone(c.ChannelIDs),
	}
}

func ChecksToScheduler(cs []store.Check) []checks.Check {
	out := make([]checks.Check, 0, len(cs))
	for _, c := range cs {
		out = append(out, CheckToScheduler(c))
	}
	return out
}

type checkResultJSON struct {
	At         time.Time `json:"at"`
	OK         bool      `json:"ok"`
	LatencyMS  float64   `json:"latency_ms"`
	StatusCode *int      `json:"status_code"`
	Error      *string   `json:"error"`
}

func toCheckResultJSON(r checks.Result) checkResultJSON {
	out := checkResultJSON{At: r.At.UTC(), OK: r.OK, LatencyMS: roundLatency(float64(r.Latency) / float64(time.Millisecond))}
	if r.StatusCode != 0 {
		code := r.StatusCode
		out.StatusCode = &code
	}
	if r.Error != "" {
		e := r.Error
		out.Error = &e
	}
	return out
}

func roundLatency(ms float64) float64 { return math.Round(ms*latencyDecimals) / latencyDecimals }

type checkJSON struct {
	ID              int64            `json:"id"`
	Name            string           `json:"name"`
	Type            string           `json:"type"`
	Target          string           `json:"target"`
	IntervalSeconds int              `json:"interval_seconds"`
	TimeoutSeconds  int              `json:"timeout_seconds"`
	ExpectStatus    int              `json:"expect_status"`
	Keyword         string           `json:"keyword"`
	TLSWarnDays     int              `json:"tls_warn_days"`
	Enabled         bool             `json:"enabled"`
	ChannelIDs      []int64          `json:"channel_ids"`
	Status          string           `json:"status"`
	Last            *checkResultJSON `json:"last"`
	Uptime24h       *float64         `json:"uptime_24h"`
	LatencySpark    []float64        `json:"latency_spark"`
	TLSDaysLeft     *int             `json:"tls_days_left"`
	OpenIncidents   int              `json:"open_incidents"`
	Maintenance     bool             `json:"maintenance"`
	CreatedAt       time.Time        `json:"created_at"`
}

// liveCheckJSON is the slimmer per-check payload pushed over SSE every 3 s.
type liveCheckJSON struct {
	ID          int64            `json:"id"`
	Status      string           `json:"status"`
	Last        *checkResultJSON `json:"last"`
	Uptime24h   *float64         `json:"uptime_24h"`
	TLSDaysLeft *int             `json:"tls_days_left"`
	Maintenance bool             `json:"maintenance"`
}

func (a *API) silenced(orgID, serverID, checkID int64, at time.Time) bool {
	return a.Silenced != nil && a.Silenced(orgID, serverID, checkID, at)
}

// snapshotOr falls back to "pending" for a check the scheduler has not
// picked up yet (or "paused" when disabled), so the API never shows a gap.
func snapshotOr(snaps map[int64]checks.Snapshot, c store.Check) checks.Snapshot {
	if s, ok := snaps[c.ID]; ok {
		return s
	}
	st := checks.StatusPending
	if !c.Enabled {
		st = checks.StatusPaused
	}
	return checks.Snapshot{Status: st, LatencySpark: []float64{}}
}

func (a *API) checkJSONs(orgID int64, cs []store.Check) []checkJSON {
	ids := make([]int64, len(cs))
	for i, c := range cs {
		ids[i] = c.ID
	}
	snaps := a.Checks.Snapshots(ids)
	now := a.Now()
	out := make([]checkJSON, 0, len(cs))
	for _, c := range cs {
		snap := snapshotOr(snaps, c)
		j := checkJSON{
			ID: c.ID, Name: c.Name, Type: c.Type, Target: c.Target, IntervalSeconds: c.IntervalSeconds,
			TimeoutSeconds: c.TimeoutSeconds, ExpectStatus: c.ExpectStatus, Keyword: c.Keyword, TLSWarnDays: c.TLSWarnDays,
			Enabled: c.Enabled, ChannelIDs: nonNil(c.ChannelIDs), Status: string(snap.Status), Uptime24h: snap.Uptime24h,
			LatencySpark: make([]float64, 0, len(snap.LatencySpark)), TLSDaysLeft: snap.TLSDaysLeft,
			OpenIncidents: snap.OpenIncidents, Maintenance: a.silenced(orgID, 0, c.ID, now), CreatedAt: c.CreatedAt,
		}
		for _, ms := range snap.LatencySpark {
			j.LatencySpark = append(j.LatencySpark, roundLatency(ms))
		}
		if snap.Last != nil {
			last := toCheckResultJSON(*snap.Last)
			j.Last = &last
		}
		out = append(out, j)
	}
	return out
}

func (a *API) liveChecks(orgID int64) []liveCheckJSON {
	full := a.checkJSONs(orgID, a.Dir.OrgChecks(orgID))
	out := make([]liveCheckJSON, 0, len(full))
	for _, c := range full {
		out = append(out, liveCheckJSON{ID: c.ID, Status: c.Status, Last: c.Last, Uptime24h: c.Uptime24h,
			TLSDaysLeft: c.TLSDaysLeft, Maintenance: c.Maintenance})
	}
	return out
}

// checkInput is the create/patch body; pointers distinguish "absent" in PATCH.
type checkInput struct {
	Name            *string `json:"name"`
	Type            *string `json:"type"`
	Target          *string `json:"target"`
	IntervalSeconds *int    `json:"interval_seconds"`
	TimeoutSeconds  *int    `json:"timeout_seconds"`
	ExpectStatus    *int    `json:"expect_status"`
	Keyword         *string `json:"keyword"`
	TLSWarnDays     *int    `json:"tls_warn_days"`
	Enabled         *bool   `json:"enabled"`
	ChannelIDs      []int64 `json:"channel_ids"`
}

func (in checkInput) apply(c store.Check) store.Check {
	if in.Name != nil {
		c.Name = strings.TrimSpace(*in.Name)
	}
	if in.Type != nil {
		c.Type = strings.ToLower(strings.TrimSpace(*in.Type))
	}
	if in.Target != nil {
		c.Target = strings.TrimSpace(*in.Target)
	}
	if in.IntervalSeconds != nil {
		c.IntervalSeconds = *in.IntervalSeconds
	}
	if in.TimeoutSeconds != nil {
		c.TimeoutSeconds = *in.TimeoutSeconds
	}
	if in.ExpectStatus != nil {
		c.ExpectStatus = *in.ExpectStatus
	}
	if in.Keyword != nil {
		c.Keyword = *in.Keyword
	}
	if in.TLSWarnDays != nil {
		c.TLSWarnDays = *in.TLSWarnDays
	}
	if in.Enabled != nil {
		c.Enabled = *in.Enabled
	}
	if in.ChannelIDs != nil {
		c.ChannelIDs = in.ChannelIDs
	}
	return c
}

// validateCheck normalizes c in place (target form, http-only fields,
// channel list) and returns a message for the first invalid field.
func (a *API) validateCheck(orgID int64, c *store.Check) string {
	if n := len([]rune(c.Name)); n == 0 || n > maxCheckNameLen {
		return "name must be 1 to 60 characters"
	}
	typ, err := checks.ParseType(c.Type)
	if err != nil {
		return "type must be http, tcp or tls"
	}
	target, msg := a.normalizeTarget(typ, c.Target)
	if msg != "" {
		return msg
	}
	c.Target = target
	minInterval := max(a.Dir.Plan(orgID).MinCheckIntervalSeconds, minCheckIntervalFloorSeconds)
	if c.IntervalSeconds < minInterval || c.IntervalSeconds > maxCheckIntervalSeconds {
		return "interval_seconds must be between " + strconv.Itoa(minInterval) +
			" (your plan's minimum) and " + strconv.Itoa(maxCheckIntervalSeconds)
	}
	if c.TimeoutSeconds < minCheckTimeoutSeconds || c.TimeoutSeconds > maxCheckTimeoutSeconds {
		return "timeout_seconds must be between 1 and 30"
	}
	if c.TimeoutSeconds > c.IntervalSeconds {
		return "timeout_seconds must not exceed interval_seconds"
	}
	if typ == checks.TypeHTTP {
		if c.ExpectStatus != 0 && (c.ExpectStatus < minHTTPStatus || c.ExpectStatus > maxHTTPStatus) {
			return "expect_status must be 0 (any 2xx or 3xx) or an HTTP status from 100 to 599"
		}
		if len([]rune(c.Keyword)) > maxKeywordLen {
			return "keyword must be at most 200 characters"
		}
	} else {
		// Only http checks look at status and body; clearing keeps a type
		// change from carrying over settings that no longer apply.
		c.ExpectStatus, c.Keyword = 0, ""
	}
	if c.TLSWarnDays < 0 || c.TLSWarnDays > maxTLSWarnDays {
		return "tls_warn_days must be between 0 (no warning) and 365"
	}
	chs := a.Dir.OrgChannels(orgID)
	ids := make([]int64, 0, len(c.ChannelIDs))
	for _, id := range c.ChannelIDs {
		if !slices.ContainsFunc(chs, func(ch store.Channel) bool { return ch.ID == id }) {
			return "check routes to a channel that is not in this organization"
		}
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	c.ChannelIDs = ids
	return ""
}

// normalizeTarget validates the target for the type. Literal private and
// loopback addresses are refused here for a clear error; hostnames are
// enforced at dial time by the SSRF guard (after DNS resolution).
func (a *API) normalizeTarget(typ checks.Type, raw string) (string, string) {
	if raw == "" || len(raw) > maxCheckTargetLen || strings.ContainsAny(raw, " \t\r\n") {
		return "", "target is required and must not contain spaces"
	}
	switch typ {
	case checks.TypeHTTP:
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
			return "", "http targets must be an http:// or https:// URL"
		}
		if u.User != nil {
			return "", "http targets must not contain credentials"
		}
		if p := u.Port(); p != "" && !validPort(p) {
			return "", "target port must be between 1 and 65535"
		}
		if msg := a.checkHost(u.Hostname()); msg != "" {
			return "", msg
		}
		return raw, ""
	case checks.TypeTCP, checks.TypeTLS:
		if strings.Contains(raw, "://") || strings.ContainsAny(raw, "/?#@") {
			return "", "tcp and tls targets must be host:port"
		}
		host, port, err := net.SplitHostPort(raw)
		if err != nil {
			if typ != checks.TypeTLS {
				return "", "tcp targets must be host:port"
			}
			host, port = strings.TrimSuffix(strings.TrimPrefix(raw, "["), "]"), defaultTLSPort
		}
		if !validPort(port) {
			return "", "target port must be between 1 and 65535"
		}
		if msg := a.checkHost(host); msg != "" {
			return "", msg
		}
		return net.JoinHostPort(host, port), ""
	default:
		return "", "type must be http, tcp or tls"
	}
}

func validPort(p string) bool {
	n, err := strconv.Atoi(p)
	return err == nil && n >= 1 && n <= maxPort
}

func (a *API) checkHost(host string) string {
	addr, ipErr := netip.ParseAddr(host)
	if host == "" || len(host) > maxHostLen || (ipErr != nil && !hostnamePattern.MatchString(host)) {
		return "target host must be a hostname or IP address"
	}
	if a.Config.Checks.AllowPrivateTargets {
		return ""
	}
	lower := strings.ToLower(strings.TrimSuffix(host, "."))
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") || (ipErr == nil && notify.IsBlockedIP(addr)) {
		return "target must be a public address (private, loopback and link-local targets are disabled)"
	}
	return ""
}

func (a *API) orgCheck(c *gin.Context) (store.Check, auth.Principal, bool) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return store.Check{}, p, false
	}
	chk, ok := a.Dir.OrgCheck(p.OrgID, id)
	if !ok {
		fail(c, http.StatusNotFound, "not_found", "check not found")
		return store.Check{}, p, false
	}
	return chk, p, true
}

func (a *API) listChecks(c *gin.Context) {
	p := auth.MustPrincipal(c)
	c.JSON(http.StatusOK, gin.H{"checks": a.checkJSONs(p.OrgID, a.Dir.OrgChecks(p.OrgID))})
}

func (a *API) createCheck(c *gin.Context) {
	p := auth.MustPrincipal(c)
	var in checkInput
	if !bind(c, &in) {
		return
	}
	plan := a.Dir.Plan(p.OrgID)
	interval := max(defaultCheckIntervalSeconds, plan.MinCheckIntervalSeconds)
	if in.IntervalSeconds != nil {
		interval = *in.IntervalSeconds
	}
	chk := in.apply(store.Check{
		OrgID: p.OrgID, IntervalSeconds: interval, TimeoutSeconds: min(defaultCheckTimeoutSeconds, max(interval, 1)),
		TLSWarnDays: defaultTLSWarnDays, Enabled: true,
	})
	if msg := a.validateCheck(p.OrgID, &chk); msg != "" {
		invalid(c, msg)
		return
	}
	ctx := c.Request.Context()
	created, err := a.Store.CreateCheck(ctx, chk, plan.MaxChecks)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	a.Dir.PutCheck(created)
	a.Checks.Upsert(ctx, CheckToScheduler(created))
	c.JSON(http.StatusCreated, gin.H{"check": a.checkJSONs(p.OrgID, []store.Check{created})[0]})
}

func (a *API) patchCheck(c *gin.Context) {
	current, p, ok := a.orgCheck(c)
	if !ok {
		return
	}
	var in checkInput
	if !bind(c, &in) {
		return
	}
	next := in.apply(current)
	if msg := a.validateCheck(p.OrgID, &next); msg != "" {
		invalid(c, msg)
		return
	}
	ctx := c.Request.Context()
	updated, err := a.Store.UpdateCheck(ctx, next)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	a.Dir.PutCheck(updated)
	if a.Checks.Upsert(ctx, CheckToScheduler(updated)) {
		// Re-targeting or pausing closed open incidents without a notifier
		// event; tell live clients to refetch.
		a.Broker.Publish(p.OrgID, eventIncident, map[string]string{"action": "refresh"})
	}
	if org, ok := a.Dir.Org(p.OrgID); ok && slices.Contains(org.StatusPage.CheckIDs, updated.ID) {
		a.invalidateStatus(org.Slug)
	}
	c.JSON(http.StatusOK, gin.H{"check": a.checkJSONs(p.OrgID, []store.Check{updated})[0]})
}

func (a *API) deleteCheck(c *gin.Context) {
	chk, p, ok := a.orgCheck(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	if err := a.Store.DeleteCheck(ctx, p.OrgID, chk.ID); err != nil {
		a.handleErr(c, err)
		return
	}
	a.Dir.RemoveCheck(p.OrgID, chk.ID)
	a.Checks.Remove(chk.ID)
	// The status page dropped the check in the same transaction, and its
	// incidents were deleted with it.
	if org, err := a.Store.GetOrg(ctx, p.OrgID); err == nil {
		a.Dir.PutOrg(org)
		a.invalidateStatus(org.Slug)
	}
	a.Broker.Publish(p.OrgID, eventIncident, map[string]string{"action": "refresh"})
	c.Status(http.StatusNoContent)
}

func (a *API) runCheck(c *gin.Context) {
	chk, p, ok := a.orgCheck(c)
	if !ok {
		return
	}
	if !a.Limiter.Allow("check-run:"+strconv.FormatInt(p.OrgID, 10), checkRunsPerMinute, checkRunBurst) {
		fail(c, http.StatusTooManyRequests, "rate_limited", "wait a minute before running checks again")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), checkRunTimeout)
	defer cancel()
	res, err := a.Checks.RunNow(ctx, chk.ID)
	if errors.Is(err, checks.ErrNotFound) {
		fail(c, http.StatusNotFound, "not_found", "check not found")
		return
	}
	if err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"result": toCheckResultJSON(res)})
}

func (a *API) checkResults(c *gin.Context) {
	chk, _, ok := a.orgCheck(c)
	if !ok {
		return
	}
	rng, err := checks.ParseRange(c.DefaultQuery("range", string(checks.Range24h)))
	if err != nil {
		invalid(c, "range must be one of 24h, 7d, 30d")
		return
	}
	series, err := a.Checks.Results(c.Request.Context(), chk.ID, rng)
	if errors.Is(err, checks.ErrNotFound) {
		fail(c, http.StatusNotFound, "not_found", "check not found")
		return
	}
	if err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"range": series.Range, "step_seconds": series.StepSeconds, "points": nonNil(series.Points)})
}

// reloadOrgChecks refreshes the directory and scheduler after a change that
// rewrote the org's checks in the database (a deleted channel).
func (a *API) reloadOrgChecks(ctx context.Context, orgID int64) error {
	cs, err := a.Store.ListOrgChecks(ctx, orgID)
	if err != nil {
		return err
	}
	a.Dir.SetOrgChecks(orgID, cs)
	for _, chk := range cs {
		a.Checks.Upsert(ctx, CheckToScheduler(chk))
	}
	return nil
}
