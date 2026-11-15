# Monitaur platform v2: build spec

This is the contract that parallel work streams build against. It implements PLAN.md sections 2.3 (B2 write-behind), 3 (multi-tenancy) and features F1 to F5 and F8, plus the UI redesign (design canvas "Monitaur dashboard redesign").

Decisions taken (PLAN.md section 0): flush interval 30 min, orgs now, alert state changes written immediately.

Conventions for all Go code: Go 1.24, `log/slog`, `context.Context` first on I/O, errors returned (no panics), named constants (no magic numbers), table-driven tests, imports grouped stdlib / external / internal. IDs are `int64` everywhere in new code. Times are UTC.

---

## 1. Backend layout

```
backend/
  main.go                 flags: -init (sample config), -migrate (run migrations, exit); default: serve
  config/                 viper; env override with MONITAUR_ prefix and "." -> "_" replacer
  database/               Open(), Migrate() (goose, embedded SQL, Postgres session lock)
    migrations/*.sql
  models/                 GORM models for control-plane tables
  store/                  all SQL (control plane + metric rollups); implements metrics.Sink/History,
                          alerting.IncidentStore, notify.DeliveryRecorder
  auth/                   Firebase verify, identity cache, org context, role checks
  limits/                 plans, quota checks, token-bucket rate limiter
  secrets/                AES-GCM box for channel configs at rest
  metrics/                B2 in-memory store (stream A)
  alerting/               rules engine + incident state machine (stream B)
  notify/                 channel senders + dispatcher (stream C)
  ingest/                 agent WebSocket hub
  api/                    REST + SSE handlers, router
```

Old `handlers/`, `database/postgres.go` and the old `models` are replaced.

---

## 2. Package contracts

### 2.1 `backend/metrics` (stream A)

```go
package metrics

type Resolution int
const (
    Minute Resolution = iota + 1
    Hour
)

// Sample is one validated agent reading. Network values are cumulative counters.
type Sample struct {
    Time           time.Time
    CPUPercent     float64
    CPUCores       int
    MemTotalBytes  uint64
    MemUsedBytes   uint64
    MemPercent     float64
    DiskTotalBytes uint64
    DiskUsedBytes  uint64
    DiskPercent    float64
    NetRxTotal     uint64
    NetTxTotal     uint64
    UptimeSeconds  int64
}

// Point is the derived value kept in memory and fed to alerting and live views.
// Net rates are bytes/second from counter deltas, clamped to 0 on counter reset.
type Point struct {
    Time      time.Time
    CPU       float32
    Mem       float32
    Disk      float32
    NetInBps  float32
    NetOutBps float32
}

type Latest struct {
    Point
    CPUCores      int
    MemTotalBytes uint64
    MemUsedBytes  uint64
    DiskTotalBytes uint64
    DiskUsedBytes uint64
    UptimeSeconds int64
    ReceivedAt    time.Time
}

// Bucket is a closed rollup. Start is truncated to the minute or hour.
type Bucket struct {
    ServerID   int64
    Res        Resolution
    Start      time.Time
    Samples    int
    CPUAvg, CPUMax   float32
    MemAvg, MemMax   float32
    DiskAvg          float32
    NetInAvg, NetInMax   float32
    NetOutAvg, NetOutMax float32
    MemTotalBytes, DiskTotalBytes, DiskUsedBytes uint64
    UptimeSeconds int64
}

type Sink interface {
    // WriteBuckets must be idempotent (ON CONFLICT DO NOTHING on (server_id, bucket)).
    WriteBuckets(ctx context.Context, buckets []Bucket) error
}

type History interface {
    ReadBuckets(ctx context.Context, serverID int64, res Resolution, from, to time.Time) ([]Bucket, error)
}

type Range string
const (
    RangeLive Range = "live" // last 15 min, raw, 5 s step
    Range1h   Range = "1h"   // raw ring, 10 s step
    Range6h   Range = "6h"   // recent ring, 1 m
    Range24h  Range = "24h"  // recent ring, 4 m
    Range7d   Range = "7d"   // history 1h + current hour from memory
    Range30d  Range = "30d"  // history 1h, 2 h step
)
func ParseRange(s string) (Range, error)

// SeriesPoint fields are nil for a gap (no samples in that step).
type SeriesPoint struct {
    T         time.Time `json:"t"`
    CPU       *float32  `json:"cpu"`
    Mem       *float32  `json:"mem"`
    Disk      *float32  `json:"disk"`
    NetInBps  *float32  `json:"net_in"`
    NetOutBps *float32  `json:"net_out"`
}
type Stat struct {
    Min float32 `json:"min"`; Avg float32 `json:"avg"`; Max float32 `json:"max"`; Now float32 `json:"now"`
}
type Series struct {
    Range       Range            `json:"range"`
    StepSeconds int              `json:"step_seconds"`
    From        time.Time        `json:"from"`
    To          time.Time        `json:"to"`
    Points      []SeriesPoint    `json:"points"`
    Stats       map[string]Stat  `json:"stats"` // keys: cpu, mem, disk, net_in, net_out
}

type Config struct {
    RawWindow        time.Duration // default 1h
    RecentWindow     time.Duration // default 24h of minute buckets
    FlushInterval    time.Duration // default 30m
    MaxPendingBuckets int          // default 48h worth for 1000 servers is too much; default 200_000
    JournalDir       string        // "" disables the journal
    BucketGrace      time.Duration // default 5s
    Now              func() time.Time // nil = time.Now (tests inject)
}
func DefaultConfig() Config

var ErrTooFrequent = errors.New("sample arrived faster than the minimum interval")

type Store struct{ /* unexported */ }
func New(cfg Config, sink Sink, history History, log *slog.Logger) (*Store, error)

// Ingest records a sample. minInterval > 0 drops samples arriving faster (returns ErrTooFrequent).
func (s *Store) Ingest(serverID int64, smp Sample, minInterval time.Duration) (Point, error)
func (s *Store) Latest(serverID int64) (Latest, bool)
func (s *Store) LastSeen() map[int64]time.Time           // every server with a sample, for the flush-window batch update
// Sparkline returns the last n minute buckets (closed + current partial), oldest first, for one field.
func (s *Store) Sparkline(serverID int64, n int) (cpu, mem, disk []float32)
func (s *Store) Series(ctx context.Context, serverID int64, r Range) (Series, error)
func (s *Store) Forget(serverID int64)                   // server deleted: drop rings and pending buckets
func (s *Store) OnFlush(fn func(ctx context.Context))    // housekeeping hooks, run after each flush
func (s *Store) Run(ctx context.Context) error           // closes buckets, flushes every FlushInterval, final flush on ctx.Done
func (s *Store) Flush(ctx context.Context) error
type Stats struct { Servers int; PendingBuckets int; DroppedBuckets int64; LastFlush time.Time; LastFlushErr string; Flushes int64 }
func (s *Store) Stats() Stats
```

