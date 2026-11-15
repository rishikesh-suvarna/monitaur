package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Incident struct {
	ID               int64      `json:"id"`
	OrgID            int64      `json:"-"`
	ServerID         int64      `json:"server_id"`
	ServerName       string     `json:"server_name"`
	RuleID           *int64     `json:"rule_id"`
	RuleName         string     `json:"rule_name"`
	Metric           string     `json:"metric"`
	Severity         string     `json:"severity"`
	Threshold        float64    `json:"threshold"`
	Peak             float64    `json:"peak"`
	LastValue        float64    `json:"last_value"`
	SamplesOver      int        `json:"samples_over"`
	StartedAt        time.Time  `json:"started_at"`
	ResolvedAt       *time.Time `json:"resolved_at"`
	ResolvedHow      *string    `json:"resolved_how"`
	AckedAt          *time.Time `json:"acked_at"`
	AckedBy          *string    `json:"acked_by"`
	LastNotifiedAt   *time.Time `json:"last_notified_at"`
	NotifiedChannels []string   `json:"notified_channels"`
}

func (i Incident) State() string {
	switch {
	case i.ResolvedAt != nil:
		return "resolved"
	case i.AckedAt != nil:
		return "acked"
	default:
		return "open"
	}
}

const incidentColumns = `i.id, i.org_id, i.server_id, s.name, i.rule_id, i.rule_name, i.metric, i.severity, i.threshold,
	i.peak, i.last_value, i.samples_over, i.started_at, i.resolved_at, i.resolved_how, i.acked_at,
	NULLIF(COALESCE(NULLIF(u.display_name, ''), u.email), ''), i.last_notified_at, i.notified_channels`

const incidentFrom = ` FROM incidents i JOIN servers s ON s.id = i.server_id LEFT JOIN users u ON u.id = i.acked_by `

func scanIncident(row pgx.Row) (Incident, error) {
	var i Incident
	err := row.Scan(&i.ID, &i.OrgID, &i.ServerID, &i.ServerName, &i.RuleID, &i.RuleName, &i.Metric, &i.Severity,
		&i.Threshold, &i.Peak, &i.LastValue, &i.SamplesOver, &i.StartedAt, &i.ResolvedAt, &i.ResolvedHow,
		&i.AckedAt, &i.AckedBy, &i.LastNotifiedAt, &i.NotifiedChannels)
	if i.NotifiedChannels == nil {
		i.NotifiedChannels = []string{}
	}
	return i, mapErr(err)
}

func collectIncidents(rows pgx.Rows, err error) ([]Incident, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Incident
	for rows.Next() {
		i, err := scanIncident(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

type NewIncident struct {
	OrgID, ServerID int64
	RuleID          int64
	RuleName        string
	Metric          string
	Severity        string
	Threshold       float64
	Peak            float64
	LastValue       float64
	SamplesOver     int
	StartedAt       time.Time
}

func (s *Store) OpenIncident(ctx context.Context, in NewIncident) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `
INSERT INTO incidents (org_id, server_id, rule_id, rule_name, metric, severity, threshold, peak, last_value, samples_over, started_at)
SELECT $1, $2, NULLIF($3, 0), $4, $5, $6, $7, $8, $9, $10, $11
WHERE EXISTS (SELECT 1 FROM servers WHERE id = $2)
RETURNING id`, in.OrgID, in.ServerID, in.RuleID, in.RuleName, in.Metric, in.Severity, in.Threshold, in.Peak, in.LastValue,
		max(in.SamplesOver, 1), in.StartedAt).Scan(&id)
	return id, mapErr(err)
}

func (s *Store) ResolveIncident(ctx context.Context, id int64, at time.Time, how string, peak float64, samplesOver int, by *int64) error {
	_, err := s.pool.Exec(ctx, `
UPDATE incidents SET resolved_at = $2, resolved_how = $3, peak = $4, samples_over = $5, resolved_by = $6
WHERE id = $1 AND resolved_at IS NULL`, id, at, how, peak, samplesOver, by)
	return err
}

func (s *Store) SaveIncidentProgress(ctx context.Context, id int64, peak, lastValue float64, samplesOver int, lastNotifiedAt *time.Time) error {
	_, err := s.pool.Exec(ctx, `
UPDATE incidents SET peak = $2, last_value = $3, samples_over = $4, last_notified_at = COALESCE($5, last_notified_at)
WHERE id = $1 AND resolved_at IS NULL`, id, peak, lastValue, samplesOver, lastNotifiedAt)
	return err
}

func (s *Store) AppendNotified(ctx context.Context, id int64, channelNames []string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `
UPDATE incidents SET
	notified_channels = ARRAY(SELECT DISTINCT unnest(notified_channels || $2::text[]) ORDER BY 1),
	last_notified_at = $3
WHERE id = $1`, id, channelNames, at)
	return err
}

