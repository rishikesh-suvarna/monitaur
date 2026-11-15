-- F11 maintenance windows (docs/platform-v2.md section 6.4). While a window
-- is active for a server or check, incidents are still recorded but marked
-- silenced and no notification is sent. Windows are cached in the directory
-- and evaluated in memory, so this table is read once at startup.

-- +goose Up

CREATE TABLE maintenance_windows (
    id               bigserial PRIMARY KEY,
    org_id           bigint NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name             text NOT NULL,
    scope_all        boolean NOT NULL DEFAULT false,
    scope_server_ids bigint[] NOT NULL DEFAULT '{}',
    scope_tags       text[] NOT NULL DEFAULT '{}',
    -- No foreign key: arrays cannot reference rows, and check IDs are only
    -- shape-validated so windows can name checks created later.
    scope_check_ids  bigint[] NOT NULL DEFAULT '{}',
    starts_at        timestamptz NOT NULL,
    ends_at          timestamptz NOT NULL,
    created_by       bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT maintenance_windows_ends_after_start CHECK (ends_at > starts_at)
);
CREATE INDEX maintenance_windows_org_idx ON maintenance_windows (org_id);

-- Constant default: a metadata-only change on Postgres 11+, no table rewrite.
ALTER TABLE incidents ADD COLUMN silenced boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE incidents DROP COLUMN silenced;
DROP TABLE maintenance_windows;
