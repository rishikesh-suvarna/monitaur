// Package api is the HTTP surface: REST under /api/v1, the SSE stream, the
// public status page and the agent WebSocket endpoint. Reads come from the
// in-memory directory, metrics store and alerting engine; the database is
// touched only for user-initiated writes and history (docs/platform-v2.md).
package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"backend/alerting"
	"backend/auth"
	"backend/checks"
	"backend/config"
	"backend/directory"
	"backend/ingest"
	"backend/limits"
	"backend/metrics"
	"backend/notify"
	"backend/processes"
	"backend/store"
)

const (
	apiBurstDivisor   = 4
	minAPIBurst       = 10
	publicPerMinute   = 60
	publicBurst       = 20
	corsMaxAge        = 12 * time.Hour
	staleAfter        = 2 * time.Minute
	maxRequestBodyLen = 1 << 20
)

type Deps struct {
	Config     *config.Config
	Store      *store.Store
	Auth       *auth.Service
	Dir        *directory.Directory
	Metrics    *metrics.Store
	Processes  *processes.Store
	Engine     *alerting.Engine
	Dispatcher *notify.Dispatcher
	Hub        *ingest.Hub
	Broker     *Broker
	Limiter    *limits.RateLimiter
	Budget     *limits.EmailBudget
	Log        *slog.Logger
	Now        func() time.Time
	Checks     *checks.Scheduler
	// Silenced reports whether a maintenance window mutes a server or check
	// (0 for the one not concerned) at a time; app owns the evaluation so alerts
	// and the API agree. Nil means never.
	Silenced func(orgID, serverID, checkID int64, at time.Time) bool
}

type API struct {
	Deps
	statusMu    sync.Mutex
	statusCache map[string]cachedStatus
}

func New(d Deps) *API {
	if d.Now == nil {
		d.Now = time.Now
	}
	return &API{Deps: d, statusCache: map[string]cachedStatus{}}
}

func (a *API) Router() *gin.Engine {
	if a.Config.Server.Release {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(a.recovery(), a.requestLog(), limitBody())
	r.Use(cors.New(cors.Config{
		AllowOrigins:     a.Config.Server.Origins(),
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization", "X-Monitaur-Org", "X-Firebase-AppCheck"},
		ExposeHeaders:    []string{"Content-Disposition"},
		AllowCredentials: false,
		MaxAge:           corsMaxAge,
	}))

	// /health never touches the database, so uptime probes cannot keep Neon awake.
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "agents_connected": a.Hub.ConnectedCount()})
	})
	r.GET("/agent/connect", a.Hub.Handle)

	pub := r.Group("/api/v1/public", a.ipLimit(publicPerMinute, publicBurst))
	pub.GET("/status/:slug", a.publicStatus)

	v1 := r.Group("/api/v1", a.Auth.Authenticate(), a.userLimit())
	v1.GET("/me", a.getMe)
	v1.PATCH("/me", a.patchMe)
	v1.DELETE("/me", a.deleteMe)
	v1.POST("/me/sessions/revoke", a.revokeSessions)
	v1.POST("/invites/accept", a.acceptInvite)

	org := v1.Group("", a.Auth.OrgContext())
	viewer, member, admin, owner := auth.RequireRole(store.RoleViewer), auth.RequireRole(store.RoleMember),
		auth.RequireRole(store.RoleAdmin), auth.RequireRole(store.RoleOwner)

	org.GET("/stream", viewer, a.stream)
	org.GET("/export", admin, a.export)

	org.GET("/org", viewer, a.getOrg)
	org.PATCH("/org", admin, a.patchOrg)
	org.GET("/org/members", viewer, a.listMembers)
	org.POST("/org/invites", admin, a.createInvite)
	org.DELETE("/org/invites/:id", admin, a.deleteInvite)
	org.PATCH("/org/members/:userId", owner, a.patchMember)
	org.DELETE("/org/members/:userId", viewer, a.removeMember) // self-removal; admin checked inside

	org.GET("/servers", viewer, a.listServers)
	org.POST("/servers", member, a.createServer)
	org.GET("/servers/:id", viewer, a.getServer)
	org.PATCH("/servers/:id", member, a.patchServer)
	org.DELETE("/servers/:id", admin, a.deleteServer)
	org.POST("/servers/:id/token/rotate", admin, a.rotateToken)
	org.PUT("/servers/:id/pin", viewer, a.pinServer(true))
	org.DELETE("/servers/:id/pin", viewer, a.pinServer(false))
	org.GET("/servers/:id/series", viewer, a.series)
	org.GET("/servers/:id/processes", viewer, a.serverProcesses)

	org.GET("/incidents", viewer, a.listIncidents)
	org.POST("/incidents/:id/ack", member, a.ackIncident)
	org.POST("/incidents/:id/resolve", member, a.resolveIncident)

	org.GET("/rules", viewer, a.listRules)
	org.POST("/rules", member, a.createRule)
	org.POST("/rules/preview", viewer, a.previewRule)
	org.PATCH("/rules/:id", member, a.patchRule)
	org.DELETE("/rules/:id", member, a.deleteRule)

	org.GET("/channels", viewer, a.listChannels)
	org.POST("/channels", admin, a.createChannel)
	org.PATCH("/channels/:id", admin, a.patchChannel)
	org.DELETE("/channels/:id", admin, a.deleteChannel)
	org.POST("/channels/:id/test", member, a.testChannel)

	org.GET("/maintenance", viewer, a.listMaintenance)
	org.POST("/maintenance", member, a.createMaintenance)
	org.PATCH("/maintenance/:id", member, a.patchMaintenance)
	org.DELETE("/maintenance/:id", member, a.deleteMaintenance)
	org.GET("/checks", viewer, a.listChecks)
	org.POST("/checks", member, a.createCheck)
	org.PATCH("/checks/:id", member, a.patchCheck)
	org.DELETE("/checks/:id", member, a.deleteCheck)
	org.POST("/checks/:id/run", member, a.runCheck)
	org.GET("/checks/:id/results", viewer, a.checkResults)

	r.NoRoute(func(c *gin.Context) { fail(c, http.StatusNotFound, "not_found", "no such endpoint") })
	return r
}