// LoadOpenIncidents restores the alerting engine after a restart.
func (s *Store) LoadOpenIncidents(ctx context.Context) ([]Incident, error) {
	return collectIncidents(s.pool.Query(ctx, `SELECT `+incidentColumns+incidentFrom+`WHERE i.resolved_at IS NULL ORDER BY i.id`))
}

func (s *Store) GetIncident(ctx context.Context, orgID, id int64) (Incident, error) {
	return scanIncident(s.pool.QueryRow(ctx, `SELECT `+incidentColumns+incidentFrom+`WHERE i.org_id = $1 AND i.id = $2`, orgID, id))
}

func (s *Store) AckIncident(ctx context.Context, orgID, id, userID int64, at time.Time) (Incident, error) {
	tag, err := s.pool.Exec(ctx, `
UPDATE incidents SET acked_at = $4, acked_by = $3
WHERE org_id = $1 AND id = $2 AND acked_at IS NULL AND resolved_at IS NULL`, orgID, id, userID, at)
	if err != nil {
		return Incident{}, err
	}
	inc, err := s.GetIncident(ctx, orgID, id)
	if err != nil {
		return inc, err
	}
	if tag.RowsAffected() == 0 && inc.ResolvedAt != nil {
		return inc, fmt.Errorf("%w: incident already resolved", ErrConflict)
	}
	return inc, nil
}

type IncidentFilter struct {
	State    string // open, acked, resolved, all
	Severity string
	Metric   string
	ServerID int64
	BeforeID int64
	Limit    int
}

type IncidentCounts struct {
	Open        int `json:"open"`
	Acked       int `json:"acked"`
	Resolved24h int `json:"resolved_24h"`
}

const (
	defaultIncidentLimit = 50
	maxIncidentLimit     = 200
)

func (s *Store) ListIncidents(ctx context.Context, orgID int64, f IncidentFilter) ([]Incident, IncidentCounts, error) {
	where := []string{"i.org_id = $1"}
	args := []any{orgID}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	switch f.State {
	case "open":
		where = append(where, "i.resolved_at IS NULL AND i.acked_at IS NULL")
	case "acked":
		where = append(where, "i.resolved_at IS NULL AND i.acked_at IS NOT NULL")
	case "resolved":
		where = append(where, "i.resolved_at IS NOT NULL")
	}
	if f.Severity != "" {
		add("i.severity = $%d", f.Severity)
	}
	if f.Metric != "" {
		add("i.metric = $%d", f.Metric)
	}
	if f.ServerID > 0 {
		add("i.server_id = $%d", f.ServerID)
	}
	if f.BeforeID > 0 {
		add("i.id < $%d", f.BeforeID)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = defaultIncidentLimit
	}
	limit = min(limit, maxIncidentLimit)

	incidents, err := collectIncidents(s.pool.Query(ctx,
		`SELECT `+incidentColumns+incidentFrom+`WHERE `+strings.Join(where, " AND ")+
			// Newest first by id alone, so the `before` cursor pages without gaps.
			fmt.Sprintf(` ORDER BY i.id DESC LIMIT %d`, limit), args...))
	if err != nil {
		return nil, IncidentCounts{}, err
	}

	var c IncidentCounts
	err = s.pool.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE resolved_at IS NULL AND acked_at IS NULL),
       count(*) FILTER (WHERE resolved_at IS NULL AND acked_at IS NOT NULL),
       count(*) FILTER (WHERE resolved_at > now() - interval '24 hours')
FROM incidents WHERE org_id = $1`, orgID).Scan(&c.Open, &c.Acked, &c.Resolved24h)
	return incidents, c, err
}

// IncidentsForServers feeds the public status page.
func (s *Store) IncidentsForServers(ctx context.Context, orgID int64, serverIDs []int64, since time.Time, limit int) ([]Incident, error) {
	return collectIncidents(s.pool.Query(ctx, `SELECT `+incidentColumns+incidentFrom+`
WHERE i.org_id = $1 AND i.server_id = ANY($2) AND i.started_at >= $3
ORDER BY i.started_at DESC LIMIT $4`, orgID, serverIDs, since, limit))
}

// ExportIncidents returns up to the last 90 days for GET /export.
func (s *Store) ExportIncidents(ctx context.Context, orgID int64, since time.Time) ([]Incident, error) {
	return collectIncidents(s.pool.Query(ctx, `SELECT `+incidentColumns+incidentFrom+`
WHERE i.org_id = $1 AND i.started_at >= $2 ORDER BY i.id`, orgID, since))
}

// SetResolvedBy records who closed an incident by hand (the engine resolves
// it; this adds attribution).
func (s *Store) SetResolvedBy(ctx context.Context, id, userID int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE incidents SET resolved_by = $2 WHERE id = $1`, id, userID)
	return err
}