Behaviour: see PLAN.md 2.3.2 to 2.3.6. History results for 7d/30d are cached per (server, range) and the cache is cleared on every successful flush. After a restart, journal replay refills pending buckets and the recent ring; any remaining gap in a memory range falls back to History once (cached until next flush).

### 2.2 `backend/alerting` (stream B)

```go
package alerting

type Metric string
const (
    MetricCPU Metric = "cpu"; MetricMemory Metric = "memory"; MetricDisk Metric = "disk"
    MetricNetIn Metric = "net_in"; MetricNetOut Metric = "net_out"; MetricHeartbeat Metric = "heartbeat"
)
type Comparison string
const ( Above Comparison = "above"; Below Comparison = "below" )
type Severity string
const ( Warning Severity = "warning"; Critical Severity = "critical" )

type Scope struct {
    All       bool
    ServerIDs []int64
    Tags      []string
}

type Rule struct {
    ID, OrgID   int64
    Name        string
    Enabled     bool
    Scope       Scope
    Metric      Metric
    Comparison  Comparison   // ignored for heartbeat ("is missing")
    Threshold   float64      // percent for cpu/mem/disk, bytes/s for net; ignored for heartbeat
    For         time.Duration
    Severity    Severity
    ChannelIDs  []int64
    Cooldown    time.Duration // re-notify interval while firing and not acked; 0 = never
    AutoResolve time.Duration // must be under threshold this long before resolving; 0 = immediately
}
func (r Rule) Validate() error
func (r Rule) Matches(s ServerInfo) bool

type ServerInfo struct {
    ID, OrgID int64
    Name      string
    Tags      []string
}

type Incident struct {
    ID          int64
    OrgID       int64
    ServerID    int64
    RuleID      int64
    RuleName    string
    Metric      Metric
    Severity    Severity
    Threshold   float64
    Peak        float64
    LastValue   float64
    SamplesOver int
    StartedAt   time.Time
    LastNotifiedAt *time.Time
    AckedAt     *time.Time
}

type ResolveHow string
const ( ResolvedAuto ResolveHow = "auto"; ResolvedManual ResolveHow = "manual"; ResolvedServerDeleted ResolveHow = "server_deleted"; ResolvedRuleDeleted ResolveHow = "rule_changed" )

type IncidentStore interface {
    OpenIncident(ctx context.Context, inc Incident) (int64, error)
    ResolveIncident(ctx context.Context, id int64, at time.Time, how ResolveHow, peak float64, samplesOver int) error
    SaveProgress(ctx context.Context, id int64, peak, lastValue float64, samplesOver int, lastNotifiedAt *time.Time) error
    LoadOpenIncidents(ctx context.Context) ([]Incident, error)
}

type EventKind string
const ( EventFired EventKind = "fired"; EventRenotify EventKind = "renotify"; EventResolved EventKind = "resolved" )
type Event struct {
    Kind     EventKind
    Incident Incident
    Rule     Rule
    Server   ServerInfo
    At       time.Time
}
type Notifier interface { Notify(ctx context.Context, ev Event) }

type Engine struct{ /* unexported */ }
func NewEngine(store IncidentStore, notifier Notifier, now func() time.Time, log *slog.Logger) *Engine
func (e *Engine) Load(ctx context.Context, rules []Rule, servers []ServerInfo) error // startup: rules, servers, open incidents
func (e *Engine) SetOrgRules(orgID int64, rules []Rule)   // replace an org's rules (after CRUD); resolves incidents of removed/changed rules with ResolvedRuleDeleted
func (e *Engine) UpsertServer(s ServerInfo)
func (e *Engine) RemoveServer(ctx context.Context, serverID int64) // resolves its incidents with ResolvedServerDeleted
func (e *Engine) Observe(ctx context.Context, serverID int64, p metrics.Point)
func (e *Engine) Tick(ctx context.Context)                 // heartbeat rules, cooldown renotify, auto-resolve timers; call every 5 s
func (e *Engine) Heartbeat(serverID int64, at time.Time)   // any sample or connect counts
func (e *Engine) Ack(incidentID int64, at time.Time)       // stops renotify
func (e *Engine) Resolve(ctx context.Context, incidentID int64, at time.Time) error // manual
func (e *Engine) SaveProgress(ctx context.Context)         // flush-window hook: persist peaks/counters of open incidents
func (e *Engine) Open(orgID int64) []Incident              // in-memory open incidents (for live status)
func (e *Engine) ServerSeverity(serverID int64) (Severity, bool) // worst open severity

// Preview replays minute buckets (oldest first) through the rule and returns would-be incidents.
type PreviewIncident struct { Start, End time.Time; Peak float64 }
func Preview(r Rule, buckets []metrics.Bucket) []PreviewIncident
func DefaultRules(orgID int64, channelIDs []int64) []Rule  // seeded for new orgs: cpu>80 5m warn, mem>85 5m warn, disk>90 5m warn, disk>95 5m crit, heartbeat missing 5m crit
```

