/**
 * Uptime check editing and shaping (docs/platform-v2.md 6.3): the form draft
 * per type, target and interval validation against the plan, the API bodies
 * and the results chart rows. Pure, so it is unit tested.
 */
import type {
  Channel,
  Check,
  OrgUsage,
  Plan,
  CheckResultPoint,
  CheckResultsRange,
  CheckStatus,
  CheckType,
  CreateCheckBody,
  UpdateCheckBody,
} from '../../api/types';
import { CHECK_STATUS_META, reportsTls, type CheckStatusCounts, type TlsTone } from '../../lib/checks';
import { plural } from '../../lib/format';
import { usageState } from '../../lib/usage';
import { formatRuleDuration } from '../rules/ruleModel';

// ---------------------------------------------------------------- limits

export const MAX_CHECK_NAME_LENGTH = 80;
export const MAX_TARGET_LENGTH = 2048;
export const MAX_KEYWORD_LENGTH = 256;
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
export const DEFAULT_TLS_PORT = 443;
export const DEFAULT_TLS_WARN_DAYS = 14;
export const MIN_TLS_WARN_DAYS = 1;
export const MAX_TLS_WARN_DAYS = 365;
export const MIN_EXPECT_STATUS = 100;
export const MAX_EXPECT_STATUS = 599;
/** "0 means any 2xx/3xx" on the wire. */
export const ANY_STATUS = 0;

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const INTERVAL_PRESETS: readonly number[] = [30, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR];
/** The backend rejects longer timeouts (api/checks.go maxCheckTimeoutSeconds). */
export const MAX_TIMEOUT_SECONDS = 30;
export const TIMEOUT_PRESETS: readonly number[] = [5, 10, 15, MAX_TIMEOUT_SECONDS];
export const DEFAULT_INTERVAL_SECONDS = MINUTE;
export const DEFAULT_TIMEOUT_SECONDS = 10;

/** With the stream up, GET /checks only refreshes sparklines and counts; without it, poll. */
export const CHECKS_REFRESH_LIVE_MS = 60_000;
export const CHECKS_REFRESH_FALLBACK_MS = 15_000;

export const RESULTS_RANGES: readonly CheckResultsRange[] = ['24h', '7d', '30d'];
export const RESULTS_RANGE_LABELS: Record<CheckResultsRange, string> = { '24h': '24h', '7d': '7d', '30d': '30d' };

/** Certificate days left: warn/crit only inside the check's own warning window. */
export const TLS_TONE_CLASS: Record<TlsTone, string> = {
  ok: 'text-ink',
  warn: 'font-semibold text-warn',
  crit: 'font-semibold text-crit',
  none: 'text-ink-faint',
};

/** "30 s", "1 min", "1 h". */
export const formatInterval = (seconds: number): string => formatRuleDuration(seconds);

// ---------------------------------------------------------------- targets

export interface HostPort {
  host: string;
  /** Null when the target has no port (tls defaults to 443). */
  port: number | null;
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_CHARS = /^[0-9a-f:.]+$/i;
const MAX_HOST_LENGTH = 253;
const DIGITS = /^\d+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HTTP_SCHEME = /^https?:\/\//i;

export function isValidHost(host: string): boolean {
  if (host === '' || host.length > MAX_HOST_LENGTH) return false;
  if (IPV4.test(host)) return true;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return name.split('.').every((label) => HOST_LABEL.test(label));
}

export type HostPortProblem = 'empty' | 'scheme' | 'ipv6' | 'host' | 'port' | 'missing_port';

/** Parses "host:port", "host" or "[v6]:port". */
export function parseHostPort(raw: string): HostPort | HostPortProblem {
  const value = raw.trim();
  if (value === '') return 'empty';
  if (SCHEME.test(value) || value.includes('/')) return 'scheme';

  let host: string;
  let portText: string | null;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return 'ipv6';
    host = value.slice(1, close);
    const rest = value.slice(close + 1);
    if (rest !== '' && !rest.startsWith(':')) return 'ipv6';
    portText = rest === '' ? null : rest.slice(1);
    if (host === '' || !IPV6_CHARS.test(host) || !host.includes(':')) return 'ipv6';
  } else {
    const colons = value.split(':').length - 1;
    if (colons > 1) return 'ipv6';
    const at = value.lastIndexOf(':');
    host = at === -1 ? value : value.slice(0, at);
    portText = at === -1 ? null : value.slice(at + 1);
    if (!isValidHost(host)) return 'host';
  }
  if (portText === null) return { host, port: null };
  if (!DIGITS.test(portText)) return 'port';
  const port = Number(portText);
  if (port < MIN_PORT || port > MAX_PORT) return 'port';
  return { host, port };
}

