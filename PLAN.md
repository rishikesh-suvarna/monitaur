# Monitaur Plan

Date: 2026-11-15. Sources: full read of `backend/`, `agent/`, key frontend files, two parallel review agents (Go, frontend/CI), and the graphify graph in `graphify-out/`.

Contents:
0. Decisions
1. Repo snapshot
2. Database optimisation (Neon out of compute)
3. Multi-tenancy
4. Feature roadmap
5. Code review findings
6. Suggested execution order
7. UI redesign brief (for Claude Design)

---

## 0. Decisions

| Date | Decision | Consequence |
|---|---|---|
| 2026-11-15 | **Metrics storage: B2** (stay on Neon, write-behind buffer) | Section 2.3. Neon is touched every F minutes plus on rare control-plane events, never per message or per poll. Backend stays a single stateful process. |
| 2026-11-15 | **Multi-tenant, public sign-up** | Section 3. Tenants are isolated orgs with plans and quotas. Verified email required. Agent tokens hashed at rest. |

Open, with my recommendation:
- Flush interval F: **30 min** (configurable). See the budget table in 2.3.
- Orgs now or later: **now**. Alert rules, channels, status pages and API keys are all tenant-owned, so adding orgs after them means migrating each one.
- Alert state changes: **write immediately**, not batched with the flush. They are rare after dedup, and losing alert history in a crash is worse than an extra 5-minute wake-up.

---

## 1. Repo snapshot

- ~7k lines across three deployables: Go agent, Go/Gin/GORM backend, React 19 + Vite frontend. See `CLAUDE.md` for layout and commands.
- Graphify: 444 nodes, 855 edges, 18 communities. God nodes are `Database` (28 edges), `WebSocketHandler` (26), `Server` (16), `APIHandler`, `FirebaseAuth`. No import cycles. The "Backend Handlers and Data Models" community has cohesion 0.06, which reflects handlers reaching straight into `h.db.DB` instead of going through the `Database` methods.
- Zero tests. No Makefile. Deploys run on push to `main`.

---

## 2. Database optimisation (Neon out of compute)

### 2.1 Root cause

Neon suspends compute only after **5 minutes with no queries**. The Free plan allows **100 CU-hours a month** (about 400 hours at 0.25 CU), the timeout cannot be changed, and an always-on 0.25 CU compute needs about 182 CU-hours. Monitaur never lets the DB go idle:

| Source | Code | Queries |
|---|---|---|
| Agent sends metrics every **5 s** (default) | `agent/config/config.go` `collection_interval: 5` | 12 msgs/min/server |
| Each metrics message: INSERT metric | `handlers/websocket.go:235` | 1 write txn |
| + UPDATE `servers.status` | `handlers/websocket.go:245` | 1 write txn |
| + UPDATE `servers.last_seen, status` | `handlers/websocket.go:155` | 1 write txn |
| **Total per server** (GORM wraps each in BEGIN/COMMIT, so 9 statements per message) | | **36 write txns/min, ~52k/day, 24/7** |
| Alerts: agent re-sends the same alert **every tick** while over threshold. Each one is an INSERT plus 2 lookups (server, user) plus 1 email | `agent/main.go` loop, `collector.go:CheckAlerts`, `websocket.go:285,514,521` | A host sitting at 86% memory produces **17,280 alert rows and 17,280 emails a day** |
| Every API request: `EnsureUserExists` runs `SELECT user`, then most handlers run the same `SELECT user` again | `auth/firebase.go:132`, `handlers/*.go` | 2+ redundant reads/request |
| Dashboard poll every 30 s: user x2, servers, then **per server** latest metric + unresolved alerts, then recent alerts + Preload | `handlers/dashboard.go:57-168` | 5 + 2N queries per tab per 30 s |
| Server detail poll every 30 s: **two** endpoints each fetch the full raw metrics range (720 rows at 1 h, 17,280 at 24 h, 120,960 at 1 week). `/dashboard` also returns all those rows in JSON | `dashboard.go:196,258` | 2 range scans per 30 s |
| No retention: `metrics` grows by ~17k rows/day/server, `alerts` grows the same way under alert storms | n/a | Storage and index bloat, slower scans, higher CU when autoscaled |
| Indexes: separate single-column indexes on `metrics.time` and `metrics.server_id`, none composite. `alerts` only on `server_id` | `models/models.go` | `ORDER BY time DESC LIMIT 1 WHERE server_id=?` and `resolved=false` filters cannot use an ideal index |
| GORM logger at `Info` logs every statement | `database/postgres.go:23` | CPU and log noise on the VM, not Neon, but it hides real errors |

So the DB never suspends, and the heavy range scans push autoscaling above 0.25 CU while a detail page is open.

### 2.2 Phase A: quick wins (1 to 2 days, no architecture change)

Each step stands alone and can ship as its own small PR.

> **With B2 chosen:** do A1 to A5 (A5: only the `alerts` indexes; `metrics` is replaced). Skip A6 to A10: B2 replaces the raw `metrics` table and its read path, so optimising them is throwaway work. Under B2, A1 persists `last_seen` during the flush window, not on a separate 5 to 10 minute heartbeat that would keep Neon awake by itself.

1. **Stop per-message `servers` writes.** "Online" already comes from the in-memory `connections` map (`IsAgentConnected`). Write `status`/`last_seen` only on connect and disconnect, plus at most once every 5 to 10 minutes as a heartbeat. Saves 2 of the 3 writes per message.
   ```go
   // websocket.go, in the read loop
   if time.Since(agentConn.lastPersisted) > lastSeenPersistInterval {
       h.db.UpdateServerLastSeen(agentConn.server.ID)
       agentConn.lastPersisted = time.Now()
   }
   ```
