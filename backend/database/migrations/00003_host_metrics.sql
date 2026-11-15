-- +goose Up
-- F6 richer host metrics (docs/platform-v2.md 6.1).
--
-- The new rollup columns are nullable: rows written before this migration or
-- for older agents keep NULL, which the API reports as null rather than 0.
-- ext_samples counts the samples that carried these values, so a bucket that
-- is merged after a restart weights its extended averages correctly. Adding
-- nullable columns and a constant default is a catalog-only change, so this
-- stays fast on large rollup tables.
ALTER TABLE metrics_1m
    ADD COLUMN load1_avg          real,
    ADD COLUMN load1_max          real,
    ADD COLUMN swap_avg           real,
    ADD COLUMN disk_read_bps_avg  real,
    ADD COLUMN disk_read_bps_max  real,
    ADD COLUMN disk_write_bps_avg real,
    ADD COLUMN disk_write_bps_max real,
    ADD COLUMN ext_samples        smallint NOT NULL DEFAULT 0;

ALTER TABLE metrics_1h
    ADD COLUMN load1_avg          real,
    ADD COLUMN load1_max          real,
    ADD COLUMN swap_avg           real,
    ADD COLUMN disk_read_bps_avg  real,
    ADD COLUMN disk_read_bps_max  real,
    ADD COLUMN disk_write_bps_avg real,
    ADD COLUMN disk_write_bps_max real,
    ADD COLUMN ext_samples        smallint NOT NULL DEFAULT 0;

-- The inline CHECK from 00002 is named <table>_<column>_check. No IF EXISTS:
-- if the name were different the old constraint would survive and keep
-- rejecting the new metrics, so failing loudly here is the safer outcome.
ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_metric_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_metric_check
    CHECK (metric IN ('cpu', 'memory', 'disk', 'net_in', 'net_out', 'heartbeat', 'load1', 'swap'));

-- +goose Down
-- Rules on the new metrics cannot exist under the old constraint.
DELETE FROM alert_rules WHERE metric IN ('load1', 'swap');
ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_metric_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_metric_check
    CHECK (metric IN ('cpu', 'memory', 'disk', 'net_in', 'net_out', 'heartbeat'));

ALTER TABLE metrics_1h
    DROP COLUMN ext_samples,
    DROP COLUMN disk_write_bps_max,
    DROP COLUMN disk_write_bps_avg,
    DROP COLUMN disk_read_bps_max,
    DROP COLUMN disk_read_bps_avg,
    DROP COLUMN swap_avg,
    DROP COLUMN load1_max,
    DROP COLUMN load1_avg;

ALTER TABLE metrics_1m
    DROP COLUMN ext_samples,
    DROP COLUMN disk_write_bps_max,
    DROP COLUMN disk_write_bps_avg,
    DROP COLUMN disk_read_bps_max,
    DROP COLUMN disk_read_bps_avg,
    DROP COLUMN swap_avg,
    DROP COLUMN load1_max,
    DROP COLUMN load1_avg;