const HOST_PORT_MESSAGES: Record<Exclude<CheckType, 'http'>, Record<HostPortProblem, string>> = {
  tcp: {
    empty: 'Enter host:port, for example db.example.com:5432.',
    scheme: 'Leave out the scheme and path: host:port only.',
    ipv6: 'Wrap IPv6 addresses in brackets: [2001:db8::1]:5432.',
    host: 'Enter a host name or IP address before the port.',
    port: `The port must be ${MIN_PORT} to ${MAX_PORT}.`,
    missing_port: 'Add the port, for example :5432.',
  },
  tls: {
    empty: 'Enter a host, for example example.com or example.com:8443.',
    scheme: 'Leave out https:// and the path: host or host:port only.',
    ipv6: 'Wrap IPv6 addresses in brackets: [2001:db8::1]:443.',
    host: 'Enter a host name or IP address.',
    port: `The port must be ${MIN_PORT} to ${MAX_PORT}.`,
    missing_port: 'Add the port.',
  },
};

/** Why a target is not valid for the type, or undefined when it is. */
export function targetError(type: CheckType, raw: string): string | undefined {
  const value = raw.trim();
  if (value.length > MAX_TARGET_LENGTH) return `At most ${MAX_TARGET_LENGTH} characters.`;
  if (type === 'http') {
    if (value === '') return 'Enter a URL.';
    if (!HTTP_SCHEME.test(value)) return 'Start the URL with http:// or https://.';
    if (/\s/.test(value)) return 'URLs can’t contain spaces.';
    try {
      const url = new URL(value);
      if (url.hostname === '') return 'Enter a URL with a host.';
    } catch {
      return 'That isn’t a valid URL.';
    }
    return undefined;
  }
  const parsed = parseHostPort(value);
  if (typeof parsed === 'string') return HOST_PORT_MESSAGES[type][parsed];
  if (type === 'tcp' && parsed.port === null) return HOST_PORT_MESSAGES.tcp.missing_port;
  return undefined;
}

export const TARGET_COPY: Record<CheckType, { label: string; placeholder: string; hint: string }> = {
  http: {
    label: 'URL',
    placeholder: 'https://api.example.com/health',
    hint: 'Monitaur sends a GET. Private and local addresses are refused.',
  },
  tcp: {
    label: 'Host and port',
    placeholder: 'db.example.com:5432',
    hint: 'Up when a TCP connection opens within the timeout.',
  },
  tls: {
    label: 'Host',
    placeholder: 'example.com or example.com:8443',
    hint: `Port ${DEFAULT_TLS_PORT} unless you give one. Reports the days until the certificate expires.`,
  },
};

export const TYPE_PITCH: Record<CheckType, string> = {
  http: 'A website or API answers with the right status, and optionally a keyword.',
  tcp: 'A port accepts connections: databases, mail, SSH, game servers.',
  tls: 'A certificate is valid and not about to expire.',
};

// ---------------------------------------------------------------- form

export interface CheckForm {
  name: string;
  type: CheckType;
  /** One target per type, so switching type and back keeps what was typed. */
  targets: Record<CheckType, string>;
  /** As typed; empty means any 2xx or 3xx. */
  expectStatus: string;
  keyword: string;
  tlsWarnDays: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  channelIds: number[];
  enabled: boolean;
}

export interface CheckLimits {
  /** GET /org plan.min_check_interval_seconds; 0 when the plan does not say. */
  minIntervalSeconds: number;
  planName?: string;
}

/** Plan limits for the form; a backend that predates checks sends none, so nothing is enforced client-side. */
export function checkLimits(plan: Pick<Plan, 'name' | 'min_check_interval_seconds'> | undefined): CheckLimits {
  return { minIntervalSeconds: plan?.min_check_interval_seconds ?? 0, ...(plan ? { planName: plan.name } : {}) };
}

export interface CheckQuotaState {
  used: number;
  /** 0 means unlimited. */
  limit: number;
  planName?: string;
  atLimit: boolean;
}