2. **Alert state machine on the backend.** Keep an in-memory map `(serverID, type) -> openAlertID`. INSERT only when the state changes from OK to FIRING, auto-resolve (UPDATE) on FIRING to OK, and enforce an email cooldown. Takes alert writes from thousands a day to a handful. Also cache the owner email on `AgentConnection` at connect time so emails need no DB lookups.
3. **GORM config:** `SkipDefaultTransaction: true` (drops BEGIN/COMMIT around single inserts), `PrepareStmt: true`, logger `Warn` unless `GIN_MODE=debug`. Add `SetConnMaxIdleTime(2 * time.Minute)` so no idle connection lingers.
4. **Cache identity.** `EnsureUserExists` resolves `uid -> users.id` once and stores it in the Gin context; keep a process-wide `sync.Map` or small LRU (users are immutable apart from email). Handlers read `c.MustGet("user_id")` instead of calling `GetUserByUID` again. Removes 2+ queries per request.
5. **Indexes** (one migration):
   ```sql
   CREATE INDEX CONCURRENTLY idx_metrics_server_time ON metrics (server_id, time DESC);
   DROP INDEX IF EXISTS idx_metrics_server_id; -- covered by composite
   CREATE INDEX CONCURRENTLY idx_alerts_open ON alerts (server_id, created_at DESC) WHERE resolved = false;
   CREATE INDEX CONCURRENTLY idx_alerts_server_created ON alerts (server_id, created_at DESC);
   ```
6. **Server-side downsampling.** Chart queries return at most ~300 buckets using `date_bin` (PG14+, works on Neon without Timescale):
   ```sql
   SELECT date_bin($bucket, time, TIMESTAMPTZ 'epoch') AS t,
          avg(cpu_usage), max(cpu_usage), avg(memory_percent), avg(disk_percent),
          max(network_bytes_in), max(network_bytes_out)
   FROM metrics WHERE server_id = $1 AND time >= $2
   GROUP BY 1 ORDER BY 1;
   ```
   Bucket = range / 300 (1 h -> 12 s, 24 h -> ~5 min, 1 w -> ~34 min). Compute statistics in the same query or a sibling aggregate query, not in Go over every row.
7. **Merge the two detail endpoints.** `/servers/:id/dashboard` should not return the raw `metrics` array. One downsampled series payload containing all metric types replaces `/chart?type=` per metric, so switching tabs is free on the client.
8. **Batch the dashboard.** Replace the per-server loop with two set-based queries: `DISTINCT ON (server_id) ... ORDER BY server_id, time DESC` for latest metrics, and one `WHERE server_id IN ? AND resolved = false` for open alerts.
9. **Retention job.** A goroutine runs every hour and deletes raw metrics older than `retention.raw_days` (default 7) in batches of 10k rows. This bounds both storage and scan cost.
10. **Agent default interval.** Keep collection at 5 s for alert responsiveness, but send at 15 s by default (or send averages of the 5 s samples). This cuts ingest by 3x even before Phase B.

Expected effect: write volume drops by roughly 80 to 90% and read cost by an order of magnitude. On its own that is **still not enough to let Neon sleep**, because any ingest more often than every 5 minutes keeps it awake. Phase B is what fixes the compute bill.

### 2.3 Phase B2: write-behind buffer on Neon (decided)

**Rule:** Neon gets touched on a schedule (every F minutes) and on rare control-plane events (sign-in cache miss, CRUD, alert state change, a long-range chart cache miss). Never per agent message, never per dashboard poll.

#### 2.3.1 Data path

```
agent --ws--> ingest --> per-server state
                           |-- raw ring: last 60 min of 5 s samples --> "latest", live and 1 h reads, alert evaluation
                           |-- minute aggregator --> closed 1 m bucket
                           |                           |-- recent ring: last 24 h --> 6 h / 24 h reads
                           |                           |-- journal file (append, fsync per batch)
                           |                           '-- flush queue --every F--> Neon metrics_1m
                           |-- hour aggregator (from 1 m buckets) --> flush queue --> Neon metrics_1h
                           '-- alert state machine --on transition only--> Neon alerts (immediate) + notifier
```

New package `backend/metrics` (a `Store`), separate from `handlers/websocket.go`. The WebSocket handler just calls `store.Ingest(serverID, sample)`. That separation also fixes the review finding about DB writes happening while the global connection mutex is held.

#### 2.3.2 Components

1. **Per-server state:** `serverState{mu, raw ring[Sample], curMinute agg, recent ring[Bucket], lastNet counters}` in a `map[serverID]*serverState`. Store fields as `float32`: about 50 B per sample and 70 B per bucket, so **about 140 KB per server** (36 KB raw + 100 KB of 24 h buckets). 1,000 servers is about 140 MB of RAM. Ring sizes are config knobs.
2. **Minute aggregator:** count, plus avg/max for CPU % and memory %, avg for disk %, last value for totals and uptime. Network **rates** come from counter deltas divided by elapsed time, clamped to 0 on a counter reset (reboot). This fixes the backwards and negative network chart. A 1 s ticker closes a bucket once its minute plus a 5 s grace period has passed, so a disconnected agent still closes its final bucket.
3. **Hour aggregator:** built from closed minute buckets when the hour rolls over.
4. **Flusher:** runs every `metrics.flush_interval` (default 30 m) and on SIGTERM (graceful shutdown with a 20 s budget). It drains the queue into one transaction of multi-row `INSERT ... ON CONFLICT (server_id, bucket) DO NOTHING` in batches of 1,000.
   - On error: requeue with backoff.
   - The queue is capped at `metrics.max_pending` (default 48 h of buckets). Past the cap, drop the oldest and count `dropped_buckets`.
5. **Journal:** append closed buckets as JSON lines to `/var/lib/monitaur/journal/<flush-epoch>.jsonl`, rotate at each flush, and delete a file once its flush has committed. On startup, replay any leftover files into the queue. The primary key plus `ON CONFLICT` makes replay idempotent. **The loss window on a hard crash is the currently open minute**, not F.
6. **Housekeeping runs in the flush window** (same wake-up, no extra one):
   - Retention deletes per plan (section 3.4).
   - A batched `last_seen` update: `UPDATE servers s SET last_seen = v.ts FROM (VALUES ...) v(id, ts) WHERE s.id = v.id`.
   - Refresh of the plan and limit caches.
   - Nothing else may schedule background DB work.
