/**
 * Alert rule editing logic for Rules.dc.html: the editable draft, unit
 * conversion (MB/s on screen, bytes/s on the wire), the rule sentence, scope
 * matching and the preview timeline. Pure, so it is unit tested.
 */
import type {
  Channel,
  Comparison,
  MetricKey,
  Rule,
  RuleInput,
  RulePreviewIncident,
  RuleScope,
  ServerSummary,
  Severity,
} from '../../api/types';
import { channelLabel } from '../../lib/channels';
import { METRIC_LABELS } from '../../lib/status';

// ---------------------------------------------------------------- units

/** Network thresholds are typed in MB/s (binary, like formatMBps) and sent as bytes/s. */
export const BYTES_PER_MB = 1024 * 1024;
export const PERCENT_MAX = 100;
const DISPLAY_DECIMALS = 2;

export type DisplayUnit = '%' | 'MB/s' | '';

export const RULE_METRICS: readonly MetricKey[] = ['cpu', 'memory', 'disk', 'net_in', 'net_out', 'heartbeat'];

export const isPercentMetric = (metric: MetricKey): boolean => metric === 'cpu' || metric === 'memory' || metric === 'disk';
export const isRateMetric = (metric: MetricKey): boolean => metric === 'net_in' || metric === 'net_out';

export function displayUnit(metric: MetricKey): DisplayUnit {
  if (isPercentMetric(metric)) return '%';
  if (isRateMetric(metric)) return 'MB/s';
  return '';
}

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Screen value (%, MB/s) to the API value (%, bytes/s). */
export function toApiThreshold(metric: MetricKey, display: number): number {
  if (isRateMetric(metric)) return Math.round(display * BYTES_PER_MB);
  if (metric === 'heartbeat') return 0;
  return display;
}

/** API value to the screen value, without float noise: 104857600 B/s -> 100 MB/s. */
export function fromApiThreshold(metric: MetricKey, api: number): number {
  if (isRateMetric(metric)) return roundTo(api / BYTES_PER_MB, DISPLAY_DECIMALS);
  return roundTo(api, DISPLAY_DECIMALS);
}

/** "85%", "100 MB/s", "92.4%" for an API-unit value. */
export function formatRuleValue(metric: MetricKey, api: number, decimals = DISPLAY_DECIMALS): string {
  const value = String(roundTo(fromApiThreshold(metric, api), decimals));
  const unit = displayUnit(metric);
  if (unit === '') return value;
  return unit === '%' ? `${value}%` : `${value} ${unit}`;
}

// ---------------------------------------------------------------- durations

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MINUTE = SECONDS_PER_MINUTE;
const HOUR = SECONDS_PER_HOUR;

/** The engine refuses anything longer (alerting.maxRuleDuration). */
export const MAX_RULE_SECONDS = 24 * HOUR;
/** Heartbeat windows stay above the agent send interval (alerting.minHeartbeatFor). */
export const MIN_HEARTBEAT_FOR_SECONDS = 30;
export const MAX_RULE_NAME_LENGTH = 80;

export const FOR_OPTIONS: readonly number[] = [1, 2, 5, 10, 15, 30, 60].map((minutes) => minutes * MINUTE);
export const COOLDOWN_OPTIONS: readonly number[] = [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 6 * HOUR];
export const AUTO_RESOLVE_OPTIONS: readonly number[] = [1, 2, 5, 10, 15].map((minutes) => minutes * MINUTE);

export const DEFAULT_FOR_SECONDS = 5 * MINUTE;
export const DEFAULT_COOLDOWN_SECONDS = 30 * MINUTE;
export const DEFAULT_AUTO_RESOLVE_SECONDS = 2 * MINUTE;

/** Display defaults when a metric is picked (Rules.dc.html). */
export const DEFAULT_THRESHOLD: Record<MetricKey, number> = {
  cpu: 85,
  memory: 80,
  disk: 90,
  net_in: 100,
  net_out: 50,
  heartbeat: 0,
};

