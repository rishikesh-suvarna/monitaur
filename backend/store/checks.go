package store

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"backend/checks"
)

// Check is a stored uptime check (docs/platform-v2.md 6.3).
type Check struct {
	ID              int64
	OrgID           int64
	Name            string
	Type            string
	Target          string
	IntervalSeconds int
	TimeoutSeconds  int
	ExpectStatus    int
	Keyword         string
	TLSWarnDays     int
	Enabled         bool
	ChannelIDs      []int64
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const (
	checkColumns = `id, org_id, name, type, target, interval_seconds, timeout_seconds, expect_status, keyword,
	tls_warn_days, enabled, channel_ids, created_at, updated_at`
	// check_results_1h counts are smallint.
	maxSmallint = math.MaxInt16
)

func scanCheck(row pgx.Row) (Check, error) {
	var c Check
	err := row.Scan(&c.ID, &c.OrgID, &c.Name, &c.Type, &c.Target, &c.IntervalSeconds, &c.TimeoutSeconds, &c.ExpectStatus,
		&c.Keyword, &c.TLSWarnDays, &c.Enabled, &c.ChannelIDs, &c.CreatedAt, &c.UpdatedAt)
	if c.ChannelIDs == nil {
		c.ChannelIDs = []int64{}
	}
	return c, mapErr(err)
}

func collectChecks(rows pgx.Rows, err error) ([]Check, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Check
	for rows.Next() {
		c, err := scanCheck(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListAllChecks loads the directory and the scheduler at startup.
func (s *Store) ListAllChecks(ctx context.Context) ([]Check, error) {
	return collectChecks(s.pool.Query(ctx, `SELECT `+checkColumns+` FROM checks ORDER BY org_id, id`))
}

func (s *Store) ListOrgChecks(ctx context.Context, orgID int64) ([]Check, error) {
	return collectChecks(s.pool.Query(ctx, `SELECT `+checkColumns+` FROM checks WHERE org_id = $1 ORDER BY name, id`, orgID))
}

func (s *Store) GetCheck(ctx context.Context, orgID, id int64) (Check, error) {
	return scanCheck(s.pool.QueryRow(ctx, `SELECT `+checkColumns+` FROM checks WHERE org_id = $1 AND id = $2`, orgID, id))
}

// CreateCheck locks the org row so concurrent creates cannot exceed the
// plan's max_checks (0 = unlimited).
func (s *Store) CreateCheck(ctx context.Context, c Check, maxChecks int) (Check, error) {
	if c.ChannelIDs == nil {
		c.ChannelIDs = []int64{}
	}
	var out Check
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, c.OrgID); err != nil {
			return err
		}
		if !unlimited(maxChecks) {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM checks WHERE org_id = $1`, c.OrgID).Scan(&n); err != nil {
				return err
			}
			if n >= maxChecks {
				return ErrLimitReached
			}
		}
		var err error
		out, err = scanCheck(tx.QueryRow(ctx, `
INSERT INTO checks (org_id, name, type, target, interval_seconds, timeout_seconds, expect_status, keyword,
	tls_warn_days, enabled, channel_ids)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING `+checkColumns, c.OrgID, c.Name, c.Type, c.Target, c.IntervalSeconds, c.TimeoutSeconds, c.ExpectStatus,
			c.Keyword, c.TLSWarnDays, c.Enabled, c.ChannelIDs))
		return err
	})
	return out, err
}

// UpdateCheck replaces every editable field (the API merges partial updates
// before calling).
func (s *Store) UpdateCheck(ctx context.Context, c Check) (Check, error) {
	if c.ChannelIDs == nil {
		c.ChannelIDs = []int64{}
	}
	return scanCheck(s.pool.QueryRow(ctx, `
UPDATE checks SET name = $3, type = $4, target = $5, interval_seconds = $6, timeout_seconds = $7,
	expect_status = $8, keyword = $9, tls_warn_days = $10, enabled = $11, channel_ids = $12, updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING `+checkColumns, c.OrgID, c.ID, c.Name, c.Type, c.Target, c.IntervalSeconds, c.TimeoutSeconds,
		c.ExpectStatus, c.Keyword, c.TLSWarnDays, c.Enabled, c.ChannelIDs))
}

// DeleteCheck cascades results, uptime and incidents, and removes the check
// from the status page.
func (s *Store) DeleteCheck(ctx context.Context, orgID, id int64) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM checks WHERE org_id = $1 AND id = $2`, orgID, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `
UPDATE organizations SET status_page_check_ids = array_remove(status_page_check_ids, $2)
WHERE id = $1 AND $2 = ANY(status_page_check_ids)`, orgID, id)
		return err
	})
}

// WriteCheckRollups merges flush-window deltas into hourly results and daily
// uptime in one transaction. Deltas of checks deleted since they were
// buffered are dropped. A delta written twice (a write that committed but
// reported failure) double counts, the same trade-off as metrics rollups.
func (s *Store) WriteCheckRollups(ctx context.Context, hours []checks.HourRollup, days []checks.DayRollup) error {
	if len(hours) == 0 && len(days) == 0 {
		return nil
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if len(hours) > 0 {
			n := len(hours)
			ids, starts := make([]int64, n), make([]time.Time, n)
			totals, oks := make([]int32, n), make([]int32, n)
			avgs, maxes := make([]float32, n), make([]float32, n)
			for i, h := range hours {
				ids[i], starts[i] = h.CheckID, h.Start.UTC()
				totals[i], oks[i] = int32(min(h.Total, maxSmallint)), int32(min(h.OK, maxSmallint))
				avgs[i], maxes[i] = h.LatencyAvgMS, h.LatencyMaxMS
			}
			if _, err := tx.Exec(ctx, `
INSERT INTO check_results_1h AS t (check_id, bucket, total, ok, latency_avg_ms, latency_max_ms)
SELECT v.check_id, v.bucket, v.total::smallint, v.ok::smallint,
	CASE WHEN v.ok > 0 THEN v.lat_avg END, CASE WHEN v.ok > 0 THEN v.lat_max END
FROM unnest($1::bigint[], $2::timestamptz[], $3::int[], $4::int[], $5::real[], $6::real[])
	AS v(check_id, bucket, total, ok, lat_avg, lat_max)
WHERE EXISTS (SELECT 1 FROM checks c WHERE c.id = v.check_id)
-- An hour flushed in parts (every flush window, or across a restart) adds
-- up; latency averages are weighted by successful probes.
ON CONFLICT (check_id, bucket) DO UPDATE SET
	total          = LEAST(t.total::int + EXCLUDED.total, `+fmt.Sprint(maxSmallint)+`),
	ok             = LEAST(t.ok::int + EXCLUDED.ok, `+fmt.Sprint(maxSmallint)+`),
	latency_avg_ms = (COALESCE(t.latency_avg_ms, 0) * t.ok + COALESCE(EXCLUDED.latency_avg_ms, 0) * EXCLUDED.ok)
	                 / NULLIF(t.ok::int + EXCLUDED.ok, 0),
	latency_max_ms = GREATEST(t.latency_max_ms, EXCLUDED.latency_max_ms)`,
				ids, starts, totals, oks, avgs, maxes); err != nil {
				return fmt.Errorf("write check hours: %w", err)
			}
		}
		if len(days) > 0 {
			n := len(days)
			ids, starts := make([]int64, n), make([]time.Time, n)
			totals, oks := make([]int32, n), make([]int32, n)
			for i, d := range days {
				ids[i], starts[i], totals[i], oks[i] = d.CheckID, d.Day.UTC(), int32(d.Total), int32(d.OK)
			}
			if _, err := tx.Exec(ctx, `
INSERT INTO check_uptime_daily AS t (check_id, day, total, ok)
SELECT v.check_id, (v.day AT TIME ZONE 'UTC')::date, v.total, v.ok
FROM unnest($1::bigint[], $2::timestamptz[], $3::int[], $4::int[]) AS v(check_id, day, total, ok)
WHERE EXISTS (SELECT 1 FROM checks c WHERE c.id = v.check_id)
ON CONFLICT (check_id, day) DO UPDATE SET total = t.total + EXCLUDED.total, ok = t.ok + EXCLUDED.ok`,
				ids, starts, totals, oks); err != nil {
				return fmt.Errorf("write check days: %w", err)
			}
		}
		return nil
	})
}