7. **Control-plane caches** (single process, so write-through is trivial):
   - `uid -> user` and `token_hash -> server`, so agent reconnects after a deploy need no DB.
   - `org -> servers list`, invalidated on create/delete/rename.
   - Open alerts, which are already in the state machine.
   - Result: `/dashboard` and `/servers` cost **zero queries** on a cache hit.

#### 2.3.3 Read path

`GET /api/v1/servers/:id/series?range=1h|6h|24h|7d|30d` returns every metric in one payload of at most ~360 points, plus min/avg/max. It replaces `/metrics`, `/chart` and the `metrics` array in `/servers/:id/dashboard`.

| Range | Source | Resolution | DB? |
|---|---|---|---|
| live / 1 h | raw ring | 10 s | no |
| 6 h | recent ring | 1 m | no |
| 24 h | recent ring | 4 m | no |
| 7 d | `metrics_1h` + current hour from memory | 1 h (168 pts) | once per F per server |
| 30 d | `metrics_1h` + memory | 2 h (360 pts) | once per F per server |

After a restart the rings start empty. Journal replay refills unflushed buckets, and any remaining gap in a memory-backed range is filled from `metrics_1m` with one query that stays cached until the next flush. So "no DB" in the table above means steady state.

DB metric data only changes at flush time, so long-range DB results are **cached until the next flush**, keyed by `(server, range)`. A week-long chart costs at most one query per flush interval no matter how many tabs poll it. The frontend polls `/series` every 10 s for live/1 h (memory, cheap) and every 5 min for 24 h and longer; F4 later swaps polling for SSE.

#### 2.3.4 Schema and migration

```sql
CREATE TABLE metrics_1m (
  server_id        bigint      NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  bucket           timestamptz NOT NULL,
  samples          smallint    NOT NULL,
  cpu_avg real, cpu_max real,
  mem_avg real, mem_max real,
  disk_avg real,
  mem_total_bytes bigint, disk_total_bytes bigint, disk_used_bytes bigint,
  net_in_bps_avg real, net_in_bps_max real,
  net_out_bps_avg real, net_out_bps_max real,
  uptime_s bigint,
  PRIMARY KEY (server_id, bucket)
);
CREATE TABLE metrics_1h (LIKE metrics_1m INCLUDING ALL);
ALTER TABLE metrics_1h ADD FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
```

- `ON DELETE CASCADE` replaces the manual metric delete in `DeleteServer`.
- `real` (float4) keeps rows at about 130 B including the PK index.
- Move to versioned SQL migrations with **goose** (`backend/database/migrations/` already exists with a `.keep`). AutoMigrate cannot express composite PKs, partial indexes or `CONCURRENTLY`.
- Cutover, in order:
  1. Deploy B2 with raw writes off.
  2. Backfill the last 7 days: `INSERT INTO metrics_1m SELECT server_id, date_bin('1 minute', time, TIMESTAMPTZ 'epoch'), count(*), avg(cpu_usage), max(cpu_usage), ... FROM metrics GROUP BY 1, 2 ON CONFLICT DO NOTHING`. Network rates stay NULL for backfilled history.
  3. Backfill `metrics_1h` from `metrics_1m`.
  4. `DROP TABLE metrics` a week later.

#### 2.3.5 Neon budget with B2

Each flush wakes Neon for about 5 min (the fixed suspend timeout) plus a few seconds of work.

| F | Wake-ups/day | Awake h/month | CU-h/month at 0.25 CU | Headroom on Free (100) |
|---|---|---|---|---|
| 15 m | 96 | ~248 | ~62 | 38 |
| **30 m** | 48 | ~124 | **~31** | **69** |
| 60 m | 24 | ~62 | ~16 | 84 |

The headroom pays for user-driven wake-ups, each at least 5 min unless it lands inside an already-awake window: cache misses after a deploy, CRUD, alert transitions, long-range chart cache misses. Expose `neon_wakeups_estimate` in `/debug/stats` (count distinct 5-minute windows that contained a query) so a regression shows up as a number.

**Storage:** about 190 KB/day per server in `metrics_1m`. At Free-plan retention (7 d of 1 m data + 30 d of 1 h data) that is about 1.5 MB per server, so Neon's Free storage (0.5 GB per project at last check) fits roughly **300 servers**. Past that, the levers are plan retention or Neon Launch.

#### 2.3.6 Trade-offs accepted with B2

- The backend must stay a **single instance** (it already has to because of the connection map). Horizontal scale later would need a shared queue (Redis/NATS) or a move to B1/Timescale.
- History in Neon lags by up to F. Reads merge memory and DB, so users do not see the lag. External consumers of the DB would.
- Up to about 1 minute of data is lost on a hard crash (journal), and none on a clean restart.

### 2.4 Options not chosen

**B1. Embedded store for time series:** SQLite on the VM for metrics, Neon only for the control plane. Lowest Neon usage (single-digit CU-hours), but two data stores and Litestream backups to run. Still a good fallback if Neon's storage cap becomes the constraint.

**Others**
- Self-hosted Postgres + TimescaleDB on the VM. The code already tries `create_hypertable` and would gain compression, continuous aggregates, and retention policies. Best long-term TSDB story, but you run Postgres yourself and need more VM RAM.
- Managed TSDB (Grafana Cloud/Prometheus remote write, InfluxDB Cloud, ClickHouse Cloud free tiers). Offloads ops, but adds another vendor and auth surface. Revisit once multi-tenant usage outgrows a single backend process.
- Paid Neon Launch plan (about $0.106/CU-hour). Always-on 0.25 CU costs about $19/month. That is the simplest fix if you just want it to work, and Phase A still matters so autoscaling stays at 0.25.

### 2.5 Measuring it

