/**
 * JSON shapes of the v2 HTTP API (docs/platform-v2.md section 4). IDs are
 * int64 on the server and fit in a JS number. Times are ISO 8601 UTC strings.
 * Where section 4 leaves a shape open, the type says so in a comment.
 */

export type ServerStatus = 'healthy' | 'warning' | 'critical' | 'offline';
export type Role = 'viewer' | 'member' | 'admin' | 'owner';
export type MetricKey = 'cpu' | 'memory' | 'disk' | 'net_in' | 'net_out' | 'heartbeat';
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
}

/** @deprecated Use Plan. */
export type PlanLimits = Plan;

export interface OrgUsage {
  servers: number;
  members: number;
  rules: number;
  channels: number;
  alert_emails_today: number;
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
  /**
   * Lowest warning and critical threshold of the enabled "above" rules that
   * apply to this server, keyed like `latest`. A metric without such a rule
   * has no key; a severity without one is null.
   */
  thresholds: ServerThresholds;
}

/** ServerSummary.thresholds: keyed cpu, mem, disk, net_in, net_out. */
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
}

export interface SeriesStat {
  min: number;
  avg: number;
  max: number;
  now: number;
}

export type SeriesField = 'cpu' | 'mem' | 'disk' | 'net_in' | 'net_out';

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

export interface Incident {
  id: number;
  server_id: number;
  server_name: string;
  rule_id: number | null;
  rule_name: string;
  metric: MetricKey;
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
  metric?: MetricKey;
  server_id?: number;
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

export interface PublicStatusService {
  name: string;
  status: ServerStatus;
  uptime_pct: number;
  /** 90 days, oldest first. */
  days: PublicStatusDay[];
}

export interface PublicStatusIncident {
  service: string;
  metric: MetricKey;
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

// ---------------------------------------------------------------- SSE

export interface StreamServerUpdate {
  id: number;
  status: ServerStatus;
  connected: boolean;
  last_seen: string | null;
  latest: ServerLatest | null;
  /** Reported on connect, which can happen after the list was cached. */
  agent_version?: string;
}

export interface ServersStreamEvent {
  servers: StreamServerUpdate[];
}

export type IncidentAction = 'opened' | 'updated' | 'resolved';

export interface IncidentStreamEvent {
  action: IncidentAction;
  incident: Incident;
}