/** "30 s", "5 min", "1 h", "1 h 30 min". */
export function formatRuleDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < MINUTE) return `${total} s`;
  if (total < HOUR) {
    const minutes = Math.floor(total / MINUTE);
    const rest = total % MINUTE;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(total / HOUR);
  const minutes = Math.round((total % HOUR) / MINUTE);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** The preset options plus the current value when it is a custom one. */
export function durationOptions(presets: readonly number[], current: number): number[] {
  const values = new Set(presets);
  if (current > 0) values.add(current);
  return [...values].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- draft

export interface RuleDraft {
  name: string;
  /** False while the name is still the generated one, so it follows the condition. */
  nameEdited: boolean;
  enabled: boolean;
  scopeAll: boolean;
  serverIds: number[];
  tags: string[];
  metric: MetricKey;
  comparison: Comparison;
  /** As typed, in display units. */
  threshold: string;
  forSeconds: number;
  severity: Severity;
  channelIds: number[];
  cooldownOn: boolean;
  cooldownSeconds: number;
  autoResolveOn: boolean;
  autoResolveSeconds: number;
}

/** "cpu-warn", "disk-critical", "net_in-low-warn", "host-unreachable". */
export function autoRuleName(draft: Pick<RuleDraft, 'metric' | 'comparison' | 'severity'>): string {
  if (draft.metric === 'heartbeat') return draft.severity === 'critical' ? 'host-unreachable' : 'host-unreachable-warn';
  const level = draft.severity === 'critical' ? 'critical' : 'warn';
  return draft.comparison === 'below' ? `${draft.metric}-low-${level}` : `${draft.metric}-${level}`;
}

export function draftFromRule(rule: Rule): RuleDraft {
  return {
    name: rule.name,
    nameEdited: true,
    enabled: rule.enabled,
    scopeAll: rule.scope.all,
    serverIds: [...rule.scope.server_ids],
    tags: [...rule.scope.tags],
    metric: rule.metric,
    comparison: rule.comparison,
    threshold: rule.metric === 'heartbeat' ? '' : String(fromApiThreshold(rule.metric, rule.threshold)),
    forSeconds: rule.for_seconds,
    severity: rule.severity,
    channelIds: [...rule.channel_ids],
    cooldownOn: rule.cooldown_seconds > 0,
    cooldownSeconds: rule.cooldown_seconds > 0 ? rule.cooldown_seconds : DEFAULT_COOLDOWN_SECONDS,
    autoResolveOn: rule.auto_resolve_seconds > 0,
    autoResolveSeconds: rule.auto_resolve_seconds > 0 ? rule.auto_resolve_seconds : DEFAULT_AUTO_RESOLVE_SECONDS,
  };
}

export interface NewDraftOptions {
  /** /rules?new=1&server=<id>: scope the new rule to that server. */
  serverId?: number | null;
  /** Enabled channels are preselected; a rule that notifies nobody is rarely intended. */
  channels?: readonly Channel[];
}

export function newDraft({ serverId = null, channels = [] }: NewDraftOptions = {}): RuleDraft {
  const base = { metric: 'cpu', comparison: 'above', severity: 'warning' } as const;
  return {
    ...base,
    name: autoRuleName(base),
    nameEdited: false,
    enabled: true,
    scopeAll: serverId === null,
    serverIds: serverId === null ? [] : [serverId],
    tags: [],
    threshold: String(DEFAULT_THRESHOLD.cpu),
    forSeconds: DEFAULT_FOR_SECONDS,
    channelIds: channels.filter((channel) => channel.enabled).map((channel) => channel.id),
    cooldownOn: true,
    cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
    autoResolveOn: true,
    autoResolveSeconds: DEFAULT_AUTO_RESOLVE_SECONDS,
  };
}

/** Applies a change and keeps a generated name in step with the condition. */
export function updateDraft(draft: RuleDraft, patch: Partial<RuleDraft>): RuleDraft {
  const next = { ...draft, ...patch };
  if (patch.metric !== undefined && patch.metric !== draft.metric && patch.threshold === undefined) {
    next.threshold = patch.metric === 'heartbeat' ? '' : String(DEFAULT_THRESHOLD[patch.metric]);
    if (patch.metric === 'heartbeat' && next.forSeconds < MIN_HEARTBEAT_FOR_SECONDS) next.forSeconds = DEFAULT_FOR_SECONDS;
  }
  if (!next.nameEdited) next.name = autoRuleName(next);
  return next;
}

export const parseThreshold = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw));

export function draftScope(draft: Pick<RuleDraft, 'scopeAll' | 'serverIds' | 'tags'>): RuleScope {
  return draft.scopeAll ? { all: true, server_ids: [], tags: [] } : { all: false, server_ids: [...draft.serverIds], tags: [...draft.tags] };
}

/** The API body. Heartbeat sends comparison "above" and threshold 0, which the engine ignores. */
export function draftToInput(draft: RuleDraft): RuleInput {
  const heartbeat = draft.metric === 'heartbeat';
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    scope: draftScope(draft),
    metric: draft.metric,
    comparison: heartbeat ? 'above' : draft.comparison,
    threshold: heartbeat ? 0 : toApiThreshold(draft.metric, parseThreshold(draft.threshold)),
    for_seconds: draft.forSeconds,
    severity: draft.severity,
    channel_ids: [...draft.channelIds],
    cooldown_seconds: draft.cooldownOn ? draft.cooldownSeconds : 0,
    auto_resolve_seconds: draft.autoResolveOn ? draft.autoResolveSeconds : 0,
  };
}

