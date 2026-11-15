package store

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"backend/metrics"
)

const (
	retentionBatch      = 10_000
	retentionMaxBatches = 20 // per flush window, so one window never runs long
	legacyBackfillJob   = "legacy_rollups_v1"
	legacyBackfillDays  = 7
	uptimeDailyKeepDays = 400
	minutesPerDay       = 1440
)

func clampInt64(v uint64) int64 {
	if v > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(v)
}

func rollupTable(res metrics.Resolution) (string, error) {
	switch res {
	case metrics.Minute:
		return "metrics_1m", nil
	case metrics.Hour:
		return "metrics_1h", nil
	default:
		return "", fmt.Errorf("unknown resolution %d", res)
	}
}

// WriteBuckets implements metrics.Sink. A bucket that already exists is merged
// (restart split), and only newly inserted minute buckets count toward
// uptime_daily. The journal is deleted after a successful flush, so replay
// double-counts only if the process dies between commit and that delete.
func (s *Store) WriteBuckets(ctx context.Context, buckets []metrics.Bucket) error {
	byRes := map[metrics.Resolution][]metrics.Bucket{}
	for _, b := range buckets {
		byRes[b.Res] = append(byRes[b.Res], b)
	}
	for res, bs := range byRes {
		if err := s.writeBuckets(ctx, res, bs); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) writeBuckets(ctx context.Context, res metrics.Resolution, bs []metrics.Bucket) error {
	table, err := rollupTable(res)
	if err != nil {
		return err
	}
	n := len(bs)
	var (
		ids                                     = make([]int64, n)
		starts                                  = make([]time.Time, n)
		samples                                 = make([]int32, n)
		cpuAvg, cpuMax, memAvg, memMax, diskAvg = make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n)
		inAvg, inMax, outAvg, outMax            = make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n)
		memTotal, diskTotal, diskUsed, uptime   = make([]int64, n), make([]int64, n), make([]int64, n), make([]int64, n)
	)
	for i, b := range bs {
		ids[i], starts[i] = b.ServerID, b.Start.UTC()
		samples[i] = int32(min(b.Samples, math.MaxInt16))
		cpuAvg[i], cpuMax[i], memAvg[i], memMax[i], diskAvg[i] = b.CPUAvg, b.CPUMax, b.MemAvg, b.MemMax, b.DiskAvg
		inAvg[i], inMax[i], outAvg[i], outMax[i] = b.NetInAvg, b.NetInMax, b.NetOutAvg, b.NetOutMax
		memTotal[i], diskTotal[i], diskUsed[i] = clampInt64(b.MemTotalBytes), clampInt64(b.DiskTotalBytes), clampInt64(b.DiskUsedBytes)
		uptime[i] = b.UptimeSeconds
	}

	insert := `
INSERT INTO ` + table + ` AS t (server_id, bucket, samples, cpu_avg, cpu_max, mem_avg, mem_max, disk_avg,
	mem_total_bytes, disk_total_bytes, disk_used_bytes, net_in_bps_avg, net_in_bps_max, net_out_bps_avg, net_out_bps_max, uptime_s)
SELECT v.* FROM unnest($1::bigint[], $2::timestamptz[], $3::smallint[], $4::real[], $5::real[], $6::real[], $7::real[], $8::real[],
	$9::bigint[], $10::bigint[], $11::bigint[], $12::real[], $13::real[], $14::real[], $15::real[], $16::bigint[])
	AS v(server_id, bucket, samples, cpu_avg, cpu_max, mem_avg, mem_max, disk_avg, mem_total_bytes,
	     disk_total_bytes, disk_used_bytes, net_in_bps_avg, net_in_bps_max, net_out_bps_avg, net_out_bps_max, uptime_s)
-- buckets of a server deleted since they were buffered are dropped
WHERE EXISTS (SELECT 1 FROM servers s WHERE s.id = v.server_id)
-- A minute or hour that spans a restart arrives in two parts: merge them,
-- weighting averages by sample count.
ON CONFLICT (server_id, bucket) DO UPDATE SET
	samples         = LEAST(t.samples + EXCLUDED.samples, 32767),
	cpu_avg         = (COALESCE(t.cpu_avg, 0) * t.samples + COALESCE(EXCLUDED.cpu_avg, 0) * EXCLUDED.samples) / NULLIF(t.samples + EXCLUDED.samples, 0),
	cpu_max         = GREATEST(t.cpu_max, EXCLUDED.cpu_max),
	mem_avg         = (COALESCE(t.mem_avg, 0) * t.samples + COALESCE(EXCLUDED.mem_avg, 0) * EXCLUDED.samples) / NULLIF(t.samples + EXCLUDED.samples, 0),
	mem_max         = GREATEST(t.mem_max, EXCLUDED.mem_max),
	disk_avg        = (COALESCE(t.disk_avg, 0) * t.samples + COALESCE(EXCLUDED.disk_avg, 0) * EXCLUDED.samples) / NULLIF(t.samples + EXCLUDED.samples, 0),
	net_in_bps_avg  = (COALESCE(t.net_in_bps_avg, 0) * t.samples + COALESCE(EXCLUDED.net_in_bps_avg, 0) * EXCLUDED.samples) / NULLIF(t.samples + EXCLUDED.samples, 0),
	net_in_bps_max  = GREATEST(t.net_in_bps_max, EXCLUDED.net_in_bps_max),
	net_out_bps_avg = (COALESCE(t.net_out_bps_avg, 0) * t.samples + COALESCE(EXCLUDED.net_out_bps_avg, 0) * EXCLUDED.samples) / NULLIF(t.samples + EXCLUDED.samples, 0),
	net_out_bps_max = GREATEST(t.net_out_bps_max, EXCLUDED.net_out_bps_max),
	mem_total_bytes  = EXCLUDED.mem_total_bytes,
	disk_total_bytes = EXCLUDED.disk_total_bytes,
	disk_used_bytes  = EXCLUDED.disk_used_bytes,
	uptime_s         = GREATEST(t.uptime_s, EXCLUDED.uptime_s)
RETURNING server_id, bucket, (xmax = 0) AS inserted`
	args := []any{ids, starts, samples, cpuAvg, cpuMax, memAvg, memMax, diskAvg,
		memTotal, diskTotal, diskUsed, inAvg, inMax, outAvg, outMax, uptime}

	if res != metrics.Minute {
		_, err := s.pool.Exec(ctx, insert, args...)
		return err
	}
	_, err = s.pool.Exec(ctx, `
WITH ins AS (`+insert+`)
INSERT INTO uptime_daily (server_id, day, minutes_up)
SELECT server_id, (bucket AT TIME ZONE 'UTC')::date, count(*) FROM ins WHERE inserted GROUP BY 1, 2
ON CONFLICT (server_id, day) DO UPDATE
SET minutes_up = LEAST(uptime_daily.minutes_up + EXCLUDED.minutes_up, `+fmt.Sprint(minutesPerDay)+`)`, args...)
	return err
}