State machine per (rule, server): ok -> pending (first breach) -> firing (breach held for `For`, OpenIncident + EventFired) -> recovering (back under, timer `AutoResolve`) -> ok (ResolveIncident + EventResolved). A breach during recovering returns to firing (same incident). Heartbeat rules: fire when no Heartbeat for `For`; resolve on next Heartbeat. Only transitions call the store; peaks/counters are persisted via SaveProgress in the flush window.

### 2.3 `backend/notify` (stream C)

```go
package notify

type ChannelType string
const ( Email ChannelType = "email"; Slack ChannelType = "slack"; Discord ChannelType = "discord"; Telegram ChannelType = "telegram"; Webhook ChannelType = "webhook" )

type Channel struct {
    ID, OrgID int64
    Type      ChannelType
    Name      string
    Enabled   bool
    Config    ChannelConfig
}
type ChannelConfig struct {
    EmailTo        []string `json:"email_to,omitempty"`
    WebhookURL     string   `json:"webhook_url,omitempty"`      // slack, discord, webhook
    WebhookSecret  string   `json:"webhook_secret,omitempty"`   // webhook HMAC
    TelegramToken  string   `json:"telegram_token,omitempty"`
    TelegramChatID string   `json:"telegram_chat_id,omitempty"`
}
func (c Channel) Validate() error
func (c ChannelConfig) Redacted(t ChannelType) map[string]string // safe summary for the API: "#ops via hooks.slack.com", masked secrets

type MessageKind string
const ( KindFired MessageKind = "fired"; KindRenotify MessageKind = "renotify"; KindResolved MessageKind = "resolved"; KindTest MessageKind = "test"; KindInvite MessageKind = "invite" )
type Message struct {
    Kind        MessageKind
    OrgID       int64
    IncidentID  int64
    ServerName  string
    RuleName    string
    Metric      string
    Severity    string
    Value       float64
    Threshold   float64
    Unit        string     // "%", "B/s", ""
    StartedAt   time.Time
    ResolvedAt  *time.Time
    DashboardURL string
    // invites only
    InviteOrgName, InviteURL string
}

type Sender interface { Send(ctx context.Context, ch Channel, msg Message) error }

type SMTPConfig struct { Host, Port, Username, Password, From string; RequireTLS bool }
func NewSMTPSender(cfg SMTPConfig) Sender      // html/template, CR/LF stripped from headers, DialTimeout + deadlines, checks Data().Close()
func NewSlackSender(client *http.Client) Sender
func NewDiscordSender(client *http.Client) Sender
func NewTelegramSender(client *http.Client, apiBase string) Sender
func NewWebhookSender(client *http.Client) Sender // JSON body, X-Monitaur-Signature: sha256=<hex hmac>
// SafeHTTPClient refuses loopback, private, link-local and unspecified addresses unless allowPrivate (self-hosted).
func SafeHTTPClient(timeout time.Duration, allowPrivate bool) *http.Client

type DeliveryRecorder interface {
    RecordDelivery(ctx context.Context, channelID int64, at time.Time, err error)
}

type Limits interface {
    // AllowEmail reports whether org may send one more alert email today.
    AllowEmail(orgID int64, now time.Time) bool
}

type DispatcherConfig struct { Workers int; QueueSize int; SendTimeout time.Duration }
type Dispatcher struct{ /* unexported */ }
func NewDispatcher(cfg DispatcherConfig, senders map[ChannelType]Sender, rec DeliveryRecorder, lim Limits, log *slog.Logger) *Dispatcher
func (d *Dispatcher) Run(ctx context.Context)                        // worker pool; drains on ctx.Done
func (d *Dispatcher) Dispatch(chs []Channel, msg Message)            // non-blocking; skips disabled channels; drops + logs when queue full
func (d *Dispatcher) Test(ctx context.Context, ch Channel) error     // synchronous, records delivery
func (d *Dispatcher) SendDirect(ctx context.Context, to string, msg Message) error // invites: email to an address
```

