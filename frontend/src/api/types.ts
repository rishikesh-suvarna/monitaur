/**
 * JSON shapes of the v2 HTTP API (docs/platform-v2.md section 4). IDs are
 * int64 on the server and fit in a JS number. Times are ISO 8601 UTC strings.
 * Where section 4 leaves a shape open, the type says so in a comment.
 */

export type ServerStatus = 'healthy' | 'warning' | 'critical' | 'offline';
export type Role = 'viewer' | 'member' | 'admin' | 'owner';
export type MetricKey = 'cpu' | 'memory' | 'disk' | 'net_in' | 'net_out' | 'heartbeat' | 'load1' | 'swap';
export type Severity = 'warning' | 'critical';
export type IncidentState = 'open' | 'acked' | 'resolved';
export type Comparison = 'above' | 'below';
export type ChannelType = 'email' | 'slack' | 'discord' | 'telegram' | 'webhook';
export type MetricUnit = '%' | 'B/s' | '';
export type SeriesRange = 'live' | '1h' | '6h' | '24h' | '7d' | '30d';

// ---------------------------------------------------------------- me + org

export interface User {
  id: number;
  email: string;
  display_name: string;
  email_verified: boolean;
  provider: string;
}

export interface OrgMembership {
  id: number;
  name: string;
  role: Role;
  personal: boolean;
  plan_id: string;
}

export interface MeResponse {
  user: User;
  orgs: OrgMembership[];
  current_org_id: number;
}

export interface UpdateMeBody {
  display_name: string;
}

export interface StatusPageSettings {
  enabled: boolean;
  slug: string;
  title: string;
  server_ids: number[];
  /** Uptime checks shown on the page (F7). Absent on backends that predate checks. */
  check_ids?: number[];
}

export interface Org {
  id: number;
  name: string;
  plan_id: string;
  status_page: StatusPageSettings;
  /** Public status page address segment (`/status/<slug>`). */
  slug: string;
  personal: boolean;
  /** The caller's role; empty on POST /invites/accept, which has no org context yet. */
  role: Role | '';
  created_at: string;
}

/** GET /org .plan. Every limit uses 0 for unlimited. */
export interface Plan {
  id: string;
  name: string;
  max_servers: number;
  min_interval_seconds: number;
  retention_1m_days: number;
  retention_1h_days: number;
  max_members: number;
  alert_emails_per_day: number;
  max_rules: number;
  max_channels: number;
  api_rpm: number;
  /** F7 uptime checks quota (0 = unlimited). Absent on backends that predate checks. */
  max_checks?: number;
  /** F7 shortest check interval the plan allows. Absent on backends that predate checks. */
  min_check_interval_seconds?: number;
}

/** @deprecated Use Plan. */
export type PlanLimits = Plan;

export interface OrgUsage {
  servers: number;
  members: number;
  rules: number;
  channels: number;
  alert_emails_today: number;
  /**
   * Uptime checks in use. Not named in docs/platform-v2.md 6.3, which only adds
   * plans.max_checks; the UI falls back to the length of GET /checks.
   */
  checks?: number;
}

export interface OrgResponse {
  org: Org;
  plan: Plan;
  usage: OrgUsage;
}

export interface UpdateOrgBody {
  name?: string;
  /** 3 to 40 lowercase letters, digits and dashes, starting with a letter or digit. */
  slug?: string;
  /** Replaces the whole status page config, so send every field. */
  status_page?: Omit<StatusPageSettings, 'slug'>;
}

export interface Member {
  user_id: number;
  email: string;
  display_name: string;
  role: Role;
  joined_at: string;
}

export interface Invite {
  id: number;
  email: string;
  role: Role;
  expires_at: string;
  created_at: string;
}

export interface MembersResponse {
  members: Member[];
  invites: Invite[];
}

export interface CreateInviteBody {
  email: string;
  /** Owner is not invitable; promote an accepted member instead. */
  role: Exclude<Role, 'owner'>;
}

