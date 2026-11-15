-- F7 uptime checks (docs/platform-v2.md section 6.3): checks run from the
-- backend, hourly result rollups and daily uptime written in the metrics
-- flush window, per-plan quotas, check incidents and status page entries.

-- +goose Up

CREATE TABLE checks (
    id               bigserial PRIMARY KEY,
    org_id           bigint NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name             text NOT NULL,
    type             text NOT NULL CHECK (type IN ('http', 'tcp', 'tls')),
    target           text NOT NULL,
    interval_seconds integer NOT NULL,
    timeout_seconds  integer NOT NULL,
    expect_status    integer NOT NULL DEFAULT 0,
    keyword          text NOT NULL DEFAULT '',
    tls_warn_days    integer NOT NULL DEFAULT 14,
    enabled          boolean NOT NULL DEFAULT true,
    channel_ids      bigint[] NOT NULL DEFAULT '{}',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checks_org_idx ON checks (org_id);

-- real (float4) and smallint keep rows small; an hour holds at most 120
-- probes at the 30 s minimum interval.
CREATE TABLE check_results_1h (
    check_id       bigint      NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
    bucket         timestamptz NOT NULL,
    total          smallint    NOT NULL,
    ok             smallint    NOT NULL,
    latency_avg_ms real,
    latency_max_ms real,
    PRIMARY KEY (check_id, bucket)
);

-- Probes per check per UTC day, for 90-day status page bars.
CREATE TABLE check_uptime_daily (
    check_id bigint  NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
    day      date    NOT NULL,
    total    integer NOT NULL,
    ok       integer NOT NULL,
    PRIMARY KEY (check_id, day)
);

-- Plans: 0 means unlimited. The defaults only fill the existing rows and are
-- dropped so a future plan must state its limits, like every other column.
ALTER TABLE plans
    ADD COLUMN max_checks                 integer NOT NULL DEFAULT 3,
    ADD COLUMN min_check_interval_seconds integer NOT NULL DEFAULT 60;
UPDATE plans SET max_checks = 3, min_check_interval_seconds = 60 WHERE id = 'free';
UPDATE plans SET max_checks = 0, min_check_interval_seconds = 30 WHERE id = 'legacy';
ALTER TABLE plans
    ALTER COLUMN max_checks DROP DEFAULT,
    ALTER COLUMN min_check_interval_seconds DROP DEFAULT;

-- An incident belongs to a server (alert rules) or to a check.
ALTER TABLE incidents
    ALTER COLUMN server_id DROP NOT NULL,
    ADD COLUMN check_id bigint REFERENCES checks (id) ON DELETE CASCADE,
    ADD CONSTRAINT incidents_subject_check CHECK (server_id IS NOT NULL OR check_id IS NOT NULL);
CREATE INDEX incidents_check_started_idx ON incidents (check_id, started_at DESC) WHERE check_id IS NOT NULL;

ALTER TABLE organizations ADD COLUMN status_page_check_ids bigint[] NOT NULL DEFAULT '{}';

-- +goose Down
DELETE FROM incidents WHERE server_id IS NULL;
DROP INDEX IF EXISTS incidents_check_started_idx;
ALTER TABLE incidents
    DROP CONSTRAINT IF EXISTS incidents_subject_check,
    DROP COLUMN IF EXISTS check_id,
    ALTER COLUMN server_id SET NOT NULL;
ALTER TABLE organizations DROP COLUMN IF EXISTS status_page_check_ids;
ALTER TABLE plans
    DROP COLUMN IF EXISTS max_checks,
    DROP COLUMN IF EXISTS min_check_interval_seconds;
DROP TABLE IF EXISTS check_uptime_daily;
DROP TABLE IF EXISTS check_results_1h;
DROP TABLE IF EXISTS checks;