/** Usage against plans.max_checks; usage.checks when the backend sends it, else the list length. */
export function checkQuota(
  plan: Pick<Plan, 'name' | 'max_checks'> | undefined,
  usage: Pick<OrgUsage, 'checks'> | undefined,
  listed: number,
): CheckQuotaState | null {
  if (plan?.max_checks === undefined) return null;
  const used = usage?.checks ?? listed;
  return { used, limit: plan.max_checks, planName: plan.name, atLimit: usageState(used, plan.max_checks).atLimit };
}

/** The shortest interval allowed by the plan, snapped to a preset. */
export function defaultInterval(minIntervalSeconds: number): number {
  const wanted = Math.max(DEFAULT_INTERVAL_SECONDS, minIntervalSeconds);
  return INTERVAL_PRESETS.find((preset) => preset >= wanted) ?? wanted;
}

export function emptyCheckForm(limits: CheckLimits, channels: readonly Channel[] = []): CheckForm {
  return {
    name: '',
    type: 'http',
    targets: { http: '', tcp: '', tls: '' },
    expectStatus: '',
    keyword: '',
    tlsWarnDays: String(DEFAULT_TLS_WARN_DAYS),
    intervalSeconds: defaultInterval(limits.minIntervalSeconds),
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    // Enabled channels are preselected; a check that notifies nobody is rarely intended.
    channelIds: channels.filter((channel) => channel.enabled).map((channel) => channel.id),
    enabled: true,
  };
}

export function formFromCheck(check: Check): CheckForm {
  return {
    name: check.name,
    type: check.type,
    targets: { http: '', tcp: '', tls: '', [check.type]: check.target },
    expectStatus: check.expect_status === ANY_STATUS ? '' : String(check.expect_status),
    keyword: check.keyword,
    tlsWarnDays: String(check.tls_warn_days),
    intervalSeconds: check.interval_seconds,
    timeoutSeconds: check.timeout_seconds,
    channelIds: [...check.channel_ids],
    enabled: check.enabled,
  };
}

export const formTarget = (form: Pick<CheckForm, 'type' | 'targets'>): string => form.targets[form.type].trim();

/** Certificate warnings apply to tls checks and to http checks of https URLs. */
export const formReportsTls = (form: Pick<CheckForm, 'type' | 'targets'>): boolean =>
  reportsTls({ type: form.type, target: formTarget(form) });

export interface CheckFormErrors {
  name?: string;
  target?: string;
  expectStatus?: string;
  keyword?: string;
  tlsWarnDays?: string;
  interval?: string;
  timeout?: string;
}

const INTEGER = /^\d+$/;

const parseInteger = (raw: string): number | null => (INTEGER.test(raw.trim()) ? Number(raw.trim()) : null);

export function validateCheckForm(form: CheckForm, limits: CheckLimits): CheckFormErrors {
  const errors: CheckFormErrors = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'Give the check a name.';
  else if (name.length > MAX_CHECK_NAME_LENGTH) errors.name = `At most ${MAX_CHECK_NAME_LENGTH} characters.`;

  const target = targetError(form.type, form.targets[form.type]);
  if (target) errors.target = target;

  if (form.type === 'http') {
    if (form.expectStatus.trim() !== '') {
      const status = parseInteger(form.expectStatus);
      if (status === null || status < MIN_EXPECT_STATUS || status > MAX_EXPECT_STATUS) {
        errors.expectStatus = `An HTTP status from ${MIN_EXPECT_STATUS} to ${MAX_EXPECT_STATUS}, or empty for any 2xx or 3xx.`;
      }
    }
    if (form.keyword.length > MAX_KEYWORD_LENGTH) errors.keyword = `At most ${MAX_KEYWORD_LENGTH} characters.`;
  }

  if (formReportsTls(form)) {
    const days = parseInteger(form.tlsWarnDays);
    if (days === null || days < MIN_TLS_WARN_DAYS || days > MAX_TLS_WARN_DAYS) {
      errors.tlsWarnDays = `Whole days from ${MIN_TLS_WARN_DAYS} to ${MAX_TLS_WARN_DAYS}.`;
    }
  }

  if (limits.minIntervalSeconds > 0 && form.intervalSeconds < limits.minIntervalSeconds) {
    const plan = limits.planName ? `The ${limits.planName} plan` : 'Your plan';
    errors.interval = `${plan} checks at most every ${formatInterval(limits.minIntervalSeconds)}.`;
  }
  if (form.timeoutSeconds <= 0) errors.timeout = 'Pick a timeout.';
  else if (form.timeoutSeconds > MAX_TIMEOUT_SECONDS) errors.timeout = `Timeouts go up to ${formatInterval(MAX_TIMEOUT_SECONDS)}.`;
  else if (form.timeoutSeconds >= form.intervalSeconds) errors.timeout = 'The timeout must be shorter than the interval.';
  return errors;
}