---

## 3. Database (goose migrations, `backend/database/migrations`)

- `00001_baseline.sql`: `CREATE TABLE IF NOT EXISTS` for the legacy GORM tables (`users`, `servers`, `metrics`, `alerts`) so a fresh DB and the existing Neon DB converge.
- `00002_platform_v2.sql`: plans, organizations, memberships, invites, server columns (`org_id`, `tags text[]`, `token_hash`, `token_prefix`, `token_created_at`, `token_last_used_at`, `prev_token_hash`, `prev_token_expires_at`, `agent_version`, `created_by`), `server_pins`, `metrics_1m`, `metrics_1h`, `uptime_daily`, `notification_channels` (`config_enc bytea`), `alert_rules`, `incidents`. Backfill: one personal org per existing user on plan `legacy` (unlimited), owner membership, `servers.org_id`, `token_hash = sha256(token)`, then plaintext `token` set to NULL. Legacy `alerts` renamed `alerts_legacy`. Legacy `metrics` kept (dropped manually after the backfill week).
- `00003_backfill_rollups.sql`: last 7 days of `metrics` into `metrics_1m` and `metrics_1h` (network rates NULL).

Plans (0 = unlimited):

| id | servers | min interval s | 1m days | 1h days | members | alert emails/day | rules | channels | api rpm |
|---|---|---|---|---|---|---|---|---|---|
| free | 3 | 10 | 7 | 30 | 3 | 20 | 10 | 2 | 120 |
| legacy | 0 | 5 | 7 | 90 | 0 | 0 | 0 | 0 | 600 |

New sign-ups get `limits.default_plan` (default `free`).

Server status: `offline` if the agent is not connected and no sample in 2 min; else `critical` / `warning` from the worst open incident; else `healthy`.

---

## 4. HTTP API (`/api/v1`, JSON)

Auth: `Authorization: Bearer <Firebase ID token>`. Password accounts need `email_verified` (403 `{"code":"email_unverified"}`). Org context: header `X-Monitaur-Org: <id>`; absent = the user's personal org. Roles: viewer < member < admin < owner. Errors: `{"error": "<message>", "code": "<machine_code>"}` with codes `unauthorized`, `email_unverified`, `forbidden`, `not_found`, `invalid`, `limit_reached`, `rate_limited`, `conflict`.