- Before/after: Neon console "Compute usage" per day, plus `pg_stat_statements` top 10 by `calls` and `total_exec_time`.
- Add a `/debug/stats` (admin only) or log line every 10 minutes: messages ingested, DB writes issued, buffer sizes. A regression should show up as a number, not a bill.

---

## 3. Multi-tenancy (decided: public sign-up, isolated tenants)

Today data is isolated **per user**, and any Firebase account is auto-provisioned. Opening this to strangers means isolation, abuse limits, and resource caps all have to be explicit.

### 3.1 Tenancy model: organizations (pulls F13 forward)

- Tenant = **organization**. New tables:
  - `organizations(id, name, plan_id, created_at)`
  - `memberships(org_id, user_id, role)`, with role one of `owner | admin | member | viewer`
  - `invites(org_id, email, role, token_hash, expires_at)`
- First sign-in creates the user, a personal org, and an owner membership in **one transaction** using `INSERT ... ON CONFLICT DO NOTHING`. That also fixes the get-then-create race from 5.1.
- `servers.user_id` becomes `servers.org_id`. Migration: one personal org per existing user, backfill `org_id`, keep `user_id` renamed to `created_by`.
- Everything new is org-scoped from day one: alert rules (F2), channels (F3), status pages (F8), API keys (F14).
- Trade-off: about 2 to 3 extra days up front, and the UI needs an org switcher (hidden while a user belongs to only one org).

### 3.2 Isolation rules

- **One authz helper**, used by every handler: `requireServer(c, serverID, minRole) (*models.Server, error)`, which joins `memberships` on `org_id`. Inline `Where("user_id = ?")` in handlers goes away.
- **Caches are tenant-keyed** (`org -> servers`). No global listing endpoint exists.
- **Agent tokens hashed at rest:** store `sha256(token)` in `servers.token_hash` and look agents up by hash. Show the plaintext token once, on create or rotate, prefixed `mtr_` so secret scanners can flag it. A DB leak then exposes no tenant's ingest credentials. Rotation and revocation (F5) ship with this.
- **Cross-tenant test suite:** table-driven `httptest`. For every endpoint, user B requesting org A's IDs gets 404. It runs in CI and is the main control.
- Postgres RLS is **not** recommended for now (GORM with a single DB role makes it awkward). Revisit if a second service ever touches the DB.

### 3.3 Sign-up hygiene

- **Require `email_verified`** for password accounts before provisioning. The backend returns `403 {code: "email_unverified"}` and the frontend shows a verify screen with a resend button (`sendEmailVerification`). Google sign-ins arrive verified.
- Fix the unchecked `Claims["email"].(string)` panic (5.1 Medium).
- **Firebase App Check** (reCAPTCHA Enterprise) on the frontend, verified by the backend, to block scripted sign-ups.
- In-memory token-bucket rate limits: `/api/v1` per user and per IP, and `/agent/connect` per IP and per token.
- Org/account deletion (cascading) and data export. Strangers will ask.

### 3.4 Plans and quotas

A `plans` table holds these limits, and `organizations.plan_id` points at a row. Billing (Stripe) is out of scope; the plan column is where it plugs in later.

| Limit | Free default | Enforced at |
|---|---|---|
| Servers per org | 3 | `CreateServer` -> `403 {code: "limit_reached"}` |
| Min agent send interval | 10 s | Ingest: a per-connection limiter merges faster samples; the agent learns the minimum via config push (F10) |
| `metrics_1m` retention | 7 days | Flush housekeeping |
| `metrics_1h` retention | 30 days | Flush housekeeping |
| Members per org | 3 | Invites |
| Alert emails | 20/day/org, at most 1 per (server, type) per 30 min | Notifier |
| Alert rules / channels | 10 / 2 | Rules API |
| API requests | 60/min/user, burst 20 | Middleware |
| Agent WS frame | 64 KB | `conn.SetReadLimit` |

### 3.5 Shared-infrastructure risks

- **Memory:** all tenants' buffers live in one process, about 140 KB per server (2.3.2). Show per-org server counts and buffer bytes in `/debug/stats`.
- **Neon storage:** about 300 servers fit at Free retention (2.3.5). Retention per plan is the lever.
- **Noisy neighbour:** the per-connection ingest limiter and per-org caps stop one tenant from flooding the flush queue or the notifier.
- **Email reputation:** one SES identity is shared by all tenants. Before opening sign-up widely:
  - Send from a domain you control with SPF/DKIM/DMARC, and remove the hardcoded `smtp.from` default in `backend/config/config.go`.
  - Handle SES bounce and complaint notifications.
  - Escape tenant-controlled server names and messages in emails (5.1 Low), since they now come from strangers.
- **CORS and WebSocket origin:** with public sign-up, `allow_origins: *` and `CheckOrigin: true` must become an explicit allowlist.

### 3.6 Frontend changes

- Verify-email screen, org switcher, members and invites page, and a plan/usage page ("2 of 3 servers").
- Handle `limit_reached` with an upgrade hint.
- Include `orgId` in every query key, and `queryClient.clear()` on logout and on org switch (5.2 Medium).

---

## 4. Feature roadmap

Ranked by user value against effort. "Needs" lists hard dependencies on section 2.

### Now (high value, small to medium)
| # | Feature | Why | Needs |
|---|---|---|---|
| F1 | **Server down alerts** (agent disconnected for > N min) | The most important monitoring alert is missing: a dead host today just turns "offline" silently | Alert state machine (A2) |
| F2 | **Alert rules in the UI**: per-server thresholds, duration ("CPU > 90% for 5 min"), warning/critical levels, auto-resolve, cooldown | README promises "set up custom alert thresholds" but they only exist in the agent's config file | A2; move evaluation to the backend |
| F3 | **Notification channels**: Slack, Discord, Telegram, generic webhook, per-channel routing | README Phase 2; email-only is noisy and SMTP is fragile | F2 |
| F4 | **Live dashboard over WebSocket/SSE** from the ring buffer | Real-time feel, and removes polling load entirely | B2 raw ring (2.3.2) |
| F5 | **Token management**: regenerate/revoke server tokens, show last connect IP and agent version | Tokens are permanent UUIDs today with no rotation | Ships with token hashing (3.2) |
| F6 | **Richer host metrics**: load average, swap, per-mount disk, per-interface net, disk I/O, temperatures. Compute network *rates* in the agent | Network charts currently diff counters in the browser | Agent + model change |

