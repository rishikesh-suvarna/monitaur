# CLAUDE.md

Project guide for Claude Code. Global preferences live in `~/.claude/CLAUDE.md`; this file only covers what is specific to Monitaur.

## What this is

Monitaur is a self-hosted server monitoring tool. Three deployables in one repo, no workspace tooling tying them together:

| Dir | What | Stack |
|---|---|---|
| `agent/` | Binary installed on each monitored host. Collects CPU/mem/disk/net via gopsutil and streams JSON over WebSocket. | Go 1.24, gorilla/websocket, viper |
| `backend/` | API + agent WebSocket hub. Persists metrics/alerts, sends SMTP alert emails. | Go 1.24, Gin, GORM, Postgres (Neon), Firebase Admin |
| `frontend/` | Dashboard SPA. | React 19 (JSX, not TS), Vite 7, Tailwind 3, TanStack Query 5, Recharts 3, Firebase Auth |

Live deployment: backend runs as a systemd service (`monitaur-backend`) on an Ubuntu VM, frontend is a static build copied to the same VM, DB is Neon serverless Postgres.

## Data flow

1. User signs in with Firebase on the frontend. Every API call sends `Authorization: Bearer <firebase id token>` (`frontend/src/config/api.js`).
2. Backend `/api/v1/*` runs `AuthMiddleware` (verifies token) then `EnsureUserExists` (upserts the `users` row) on every request (`backend/auth/firebase.go`).
3. User creates a server in the UI; backend generates a UUID token (`handlers/api.go:CreateServer`).
4. Agent connects to `GET /agent/connect?token=...&server_name=...` and sends `{type: "metrics"|"alert", data}` every `collection_interval` seconds (default 5).
5. Backend `handlers/websocket.go` keeps an in-memory `connections map[serverID]*AgentConnection`, inserts a `metrics` row per message, updates `servers.status` and `servers.last_seen`, and on `alert` inserts an `alerts` row and emails the server owner.
6. Frontend polls REST endpoints with TanStack Query (`refetchInterval: 30000` on Dashboard and ServerDetail). There is no browser WebSocket.

"Online" in the UI means "agent has an open socket on this backend process" (`IsAgentConnected`), not the DB `status` column.

## Layout

```
agent/
  main.go              collection loop, alert check, send
  client/websocket.go  dial, reconnect, heartbeat
  metrics/collector.go gopsutil collection + threshold alerts
  config/config.go     config.json lookup: ./, /etc/monitaur/, ~/.monitaur/
  scripts/build.sh     cross-compile + package releases
backend/
  main.go              flags (-init, -migrate), router wiring
  config/config.go     viper, reads ./config.yaml or env
  database/postgres.go GORM connection, AutoMigrate, all queries
  models/models.go     User, Server, Metric, Alert + agent wire types
  auth/firebase.go     token verify + user upsert middleware
  handlers/api.go      CRUD for servers/alerts/metrics
  handlers/dashboard.go aggregated dashboard + chart endpoints
  handlers/websocket.go agent hub, metric ingest, SMTP email
frontend/src/
  config/api.js        axios instance + auth interceptor
  apis/index.js        typed-ish endpoint wrappers
  contexts/AuthContext.jsx
  components/          one file per page (Dashboard, ServersPage, ServerDetail, AlertsPage, SettingsPage, Login) + Layout, Router
install.sh             curl | sudo bash agent installer (pulls GitHub release)
.github/workflows/     agent-release (on tag), backend-deploy, frontend-deploy (on push to main, path-filtered)
```

## Commands

No Makefile and no root package.json. Run per directory.

```bash
# backend
cd backend
go run . -init          # writes sample config.yaml (gitignored, holds secrets)
go run . -migrate       # GORM AutoMigrate + optional Timescale hypertable, then exits
go run .                # serve on server.host:server.port (default localhost:8080)
go vet ./... && go build ./...

# agent
cd agent
go run . -init          # writes sample config.json (gitignored)
go run .                # needs a valid token from the dashboard
./scripts/build.sh      # cross-compile all platforms into build/

# frontend (repo uses yarn: yarn.lock + CI runs `corepack enable && yarn install --immutable`)
cd frontend
yarn dev                # http://localhost:5173
yarn build && yarn lint
```

The frontend lockfile is yarn. Do not switch to bun or npm without also updating `frontend-deploy.yml`; if migrating, do it as its own PR.

Required env for the frontend: `VITE_APP_SERVER_URL`, `VITE_APP_SERVER_WS_URL` (shown in the add-server agent snippet), plus the `VITE_FIREBASE_*` keys read in `src/config/firebase.js` (local values live in the gitignored `.env.development.local`).

## Tests

There are none yet in any of the three packages. When adding code:
- Go: table-driven `_test.go` beside the file. Handlers are easiest to test with `httptest` + a Postgres test container, or by extracting the DB behind an interface first.
- Frontend: no runner configured. Vitest is the natural fit for Vite if one is added.

## Conventions and gotchas

- **The DB is the bottleneck.** Neon free tier suspends compute after 5 min with no queries. Any change that adds per-message or per-request queries keeps it awake and burns CU-hours.
- **Decided direction (2026-11-15, see `PLAN.md` sections 0, 2.3, 3), being rolled out:**
  - **B2 write-behind:** metrics are buffered in memory and flushed to Neon every `metrics.flush_interval` (30 min). Never add a DB call on the agent ingest path or on a polled endpoint. Serve from the in-memory store or a cache, and put periodic DB work in the flush window. The backend must stay a single instance.
  - **Multi-tenant:** tenants are organizations with plans and quotas. Every new table carries `org_id`, every handler authorizes through one helper (`requireServer` once it exists), and every cross-tenant path gets a test. Agent tokens are stored hashed; never return a stored token.
- All SQL goes through `backend/database/postgres.go` except a few inline `h.db.DB.Where(...)` calls in handlers. Prefer adding a method on `*Database` over inline GORM in handlers. New schema goes in versioned SQL migrations (goose, `backend/database/migrations/`), not AutoMigrate.
- Ownership checks: every `/servers/:id/*` and `/alerts/:id/*` handler must scope by owner (`user_id` today, `org_id` after the tenancy migration). Copy the existing `validateServerOwnership` pattern, do not skip it.
- GORM logger is set to `Info` (logs every statement). Keep that in mind when reading prod logs.
- Agent wire format is defined twice: `agent/metrics/collector.go` (sender) and `backend/models/models.go` `MetricData`/`AlertData` (receiver). Change both together and keep the backend tolerant of older agents.
- `backend/config.yaml`, `agent/config.json`, `frontend/.env*.local`, and Firebase service account JSON are gitignored and contain secrets. Never commit them; never print their values.
- CI pins `go-version: '1.21'` while `go.mod` says `go 1.24`; it works only because of toolchain auto-download.
- Deploys trigger on push to `main` (path-filtered). Work on a branch and open a PR.
- Markdown and commit messages: no em dashes, no "Co-authored by Claude" trailer (user preference).

## Planning docs

- `PLAN.md`: DB optimisation plan, feature roadmap, code review findings, UI redesign brief.
- `graphify-out/`: knowledge graph of the repo (`GRAPH_REPORT.md`, `graph.html`, `graph.json`). Query with `graphify query "<question>"` before broad greps on architecture questions. Rebuild with `/graphify . --update` after large changes.