| Method | Path | Role | Body / query | Response |
|---|---|---|---|---|
| GET | /me | any | | `{user:{id,email,display_name,email_verified,provider}, orgs:[{id,name,role,personal,plan_id}], current_org_id}` |
| PATCH | /me | any | `{display_name}` | `{user}` |
| DELETE | /me | any | | 204. Deletes orgs where sole owner, memberships, Firebase user |
| POST | /me/sessions/revoke | any | | 204 (Firebase RevokeRefreshTokens) |
| GET | /export | admin | | JSON attachment: org, servers, rules, channels (redacted), incidents, 30 d hourly metrics |
| GET | /org | viewer | | `{org:{id,name,plan_id,status_page:{enabled,slug,title,server_ids}}, plan:{...limits}, usage:{servers,members,rules,channels,alert_emails_today}}` |
| PATCH | /org | admin | `{name?, slug?, status_page?:{enabled,title,server_ids}}` (slug: 3 to 40 of a-z, 0-9, -) | `{org}` |
| GET | /org/members | viewer | | `{members:[{user_id,email,display_name,role,joined_at}], invites:[{id,email,role,expires_at}]}` |
| POST | /org/invites | admin | `{email, role}` | 201 `{invite, invite_url, emailed}` (link returned so it can be shared when SMTP is off) |
| DELETE | /org/invites/:id | admin | | 204 |
| PATCH | /org/members/:userId | owner | `{role}` | `{member}` |
| DELETE | /org/members/:userId | admin (self: any) | | 204 |
| POST | /invites/accept | any | `{token}` | `{org}` |
| GET | /servers | viewer | | `{servers:[ServerSummary]}` |
| POST | /servers | member | `{name, tags?}` | 201 `{server:ServerSummary, token, install:{command, config_path, config}}` |
| GET | /servers/:id | viewer | | `{server:ServerSummary, token:{prefix,created_at,last_used_at}, counts:{incidents,rules,metrics_days}}` |
| PATCH | /servers/:id | member | `{name?, tags?}` | `{server}` |
| DELETE | /servers/:id | admin | | 204 |
| POST | /servers/:id/token/rotate | admin | | `{token, previous_valid_until, prefix, install:{command, config_path, config}}` |
| PUT / DELETE | /servers/:id/pin | viewer | | 204 |
| GET | /servers/:id/series | viewer | `?range=live\|1h\|6h\|24h\|7d\|30d` | `metrics.Series` + `thresholds:{cpu:{warning,critical},...}` |
| GET | /incidents | viewer | `?state=open\|acked\|resolved\|all&severity=&metric=&server_id=&limit=50&before=<id>` | `{incidents:[Incident], counts:{open,acked,resolved_24h}}` |
| POST | /incidents/:id/ack | member | | `{incident}` |
| POST | /incidents/:id/resolve | member | | `{incident}` |
| GET | /rules | viewer | | `{rules:[Rule], matched:{<ruleId>: <serverCount>}}` |
| POST | /rules | member | Rule | 201 `{rule}` |
| PATCH | /rules/:id | member | partial Rule | `{rule}` |
| DELETE | /rules/:id | member | | 204 |
| POST | /rules/preview | viewer | Rule | `{matched_servers, previewed, window_hours, would_fire: number, incidents:[{server_id,start,end|null,peak}]}` (last 7 d of minute buckets, at most 10 servers) |
| GET | /channels | viewer | | `{channels:[Channel]}` |
| POST | /channels | admin | `{type,name,config}` | 201 `{channel}` |
| PATCH | /channels/:id | admin | `{name?,enabled?,config?}` | `{channel}` |
| DELETE | /channels/:id | admin | | 204 |
| POST | /channels/:id/test | member | | `{ok, error?}` |
| GET | /stream | viewer | SSE via `fetch` (Authorization header, not EventSource) | events below |
| GET | /public/status/:slug | none | | `{title, overall, updated_at, services:[{name,status,uptime_pct,days:[{day,pct,worst}]}], incidents:[...]}` |

`GET /health` (no DB). `GET /agent/connect` WebSocket: `Authorization: Bearer <server token>` (legacy `?token=` still accepted), `X-Agent-Version` header, `server_name` query.

JSON shapes:

```ts
interface ServerSummary {
  id: number; name: string; tags: string[]; pinned: boolean;
  status: 'healthy' | 'warning' | 'critical' | 'offline';
  connected: boolean; last_seen: string | null; agent_version: string;
  latest: null | { cpu: number; mem: number; disk: number; net_in: number; net_out: number;
                   mem_total: number; mem_used: number; disk_total: number; disk_used: number;
                   cpu_cores: number; uptime_s: number; at: string };
  spark: { cpu: number[]; mem: number[]; disk: number[] };   // last 30 minute buckets
  open_incidents: number; created_at: string;
  thresholds: Record<'cpu'|'mem'|'disk'|'net_in'|'net_out', { warning: number | null; critical: number | null }>;  // only keys with an enabled 'above' rule
}
interface Incident {
  id: number; server_id: number; server_name: string; rule_id: number | null; rule_name: string;
  metric: 'cpu'|'memory'|'disk'|'net_in'|'net_out'|'heartbeat'; severity: 'warning'|'critical';
  state: 'open' | 'acked' | 'resolved'; comparison: 'above' | 'below';
  threshold: number; peak: number; last_value: number; unit: '%' | 'B/s' | '';
  samples_over: number; started_at: string; resolved_at: string | null; resolved_how: string | null;
  acked_at: string | null; acked_by: string | null; last_notified_at: string | null;
  notified_channels: string[]; next_notify_at: string | null;
}
interface Rule {
  id: number; name: string; enabled: boolean;
  scope: { all: boolean; server_ids: number[]; tags: string[] };
  metric: 'cpu'|'memory'|'disk'|'net_in'|'net_out'|'heartbeat'; comparison: 'above'|'below';
  threshold: number; for_seconds: number; severity: 'warning'|'critical';
  channel_ids: number[]; cooldown_seconds: number; auto_resolve_seconds: number;
  created_at: string; updated_at: string;
}
interface Channel {
  id: number; type: 'email'|'slack'|'discord'|'telegram'|'webhook'; name: string; enabled: boolean;
  summary: Record<string, string>;            // redacted config
  last_delivery_at: string | null; last_delivery_ok: boolean | null; last_error: string | null;
}
```