// ReadBuckets implements metrics.History.
func (s *Store) ReadBuckets(ctx context.Context, serverID int64, res metrics.Resolution, from, to time.Time) ([]metrics.Bucket, error) {
	table, err := rollupTable(res)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
SELECT bucket, samples, COALESCE(cpu_avg, 0), COALESCE(cpu_max, 0), COALESCE(mem_avg, 0), COALESCE(mem_max, 0),
	COALESCE(disk_avg, 0), COALESCE(net_in_bps_avg, 0), COALESCE(net_in_bps_max, 0), COALESCE(net_out_bps_avg, 0),
	COALESCE(net_out_bps_max, 0), COALESCE(mem_total_bytes, 0), COALESCE(disk_total_bytes, 0), COALESCE(disk_used_bytes, 0),
	COALESCE(uptime_s, 0)
FROM `+table+` WHERE server_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, serverID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []metrics.Bucket
	for rows.Next() {
		b := metrics.Bucket{ServerID: serverID, Res: res}
		var samples int16
		var memTotal, diskTotal, diskUsed int64
		if err := rows.Scan(&b.Start, &samples, &b.CPUAvg, &b.CPUMax, &b.MemAvg, &b.MemMax, &b.DiskAvg,
			&b.NetInAvg, &b.NetInMax, &b.NetOutAvg, &b.NetOutMax, &memTotal, &diskTotal, &diskUsed, &b.UptimeSeconds); err != nil {
			return nil, err
		}
		b.Samples = int(samples)
		b.MemTotalBytes, b.DiskTotalBytes, b.DiskUsedBytes = uint64(max(memTotal, 0)), uint64(max(diskTotal, 0)), uint64(max(diskUsed, 0))
		b.Start = b.Start.UTC()
		out = append(out, b)
	}
	return out, rows.Err()
}