### Next (medium value or effort)
| # | Feature | Notes |
|---|---|---|
| F7 | Uptime checks: HTTP(S)/TCP/ping/SSL-expiry monitors run from the backend | Turns Monitaur into host + endpoint monitoring; small scheduler + results table |
| F8 | Public status pages per org | Builds on F7 and F1 |
| F9 | Process and service view: top N processes, systemd unit status, Docker container stats | Agent collectors behind feature flags |
| F10 | Remote agent config: change interval and thresholds from the UI; agent self-update | `SendMessageToAgent` already exists and is unused |
| F11 | Maintenance windows and alert silencing | Needed once F1 and F3 are noisy |
| F12 | Server tags/groups, search, fleet overview heatmap | Scales the UI past ~10 servers |

### Later (bigger bets)
| # | Feature | Notes |
|---|---|---|
| F13 | ~~Teams/orgs with roles~~ | **Pulled forward into section 3.1** |
| F14 | Prometheus `/metrics` exporter and read API keys | Lets people pipe Monitaur into Grafana |
| F15 | AI incident summary: on alert, send the last 30 min of metrics + top processes to Claude (`claude-sonnet-5-5` for cost, `claude-opus-5-5` for deep dives) for a plain-English "what happened" in the alert email | Differentiator; needs F9 for useful context |
| F16 | PWA + web push notifications, mobile-first views | Pairs with the UI redesign |
| F17 | Windows/macOS service install in `install.sh` (today it is Linux/systemd only) | Release workflow already builds those binaries |

---

## 5. Code review findings

Two independent review agents (Go, and frontend/CI) read the code without seeing my DB analysis, and I spot-checked the critical items against the source. `go vet` passes on both modules. **Authorization is sound**: every `/servers/:id/*` and `/alerts/:id/*` route scopes by `user_id`, and every query is parameterized.

### 5.1 Go: backend and agent

**Critical**
- `agent/client/websocket.go:87,103,128`: two goroutines write to the same socket (the main loop sends metrics, the heartbeat sends pings), and `c.conn` is read and set to nil without a lock. Gorilla panics with "concurrent write to websocket connection", or `SendMetrics` hits nil mid-reconnect, so the agent crash-loops under systemd. Fix: one writer goroutine owns the conn (send channel, `WriteControl` for pings), and a mutex guards `conn`.
- `agent/client/websocket.go:136-177`: reconnect is broken. `ListenForMessages` is never restarted after a reconnect, the heartbeat and the listener both call `handleDisconnection`, and every successful reconnect starts another `StartHeartbeat`. After one network blip the agent stops reading, so it never answers the backend's pings and gets dropped every 60 s. `agent/main.go:82` also exits if the *first* connect fails. Fix: a single supervisor loop (dial with backoff, then start reader and writer, wait for either to exit, repeat).
- `agent/metrics/collector.go:121-157` + `backend/handlers/websocket.go:285,293`: no alert dedup or cooldown. Every 5 s tick over threshold creates an alert row and sends an email (about 17k a day per breached metric). Risks SES throttling or suspension. Fix: the DB plan item A2.

**High**
- `backend/handlers/websocket.go:105,561`: the connection map is keyed by server ID only. A reconnect overwrites the entry without closing the old socket, and when the old socket later times out its unregister deletes the *new* entry, so the dashboard shows "offline" while metrics keep flowing. Fix: close the previous conn on register, and only delete in unregister if `h.connections[id] == agentConn`.
- Token leakage into logs: the agent logs the full URL including `?token=` (`client/websocket.go:54`), Gin's default logger records the query string (`main.go:69`), and GORM at `Info` prints `WHERE token = '...'` and user emails (`postgres.go:23`). Fix: send the token in an `Authorization` header on dial, redact it in logs, and set the GORM logger to `Warn`.
- Unbounded metric queries: `/servers/:id/metrics?hours=` has no upper cap (a huge `hours` overflows the duration), the alerts `limit` is uncapped (`api.go:254`), and each metric row serializes an empty nested `server{user{}}` because `omitempty` does nothing on struct fields (`models.go:66`). Fix: cap the inputs, downsample (A6), and mark relation fields `json:"-"`.
- Dashboard N+1 queries plus unlimited unresolved alerts per server (`dashboard.go:92-139`). Fix: A8.

**Medium**
- `agent/scripts/build.sh:30,43`: on non-Windows targets the binary path is the same as `pkg_dir`, so `mkdir -p` fails and the script aborts on linux/amd64. CI is not affected because `agent-release.yml` runs `go build` inline, but the local script is broken.
- The "warning" status is never visible: it is set at `websocket.go:245`, overwritten with "online" by `UpdateServerLastSeen` (`:155`), and the API forces online/offline again (`api.go:63`).
- `auth/firebase.go:66`: the unchecked `Claims["email"].(string)` panics for phone, anonymous, or custom-token users, so every request returns 500. Use comma-ok.
- Data race on `lastPing` (the pong handler writes it without the lock, cleanup reads it with the lock). `unregisterConnection` and the cleanup loop also do DB writes *while holding the global mutex*, so a cold Neon wake-up blocks every `IsAgentConnected` call and with it every API request.
- `DeleteServer` ignores the `tx.Commit()` error and does not disconnect the live agent, so later inserts fail on the foreign key.
- SMTP: `net.Dial` has no timeout (`websocket.go:348`) and the `w.Close()` error is ignored (`:392`), so rejected mail is logged as "sent" and a blackholed host leaks a goroutine per alert.
- The agent sets no read or write deadlines and no pong handler, so a half-open TCP connection blocks writes for minutes.
- "Uptime" is the agent *process* uptime (`collector.go:62`), not the host's, and the dashboard averages it under the name `TotalUptime`. Use `host.Uptime()`.
- `create_hypertable` can never succeed because the primary key `id` does not include `time`.