```ts
interface Plan {   // GET /org .plan; 0 means unlimited
  id: string; name: string; max_servers: number; min_interval_seconds: number;
  retention_1m_days: number; retention_1h_days: number; max_members: number;
  alert_emails_per_day: number; max_rules: number; max_channels: number; api_rpm: number;
}
interface PublicStatus {  // GET /public/status/:slug (cached 60 s)
  title: string; overall: 'healthy'|'warning'|'critical'|'offline'; updated_at: string;
  services: { name: string; status: string; uptime_pct: number | null;  // null until the first metrics flush
              days: { day: string; pct: number | null; worst: 'warning'|'critical'|null }[] }[];  // 90 days, oldest first; pct null before the server existed
  incidents: { service: string; metric: string; severity: string; started_at: string; resolved_at: string | null }[];
}
```

SSE events (`text/event-stream`, one JSON object per `data:` line):
- `event: servers` every 3 s: `{servers:[{id,status,connected,last_seen,latest,agent_version}]}` for the org.
- `event: incident`: `{action:'opened'|'updated'|'resolved', incident: Incident}`, or `{action:'refresh'}` after rule or server changes resolved incidents in bulk (refetch the incidents list).
- `: ping` comment every 15 s.

---

## 5. Frontend (stream D)

- TypeScript strict, React 19, Vite 7, Tailwind 3, TanStack Query 5, React Router 7, Recharts 3 (shared crosshair via `syncId`), Headless UI 2, Heroicons. Yarn 1 (lockfile).
- Tokens exactly as the design's `Tokens.dc.html`: CSS variables as RGB channels in `src/styles/tokens.css`, `[data-theme]` on `<html>`, dark default, light parity, `system` option. Geist + Geist Mono from Google Fonts. Tailwind theme as shown in the design.
- Status is colour + shape + word (`StatusBadge`). Data series are never status-coloured.
- API client in `src/api/` typed from section 4; `X-Monitaur-Org` header from the current org; 401 → one forced token refresh, then sign out (no reload loop); `queryClient.clear()` on sign-out and org switch; query keys include the org id.
- Live data: one `useLiveStream()` hook (fetch-based SSE with backoff) that patches the `servers` and `incidents` query caches.
- Design source: the canvas files saved under `/private/tmp/claude-501/-Users-rishikeshsuvarna-Developer-personal-monitaur/a3a0b0d5-e9de-4169-8a55-21d76cabc9a8/scratchpad/artifact-files/73f972ba-3ec0-4f2f-a16e-67e72f9a3b3e/project/` (one `.dc.html` per artboard; desktop 1440, mobile 390, light variants).
- Real product facts replace design placeholders: install command `curl -sSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/main/install.sh | sudo bash`, config at `/etc/monitaur/config.json` with the agent's real keys (`token`, `api_endpoint`, `collection_interval`, `server_name`), endpoints from `VITE_APP_SERVER_URL` / `VITE_APP_SERVER_WS_URL`.

---

## 6. Monitoring additions (F6, F7, F9, F11)

Same rules as above: no per-sample or per-poll DB access, tenant checks on every lookup, new schema in new goose migrations (numbers fixed below), SSRF-safe network access, tests with every change. Older agents and older rows must keep working (missing values are `null`, never `0`).

### 6.1 F6 Richer host metrics (migration `00003_host_metrics.sql`)

Agent `metrics` payload gains (inside `data`):
```json
"load":       {"load1": 0.52, "load5": 0.40, "load15": 0.31},
"swap":       {"total": 2147483648, "used": 1048576, "used_percent": 0.05},
"disk_io":    {"read_bytes": 123456789, "write_bytes": 987654321},
"mounts":     [{"path": "/", "fstype": "ext4", "total": 1, "used": 1, "used_percent": 50.0}],
"interfaces": [{"name": "eth0", "bytes_sent": 1, "bytes_recv": 2}]
```
`disk_io` counters are cumulative over physical disks. `mounts` lists physical filesystems only (no tmpfs, overlay, squashfs, proc), at most 16. `interfaces` excludes loopback, at most 16.