const checkHourColumns = `check_id, bucket, total, ok, COALESCE(latency_avg_ms, 0), COALESCE(latency_max_ms, 0)`

func collectCheckHours(rows pgx.Rows, err error) ([]checks.HourRollup, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []checks.HourRollup
	for rows.Next() {
		var (
			h         checks.HourRollup
			total, ok int16
		)
		if err := rows.Scan(&h.CheckID, &h.Start, &total, &ok, &h.LatencyAvgMS, &h.LatencyMaxMS); err != nil {
			return nil, err
		}
		h.Total, h.OK, h.Start = int(total), int(ok), h.Start.UTC()
		out = append(out, h)
	}
	return out, rows.Err()
}

// ReadCheckHours serves the 7d and 30d results ranges (cached per flush).
func (s *Store) ReadCheckHours(ctx context.Context, checkID int64, from, to time.Time) ([]checks.HourRollup, error) {
	return collectCheckHours(s.pool.Query(ctx, `SELECT `+checkHourColumns+` FROM check_results_1h
WHERE check_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, checkID, from, to))
}

// RecentCheckHours seeds the in-memory 24 h view of every check at startup.
func (s *Store) RecentCheckHours(ctx context.Context, since time.Time) ([]checks.HourRollup, error) {
	return collectCheckHours(s.pool.Query(ctx, `SELECT `+checkHourColumns+` FROM check_results_1h
WHERE bucket >= $1 ORDER BY check_id, bucket`, since))
}

type CheckUptimeDay struct {
	CheckID   int64
	Day       time.Time
	Total, OK int
}

// CheckUptimeDays feeds the public status page.
func (s *Store) CheckUptimeDays(ctx context.Context, checkIDs []int64, since time.Time) ([]CheckUptimeDay, error) {
	rows, err := s.pool.Query(ctx, `
SELECT check_id, day, total, ok FROM check_uptime_daily
WHERE check_id = ANY($1) AND day >= $2::date ORDER BY check_id, day`, checkIDs, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CheckUptimeDay
	for rows.Next() {
		var d CheckUptimeDay
		if err := rows.Scan(&d.CheckID, &d.Day, &d.Total, &d.OK); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ApplyCheckRetention trims hourly check results per plan (retention_1h_days)
// and daily uptime after a fixed horizon. Runs in the flush window, bounded
// per call like ApplyRetention.
func (s *Store) ApplyCheckRetention(ctx context.Context) (int64, error) {
	var total int64
	for _, q := range []string{
		`DELETE FROM check_results_1h WHERE ctid IN (
			SELECT r.ctid FROM check_results_1h r
			JOIN checks c ON c.id = r.check_id JOIN organizations o ON o.id = c.org_id JOIN plans p ON p.id = o.plan_id
			WHERE p.retention_1h_days > 0 AND r.bucket < now() - make_interval(days => p.retention_1h_days)
			LIMIT ` + fmt.Sprint(retentionBatch) + `)`,
		`DELETE FROM check_uptime_daily WHERE ctid IN (
			SELECT ctid FROM check_uptime_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - ` + fmt.Sprint(uptimeDailyKeepDays) + `
			LIMIT ` + fmt.Sprint(retentionBatch) + `)`,
	} {
		for range retentionMaxBatches {
			tag, err := s.pool.Exec(ctx, q)
			if err != nil {
				return total, err
			}
			total += tag.RowsAffected()
			if tag.RowsAffected() < retentionBatch {
				break
			}
		}
	}
	return total, nil
}

// NewCheckIncident is an outage or certificate warning of a check.
type NewCheckIncident struct {
	OrgID, CheckID int64
	RuleName       string
	Metric         string
	Severity       string
	Threshold      float64
	Peak           float64
	LastValue      float64
	SamplesOver    int
	StartedAt      time.Time
}

// OpenCheckIncident inserts an open incident with server_id NULL. The check
// must still exist in the org, so a delete racing a probe opens nothing.
func (s *Store) OpenCheckIncident(ctx context.Context, in NewCheckIncident) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `
INSERT INTO incidents (org_id, check_id, rule_name, metric, severity, threshold, peak, last_value, samples_over, started_at)
SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
WHERE EXISTS (SELECT 1 FROM checks WHERE id = $2 AND org_id = $1)
RETURNING id`, in.OrgID, in.CheckID, in.RuleName, in.Metric, in.Severity, in.Threshold, in.Peak, in.LastValue,
		max(in.SamplesOver, 1), in.StartedAt).Scan(&id)
	return id, mapErr(err)
}

// LoadOpenCheckIncidents restores the check scheduler after a restart.
func (s *Store) LoadOpenCheckIncidents(ctx context.Context) ([]Incident, error) {
	return collectIncidents(s.pool.Query(ctx, `SELECT `+incidentColumns+incidentFrom+
		`WHERE i.resolved_at IS NULL AND i.check_id IS NOT NULL ORDER BY i.id`))
}