**Low**
- `config.go:64`: `AutomaticEnv` without `SetEnvKeyReplacer(".", "_")`, so `DATABASE_PASSWORD` and similar variables are silently ignored.
- Get-then-create race in `GetOrCreateUser`, which also logs the user email on every request. Use `INSERT ... ON CONFLICT DO NOTHING`.
- Network bytes are cumulative counters charted as-is. Send deltas or rates (F6).
- The agent only emits `warning`, so `CriticalAlerts` is always 0. Thresholds also disagree: 80/85/90 in the dashboard vs 90/95/95 for backend status.
- No graceful shutdown and no `ReadHeaderTimeout` (`main.go:114`). Statuses also stay "online" after a restart; reset them on boot.
- `CheckOrigin` always returns true, CORS defaults to `*` and accepts a single origin, and the default `sslmode=disable`.
- No `conn.SetReadLimit`, so a token holder can send huge frames.
- Agent-supplied `server_name` and `message` go unescaped into the email subject (CRLF header injection) and HTML body. Use `html/template` and strip CR/LF.
- `SendMessageToAgent` can send on a channel that was just closed, which panics (unused today, but F10 will use it).
- The `gin.Mode()` check in `main.go:66` does nothing, so production runs in debug mode unless `GIN_MODE` is set.
- Every connect overwrites the dashboard-given server name with the agent hostname via a full-row `Save`.
- The agent `config.json` holding the token is written 0644. Use 0600.

### 5.2 Frontend, CI, installer

No secrets are committed. `frontend/.env.development.local`, `agent/config.json` and `backend/config.yaml` are gitignored, and a scan of git history found no keys.

**High**
- `frontend/src/config/api.js:28-31`: any 401 hard-redirects to `/login` without signing out, and `/login` is not a route (the catch-all sends it to `/`). If the backend keeps rejecting a valid Firebase session (wrong project, clock skew), the tab reloads forever and logout cannot be reached. Fix: retry once with `getIdToken(true)`, then `signOut(auth)`.
- `ServerDetail.jsx:31-41`: both 30 s polls scan the full raw range, and the UI only reads `metrics[0]` and `statistics` from `/dashboard`. At 1 week and a 5 s interval that is about 484k rows per minute per open tab. Fix: A6 + A7.
- `.github/workflows/backend-deploy.yml:64-66,83` (PLAUSIBLE, check on the host): with `source: ./backend/...` + `strip_components: 1`, the binary probably lands at `/tmp/backend/monitaur-backend`, but the script runs `mv /tmp/monitaur-backend`. The frontend workflow needed exactly this path fix (commits b96f3f0, 3a99c0b). `ssh-action` does not stop on errors, so the old binary restarts and the job goes green. **The backend may never have been updated by CI.** Verify: `ls -la /tmp/backend/ /usr/local/bin/monitaur-backend` on the VM. Fix: correct the path and add `script_stop: true` / `set -euo pipefail`.
- `frontend-deploy.yml:222-260`: rollback runs on *any* failure, including a failed `yarn build` before the backup step, and restores a stale `/tmp` backup over the live site. Fix: gate it on `steps.deploy.outcome == 'failure'`.
- `install.sh:59,67,78,148`: runs as root with fixed `/tmp` paths and then executes the extracted binary, so a local user can pre-create the directory and swap the binary to get root. Fix: `mktemp -d` + `trap`.

**Medium**
- `curl | sudo bash` pulls `install.sh` from `main`, not the tag, and releases ship no checksums. Publish `SHA256SUMS`, verify it with `sha256sum -c`, and pin the URL to the tag.
- `install.sh:78`: `cp` over a running binary fails with "text file busy", so upgrades abort halfway under `set -e`. Use `install -m0755` + `systemctl try-restart`.
- `AuthContext.jsx:51-58`: logout does not `queryClient.clear()`, so the next user on the same tab briefly sees the previous user's servers and tokens.
- Agent tokens are shown in plaintext on the Servers page and returned in every list and poll (including through `Preload("Server")`), with no way to rotate them. Return them only on create, mask them in the UI, and add rotation (F5).
- Open sign-up: anyone can create a Firebase account, and the backend auto-provisions it. Decide between single-tenant (disable sign-up in Firebase + backend allowlist) and multi-tenant (require `email_verified` + quotas).
- `AlertsPage.jsx:20-58`: errors are swallowed to `[]`, so a DB outage shows "All systems running smoothly". Surface `isError` and use `isPending`.
- `mutation.isLoading` does not exist in TanStack Query v5 (`AddServerModal.jsx:103`, `ServersPage.jsx:152`, `AlertsPage.jsx:240`), so the buttons never disable and a double-click creates two servers. Use `isPending`.
- `ServerDetail.jsx:264-307`: network rates are computed from the unsorted newest-first array, so the network axis runs backwards and a counter reset plots a large negative spike.
- `backend-deploy.yml:78-135`: the service stops before the new binary is validated, a failed health check does not fail the job, `-version` is not a backend flag, and the rollback glob breaks after two deploys.
- All workflows pin third-party actions to mutable tags while handing them `SSH_PRIVATE_KEY` (sudo on prod), with no host `fingerprint`. Pin to SHAs. There is also no `concurrency` group on the deploy workflows.

