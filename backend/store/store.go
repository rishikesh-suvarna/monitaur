// Package store holds every SQL statement in the backend. Hot paths (agent
// ingest, dashboard polling) never call it directly: they read in-memory
// state, and periodic writes happen in the metrics flush window (PLAN.md 2.3).
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"backend/secrets"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrLimitReached  = errors.New("plan limit reached")
	ErrConflict      = errors.New("already exists")
	ErrLastOwner     = errors.New("an organization needs at least one owner")
	ErrInviteInvalid = errors.New("invite is invalid, expired or for another email")
)

const pgUniqueViolation = "23505"

type Store struct {
	pool *pgxpool.Pool
	box  *secrets.Box
}

func New(pool *pgxpool.Pool, box *secrets.Box) *Store {
	return &Store{pool: pool, box: box}
}

// Ping is used by readiness checks only; /health never touches the DB.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

func (s *Store) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op after commit
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
		return fmt.Errorf("%w: %s", ErrConflict, pgErr.ConstraintName)
	}
	return err
}

// Role is an org membership role, ordered viewer < member < admin < owner.
type Role string

const (
	RoleViewer Role = "viewer"
	RoleMember Role = "member"
	RoleAdmin  Role = "admin"
	RoleOwner  Role = "owner"
)

var roleRank = map[Role]int{RoleViewer: 1, RoleMember: 2, RoleAdmin: 3, RoleOwner: 4}

func ParseRole(s string) (Role, error) {
	r := Role(strings.ToLower(s))
	if _, ok := roleRank[r]; !ok {
		return "", fmt.Errorf("unknown role %q", s)
	}
	return r, nil
}

func (r Role) AtLeast(min Role) bool { return roleRank[r] >= roleRank[min] }

// unlimited reports whether a plan limit of n means "no limit".
func unlimited(n int) bool { return n <= 0 }

func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}