// requestLog replaces gin's default logger, which prints query strings (v1
// agents put their token there).
func (a *API) requestLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		if c.Request.URL.Path == "/health" {
			return
		}
		a.Log.Info("http", "method", c.Request.Method, "path", c.Request.URL.Path, "status", c.Writer.Status(),
			"duration_ms", time.Since(start).Milliseconds())
	}
}

func (a *API) recovery() gin.HandlerFunc {
	return gin.CustomRecovery(func(c *gin.Context, err any) {
		a.Log.Error("panic in handler", "path", c.Request.URL.Path, "err", err)
		fail(c, http.StatusInternalServerError, "internal", "internal error")
	})
}

func limitBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxRequestBodyLen)
		c.Next()
	}
}

func (a *API) userLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := auth.MustIdentity(c)
		rpm := a.Dir.Plan(id.PersonalOrgID).APIRPM
		burst := max(rpm/apiBurstDivisor, minAPIBurst)
		if !a.Limiter.Allow("user:"+strconv.FormatInt(id.User.ID, 10), rpm, burst) {
			fail(c, http.StatusTooManyRequests, "rate_limited", "too many requests, slow down")
			return
		}
		c.Next()
	}
}

func (a *API) ipLimit(perMinute, burst int) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !a.Limiter.Allow("ip:"+c.ClientIP(), perMinute, burst) {
			fail(c, http.StatusTooManyRequests, "rate_limited", "too many requests")
			return
		}
		c.Next()
	}
}

func fail(c *gin.Context, status int, code, msg string) { auth.Abort(c, status, code, msg) }

// handleErr maps store errors to the API error shape.
func (a *API) handleErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		fail(c, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, store.ErrLimitReached):
		fail(c, http.StatusForbidden, "limit_reached", "your plan's limit is reached")
	case errors.Is(err, store.ErrConflict):
		fail(c, http.StatusConflict, "conflict", "that already exists or changed meanwhile")
	case errors.Is(err, store.ErrLastOwner):
		fail(c, http.StatusConflict, "conflict", err.Error())
	case errors.Is(err, store.ErrInviteInvalid):
		fail(c, http.StatusBadRequest, "invalid", err.Error())
	default:
		a.Log.Error("request failed", "path", c.Request.URL.Path, "err", err)
		fail(c, http.StatusInternalServerError, "internal", "something went wrong, retry shortly")
	}
}

func invalid(c *gin.Context, msg string) { fail(c, http.StatusBadRequest, "invalid", msg) }

func pathID(c *gin.Context, name string) (int64, bool) {
	id, err := strconv.ParseInt(c.Param(name), 10, 64)
	if err != nil || id <= 0 {
		invalid(c, "invalid "+name)
		return 0, false
	}
	return id, true
}

func bind(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		invalid(c, "invalid JSON body")
		return false
	}
	return true
}
