// Package auth verifies Firebase ID tokens, resolves the caller's user and
// org membership (cached, so steady-state requests cost no DB queries) and
// enforces roles.
package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"backend/store"
)

const (
	identityTTL = 10 * time.Minute
	roleTTL     = 2 * time.Minute

	providerPassword = "password"
	orgHeader        = "X-Monitaur-Org"
	appCheckHeader   = "X-Firebase-AppCheck"

	ctxIdentity  = "auth.identity"
	ctxPrincipal = "auth.principal"
)

var ErrRevoked = errors.New("session revoked")

type Claims struct {
	UID           string
	Email         string
	Name          string
	Provider      string
	EmailVerified bool
	IssuedAt      time.Time
}

// Verifier is the Firebase surface the backend uses (faked in tests).
type Verifier interface {
	VerifyIDToken(ctx context.Context, token string) (Claims, error)
	TokensValidAfter(ctx context.Context, uid string) (time.Time, error)
	RevokeSessions(ctx context.Context, uid string) error
	DeleteUser(ctx context.Context, uid string) error
	VerifyAppCheck(token string) error
}

// UserStore is the subset of store.Store auth needs.
type UserStore interface {
	UpsertUser(ctx context.Context, uid, email, displayName string, verified bool) (store.User, error)
	EnsurePersonalOrg(ctx context.Context, userID int64, planID string) (store.Org, error)
	GetRole(ctx context.Context, orgID, userID int64) (store.Role, error)
}

type Identity struct {
	User          store.User
	Provider      string
	PersonalOrgID int64
}

type Principal struct {
	Identity
	OrgID int64
	Role  store.Role
}

type Config struct {
	DefaultPlan     string
	RequireAppCheck bool
	// OnPersonalOrg runs when a personal org without default rules/channels
	// is seen (first sign-in), outside any request lock.
	OnPersonalOrg func(ctx context.Context, org store.Org, owner store.User)
}

type Service struct {
	verifier Verifier
	users    UserStore
	cfg      Config
	log      *slog.Logger
	now      func() time.Time

	mu         sync.Mutex
	identities map[string]identityEntry // by Firebase UID
	roles      map[roleKey]roleEntry
}

type identityEntry struct {
	identity   Identity
	validAfter time.Time
	expires    time.Time
}

type roleKey struct{ orgID, userID int64 }

type roleEntry struct {
	role    store.Role
	ok      bool
	expires time.Time
}

func NewService(v Verifier, users UserStore, cfg Config, log *slog.Logger) *Service {
	return &Service{
		verifier: v, users: users, cfg: cfg, log: log, now: time.Now,
		identities: map[string]identityEntry{},
		roles:      map[roleKey]roleEntry{},
	}
}

// Error responses share one shape: {"error": "...", "code": "..."}.
func Abort(c *gin.Context, status int, code, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": msg, "code": code})
}

// Authenticate verifies the bearer token and loads (or creates) the user.
func (s *Service) Authenticate() gin.HandlerFunc {
	return func(c *gin.Context) {
		if s.cfg.RequireAppCheck {
			if err := s.verifier.VerifyAppCheck(c.GetHeader(appCheckHeader)); err != nil {
				Abort(c, http.StatusUnauthorized, "unauthorized", "app check failed")
				return
			}
		}
		raw, ok := bearer(c.GetHeader("Authorization"))
		if !ok {
			Abort(c, http.StatusUnauthorized, "unauthorized", "missing bearer token")
			return
		}
		claims, err := s.verifier.VerifyIDToken(c.Request.Context(), raw)
		if err != nil {
			Abort(c, http.StatusUnauthorized, "unauthorized", "invalid or expired token")
			return
		}
		// Password accounts must prove they own the address; Google accounts
		// arrive verified. Unverified users could otherwise claim invites.
		if claims.Provider == providerPassword && !claims.EmailVerified {
			Abort(c, http.StatusForbidden, "email_unverified", "verify your email address to continue")
			return
		}
		id, err := s.identity(c.Request.Context(), claims)
		if errors.Is(err, ErrRevoked) {
			Abort(c, http.StatusUnauthorized, "unauthorized", "session was signed out, sign in again")
			return
		}
		if err != nil {
			s.log.Error("resolve identity", "err", err)
			Abort(c, http.StatusServiceUnavailable, "unavailable", "could not load your account, retry shortly")
			return
		}
		c.Set(ctxIdentity, id)
		c.Next()
	}
}

func bearer(h string) (string, bool) {
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(h[len(prefix):]), true
}