export interface CreateInviteResponse {
  invite: Invite;
  /** The accept link. Returned to admins so it can be shared when email is not configured. */
  invite_url: string;
  /** False when SMTP is off or sending failed: share invite_url by hand. */
  emailed: boolean;
}

// ---------------------------------------------------------------- servers

/** A physical filesystem (section 6.1: no tmpfs, overlay, squashfs or proc; at most 16). */
export interface ServerMount {
  path: string;
  fstype: string;
  /** bytes */
  total: number;
  /** bytes */
  used: number;
  /** 0 to 100 */
  pct: number;
}

/** A network interface (loopback excluded, at most 16) with rates from counter deltas. */
export interface ServerInterface {
  name: string;
  /** bytes per second */
  in: number;
  /** bytes per second */
  out: number;
}

export interface ServerLatest {
  cpu: number;
  mem: number;
  disk: number;
  /** bytes per second */
  net_in: number;
  /** bytes per second */
  net_out: number;
  mem_total: number;
  mem_used: number;
  disk_total: number;
  disk_used: number;
  cpu_cores: number;
  uptime_s: number;
  at: string;
  // Section 6.1 host metrics: null when the agent does not report them (older agents), never 0.
  load1: number | null;
  load5: number | null;
  load15: number | null;
  /** 0 to 100 */
  swap: number | null;
  /** bytes */
  swap_total: number | null;
  /** bytes */
  swap_used: number | null;
  /** bytes per second */
  disk_read: number | null;
  /** bytes per second */
  disk_write: number | null;
  /** Empty for older agents. */
  mounts: ServerMount[];
  /** Empty for older agents. */
  interfaces: ServerInterface[];
}

export interface ServerSpark {
  /** Last 30 minute buckets, oldest first. */
  cpu: number[];
  mem: number[];
  disk: number[];
}

export interface ServerSummary {
  id: number;
  name: string;
  tags: string[];
  pinned: boolean;
  status: ServerStatus;
  connected: boolean;
  last_seen: string | null;
  agent_version: string;
  latest: ServerLatest | null;
  spark: ServerSpark;
  open_incidents: number;
  created_at: string;
  /** Inside an active maintenance window: incidents are recorded but notifications are paused (section 6.4). */
  maintenance: boolean;
  /**
   * Lowest warning and critical threshold of the enabled "above" rules that
   * apply to this server, keyed like `latest`. A metric without such a rule
   * has no key; a severity without one is null.
   */
  thresholds: ServerThresholds;
}

/** ServerSummary.thresholds: keyed cpu, mem, disk, net_in, net_out, load1 and swap. */
export type ServerThresholds = Partial<Record<SeriesField, ThresholdPair>>;

export interface ServersResponse {
  servers: ServerSummary[];
}

export interface CreateServerBody {
  name: string;
  tags?: string[];
}

export interface InstallInstructions {
  command: string;
  config_path: string;
  /** Section 4 does not say whether this is pre-rendered text or an object. */
  config: string | Record<string, unknown>;
}

export interface CreateServerResponse {
  server: ServerSummary;
  /** Plaintext agent token. Returned once; the backend stores only a hash. */
  token: string;
  install: InstallInstructions;
}

/** One process from the agent's latest list (section 6.2). */
export interface ServerProcess {
  pid: number;
  name: string;
  user: string;
  /** Percent CPU; can exceed 100 on multi-core hosts. */
  cpu: number;
  /** Percent of total memory. */
  mem: number;
  /** Resident set size, bytes. */
  rss: number;
  /** Command line, truncated by the agent to 200 characters. */
  cmd: string;
}

/**
 * GET /servers/:id/processes: the union of the top 15 by CPU and the top 15 by
 * memory (at most 30). `at` is null and the list empty until the agent has sent
 * one (older agents never do).
 */
export interface ProcessesResponse {
  at: string | null;
  /** Processes on the host, not just the ones listed. */
  total: number;
  processes: ServerProcess[];
}