`metrics` package additions (new fields only, existing ones unchanged):
- `Sample`: `Extended bool` (agent sent load/swap/disk_io), `Load1, Load5, Load15, SwapPercent float64`, `SwapTotalBytes, SwapUsedBytes, DiskReadTotal, DiskWriteTotal uint64`, `Mounts []Mount`, `Interfaces []IfaceCounters`.
- `Mount{Path, FSType string; TotalBytes, UsedBytes uint64; UsedPercent float32}`, `IfaceCounters{Name string; RxTotal, TxTotal uint64}`, `Iface{Name string; InBps, OutBps float32}`.
- `Point`: `Load1, Swap, DiskReadBps, DiskWriteBps float32` plus `Extended bool`.
- `Latest`: `Load5, Load15 float32`, `SwapTotalBytes, SwapUsedBytes uint64`, `Mounts []Mount`, `Interfaces []Iface` (rates from per-interface counter deltas).
- `Bucket`: `Load1Avg, Load1Max, SwapAvg, DiskReadAvg, DiskReadMax, DiskWriteAvg, DiskWriteMax float32` and `ExtSamples int` (samples that carried extended values; averages use it; 0 means store NULL).
- `SeriesPoint`: `Load1, Swap, DiskReadBps, DiskWriteBps *float32` (JSON `load1`, `swap`, `disk_read`, `disk_write`); `Stats` keys add `load1`, `swap`, `disk_read`, `disk_write`.

Migration 00003 adds nullable `real` columns `load1_avg, load1_max, swap_avg, disk_read_bps_avg, disk_read_bps_max, disk_write_bps_avg, disk_write_bps_max` and `ext_samples smallint NOT NULL DEFAULT 0` to `metrics_1m` and `metrics_1h`, and widens the `alert_rules.metric` CHECK to include `load1` and `swap`.

Alerting: new metrics `load1` (absolute, threshold >= 0, no upper bound) and `swap` (percent 0 to 100). Points without extended values never breach or recover these rules.

API: `ServerSummary.latest` gains `load1, load5, load15, swap, swap_total, swap_used, disk_read, disk_write` (bytes/s; `null` when the agent does not report them), `mounts: [{path, fstype, total, used, pct}]` and `interfaces: [{name, in, out}]` (bytes/s). Series points and stats gain `load1`, `swap`, `disk_read`, `disk_write`. `thresholds` gains `load1` and `swap` keys.

### 6.2 F9 Processes (no migration: memory only)

Every `max(30 s, collection interval)` the agent sends `{"type":"processes","data":{"total":312,"processes":[{"pid":1,"name":"postgres","user":"postgres","cpu":12.5,"mem":3.1,"rss":123456,"cmd":"postgres -D /var/lib/..."}]}}`: the union of the top 15 by CPU and the top 15 by memory (at most 30), `cmd` truncated to 200 chars. The backend keeps only the latest list per server in memory (never written to the DB; dropped on server delete).

`GET /servers/:id/processes` (viewer) → `{at: string|null, total: number, processes: [{pid, name, user, cpu, mem, rss, cmd}]}`; `at: null` and an empty list when nothing was received yet (older agents).

### 6.3 F7 Uptime checks (migration `00004_checks.sql`)

Tables: `checks(id, org_id, name, type CHECK IN ('http','tcp','tls'), target, interval_seconds, timeout_seconds, expect_status int NOT NULL DEFAULT 0, keyword text NOT NULL DEFAULT '', tls_warn_days int NOT NULL DEFAULT 14, enabled, channel_ids bigint[], created_at, updated_at)`, `check_results_1h(check_id, bucket, total smallint, ok smallint, latency_avg_ms real, latency_max_ms real, PRIMARY KEY (check_id, bucket))`, `check_uptime_daily(check_id, day, total int, ok int, PRIMARY KEY (check_id, day))`. Plans gain `max_checks` (free 3, legacy 0) and `min_check_interval_seconds` (free 60, legacy 30). `incidents.server_id` becomes nullable, `incidents.check_id bigint REFERENCES checks ON DELETE CASCADE` is added with `CHECK (server_id IS NOT NULL OR check_id IS NOT NULL)`. `organizations.status_page_check_ids bigint[] NOT NULL DEFAULT '{}'`.

Semantics: `http` GETs `target` (an http/https URL) and is up when the status is `expect_status` (0 means any 2xx/3xx) and, if set, the body (first 1 MB) contains `keyword`. `tcp` connects to `host:port`. `tls` handshakes `host:port` (default 443) and reports days until the leaf certificate expires; `https` http checks also report it. All targets go through the SSRF guard (private, loopback and link-local refused unless `checks.allow_private_targets`). Results stay in memory (last 24 h per check); hourly rollups and daily uptime are written in the metrics flush window. Two consecutive failures open a critical incident (metric `http`/`tcp`/`tls`, `check_id` set); two consecutive successes resolve it. A certificate within `tls_warn_days` opens a warning incident (metric `tls_expiry`, value = days left) that resolves once renewed. Notifications go to `channel_ids` and respect maintenance windows.

