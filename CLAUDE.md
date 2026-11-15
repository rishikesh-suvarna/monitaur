# CLAUDE.md

Project guide for Claude Code. Global preferences live in `~/.claude/CLAUDE.md`; this file only covers what is specific to Monitaur.

## What this is

Monitaur is a self-hosted server monitoring tool. Three deployables in one repo, no workspace tooling tying them together:

| Dir | What | Stack |
|---|---|---|
| `agent/` | Binary installed on each monitored host. Collects CPU/mem/disk/net via gopsutil and streams JSON over WebSocket. | Go 1.24, gorilla/websocket, viper |
| `backend/` | Multi-tenant API, agent WebSocket hub, in-memory metrics (B2), alert rules engine, notification channels, SSE, public status pages. | Go 1.24, Gin, pgx v5 + goose, Postgres (Neon), Firebase Admin |
| `frontend/` | Dashboard SPA (the "Monitaur dashboard redesign" canvas). | React 19, TypeScript strict, Vite 7, Tailwind 3, TanStack Query 5, React Router 7, Recharts 3, Headless UI 2, Firebase Auth |

Live deployment: backend runs as a systemd service (`monitaur-backend`) on an Ubuntu VM, frontend is a static build copied to the same VM, DB is Neon serverless Postgres.

## Data flow

Full contract: `docs/platform-v2.md` (API shapes, package interfaces, schema).

1. User signs in with Firebase. `auth.Service` verifies the ID token, gates unverified password accounts (`403 email_unverified`), and resolves user + personal org + role from caches (DB only on a cache miss). `X-Monitaur-Org` picks the org.
2. Creating a server returns an `mt_live_...` token once; only its sha256 is stored.
3. The agent dials `GET /agent/connect` with `Authorization: Bearer <token>` (v1 agents: `?token=`). `ingest.Hub` authenticates from the in-memory `directory` (no DB) and pushes the plan's minimum interval.
4. Each sample goes to `metrics.Store` (rings + minute/hour rollups in memory) and `alerting.Engine` (rules evaluated server-side). Nothing is written per sample.
5. Every `metrics.flush_interval` (30 min) the store writes closed rollups in one batch and runs the flush-window hooks (server last_seen batch, incident progress, retention). That is the only periodic DB traffic, so Neon can suspend between flushes.
6. Incident transitions write immediately and dispatch to channels (`notify.Dispatcher`). The browser gets live data over SSE (`GET /api/v1/stream`, fetch-based so it can send the Authorization header); server snapshots every 3 s, incident events as they happen.

Status: `critical` (critical incident open, incl. heartbeat "unreachable"), else `offline` (no socket and no sample for 2 min), else `warning`, else `healthy` (`api.status`).

## Layout

```
agent/
  main.go              collection loop, alert check, send
  client/websocket.go  dial, reconnect, heartbeat
  metrics/collector.go gopsutil collection + threshold alerts
  config/config.go     config.json lookup: ./, /etc/monitaur/, ~/.monitaur/
  scripts/build.sh     cross-compile + package releases
backend/
  main.go              flags (-init, -migrate), server timeouts, graceful shutdown (final flush)
  app/                 wiring, store<->alerting<->notify adapters, flush-window housekeeping, seeding, legacy backfill
  api/                 Gin router + handlers per resource, SSE broker, public status page, error mapping
  auth/                Firebase verifier, identity/role caches, org context, RequireRole
  config/              viper + MONITAUR_* env overrides, Validate()
  database/            pgx pool (Neon-tuned), goose Migrate(); migrations/*.sql
  directory/           in-memory control plane (orgs, plans, servers by token hash, rules, channels, pins)
  ingest/              agent WebSocket hub
  metrics/             B2 store: rings, rollups, journal, flush, Series
  alerting/            rules engine + incident state machine, Preview, DefaultRules
  notify/              email/Slack/Discord/Telegram/webhook senders, SafeHTTPClient, Dispatcher
  store/               all SQL (pgx)
  limits/              token-bucket rate limiter, daily email budget
  secrets/             AES-GCM box (channel configs), token generation and hashing
  testdb/              per-test throwaway Postgres databases
frontend/src/          (details: frontend/README.md)
  api/                 typed client, endpoints, ApiError, query keys (org-scoped), SSE parser, cache patches
  providers/           Theme, Motion, Auth, Org, LiveStream (fetch-based SSE)
  hooks/               one TanStack Query hook per endpoint + UI hooks
  components/          design system (StatusBadge, Logo, Dino, Sparkline, ...); components/layout/ is the app shell
  pages/               one folder per screen
  routes/              router, RequireAuth, RouteError
  styles/tokens.css    design tokens (dark default, light parity) as RGB channels
install.sh             curl | sudo bash agent installer (pulls GitHub release)
.github/workflows/     agent-release (on tag), backend-deploy, frontend-deploy (on push to main, path-filtered)
```