/** Only the fields that change what the preview replays; name, channels and timers do not. */
export function previewKey(input: RuleInput): string {
  const { scope, metric, comparison, threshold, for_seconds, severity } = input;
  return JSON.stringify({ scope, metric, comparison, threshold, for_seconds, severity });
}

export function sameInput(a: RuleInput, b: RuleInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------- validation

export type RuleField = 'name' | 'scope' | 'metric' | 'threshold' | 'for' | 'severity' | 'channels' | 'cooldown' | 'autoResolve';
export type RuleErrors = Partial<Record<RuleField, string>>;

/** Client-side checks mirroring alerting.Rule.Validate, so most mistakes never reach the API. */
export function validateDraft(draft: RuleDraft): RuleErrors {
  const errors: RuleErrors = {};
  const name = draft.name.trim();
  if (name === '') errors.name = 'Give the rule a name.';
  else if (Array.from(name).length > MAX_RULE_NAME_LENGTH) errors.name = `At most ${MAX_RULE_NAME_LENGTH} characters.`;

  if (!draft.scopeAll && draft.serverIds.length === 0 && draft.tags.length === 0) {
    errors.scope = 'Pick at least one server or tag, or apply the rule to all servers.';
  }

  if (draft.metric === 'heartbeat') {
    if (draft.forSeconds < MIN_HEARTBEAT_FOR_SECONDS) errors.for = `Heartbeat rules need at least ${MIN_HEARTBEAT_FOR_SECONDS} s.`;
  } else {
    const value = parseThreshold(draft.threshold);
    if (!Number.isFinite(value)) errors.threshold = 'Enter a number.';
    else if (isPercentMetric(draft.metric) && (value < 0 || value > PERCENT_MAX)) errors.threshold = 'Between 0 and 100%.';
    else if (value < 0) errors.threshold = 'Zero or more.';
  }

  if (draft.forSeconds < 0 || draft.forSeconds > MAX_RULE_SECONDS) errors.for = 'At most 24 h.';
  return errors;
}

export const hasErrors = (errors: RuleErrors): boolean => Object.keys(errors).length > 0;

/** Which field an API `invalid` message is about, so it shows next to that field. */
export function fieldForApiError(message: string): RuleField | null {
  const text = message.toLowerCase();
  if (text.includes('rule name')) return 'name';
  if (text.includes('scope')) return 'scope';
  if (text.includes('unknown metric')) return 'metric';
  if (text.includes('threshold') || text.includes('comparison')) return 'threshold';
  if (text.includes('heartbeat rules need') || text.includes('duration (for)')) return 'for';
  if (text.includes('cooldown')) return 'cooldown';
  if (text.includes('auto-resolve')) return 'autoResolve';
  if (text.includes('channel')) return 'channels';
  if (text.includes('severity')) return 'severity';
  return null;
}

// ---------------------------------------------------------------- sentences

const COMPARISON_SYMBOL: Record<Comparison, string> = { above: '>', below: '<' };

type ConditionFields = Pick<RuleInput, 'metric' | 'comparison' | 'threshold' | 'for_seconds' | 'severity'>;

/** List title: "CPU > 85% for 5 min → warning", "Unreachable for 2 min → critical". */
export function ruleTitle(rule: ConditionFields): string {
  const duration = formatRuleDuration(rule.for_seconds);
  if (rule.metric === 'heartbeat') return `Unreachable for ${duration} → ${rule.severity}`;
  const value = formatRuleValue(rule.metric, rule.threshold);
  return `${METRIC_LABELS[rule.metric]} ${COMPARISON_SYMBOL[rule.comparison]} ${value} for ${duration} → ${rule.severity}`;
}

const joinNames = (names: readonly string[]): string => {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
};

/**
 * The editor's condition read as one sentence (also its accessible summary):
 * "When CPU is above 85% for 5 min, raise warning, notify Slack · ops and Email."
 */
export function ruleSentence(rule: ConditionFields, channelNames: readonly string[]): string {
  const duration = formatRuleDuration(rule.for_seconds);
  const condition =
    rule.metric === 'heartbeat'
      ? `When the heartbeat is missing for ${duration}`
      : `When ${METRIC_LABELS[rule.metric]} is ${rule.comparison} ${formatRuleValue(rule.metric, rule.threshold)} for ${duration}`;
  const notify = channelNames.length === 0 ? 'notify nobody' : `notify ${joinNames(channelNames)}`;
  return `${condition}, raise ${rule.severity}, ${notify}.`;
}

// ---------------------------------------------------------------- scope

type ScopedServer = Pick<ServerSummary, 'id' | 'name' | 'tags'>;

/** Mirrors alerting.Rule.Matches: all, a listed id, or any shared tag (case-insensitive). */
export function matchesScope(scope: RuleScope, server: ScopedServer): boolean {
  if (scope.all || scope.server_ids.includes(server.id)) return true;
  const wanted = new Set(scope.tags.map((tag) => tag.toLowerCase()));
  return server.tags.some((tag) => wanted.has(tag.toLowerCase()));
}

export function countMatched(scope: RuleScope, servers: readonly ScopedServer[]): number {
  return servers.filter((server) => matchesScope(scope, server)).length;
}

const SCOPE_SUMMARY_ITEMS = 2;

/** "all servers", "tag: prod, worker-queue-01", "tag: prod, api-01 +2". */
export function scopeSummary(scope: RuleScope, serverNames: ReadonlyMap<number, string>): string {
  if (scope.all) return 'all servers';
  const items = [...scope.tags.map((tag) => `tag: ${tag}`), ...scope.server_ids.map((id) => serverNames.get(id) ?? `server #${id}`)];
  if (items.length === 0) return 'no servers';
  const shown = items.slice(0, SCOPE_SUMMARY_ITEMS).join(', ');
  return items.length > SCOPE_SUMMARY_ITEMS ? `${shown} +${items.length - SCOPE_SUMMARY_ITEMS}` : shown;
}

/** "ops-alerts, Email" for list rows, or "no channels". Unknown ids (a deleted channel) are skipped. */
export function channelsSummary(ids: readonly number[], channels: ReadonlyMap<number, Channel>): string {
  const names = ids.flatMap((id) => {
    const channel = channels.get(id);
    return channel ? [channel.name.trim() || channelLabel(channel)] : [];
  });
  return names.length === 0 ? 'no channels' : names.join(', ');
}

// ---------------------------------------------------------------- preview

export const PREVIEW_WINDOW_HOURS = 7 * 24;
const MS_PER_HOUR = 3_600_000;

/** Short incidents still get a visible sliver on a 7-day track. */
export const MIN_SPAN_PCT = 0.6;

export interface TimelineSpan {
  start: string;
  end: string | null;
  peak: number;
  leftPct: number;
  widthPct: number;
}

export interface TimelineRow {
  serverId: number;
  name: string;
  spans: TimelineSpan[];
}

/**
 * One row per server with would-be incidents, laid out on the preview window
 * (oldest left). Open incidents run to `now`. Busiest server first.
 */
export function previewTimeline(
  incidents: readonly RulePreviewIncident[],
  now: number,
  serverNames: ReadonlyMap<number, string>,
  windowHours = PREVIEW_WINDOW_HOURS,
): TimelineRow[] {
  const windowMs = windowHours * MS_PER_HOUR;
  const from = now - windowMs;
  const rows = new Map<number, TimelineRow>();
  for (const incident of incidents) {
    const start = Math.max(from, Date.parse(incident.start));
    const end = Math.min(now, incident.end === null ? now : Date.parse(incident.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < from) continue;
    const leftPct = ((start - from) / windowMs) * PERCENT_MAX;
    const widthPct = Math.max(MIN_SPAN_PCT, ((end - start) / windowMs) * PERCENT_MAX);
    const row = rows.get(incident.server_id) ?? {
      serverId: incident.server_id,
      name: serverNames.get(incident.server_id) ?? `server #${incident.server_id}`,
      spans: [],
    };
    row.spans.push({ start: incident.start, end: incident.end, peak: incident.peak, leftPct, widthPct: Math.min(widthPct, PERCENT_MAX - leftPct) });
    rows.set(incident.server_id, row);
  }
  return [...rows.values()].sort((a, b) => b.spans.length - a.spans.length || a.name.localeCompare(b.name));
}

export interface PreviewCounts {
  would_fire: number;
  matched_servers: number;
  previewed: number;
  /** Servers with at least one would-be incident. */
  servers: number;
}

const times = (count: number): string => (count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`);

/** The line beside "Preview · last 7 days". */
export function previewSummary(counts: PreviewCounts): string {
  if (counts.matched_servers === 0) return 'No servers match this scope yet, so there is nothing to replay.';
  if (counts.would_fire === 0) return 'Would not have fired. Quiet, maybe too quiet.';
  const on = counts.servers === 1 ? 'on 1 server' : `on ${counts.servers} servers`;
  return `Would have fired ${times(counts.would_fire)} ${on}.`;
}

/** Shown when the backend capped the replay (it previews at most 10 servers). */
export function previewCoverage(counts: Pick<PreviewCounts, 'matched_servers' | 'previewed'>): string | null {
  if (counts.previewed >= counts.matched_servers) return null;
  return `Replayed ${counts.previewed} of ${counts.matched_servers} matching servers.`;
}