export const hasErrors = (errors: CheckFormErrors): boolean => Object.keys(errors).length > 0;

/** POST /checks body. Type-specific fields go only with their type. */
export function buildCreateBody(form: CheckForm): CreateCheckBody {
  const body: CreateCheckBody = {
    name: form.name.trim(),
    type: form.type,
    target: formTarget(form),
    interval_seconds: form.intervalSeconds,
    timeout_seconds: form.timeoutSeconds,
    enabled: form.enabled,
    channel_ids: [...form.channelIds],
  };
  if (form.type === 'http') {
    body.expect_status = parseInteger(form.expectStatus) ?? ANY_STATUS;
    body.keyword = form.keyword;
  }
  if (formReportsTls(form)) body.tls_warn_days = parseInteger(form.tlsWarnDays) ?? DEFAULT_TLS_WARN_DAYS;
  return body;
}

const sameIds = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');

/** PATCH /checks/:id body: only the fields that changed. */
export function buildUpdateBody(check: Check, form: CheckForm): UpdateCheckBody {
  const next = buildCreateBody(form);
  const patch: UpdateCheckBody = {};
  if (next.name !== check.name) patch.name = next.name;
  if (next.type !== check.type) patch.type = next.type;
  if (next.target !== check.target) patch.target = next.target;
  if (next.interval_seconds !== check.interval_seconds) patch.interval_seconds = next.interval_seconds;
  if (next.timeout_seconds !== check.timeout_seconds) patch.timeout_seconds = next.timeout_seconds;
  if (next.enabled !== check.enabled) patch.enabled = next.enabled;
  if (!sameIds(next.channel_ids ?? [], check.channel_ids)) patch.channel_ids = next.channel_ids ?? [];
  if (next.expect_status !== undefined && next.expect_status !== check.expect_status) patch.expect_status = next.expect_status;
  if (next.keyword !== undefined && next.keyword !== check.keyword) patch.keyword = next.keyword;
  if (next.tls_warn_days !== undefined && next.tls_warn_days !== check.tls_warn_days) patch.tls_warn_days = next.tls_warn_days;
  return patch;
}

export interface DurationOption {
  value: number;
  label: string;
  disabled: boolean;
}

/** Interval presets plus the current value; those under the plan minimum stay listed but disabled. */
export function intervalOptions(minIntervalSeconds: number, current: number): DurationOption[] {
  const values = new Set([...INTERVAL_PRESETS, current]);
  return [...values]
    .sort((a, b) => a - b)
    .map((value) => {
      const blocked = minIntervalSeconds > 0 && value < minIntervalSeconds;
      return { value, label: blocked ? `${formatInterval(value)} (not on this plan)` : formatInterval(value), disabled: blocked };
    });
}

export function timeoutOptions(current: number): DurationOption[] {
  return [...new Set([...TIMEOUT_PRESETS, current])]
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
    .map((value) => ({ value, label: formatInterval(value), disabled: false }));
}