**Low**
- `invalidateQueries(['x'])` is v4 syntax; in v5 it matches every query, and each mutation calls it twice.
- AlertsPage makes 1 + N requests; add `GET /alerts`. ServerDetail fetches alerts separately even though `/dashboard` already returns them.
- Non-atomic frontend deploy (switch a symlink instead). Yarn 1 silently ignores `--immutable` (use `--frozen-lockfile` + `setup-node cache: yarn`).
- CI `go-version: '1.21'` vs `go 1.24` in `go.mod`, and no `go vet`/`go test` step. Use `go-version-file`.
- `agent-release.yml` passes the dispatch `version` input unvalidated into shell.
- The agent config written by `install.sh` is 0644 in a 0755 dir; use 0600/0750.
- `AddServerModal.jsx:44-54` builds config JSON by string interpolation; use `JSON.stringify`. **It also suggests `collection_interval: 30` while `install.sh` and the agent default to 5.** Pick one (see A10).
- Unhandled `mutateAsync` rejections. A `warning` server shows a red "offline" dot. The empty-state "Add Server" button has no handler. Settings mentions a "Forgot password" flow that does not exist.
- `tailwind.config.js:62-66`: `plugins` is nested inside `theme`, so `@tailwindcss/forms` never loads. Moving it will visibly change inputs.
- A missing `VITE_APP_SERVER_URL` silently produces `undefined/api/v1`; fail fast instead.

### 5.3 Health summary

Authorization and SQL safety are good. The weak spots are (1) the agent's WebSocket client lifecycle (concurrent writes and broken reconnect), (2) alert storms, (3) DB access patterns (section 2), and (4) deploy scripts that can report success without deploying. No tests anywhere, and CI never runs `go vet` or a linter.

---

## 6. Suggested execution order

### Status (2026-11-15)

| Step | State | Where |
|---|---|---|
| 1 Deploy ships | Done: broken path confirmed on the VM and fixed; actions pinned; journal dir | PR #2 `fix/backend-deploy-install` |
| 2 Hotfixes | Done. Agent: PR #1, then `feat/agent-v2`. Backend items are built into v2 (the v1 handlers were replaced, so patching them first would have been throwaway) | PR #1, `feat/agent-v2`, `feat/platform-v2` |
| 3 Foundations | Done: goose migrations, PR CI for agent, backend (with Postgres) and frontend | `fix/infra-hardening` (ci.yml), `feat/platform-v2` |
| 4 Phase A | Done, folded into v2: no per-message writes, server-side alert state machine with F1, quiet logging, identity and role caches, incident indexes | `feat/platform-v2` |
| 5 B2 | Done: metrics store, rollups, journal, flush window, `/series`, directory caches, legacy backfill job | `feat/platform-v2` |
| 6 MT core | Done: verified-email gate, App Check (opt-in), rate limits, orgs, memberships, invites, plans and quotas, hashed tokens with rotation | `feat/platform-v2` |
| 7 MT launch gate | Done in code: CORS/WS origin allowlist, invites, deletion and export. Ops left: SES sending domain (SPF/DKIM/DMARC) and SES account-level suppression list for bounces and complaints (chosen over a custom SNS webhook) | `feat/platform-v2`; ops checklist in the PR |
| 8 UI redesign | In progress | `feat/frontend-redesign` |
| 9 Features | F1 to F5, F8, F12 (tags, search) done. F6 is partial (network rates). F7, F9, F10 (beyond interval push), F11 and F13 onwards stay on the roadmap | section 4 |

Small, focused PRs, rebase-merged, each on its own branch.

Tracks: **B2** (the Neon bill) runs first, **MT** (multi-tenancy) second. Public sign-up stays closed (Firebase sign-up disabled) until step 7 is done.

1. **Verify the backend deploy actually ships** (5.2 High: check `/tmp/backend/` on the VM). Every backend fix depends on it.
   - **2026-11-15: confirmed broken.** The prod binary dates from Aug 14 2025; the Dec 13 2025 CI build sat unused in `/tmp/backend/`. The fix is in PR #2 (`fix/backend-deploy-install`).
   - **Agent hotfix:** PR #1 (`fix/agent-ws-lifecycle`), the single-writer client + supervised reconnect.
2. **Hotfix PRs**, one each:
   - Agent single writer + supervisor reconnect (5.1 Critical).
   - Connection-map overwrite.
   - Token out of logs + GORM `Warn`.
   - Email-claim panic.
   - `SetReadLimit`.
   - Email header/HTML escaping.
   - The 401 loop.
   - `isPending`.
   - Frontend rollback gate.
   - `install.sh` `mktemp`.
3. **Foundations:** goose migrations replace AutoMigrate for new tables, and CI gains `go vet` + `go test ./...` (via `go-version-file`) and frontend `lint` + `build`. Everything after this lands with tests.
4. **Phase A remainder:**
   - A1: `servers` writes out of the hot path.
   - A2: alert state machine, with F1 server-down alerts.
   - A3: GORM config.
   - A4: identity cache.
   - A5: `alerts` indexes only.
   - **Neon usage should drop sharply here.** Measure it.
5. **B2**, four PRs:
   - a. `backend/metrics` store: rings, minute and hour aggregation, network rates. Table-driven tests for bucket boundaries, gaps, and counter resets.
   - b. `metrics_1m`/`metrics_1h` + flusher + journal + graceful shutdown + flush-window housekeeping. Raw `metrics` writes stop here. **Measure Neon again**; target under 40 CU-h/month.
   - c. `/series` read path, flush-scoped cache, control-plane caches, frontend switched to `/series`.
   - d. Backfill, then drop `metrics` a week later.
6. **MT core:**
   - a. `email_verified` gate + verify screen + App Check + rate limits.
   - b. Orgs/memberships migration + `requireServer` + cross-tenant test suite.
   - c. Token hashing + rotation (F5).
   - d. Plans and quotas.
7. **MT launch gate:**
   - a. SES sender domain + bounce/complaint handling.
   - b. CORS/WS origin allowlist.
   - c. Invites + members UI.
   - d. Deletion/export.
   - Then re-enable public sign-up.
8. **UI redesign** (section 7) once the `/series` API and the org model are stable, so the design targets the real endpoints.
9. **Features:** F2 and F3 (org-scoped), F4 live SSE, then the Next tier.

---

## 7. UI redesign brief (for Claude Design)