func (s *Service) identity(ctx context.Context, claims Claims) (Identity, error) {
	now := s.now()
	s.mu.Lock()
	e, ok := s.identities[claims.UID]
	s.mu.Unlock()
	if ok && now.Before(e.expires) && e.identity.User.EmailVerified == claims.EmailVerified && e.identity.User.Email == claims.Email {
		if claims.IssuedAt.Before(e.validAfter) {
			return Identity{}, ErrRevoked
		}
		return e.identity, nil
	}

	validAfter, err := s.verifier.TokensValidAfter(ctx, claims.UID)
	if err != nil {
		return Identity{}, fmt.Errorf("tokens valid after: %w", err)
	}
	if claims.IssuedAt.Before(validAfter) {
		return Identity{}, ErrRevoked
	}
	user, err := s.users.UpsertUser(ctx, claims.UID, claims.Email, claims.Name, claims.EmailVerified)
	if err != nil {
		return Identity{}, err
	}
	org, err := s.users.EnsurePersonalOrg(ctx, user.ID, s.cfg.DefaultPlan)
	if err != nil {
		return Identity{}, err
	}
	if !org.DefaultsSeeded && s.cfg.OnPersonalOrg != nil {
		s.cfg.OnPersonalOrg(ctx, org, user)
	}
	id := Identity{User: user, Provider: claims.Provider, PersonalOrgID: org.ID}
	s.mu.Lock()
	s.identities[claims.UID] = identityEntry{identity: id, validAfter: validAfter, expires: now.Add(identityTTL)}
	s.mu.Unlock()
	return id, nil
}

// OrgContext resolves X-Monitaur-Org (default: personal org) and the role.
func (s *Service) OrgContext() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := MustIdentity(c)
		orgID := id.PersonalOrgID
		if h := c.GetHeader(orgHeader); h != "" {
			v, err := strconv.ParseInt(h, 10, 64)
			if err != nil || v <= 0 {
				Abort(c, http.StatusBadRequest, "invalid", "invalid "+orgHeader+" header")
				return
			}
			orgID = v
		}
		role, ok, err := s.role(c.Request.Context(), orgID, id.User.ID)
		if err != nil {
			s.log.Error("resolve role", "err", err)
			Abort(c, http.StatusServiceUnavailable, "unavailable", "could not load your organization")
			return
		}
		if !ok {
			// Not found, not forbidden: do not reveal which org IDs exist.
			Abort(c, http.StatusNotFound, "not_found", "organization not found")
			return
		}
		c.Set(ctxPrincipal, Principal{Identity: id, OrgID: orgID, Role: role})
		c.Next()
	}
}

func (s *Service) role(ctx context.Context, orgID, userID int64) (store.Role, bool, error) {
	now := s.now()
	key := roleKey{orgID, userID}
	s.mu.Lock()
	e, ok := s.roles[key]
	s.mu.Unlock()
	if ok && now.Before(e.expires) {
		return e.role, e.ok, nil
	}
	role, err := s.users.GetRole(ctx, orgID, userID)
	found := err == nil
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return "", false, err
	}
	s.mu.Lock()
	s.roles[key] = roleEntry{role: role, ok: found, expires: now.Add(roleTTL)}
	s.mu.Unlock()
	return role, found, nil
}

// RequireRole rejects callers below min in the current org.
func RequireRole(min store.Role) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !MustPrincipal(c).Role.AtLeast(min) {
			Abort(c, http.StatusForbidden, "forbidden", "your role in this organization does not allow this")
			return
		}
		c.Next()
	}
}

// InvalidateMembership drops a cached role after membership changes.
func (s *Service) InvalidateMembership(orgID, userID int64) {
	s.mu.Lock()
	delete(s.roles, roleKey{orgID, userID})
	s.mu.Unlock()
}

// InvalidateOrg drops every cached role for an org (deleted org).
func (s *Service) InvalidateOrg(orgID int64) {
	s.mu.Lock()
	for k := range s.roles {
		if k.orgID == orgID {
			delete(s.roles, k)
		}
	}
	s.mu.Unlock()
}

// InvalidateUser forces the next request to reload the user (revoke, delete,
// profile change).
func (s *Service) InvalidateUser(uid string) {
	s.mu.Lock()
	delete(s.identities, uid)
	s.mu.Unlock()
}

// UpdateCachedUser refreshes the cached copy after a profile edit.
func (s *Service) UpdateCachedUser(uid string, u store.User) {
	s.mu.Lock()
	if e, ok := s.identities[uid]; ok {
		e.identity.User = u
		s.identities[uid] = e
	}
	s.mu.Unlock()
}

func (s *Service) Verifier() Verifier { return s.verifier }

func MustIdentity(c *gin.Context) Identity { return c.MustGet(ctxIdentity).(Identity) }

func MustPrincipal(c *gin.Context) Principal { return c.MustGet(ctxPrincipal).(Principal) }
