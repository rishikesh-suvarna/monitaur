-- Platform v2: multi-tenancy (orgs, memberships, invites, plans), hashed
-- agent tokens, B2 metric rollups, alert rules, incidents, channels, pins
-- and status pages. See docs/platform-v2.md section 3.
--
-- One-way: plaintext agent tokens are hashed and then cleared, so a v1
-- binary cannot authenticate agents against this schema. Take a Neon branch
-- (restore point) before the first v2 deploy.

-- +goose Up

-- Plans: 0 means unlimited.
CREATE TABLE plans (
    id                    text PRIMARY KEY,
    name                  text NOT NULL,
    max_servers           integer NOT NULL,
    min_interval_seconds  integer NOT NULL,
    retention_1m_days     integer NOT NULL,
    retention_1h_days     integer NOT NULL,
    max_members           integer NOT NULL,
    alert_emails_per_day  integer NOT NULL,
    max_rules             integer NOT NULL,
    max_channels          integer NOT NULL,
    api_rpm               integer NOT NULL
);
INSERT INTO plans VALUES
    ('free',   'Free',        3, 10, 7, 30, 3, 20, 10, 2, 120),
    ('legacy', 'Self-hosted', 0,  5, 7, 90, 0,  0,  0, 0, 600);

-- Users
ALTER TABLE users
    ADD COLUMN display_name   text NOT NULL DEFAULT '',
    ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
UPDATE users SET created_at = COALESCE(created_at, now()), updated_at = COALESCE(updated_at, now());
ALTER TABLE users
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET DEFAULT now();

