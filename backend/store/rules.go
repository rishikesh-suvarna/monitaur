package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type Rule struct {
	ID                 int64     `json:"id"`
	OrgID              int64     `json:"-"`
	Name               string    `json:"name"`
	Enabled            bool      `json:"enabled"`
	ScopeAll           bool      `json:"-"`
	ScopeServerIDs     []int64   `json:"-"`
	ScopeTags          []string  `json:"-"`
	Metric             string    `json:"metric"`
	Comparison         string    `json:"comparison"`
	Threshold          float64   `json:"threshold"`
	ForSeconds         int       `json:"for_seconds"`
	Severity           string    `json:"severity"`
	ChannelIDs         []int64   `json:"channel_ids"`
	CooldownSeconds    int       `json:"cooldown_seconds"`
	AutoResolveSeconds int       `json:"auto_resolve_seconds"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

const ruleColumns = `id, org_id, name, enabled, scope_all, scope_server_ids, scope_tags, metric, comparison,
	threshold, for_seconds, severity, channel_ids, cooldown_seconds, auto_resolve_seconds, created_at, updated_at`

func scanRule(row pgx.Row) (Rule, error) {
	var r Rule
	err := row.Scan(&r.ID, &r.OrgID, &r.Name, &r.Enabled, &r.ScopeAll, &r.ScopeServerIDs, &r.ScopeTags, &r.Metric,
		&r.Comparison, &r.Threshold, &r.ForSeconds, &r.Severity, &r.ChannelIDs, &r.CooldownSeconds,
		&r.AutoResolveSeconds, &r.CreatedAt, &r.UpdatedAt)
	r.normalize()
	return r, mapErr(err)
}

func (r *Rule) normalize() {
	if r.ScopeServerIDs == nil {
		r.ScopeServerIDs = []int64{}
	}
	if r.ScopeTags == nil {
		r.ScopeTags = []string{}
	}
	if r.ChannelIDs == nil {
		r.ChannelIDs = []int64{}
	}
}

func collectRules(rows pgx.Rows, err error) ([]Rule, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Rule
	for rows.Next() {
		r, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) ListAllRules(ctx context.Context) ([]Rule, error) {
	return collectRules(s.pool.Query(ctx, `SELECT `+ruleColumns+` FROM alert_rules ORDER BY org_id, id`))
}

func (s *Store) ListOrgRules(ctx context.Context, orgID int64) ([]Rule, error) {
	return collectRules(s.pool.Query(ctx, `SELECT `+ruleColumns+` FROM alert_rules WHERE org_id = $1 ORDER BY id`, orgID))
}

func (s *Store) GetRule(ctx context.Context, orgID, id int64) (Rule, error) {
	return scanRule(s.pool.QueryRow(ctx, `SELECT `+ruleColumns+` FROM alert_rules WHERE org_id = $1 AND id = $2`, orgID, id))
}

// CreateRules inserts rules for one org atomically, enforcing the plan limit.
func (s *Store) CreateRules(ctx context.Context, orgID int64, rules []Rule, maxRules int) ([]Rule, error) {
	var out []Rule
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, orgID); err != nil {
			return err
		}
		if !unlimited(maxRules) {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM alert_rules WHERE org_id = $1`, orgID).Scan(&n); err != nil {
				return err
			}
			if n+len(rules) > maxRules {
				return ErrLimitReached
			}
		}
		for _, r := range rules {
			r.normalize()
			created, err := scanRule(tx.QueryRow(ctx, `
INSERT INTO alert_rules (org_id, name, enabled, scope_all, scope_server_ids, scope_tags, metric, comparison,
	threshold, for_seconds, severity, channel_ids, cooldown_seconds, auto_resolve_seconds)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
RETURNING `+ruleColumns, orgID, r.Name, r.Enabled, r.ScopeAll, r.ScopeServerIDs, r.ScopeTags, r.Metric,
				r.Comparison, r.Threshold, r.ForSeconds, r.Severity, r.ChannelIDs, r.CooldownSeconds, r.AutoResolveSeconds))
			if err != nil {
				return err
			}
			out = append(out, created)
		}
		return nil
	})
	return out, err
}

// UpdateRule replaces every editable field (the API merges partial updates
// before calling).
func (s *Store) UpdateRule(ctx context.Context, r Rule) (Rule, error) {
	r.normalize()
	return scanRule(s.pool.QueryRow(ctx, `
UPDATE alert_rules SET name = $3, enabled = $4, scope_all = $5, scope_server_ids = $6, scope_tags = $7,
	metric = $8, comparison = $9, threshold = $10, for_seconds = $11, severity = $12, channel_ids = $13,
	cooldown_seconds = $14, auto_resolve_seconds = $15, updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING `+ruleColumns, r.OrgID, r.ID, r.Name, r.Enabled, r.ScopeAll, r.ScopeServerIDs, r.ScopeTags, r.Metric,
		r.Comparison, r.Threshold, r.ForSeconds, r.Severity, r.ChannelIDs, r.CooldownSeconds, r.AutoResolveSeconds))
}

func (s *Store) DeleteRule(ctx context.Context, orgID, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM alert_rules WHERE org_id = $1 AND id = $2`, orgID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