export interface ServerTokenInfo {
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ServerDetailResponse {
  server: ServerSummary;
  token: ServerTokenInfo;
  counts: { incidents: number; rules: number; metrics_days: number };
}

export interface UpdateServerBody {
  name?: string;
  tags?: string[];
}

export interface RotateTokenResponse {
  token: string;
  previous_valid_until: string;
  /** Not in section 4, but the backend sends the new agent config here (same shape as POST /servers). */
  install?: InstallInstructions;
}

export interface SeriesPoint {
  t: string;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  net_in: number | null;
  net_out: number | null;
  // Section 6.1: null for steps without extended samples (older agents).
  load1: number | null;
  swap: number | null;
  /** bytes per second */
  disk_read: number | null;
  /** bytes per second */
  disk_write: number | null;
}

export interface SeriesStat {
  min: number;
  avg: number;
  max: number;
  now: number;
}

export type SeriesField = 'cpu' | 'mem' | 'disk' | 'net_in' | 'net_out' | 'load1' | 'swap' | 'disk_read' | 'disk_write';

export interface ThresholdPair {
  warning: number | null;
  critical: number | null;
}

export interface SeriesResponse {
  range: SeriesRange;
  step_seconds: number;
  from: string;
  to: string;
  points: SeriesPoint[];
  stats: Partial<Record<SeriesField, SeriesStat>>;
  /** Keyed like stats; section 4 shows `{cpu:{warning,critical},...}`. */
  thresholds: Partial<Record<string, ThresholdPair>>;
}

// ---------------------------------------------------------------- incidents

/** Incident metrics of uptime checks (F7): a failing check, or a certificate close to expiry. */
export type CheckMetric = 'http' | 'tcp' | 'tls' | 'tls_expiry';

/** Every metric an incident can carry: server rules plus uptime checks. */
export type IncidentMetric = MetricKey | CheckMetric;

export interface Incident {
  id: number;
  /** Null for uptime check incidents (F7). */
  server_id: number | null;
  /** For check incidents, the check's name. */
  server_name: string;
  rule_id: number | null;
  rule_name: string;
  metric: IncidentMetric;
  severity: Severity;
  state: IncidentState;
  /** The rule's comparison: the incident opened when the value went above or below `threshold`. */
  comparison: Comparison;
  threshold: number;
  peak: number;
  last_value: number;
  unit: MetricUnit;
  samples_over: number;
  started_at: string;
  resolved_at: string | null;
  resolved_how: string | null;
  acked_at: string | null;
  acked_by: string | null;
  last_notified_at: string | null;
  notified_channels: string[];
  next_notify_at: string | null;
  /** Set for uptime check incidents (F7). */
  check_id: number | null;
  check_name: string | null;
  /** Recorded during a maintenance window, so nobody was notified (F11). */
  silenced: boolean;
}

export interface IncidentCounts {
  open: number;
  acked: number;
  resolved_24h: number;
}

export interface IncidentsResponse {
  incidents: Incident[];
  counts: IncidentCounts;
}

export interface IncidentFilters {
  state?: IncidentState | 'all';
  severity?: Severity;
  metric?: IncidentMetric;
  server_id?: number;
  /**
   * Not in docs/platform-v2.md 6.3, which only lists server_id. Sent for the
   * check detail page; lists are also filtered locally in case it is ignored.
   */
  check_id?: number;
  limit?: number;
  /** Cursor: return incidents with id below this one. */
  before?: number;
}

export interface IncidentResponse {
  incident: Incident;
}

// ---------------------------------------------------------------- rules

export interface RuleScope {
  all: boolean;
  server_ids: number[];
  tags: string[];
}

export interface Rule {
  id: number;
  name: string;
  enabled: boolean;
  scope: RuleScope;
  metric: MetricKey;
  comparison: Comparison;
  threshold: number;
  for_seconds: number;
  severity: Severity;
  channel_ids: number[];
  cooldown_seconds: number;
  auto_resolve_seconds: number;
  created_at: string;
  updated_at: string;
}

export type RuleInput = Omit<Rule, 'id' | 'created_at' | 'updated_at'>;

export interface RulesResponse {
  rules: Rule[];
  /** ruleId -> number of servers the rule's scope matches */
  matched: Record<string, number>;
}

export interface RuleResponse {
  rule: Rule;
}

export interface RulePreviewIncident {
  server_id: number;
  start: string;
  /** null while the replayed incident would still be open. */
  end: string | null;
  /** In the rule's API unit: percent, or bytes/s for network. */
  peak: number;
}

export interface RulePreviewResponse {
  matched_servers: number;
  /** The backend replays at most this many of the matched servers. */
  previewed: number;
  /** Number of incidents the rule would have opened (incidents.length). */
  would_fire: number;
  incidents: RulePreviewIncident[];
  window_hours: number;
}

// ---------------------------------------------------------------- channels

export interface Channel {
  id: number;
  type: ChannelType;
  name: string;
  enabled: boolean;
  /** Redacted config summary, safe to display. */
  summary: Record<string, string>;
  last_delivery_at: string | null;
  last_delivery_ok: boolean | null;
  last_error: string | null;
  created_at: string;
}

/** Write-only channel config (backend notify.ChannelConfig). */
export interface ChannelConfig {
  email_to?: string[];
  webhook_url?: string;
  webhook_secret?: string;
  telegram_token?: string;
  telegram_chat_id?: string;
}

export interface CreateChannelBody {
  type: ChannelType;
  name: string;
  enabled?: boolean;
  config: ChannelConfig;
}

export interface UpdateChannelBody {
  name?: string;
  enabled?: boolean;
  config?: ChannelConfig;
}

export interface ChannelsResponse {
  channels: Channel[];
}

export interface ChannelResponse {
  channel: Channel;
}

export interface ChannelTestResponse {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------- public status

export interface PublicStatusDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  /** Percent of the day the server reported; null before the server existed. */
  pct: number | null;
  /** Worst incident severity that day, or null for none. */
  worst: Severity | null;
}

export type PublicServiceKind = 'server' | 'check';

export interface PublicStatusService {
  name: string;
  /**
   * Server status words; docs/platform-v2.md 6.3 does not say which words a
   * check service uses, so check statuses are accepted too and mapped for display.
   */
  status: ServerStatus | CheckStatus;
  /** F7. Absent on backends that predate checks (every service is a server). */
  kind?: PublicServiceKind;
  /** Null until the backend's first metrics flush has measured anything. */
  uptime_pct: number | null;
  /** 90 days, oldest first. */
  days: PublicStatusDay[];
}

export interface PublicStatusIncident {
  service: string;
  metric: IncidentMetric;
  severity: Severity;
  started_at: string;
  resolved_at: string | null;
}

/** GET /public/status/:slug (cached 60 s by the backend). */
export interface PublicStatusResponse {
  title: string;
  overall: ServerStatus;
  updated_at: string;
  services: PublicStatusService[];
  incidents: PublicStatusIncident[];
}

/** The name section 4 uses for this shape. */
export type PublicStatus = PublicStatusResponse;

// ---------------------------------------------------------------- uptime checks (F7)

export type CheckType = 'http' | 'tcp' | 'tls';
/** degraded = TLS expiring soon or a single failure. */
export type CheckStatus = 'up' | 'down' | 'degraded' | 'paused' | 'pending';
export type CheckResultsRange = '24h' | '7d' | '30d';

export interface CheckResult {
  at: string;
  ok: boolean;
  latency_ms: number;
  /** HTTP status; null for tcp and tls, or when no response came back. */
  status_code: number | null;
  error: string | null;
}

/** GET /checks item (CheckJSON in docs/platform-v2.md 6.3). */
export interface Check {
  id: number;
  name: string;
  type: CheckType;
  /** http: an http(s) URL; tcp and tls: host:port (tls defaults to 443). */
  target: string;
  interval_seconds: number;
  timeout_seconds: number;
  /** 0 means any 2xx or 3xx. */
  expect_status: number;
  /** Empty for none. */
  keyword: string;
  tls_warn_days: number;
  enabled: boolean;
  channel_ids: number[];
  status: CheckStatus;
  last: CheckResult | null;
  /** Null until the check has results. */
  uptime_24h: number | null;
  /** Last 30 results, oldest first, in ms. */
  latency_spark: number[];
  tls_days_left: number | null;
  open_incidents: number;
  /** A maintenance window covers the check right now (F11). */
  maintenance: boolean;
  created_at: string;
}

/** The name docs/platform-v2.md 6.3 uses for this shape. */
export type CheckJSON = Check;

export interface ChecksResponse {
  checks: Check[];
}

export interface CheckResponse {
  check: Check;
}

/** POST /checks body. Omitted optionals take the backend defaults. */
export interface CreateCheckBody {
  name: string;
  type: CheckType;
  target: string;
  interval_seconds?: number;
  timeout_seconds?: number;
  expect_status?: number;
  keyword?: string;
  tls_warn_days?: number;
  enabled?: boolean;
  channel_ids?: number[];
}

/** PATCH /checks/:id body. */
export type UpdateCheckBody = Partial<CreateCheckBody>;

/**
 * POST /checks/:id/run result. docs/platform-v2.md 6.3 only says `{result}`;
 * this assumes the CheckJSON.last shape, plus the certificate days when known.
 */
export interface CheckRunResult extends CheckResult {
  tls_days_left?: number | null;
}

export interface CheckRunResponse {
  result: CheckRunResult;
}

export interface CheckResultPoint {
  t: string;
  /** Share of results that were up in the step, 0 to 100; null without results. */
  up_pct: number | null;
  latency_avg: number | null;
  latency_max: number | null;
}

/** GET /checks/:id/results?range= */
export interface CheckResultsResponse {
  range: CheckResultsRange;
  step_seconds: number;
  points: CheckResultPoint[];
}

// ---------------------------------------------------------------- maintenance windows (F11)

export type MaintenanceState = 'scheduled' | 'active' | 'ended';

export interface MaintenanceScope {
  all: boolean;
  server_ids: number[];
  tags: string[];
  check_ids: number[];
}

export interface MaintenanceWindow {
  id: number;
  name: string;
  scope: MaintenanceScope;
  starts_at: string;
  ends_at: string;
  /** Display name, else email, of the creator; null once that user is deleted. */
  created_by: string | null;
  created_at: string;
  state: MaintenanceState;
}

export interface MaintenanceResponse {
  windows: MaintenanceWindow[];
}

/** POST /maintenance body. */
export interface CreateMaintenanceBody {
  name: string;
  scope: MaintenanceScope;
  starts_at: string;
  ends_at: string;
}

/** PATCH /maintenance/:id body; "End now" sends only ends_at. */
export type UpdateMaintenanceBody = Partial<CreateMaintenanceBody>;

/** POST and PATCH /maintenance response. docs/platform-v2.md 6.4 leaves it open; the UI refetches the list either way. */
export interface MaintenanceWindowResponse {
  window?: MaintenanceWindow;
}

// ---------------------------------------------------------------- SSE

export interface StreamServerUpdate {
  id: number;
  status: ServerStatus;
  connected: boolean;
  last_seen: string | null;
  latest: ServerLatest | null;
  /** Reported on connect, which can happen after the list was cached. */
  agent_version?: string;
  /** Section 6.4; absent from backends without maintenance windows. */
  maintenance?: boolean;
}

export interface ServersStreamEvent {
  servers: StreamServerUpdate[];
}

export type IncidentAction = 'opened' | 'updated' | 'resolved';

export interface IncidentStreamEvent {
  action: IncidentAction;
  incident: Incident;
}

/** `event: checks` item: the live fields of one check (F7). */
export interface StreamCheckUpdate {
  id: number;
  status: CheckStatus;
  last: CheckResult | null;
  uptime_24h: number | null;
  tls_days_left: number | null;
  maintenance: boolean;
}

export interface ChecksStreamEvent {
  checks: StreamCheckUpdate[];
}