// ApplyRetention trims rollups per plan. It runs in the flush window and is
// bounded per call so one window stays short; leftovers go next window.
func (s *Store) ApplyRetention(ctx context.Context) (int64, error) {
	var total int64
	for _, q := range []string{
		`DELETE FROM metrics_1m WHERE ctid IN (
			SELECT m.ctid FROM metrics_1m m
			JOIN servers s ON s.id = m.server_id JOIN organizations o ON o.id = s.org_id JOIN plans p ON p.id = o.plan_id
			WHERE p.retention_1m_days > 0 AND m.bucket < now() - make_interval(days => p.retention_1m_days)
			LIMIT ` + fmt.Sprint(retentionBatch) + `)`,
		`DELETE FROM metrics_1h WHERE ctid IN (
			SELECT m.ctid FROM metrics_1h m
			JOIN servers s ON s.id = m.server_id JOIN organizations o ON o.id = s.org_id JOIN plans p ON p.id = o.plan_id
			WHERE p.retention_1h_days > 0 AND m.bucket < now() - make_interval(days => p.retention_1h_days)
			LIMIT ` + fmt.Sprint(retentionBatch) + `)`,
		`DELETE FROM uptime_daily WHERE ctid IN (
			SELECT ctid FROM uptime_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - ` + fmt.Sprint(uptimeDailyKeepDays) + `
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

type UptimeDay struct {
	ServerID  int64
	Day       time.Time
	MinutesUp int
}

func (s *Store) UptimeDays(ctx context.Context, serverIDs []int64, since time.Time) ([]UptimeDay, error) {
	rows, err := s.pool.Query(ctx, `
SELECT server_id, day, minutes_up FROM uptime_daily
WHERE server_id = ANY($1) AND day >= $2::date ORDER BY server_id, day`, serverIDs, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UptimeDay
	for rows.Next() {
		var d UptimeDay
		if err := rows.Scan(&d.ServerID, &d.Day, &d.MinutesUp); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// LegacyBackfillPending reports whether v1 raw metrics still need rolling up.
func (s *Store) LegacyBackfillPending(ctx context.Context) (bool, error) {
	var done, hasLegacy bool
	err := s.pool.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM app_jobs WHERE name = $1),
       to_regclass('public.metrics') IS NOT NULL`, legacyBackfillJob).Scan(&done, &hasLegacy)
	return !done && hasLegacy, err
}

type ServerDay struct {
	ServerID int64
	Day      time.Time
}

func (s *Store) LegacyBackfillTargets(ctx context.Context) ([]ServerDay, error) {
	rows, err := s.pool.Query(ctx, `
SELECT DISTINCT m.server_id, date_trunc('day', m."time" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
FROM metrics m JOIN servers s ON s.id = m.server_id
WHERE m."time" > now() - make_interval(days => $1)
ORDER BY 1, 2`, legacyBackfillDays)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ServerDay
	for rows.Next() {
		var d ServerDay
		if err := rows.Scan(&d.ServerID, &d.Day); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// BackfillLegacyDay rolls one server-day of v1 raw metrics into 1m and 1h
// rollups. Small units keep each statement short on a cold Neon compute.
func (s *Store) BackfillLegacyDay(ctx context.Context, d ServerDay) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
WITH ins AS (
	INSERT INTO metrics_1m (server_id, bucket, samples, cpu_avg, cpu_max, mem_avg, mem_max, disk_avg,
		mem_total_bytes, disk_total_bytes, disk_used_bytes, uptime_s)
	SELECT server_id, date_trunc('minute', "time"), LEAST(count(*), 32767)::smallint,
		avg(cpu_usage)::real, max(cpu_usage)::real, avg(memory_percent)::real, max(memory_percent)::real,
		avg(disk_percent)::real, max(memory_total), max(disk_total), max(disk_used), max(uptime)
	FROM metrics WHERE server_id = $1 AND "time" >= $2 AND "time" < $2 + interval '1 day'
	GROUP BY 1, 2
	ON CONFLICT DO NOTHING
	RETURNING server_id, bucket
)
INSERT INTO uptime_daily (server_id, day, minutes_up)
SELECT server_id, (bucket AT TIME ZONE 'UTC')::date, count(*) FROM ins GROUP BY 1, 2
ON CONFLICT (server_id, day) DO UPDATE SET minutes_up = LEAST(uptime_daily.minutes_up + EXCLUDED.minutes_up, 1440)`,
			d.ServerID, d.Day); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
INSERT INTO metrics_1h (server_id, bucket, samples, cpu_avg, cpu_max, mem_avg, mem_max, disk_avg,
	mem_total_bytes, disk_total_bytes, disk_used_bytes, uptime_s)
SELECT server_id, date_trunc('hour', bucket), LEAST(sum(samples), 32767)::smallint,
	(sum(cpu_avg * samples) / sum(samples))::real, max(cpu_max),
	(sum(mem_avg * samples) / sum(samples))::real, max(mem_max),
	(sum(disk_avg * samples) / sum(samples))::real,
	max(mem_total_bytes), max(disk_total_bytes), max(disk_used_bytes), max(uptime_s)
FROM metrics_1m WHERE server_id = $1 AND bucket >= $2 AND bucket < $2 + interval '1 day'
GROUP BY 1, 2
ON CONFLICT DO NOTHING`, d.ServerID, d.Day)
		return err
	})
}

func (s *Store) MarkJobDone(ctx context.Context, name string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO app_jobs (name, finished_at) VALUES ($1, now()) ON CONFLICT DO NOTHING`, name)
	return err
}

// LegacyBackfillJob is the app_jobs name of the v1 rollup backfill.
func LegacyBackfillJob() string { return legacyBackfillJob }