/** "Every 1 min · 10 s timeout · expects 200 · contains “ok”". */
export function checkScheduleLine(check: Pick<Check, 'type' | 'interval_seconds' | 'timeout_seconds' | 'expect_status' | 'keyword'>): string {
  const parts = [`every ${formatInterval(check.interval_seconds)}`, `${formatInterval(check.timeout_seconds)} timeout`];
  if (check.type === 'http') {
    parts.push(check.expect_status === ANY_STATUS ? 'expects 2xx or 3xx' : `expects ${check.expect_status}`);
    if (check.keyword !== '') parts.push(`contains “${check.keyword}”`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------- list summary

const SUMMARY_ORDER: readonly CheckStatus[] = ['down', 'degraded', 'pending', 'paused'];

/** "8 checks · 1 down · 1 degraded", "3 checks, all up". */
export function checksSummary(counts: CheckStatusCounts): string {
  if (counts.all === 0) return 'No checks yet';
  const parts = SUMMARY_ORDER.filter((status) => counts[status] > 0).map(
    (status) => `${counts[status]} ${CHECK_STATUS_META[status].label.toLowerCase()}`,
  );
  if (parts.length === 0) return `${plural(counts.all, 'check')}, all up`;
  return [plural(counts.all, 'check'), ...parts].join(' · ');
}

// ---------------------------------------------------------------- results chart

export interface ResultRow {
  ts: number;
  /** Start of the step the row describes; differs from ts only on closing rows (see stepRows). */
  start: number;
  up: number | null;
  avg: number | null;
  max: number | null;
}

/** Chart rows, oldest first; unparsable times are dropped, gaps stay null (never interpolated). */
export function resultRows(points: readonly CheckResultPoint[]): ResultRow[] {
  return points
    .map((point) => ({ ts: Date.parse(point.t), start: Date.parse(point.t), up: point.up_pct, avg: point.latency_avg, max: point.latency_max }))
    .filter((row) => Number.isFinite(row.ts))
    .sort((a, b) => a.ts - b.ts);
}

const MS_PER_SECOND = 1000;
/** A closing row sits on the last millisecond of its step, before the next step's row. */
const STEP_END_OFFSET_MS = 1;
const SERIES_KEYS = ['up', 'avg', 'max'] as const;

/**
 * Rows to draw: a stepAfter series runs from one point to the next, so the
 * last step of a run (and a lone step, such as a new check's first) would
 * have no width. Each run therefore gets a closing copy of its last row at
 * the end of that step. Summaries use the rows from resultRows, not these.
 */
export function stepRows(rows: readonly ResultRow[], stepSeconds: number): ResultRow[] {
  if (!(stepSeconds > 0)) return [...rows];
  const stepMs = stepSeconds * MS_PER_SECOND;
  return rows.flatMap((row, index) => {
    const next = rows[index + 1];
    const endsRun = SERIES_KEYS.some((key) => row[key] !== null && (next === undefined || next[key] === null));
    return endsRun ? [row, { ...row, ts: row.start + stepMs - STEP_END_OFFSET_MS }] : [row];
  });
}

export interface ResultsSummary {
  /** Mean of the steps that have results, 0 to 100; null without any. */
  upPct: number | null;
  avgMs: number | null;
  maxMs: number | null;
  /** Steps that had at least one failure. */
  failingSteps: number;
  /** Steps with results at all. */
  measuredSteps: number;
}

const PERCENT_MAX = 100;

export function summarizeResults(rows: readonly ResultRow[]): ResultsSummary {
  const ups = rows.flatMap((row) => (row.up === null ? [] : [row.up]));
  const avgs = rows.flatMap((row) => (row.avg === null ? [] : [row.avg]));
  const maxes = rows.flatMap((row) => (row.max === null ? [] : [row.max]));
  const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    upPct: mean(ups),
    avgMs: mean(avgs),
    maxMs: maxes.length === 0 ? null : Math.max(...maxes),
    failingSteps: ups.filter((value) => value < PERCENT_MAX).length,
    measuredSteps: ups.length,
  };
}

const STEP_NOUNS: Readonly<Record<number, string>> = { [HOUR]: 'hours', [24 * HOUR]: 'days' };

/** "3 hours with failures", or "failures in 10 of 140 steps of 10 min" for other step sizes. */
export function failingStepsLabel(summary: Pick<ResultsSummary, 'failingSteps' | 'measuredSteps'>, stepSeconds: number): string | null {
  if (summary.failingSteps === 0) return null;
  const noun = STEP_NOUNS[stepSeconds];
  if (noun) return `${summary.failingSteps} ${summary.failingSteps === 1 ? noun.slice(0, -1) : noun} with failures`;
  return `failures in ${summary.failingSteps} of ${summary.measuredSteps} steps of ${formatInterval(stepSeconds)}`;
}

/** The latency axis top: the slowest step plus headroom, rounded to a readable step. */
const LATENCY_AXIS_MIN_MS = 100;
const LATENCY_AXIS_HEADROOM = 1.1;
const NICE_STEPS: readonly number[] = [1, 1.5, 2, 2.5, 5, 10];

export function latencyAxisMax(rows: readonly ResultRow[]): number {
  const peak = rows.reduce((max, row) => Math.max(max, row.max ?? 0, row.avg ?? 0), 0);
  if (peak <= 0) return LATENCY_AXIS_MIN_MS;
  const wanted = peak * LATENCY_AXIS_HEADROOM;
  const magnitude = 10 ** Math.floor(Math.log10(wanted));
  const nice = NICE_STEPS.map((step) => step * magnitude).find((value) => value >= wanted) ?? wanted;
  return Math.max(LATENCY_AXIS_MIN_MS, nice);
}