Paste the block below into Claude Design as is.

```text
Redesign the web dashboard for Monitaur, a self-hosted server monitoring and alerting tool.

PRODUCT
A tiny Go agent runs on each Linux server and streams CPU, memory, disk, network and uptime every few seconds to a backend. Users sign in (Firebase: Google + email/password), add a server, paste a generated token into the agent config, and then watch live health and get alerts. Users are solo developers and small teams running 1 to 50 VPS/bare-metal boxes. They open the dashboard when something feels wrong, or glance at it on a second monitor. It must answer "is anything on fire?" in under 2 seconds, then let them drill into why.
Monitaur is multi-tenant with public sign-up. Every user works inside one or more organisations (a personal org by default) with roles owner / admin / member / viewer, and each org is on a plan with limits (number of servers, data retention, alert emails per day).

BRAND
- Name: MONITAUR (monitor + saur). Mascot: a friendly line-art T-rex standing next to a 3-unit server rack under a heartbeat line. Current assets are black line art on white (logo.png, logo-icon.png, icon.svg).
- Keep the dino as the identity, with personality in empty states, the 404 page, onboarding and the "all systems healthy" state. Keep the data views themselves calm and serious.
- Current UI is all grayscale with Manrope at light weights. Status colours are literally indistinguishable today (success, warning and danger all map to the same grays). Fix this. Propose a restrained palette where colour is reserved for status: healthy, warning, critical, offline/unknown, plus one brand accent. Status must also be readable without colour (icon + label) for colour-blind users.
- Deliver light and dark themes. Dark is likely the default for the "second monitor" use case.
- Type: a clean grotesk for UI and a tabular-figure mono for numbers, so metric values do not jitter as they update.

SCREENS (design all of these, desktop 1440 px and mobile 390 px)
1. Sign in / sign up: Google button + email/password, with the dino. One-screen, no marketing fluff. Plus a "verify your email" screen (resend, change email) that password sign-ups land on before they can use the app.
2. Onboarding / empty state: no servers yet. A three-step "Add your first server" flow: name it, copy the one-line install command (curl ... | sudo bash) and config with the token, then a live "waiting for agent to connect..." state that flips to "Connected" when the first metric arrives. The agent token is shown only once (it is stored hashed), so make that obvious: a prominent copy button, a "you won't see this again" note, and a pointer to rotating it later in server settings.
3. Overview (home): fleet summary (total / healthy / warning / critical / offline), a dense server grid or table with per-server status, CPU, memory, disk sparklines and last-seen time, plus an "active incidents" rail. Must scale from 1 to 50 servers: offer grid and compact-table toggles, sorting, search, and tag filters.
4. Server detail: header with name, status, uptime, agent version, last seen, and tags. Time-range picker (live / 1 h / 6 h / 24 h / 7 d / 30 d). Charts for CPU, memory, disk and network in/out rates, either all four stacked with a shared crosshair or as a small-multiples grid. Min/avg/max stat chips. Alert threshold lines drawn on the charts. Alert history for this server. Settings tab: rename, tags, alert rules, rotate token, delete (with type-to-confirm).
5. Alerts / incidents: a list across all servers with filters (open / resolved, severity, server, type), grouped by incident rather than one row per sample. Each row shows when it started, how long it lasted, the peak value vs threshold, and an acknowledge / resolve action. Include a "server unreachable" alert type.
6. Alert rules: create and edit rules per server or for all servers. Pattern: "When [metric] is [above] [90]% for [5 min], raise [critical], notify [channels]". Include cooldown and auto-resolve toggles.
7. Notification channels: email, Slack, Discord, Telegram, webhook. Each card has connect, test, and enable/disable.
8. Settings: profile, theme, API endpoint info, sign out, danger zone (delete account, export data).
9. Organisation: an org switcher in the sidebar header (hidden when the user has only one org), a members list with role pickers, pending invites, an invite dialog, and leave / transfer ownership.
10. Plan and usage: meters for servers ("2 of 3"), data retention, and alert emails sent today. "Limit reached" states shown inline on the Add server, Invite and New rule buttons with an upgrade hint. No billing flow yet, just the hooks for one.
11. Public status page (future): a shareable read-only page per organisation with an uptime bar per server for the last 90 days.

STATES TO SHOW
Loading skeletons (no full-page spinners), empty, error with retry, agent offline (stale data greyed with a "last seen 12 min ago" banner), partial data, and very long server names. Live updates should animate subtly (number tick, sparkline extend); no flashing. Live and 1 h views refresh every ~10 s, while 24 h and longer refresh every ~5 min, so include a quiet freshness indicator ("updated 2 min ago"). Role-restricted actions (viewer role) appear disabled with a tooltip, not hidden.

INTERACTION AND LAYOUT
- Collapsible left sidebar on desktop, bottom tab bar on mobile. Global command palette (Cmd+K) to jump to a server.
- Dense but breathable: 8 px grid, cards with 1 px borders, no heavy shadows.
- Charts: line or area with a soft fill, a shared hover crosshair showing exact values and timestamp, no 3D, no pie charts. Thresholds as dashed horizontal lines.
- Accessibility: WCAG AA contrast in both themes, visible focus rings, full keyboard navigation, reduced-motion support.

TECH CONSTRAINTS (so it can be built directly)
React 19 + Vite + Tailwind CSS 3, Recharts for charts, Heroicons, Headless UI for menus and dialogs. Express the design system as Tailwind theme tokens (colours, radii, spacing, font sizes) plus reusable components: StatusBadge, MetricCard, Sparkline, TimeRangePicker, ServerRow, AlertRow, EmptyState, ConfirmDialog, CopyableCode, OrgSwitcher, UsageMeter, RoleBadge, LimitReachedHint.

DELIVERABLES
1. Design tokens (light + dark) and a component sheet.
2. High-fidelity screens 1 to 10 at desktop and mobile, plus screen 11 at desktop.
3. A short rationale for the palette and for how status is encoded.
```
