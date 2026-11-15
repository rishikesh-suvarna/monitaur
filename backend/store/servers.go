package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type Server struct {
	ID                 int64      `json:"id"`
	OrgID              int64      `json:"-"`
	Name               string     `json:"name"`
	Tags               []string   `json:"tags"`
	TokenHash          string     `json:"-"`
	TokenPrefix        string     `json:"-"`
	TokenCreatedAt     time.Time  `json:"-"`
	TokenLastUsedAt    *time.Time `json:"-"`
	PrevTokenHash      *string    `json:"-"`
	PrevTokenExpiresAt *time.Time `json:"-"`
	LastSeen           *time.Time `json:"last_seen"`
	AgentVersion       string     `json:"agent_version"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"-"`
}

const serverColumns = `id, org_id, name, tags, token_hash, token_prefix, COALESCE(token_created_at, created_at),
	token_last_used_at, prev_token_hash, prev_token_expires_at, last_seen, agent_version, created_at, updated_at`

func scanServer(row pgx.Row) (Server, error) {
	var s Server
	err := row.Scan(&s.ID, &s.OrgID, &s.Name, &s.Tags, &s.TokenHash, &s.TokenPrefix, &s.TokenCreatedAt,
		&s.TokenLastUsedAt, &s.PrevTokenHash, &s.PrevTokenExpiresAt, &s.LastSeen, &s.AgentVersion, &s.CreatedAt, &s.UpdatedAt)
	if s.Tags == nil {
		s.Tags = []string{}
	}
	return s, mapErr(err)
}

func collectServers(rows pgx.Rows, err error) ([]Server, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Server
	for rows.Next() {
		s, err := scanServer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ListAllServers loads the in-memory directory at startup (one query).
func (s *Store) ListAllServers(ctx context.Context) ([]Server, error) {
	return collectServers(s.pool.Query(ctx, `SELECT `+serverColumns+` FROM servers ORDER BY id`))
}

func (s *Store) ListOrgServers(ctx context.Context, orgID int64) ([]Server, error) {
	return collectServers(s.pool.Query(ctx, `SELECT `+serverColumns+` FROM servers WHERE org_id = $1 ORDER BY name`, orgID))
}

type NewServer struct {
	OrgID       int64
	CreatedBy   int64
	Name        string
	Tags        []string
	TokenHash   string
	TokenPrefix string
}

// CreateServer locks the org row so concurrent creates cannot exceed the plan.
func (s *Store) CreateServer(ctx context.Context, in NewServer, maxServers int) (Server, error) {
	var srv Server
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, in.OrgID); err != nil {
			return err
		}
		if !unlimited(maxServers) {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM servers WHERE org_id = $1`, in.OrgID).Scan(&n); err != nil {
				return err
			}
			if n >= maxServers {
				return ErrLimitReached
			}
		}
		tags := in.Tags
		if tags == nil {
			tags = []string{}
		}
		var err error
		srv, err = scanServer(tx.QueryRow(ctx, `
INSERT INTO servers (org_id, created_by, name, tags, token_hash, token_prefix, token_created_at, status, created_at, updated_at)
VALUES ($1, NULLIF($2, 0), $3, $4, $5, $6, now(), 'offline', now(), now())
RETURNING `+serverColumns, in.OrgID, in.CreatedBy, in.Name, tags, in.TokenHash, in.TokenPrefix))
		return err
	})
	return srv, err
}

// UpdateServer changes name and/or tags; nil leaves a field untouched.
func (s *Store) UpdateServer(ctx context.Context, orgID, id int64, name *string, tags []string) (Server, error) {
	return scanServer(s.pool.QueryRow(ctx, `
UPDATE servers SET
	name = COALESCE($3, name),
	tags = COALESCE($4, tags),
	updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING `+serverColumns, orgID, id, name, tags))
}

// DeleteServer cascades metrics, incidents and pins, and removes the server
// from rule scopes and the status page.
func (s *Store) DeleteServer(ctx context.Context, orgID, id int64) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM servers WHERE org_id = $1 AND id = $2`, orgID, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, err := tx.Exec(ctx, `
UPDATE alert_rules SET scope_server_ids = array_remove(scope_server_ids, $2), updated_at = now()
WHERE org_id = $1 AND $2 = ANY(scope_server_ids)`, orgID, id); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
UPDATE organizations SET status_page_server_ids = array_remove(status_page_server_ids, $2)
WHERE id = $1 AND $2 = ANY(status_page_server_ids)`, orgID, id)
		return err
	})
}

// RotateToken keeps the old token valid for grace so agents can be updated
// without a gap in data.
func (s *Store) RotateToken(ctx context.Context, orgID, id int64, newHash, newPrefix string, grace time.Duration) (Server, error) {
	return scanServer(s.pool.QueryRow(ctx, `
UPDATE servers SET
	prev_token_hash = token_hash,
	prev_token_expires_at = $5,
	token_hash = $3,
	token_prefix = $4,
	token_created_at = now(),
	token_last_used_at = NULL,
	updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING `+serverColumns, orgID, id, newHash, newPrefix, time.Now().Add(grace)))
}

// ServerTouch carries per-server activity gathered in memory between flushes.
type ServerTouch struct {
	ID           int64
	LastSeen     time.Time // zero: unchanged
	TokenUsedAt  time.Time // zero: unchanged
	AgentVersion string    // empty: unchanged
}

// TouchServers is the flush-window batch update replacing v1's three writes
// per agent message (PLAN.md 2.1).
func (s *Store) TouchServers(ctx context.Context, touches []ServerTouch) error {
	if len(touches) == 0 {
		return nil
	}
	ids := make([]int64, len(touches))
	seen := make([]time.Time, len(touches))
	used := make([]time.Time, len(touches))
	versions := make([]string, len(touches))
	for i, t := range touches {
		ids[i], seen[i], used[i], versions[i] = t.ID, t.LastSeen, t.TokenUsedAt, t.AgentVersion
	}
	_, err := s.pool.Exec(ctx, `
UPDATE servers s SET
	last_seen = CASE WHEN v.seen > 'epoch' THEN GREATEST(COALESCE(s.last_seen, v.seen), v.seen) ELSE s.last_seen END,
	token_last_used_at = CASE WHEN v.used > 'epoch' THEN v.used ELSE s.token_last_used_at END,
	agent_version = CASE WHEN v.ver <> '' THEN v.ver ELSE s.agent_version END
FROM unnest($1::bigint[], $2::timestamptz[], $3::timestamptz[], $4::text[]) AS v(id, seen, used, ver)
WHERE s.id = v.id`, ids, seen, used, versions)
	return err
}

func (s *Store) ListPins(ctx context.Context, userID int64) ([]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT server_id FROM server_pins WHERE user_id = $1 ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[int64])
}

func (s *Store) SetPin(ctx context.Context, userID, serverID int64, pinned bool) error {
	if pinned {
		_, err := s.pool.Exec(ctx, `INSERT INTO server_pins (user_id, server_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, userID, serverID)
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM server_pins WHERE user_id = $1 AND server_id = $2`, userID, serverID)
	return err
}

type ServerCounts struct {
	Incidents   int `json:"incidents"`
	MetricsDays int `json:"metrics_days"`
}

func (s *Store) ServerCounts(ctx context.Context, serverID int64) (ServerCounts, error) {
	var c ServerCounts
	err := s.pool.QueryRow(ctx, `
SELECT (SELECT count(*) FROM incidents WHERE server_id = $1),
       (SELECT count(*) FROM uptime_daily WHERE server_id = $1)`, serverID).Scan(&c.Incidents, &c.MetricsDays)
	return c, err
}
