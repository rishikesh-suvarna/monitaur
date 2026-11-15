-- Baseline: the schema GORM AutoMigrate created for v1 (users, servers,
-- metrics, alerts), with the same types and constraint names. On the
-- existing database every statement is a no-op; on a fresh database it
-- recreates v1 so 00002 has one starting point for both.

-- +goose Up
CREATE TABLE IF NOT EXISTS users (
    id           bigserial PRIMARY KEY,
    firebase_uid text NOT NULL,
    email        text NOT NULL,
    created_at   timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at   timestamptz,
    CONSTRAINT uni_users_firebase_uid UNIQUE (firebase_uid)
);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users (firebase_uid);

CREATE TABLE IF NOT EXISTS servers (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL,
    token      text NOT NULL,
    name       text NOT NULL,
    last_seen  timestamptz,
    status     text DEFAULT 'offline',
    created_at timestamptz,
    updated_at timestamptz,
    CONSTRAINT uni_servers_token UNIQUE (token),
    CONSTRAINT fk_users_servers FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_servers_user_id ON servers (user_id);

CREATE TABLE IF NOT EXISTS metrics (
    id                bigserial PRIMARY KEY,
    "time"            timestamptz NOT NULL,
    server_id         bigint NOT NULL,
    cpu_usage         numeric,
    cpu_cores         bigint,
    memory_total      bigint,
    memory_used       bigint,
    memory_available  bigint,
    memory_percent    numeric,
    disk_total        bigint,
    disk_used         bigint,
    disk_free         bigint,
    disk_percent      numeric,
    network_bytes_in  bigint,
    network_bytes_out bigint,
    uptime            bigint,
    CONSTRAINT fk_servers_metrics FOREIGN KEY (server_id) REFERENCES servers (id)
);
CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics ("time");
CREATE INDEX IF NOT EXISTS idx_metrics_server_id ON metrics (server_id);

CREATE TABLE IF NOT EXISTS alerts (
    id         bigserial PRIMARY KEY,
    server_id  bigint NOT NULL,
    type       text NOT NULL,
    level      text NOT NULL,
    message    text NOT NULL,
    value      numeric,
    threshold  numeric,
    resolved   boolean DEFAULT false,
    created_at timestamptz,
    updated_at timestamptz,
    CONSTRAINT fk_servers_alerts FOREIGN KEY (server_id) REFERENCES servers (id)
);
CREATE INDEX IF NOT EXISTS idx_alerts_server_id ON alerts (server_id);

-- +goose Down
-- The baseline is never rolled back: it describes data that predates goose.
SELECT 1;