-- Organizations and membership
CREATE TABLE organizations (
    id                     bigserial PRIMARY KEY,
    name                   text NOT NULL,
    slug                   text NOT NULL UNIQUE,
    plan_id                text NOT NULL REFERENCES plans (id),
    personal_owner_id      bigint UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    defaults_seeded        boolean NOT NULL DEFAULT false,
    status_page_enabled    boolean NOT NULL DEFAULT false,
    status_page_title      text NOT NULL DEFAULT '',
    status_page_server_ids bigint[] NOT NULL DEFAULT '{}',
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    org_id     bigint NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invites (
    id          bigserial PRIMARY KEY,
    org_id      bigint NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email       text NOT NULL,
    role        text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    token_hash  text NOT NULL UNIQUE,
    invited_by  bigint REFERENCES users (id) ON DELETE SET NULL,
    expires_at  timestamptz NOT NULL,
    accepted_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invites_open_email_idx ON invites (org_id, lower(email)) WHERE accepted_at IS NULL;

-- Every existing user gets a personal org on the unlimited legacy plan.
INSERT INTO organizations (name, slug, plan_id, personal_owner_id, created_at)
SELECT 'Personal',
       'u' || u.id || '-' || substr(md5(u.firebase_uid || u.id::text), 1, 8),
       'legacy', u.id, COALESCE(u.created_at, now())
FROM users u;
INSERT INTO memberships (org_id, user_id, role)
SELECT o.id, o.personal_owner_id, 'owner' FROM organizations o WHERE o.personal_owner_id IS NOT NULL;

-- Servers: org ownership, tags, hashed tokens with rotation grace.
ALTER TABLE servers
    ADD COLUMN org_id                bigint REFERENCES organizations (id) ON DELETE CASCADE,
    ADD COLUMN tags                  text[] NOT NULL DEFAULT '{}',
    ADD COLUMN token_hash            text,
    ADD COLUMN token_prefix          text NOT NULL DEFAULT '',
    ADD COLUMN token_created_at      timestamptz,
    ADD COLUMN token_last_used_at    timestamptz,
    ADD COLUMN prev_token_hash       text,
    ADD COLUMN prev_token_expires_at timestamptz,
    ADD COLUMN agent_version         text NOT NULL DEFAULT '',
    ADD COLUMN created_by            bigint REFERENCES users (id) ON DELETE SET NULL;

UPDATE servers s
SET org_id           = o.id,
    created_by       = s.user_id,
    token_hash       = encode(sha256(convert_to(s.token, 'UTF8')), 'hex'),
    token_prefix     = left(s.token, 8),
    token_created_at = COALESCE(s.created_at, now()),
    created_at       = COALESCE(s.created_at, now()),
    updated_at       = COALESCE(s.updated_at, now())
FROM organizations o
WHERE o.personal_owner_id = s.user_id;

-- Legacy tables: keep the data, stop blocking server deletes. NOT VALID skips
-- a full-table scan; existing rows already satisfy the constraint.
ALTER TABLE metrics DROP CONSTRAINT IF EXISTS fk_servers_metrics;
ALTER TABLE metrics ADD CONSTRAINT fk_servers_metrics
    FOREIGN KEY (server_id) REFERENCES servers (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS fk_servers_alerts;
ALTER TABLE alerts ADD CONSTRAINT fk_servers_alerts
    FOREIGN KEY (server_id) REFERENCES servers (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE alerts RENAME TO alerts_legacy;

-- Servers whose owner row is missing cannot be attributed to a tenant.
DELETE FROM servers WHERE org_id IS NULL;

ALTER TABLE servers DROP CONSTRAINT IF EXISTS uni_servers_token;
ALTER TABLE servers DROP CONSTRAINT IF EXISTS fk_users_servers;
ALTER TABLE servers
    ALTER COLUMN org_id SET NOT NULL,
    ALTER COLUMN token_hash SET NOT NULL,
    ALTER COLUMN token DROP NOT NULL,
    ALTER COLUMN user_id DROP NOT NULL,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET DEFAULT now();
-- Plaintext tokens never stay at rest; agents keep working because their
-- token hashes to token_hash.
UPDATE servers SET token = NULL;

CREATE UNIQUE INDEX servers_token_hash_idx ON servers (token_hash);
CREATE INDEX servers_prev_token_hash_idx ON servers (prev_token_hash) WHERE prev_token_hash IS NOT NULL;
CREATE INDEX servers_org_idx ON servers (org_id);

CREATE TABLE server_pins (
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    server_id  bigint NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, server_id)
);

-- B2 rollups (PLAN.md 2.3.4). real (float4) keeps rows small.
CREATE TABLE metrics_1m (
    server_id        bigint      NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    bucket           timestamptz NOT NULL,
    samples          smallint    NOT NULL,
    cpu_avg          real,
    cpu_max          real,
    mem_avg          real,
    mem_max          real,
    disk_avg         real,
    mem_total_bytes  bigint,
    disk_total_bytes bigint,
    disk_used_bytes  bigint,
    net_in_bps_avg   real,
    net_in_bps_max   real,
    net_out_bps_avg  real,
    net_out_bps_max  real,
    uptime_s         bigint,
    PRIMARY KEY (server_id, bucket)
);
CREATE TABLE metrics_1h (LIKE metrics_1m INCLUDING ALL);
ALTER TABLE metrics_1h ADD FOREIGN KEY (server_id) REFERENCES servers (id) ON DELETE CASCADE;

-- Minutes with data per server per UTC day, for 90-day status page bars.
CREATE TABLE uptime_daily (
    server_id  bigint  NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    day        date    NOT NULL,
    minutes_up integer NOT NULL,
    PRIMARY KEY (server_id, day)
);

CREATE TABLE notification_channels (
    id               bigserial PRIMARY KEY,
    org_id           bigint NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    type             text NOT NULL CHECK (type IN ('email', 'slack', 'discord', 'telegram', 'webhook')),
    name             text NOT NULL,
    enabled          boolean NOT NULL DEFAULT true,
    config_enc       bytea NOT NULL,
    last_delivery_at timestamptz,
    last_delivery_ok boolean,
    last_error       text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_channels_org_idx ON notification_channels (org_id);

CREATE TABLE alert_rules (
    id                   bigserial PRIMARY KEY,
    org_id               bigint NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name                 text NOT NULL,
    enabled              boolean NOT NULL DEFAULT true,
    scope_all            boolean NOT NULL DEFAULT true,
    scope_server_ids     bigint[] NOT NULL DEFAULT '{}',
    scope_tags           text[] NOT NULL DEFAULT '{}',
    metric               text NOT NULL CHECK (metric IN ('cpu', 'memory', 'disk', 'net_in', 'net_out', 'heartbeat')),
    comparison           text NOT NULL DEFAULT 'above' CHECK (comparison IN ('above', 'below')),
    threshold            double precision NOT NULL DEFAULT 0,
    for_seconds          integer NOT NULL DEFAULT 0,
    severity             text NOT NULL CHECK (severity IN ('warning', 'critical')),
    channel_ids          bigint[] NOT NULL DEFAULT '{}',
    cooldown_seconds     integer NOT NULL DEFAULT 0,
    auto_resolve_seconds integer NOT NULL DEFAULT 0,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_rules_org_idx ON alert_rules (org_id);

CREATE TABLE incidents (
    id                bigserial PRIMARY KEY,
    org_id            bigint NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    server_id         bigint NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    rule_id           bigint REFERENCES alert_rules (id) ON DELETE SET NULL,
    rule_name         text NOT NULL,
    metric            text NOT NULL,
    severity          text NOT NULL,
    threshold         double precision NOT NULL,
    peak              double precision NOT NULL,
    last_value        double precision NOT NULL,
    samples_over      integer NOT NULL DEFAULT 0,
    started_at        timestamptz NOT NULL,
    resolved_at       timestamptz,
    resolved_how      text,
    resolved_by       bigint REFERENCES users (id) ON DELETE SET NULL,
    acked_at          timestamptz,
    acked_by          bigint REFERENCES users (id) ON DELETE SET NULL,
    last_notified_at  timestamptz,
    notified_channels text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX incidents_org_started_idx ON incidents (org_id, started_at DESC);
CREATE INDEX incidents_server_started_idx ON incidents (server_id, started_at DESC);
CREATE INDEX incidents_open_idx ON incidents (org_id) WHERE resolved_at IS NULL;

-- Tracks one-off background jobs such as the legacy metrics backfill.
CREATE TABLE app_jobs (
    name        text PRIMARY KEY,
    finished_at timestamptz NOT NULL
);

-- +goose Down
-- Not reversible: tokens were hashed and cleared. Restore the pre-deploy
-- Neon branch instead.
SELECT 1;