## Commands

No Makefile and no root package.json. Run per directory.

```bash
# backend
cd backend
go run . -init          # writes sample config.yaml (gitignored, holds secrets)
go run . -migrate       # apply goose migrations and exit (serve also auto-migrates unless database.auto_migrate=false)
go run .                # serve on server.host:server.port (default localhost:8080)
go vet ./... && go build ./...
# DB-backed tests need a Postgres where the user may CREATE DATABASE; they skip otherwise
MONITAUR_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable" go test -race ./...

# agent
cd agent
go run . -init          # writes sample config.json (gitignored)
go run .                # needs a valid token from the dashboard
./scripts/build.sh      # cross-compile all platforms into build/

# frontend (Yarn 1; CI runs `yarn install --frozen-lockfile`, which actually enforces the lockfile)
cd frontend
yarn dev                # http://localhost:5173
yarn typecheck && yarn lint && yarn test && yarn build
```

The frontend lockfile is yarn. Do not switch to bun or npm without also updating the workflows; if migrating, do it as its own PR.

Frontend env (validated at startup, see `frontend/README.md`): `VITE_APP_SERVER_URL`, `VITE_APP_SERVER_WS_URL`, `VITE_FIREBASE_*`, and optional `VITE_FIREBASE_APPCHECK_SITE_KEY`. Local values live in the gitignored `.env.development.local`.

## Tests

- Backend: table-driven unit tests per package; `store/` and `app/` tests use `testdb` (real Postgres, one database per test). `store/store_test.go` `TestMigrateLegacyDatabase` reproduces the v1 production schema and data; keep it passing for any migration change. `app/app_test.go` drives the fully wired app (fake Firebase verifier, real agent WebSocket, cross-tenant checks).
- Agent: `agent/client` has lifecycle tests (`go test -race`).
- Frontend: Vitest unit tests for logic (formatters, mapping, API errors, data shaping). Screens are checked against the design canvas in a browser; never commit API mocks into the app.
- New code ships with tests; cross-tenant access paths get a 404 assertion.

## Conventions and gotchas

- **The DB is the bottleneck.** Neon free tier suspends compute after 5 min with no queries. Any change that adds per-message or per-request queries keeps it awake and burns CU-hours.
- **Architecture decisions (2026-11-15, `PLAN.md` sections 0, 2.3, 3):**
  - **B2 write-behind:** metrics are buffered in memory and flushed to Neon every `metrics.flush_interval` (30 min). Never add a DB call on the agent ingest path or on a polled endpoint. Serve from the in-memory store or a cache, and put periodic DB work in the flush window. The backend must stay a single instance.
  - **Multi-tenant:** tenants are organizations with plans and quotas (`plans` table, 0 = unlimited). Every new table carries `org_id`, and every cross-tenant path gets a test. Agent tokens are stored hashed; never return a stored token.
- All SQL lives in `backend/store`. New schema goes in a new goose migration under `backend/database/migrations/`; never edit an applied one. Migrations run at startup, so keep them fast (big data moves belong in an app job like `backfillLegacy`).
- Tenant scoping: look servers up with `directory.OrgServer(orgID, id)` and pass `orgID` into every store method; a miss is a 404, never a 403. The directory must be updated (write-through) after every store write it caches.
- Request logging is `api.requestLog` and never prints query strings (v1 agents send the token there). Do not switch back to `gin.Default()`.
- Agent wire format is defined twice: `agent/metrics/collector.go` (sender) and `backend/ingest/hub.go` `metricData` (receiver). Change both together and keep the backend tolerant of older agents.
- `backend/config.yaml`, `agent/config.json`, `frontend/.env*.local`, and Firebase service account JSON are gitignored and contain secrets. Never commit them; never print their values.
- Deploys trigger on push to `main` (path-filtered). Work on a branch and open a PR.
- Markdown and commit messages: no em dashes, no "Co-authored by Claude" trailer (user preference).

## Planning docs

- `PLAN.md`: DB optimisation plan, feature roadmap, code review findings, UI redesign brief.
- `graphify-out/`: knowledge graph of the repo (`GRAPH_REPORT.md`, `graph.html`, `graph.json`). Query with `graphify query "<question>"` before broad greps on architecture questions. Rebuild with `/graphify . --update` after large changes.