API (all org-scoped):
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | /checks | viewer | `{checks:[CheckJSON]}` |
| POST | /checks | member | body `{name,type,target,interval_seconds?,timeout_seconds?,expect_status?,keyword?,tls_warn_days?,enabled?,channel_ids?}` → 201 `{check}`; `limit_reached` on quota |
| PATCH | /checks/:id | member | partial → `{check}` |
| DELETE | /checks/:id | member | 204 |
| POST | /checks/:id/run | member | runs once now → `{result}` (rate limited) |
| GET | /checks/:id/results | viewer | `?range=24h\|7d\|30d` → `{range, step_seconds, points:[{t, up_pct: number\|null, latency_avg: number\|null, latency_max: number\|null}]}` |

```ts
interface CheckJSON {
  id: number; name: string; type: 'http'|'tcp'|'tls'; target: string; interval_seconds: number; timeout_seconds: number;
  expect_status: number; keyword: string; tls_warn_days: number; enabled: boolean; channel_ids: number[];
  status: 'up'|'down'|'degraded'|'paused'|'pending';   // degraded = TLS expiring soon or a single failure
  last: null | { at: string; ok: boolean; latency_ms: number; status_code: number | null; error: string | null };
  uptime_24h: number | null; latency_spark: number[];  // last 30 results, ms
  tls_days_left: number | null; open_incidents: number; maintenance: boolean; created_at: string;
}
```
SSE: `event: checks` every 3 s when the org has checks: `{checks:[{id,status,last,uptime_24h,tls_days_left,maintenance}]}`. Incidents gain `check_id: number|null` and `check_name: string|null`; for check incidents `server_id` is `null` and `server_name` is the check name. Status page: `PATCH /org` `status_page.check_ids`; public `services[]` gains `kind: 'server'|'check'`.

Implementation notes (backend `checks` package):
- Validation: name 1 to 60 chars; http targets are http(s) URLs without credentials; tcp needs `host:port`; tls defaults to port 443 (stored as `host:443`); literal private or loopback addresses and `localhost` are refused with 400 unless `checks.allow_private_targets` (hostnames are enforced at dial time). `interval_seconds` defaults to max(60, plan minimum), must be at least the plan minimum (and 10) and at most 86400; `timeout_seconds` defaults to 10, 1 to 30, not above the interval. `expect_status` is 0 or 100 to 599; a 3xx `expect_status` checks the redirect itself (not followed). `tls_warn_days` is 0 (no warning) to 365. tcp and tls checks clear `expect_status` and `keyword`.
- `PATCH /org` without `status_page.check_ids` leaves them unchanged (older clients); `GET /org` returns `status_page.check_ids`, `plan.max_checks`, `plan.min_check_interval_seconds` and `usage.checks`.
- Results: `24h` is 96 steps of 15 min from memory (after a restart, flushed hours fill the gap), `7d` is 168 steps of 1 h and `30d` 360 steps of 2 h from `check_results_1h` plus unflushed results. Latency covers successful probes only.
- Incidents: `rule_name` is `Check down` or `Certificate expiring`; outage `last_value` counts consecutive failures (`threshold` 2), certificate `last_value` is days left (`threshold` = `tls_warn_days`, `comparison: 'below'`). Changing a check's type or target closes its open incidents with `resolved_how: 'check_changed'`, pausing with `'check_paused'` (no notification, `incident` `refresh` event). `GET /incidents` also accepts `check_id`. A manual resolve resets the failure count, so a still-failing check reopens after two more failures.
- Public status page: check services use the server vocabulary (`down` is `critical`, `degraded` is `warning`, `paused` is `offline`, `up` and `pending` are `healthy`) so `overall` ranks both kinds; daily `pct` is null for days without flushed probes.
- `POST /checks/:id/run` is limited to 6 per minute per org (burst 3) and returns `{result}` in the `last` shape.

### 6.4 F11 Maintenance windows (migration `00005_maintenance.sql`)

Table `maintenance_windows(id, org_id, name, scope_all bool, scope_server_ids bigint[], scope_tags text[], scope_check_ids bigint[], starts_at, ends_at, created_by, created_at)` with `CHECK (ends_at > starts_at)`; `incidents.silenced boolean NOT NULL DEFAULT false`.

Semantics: while a window is active for a server (scope all, its id, or any of its tags) or a check (its id), incidents are still recorded but marked `silenced` and no notification is sent (fired, renotify, resolved). Windows live in the directory (in memory) and are evaluated at event time; no DB access per sample.

API: `GET /maintenance` (viewer) → `{windows:[{id,name,scope:{all,server_ids,tags,check_ids},starts_at,ends_at,created_by,created_at,state:'scheduled'|'active'|'ended'}]}`; `POST /maintenance` (member); `PATCH /maintenance/:id` (member; "end now" = `{ends_at: now}`); `DELETE /maintenance/:id` (member). `ServerSummary` and `CheckJSON` gain `maintenance: boolean`; SSE `servers` updates carry `maintenance`; incidents gain `silenced: boolean`.
