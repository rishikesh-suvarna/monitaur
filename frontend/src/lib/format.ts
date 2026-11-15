/**
 * Display formatters. Every numeric output is meant to be rendered inside a
 * `.num` element (Geist Mono, tabular figures) so values do not jitter.
 */

/** Shown when a value is unknown (no sample yet, agent offline, etc.). */
export const EMPTY_VALUE = '—';

const BYTES_PER_KIB = 1024;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
const WHOLE_NUMBER_FROM = 100;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const DAYS_PER_WEEK = 7;

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** One decimal under 100, none from 100 up: 0.4, 38.2, 142. */
export function formatCompact(value: number): string {
  return Math.abs(value) >= WHOLE_NUMBER_FROM ? Math.round(value).toString() : value.toFixed(1);
}

/** Binary units labelled KB/MB/GB, as most server tools show them: 16 GB, 512 MB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!isFiniteNumber(bytes) || bytes < 0) return EMPTY_VALUE;
  if (bytes < BYTES_PER_KIB) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_KIB && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_KIB;
    unit += 1;
  }
  return `${formatCompact(value)} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/** Bytes per second with an auto-scaled unit: 38.2 MB/s. */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  const bytes = formatBytes(bytesPerSecond);
  return bytes === EMPTY_VALUE ? bytes : `${bytes}/s`;
}

/** Bytes per second as a bare MB/s number, for columns headed "MB/s". */
export function formatMBps(bytesPerSecond: number | null | undefined): string {
  if (!isFiniteNumber(bytesPerSecond) || bytesPerSecond < 0) return EMPTY_VALUE;
  return formatCompact(bytesPerSecond / (BYTES_PER_KIB * BYTES_PER_KIB));
}

/** 94.2% (digits = 1) or 94% (digits = 0). */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  return `${value.toFixed(digits)}%`;
}

const DURATION_UNITS = [
  { suffix: 'd', seconds: SECONDS_PER_DAY, pad: false },
  { suffix: 'h', seconds: SECONDS_PER_HOUR, pad: false },
  { suffix: 'm', seconds: SECONDS_PER_MINUTE, pad: true },
  { suffix: 's', seconds: 1, pad: true },
] as const;

/**
 * Compact duration with up to `maxUnits` units, largest first:
 * 12s, 4m 10s, 23m, 2h 03m, 63d 4h, 102d. A trailing zero unit is dropped.
 */
export function formatDuration(totalSeconds: number | null | undefined, maxUnits = 2): string {
  if (!isFiniteNumber(totalSeconds) || totalSeconds < 0) return EMPTY_VALUE;
  let remaining = Math.floor(totalSeconds);
  if (remaining === 0) return '0s';

  const parts: string[] = [];
  for (const unit of DURATION_UNITS) {
    const amount = Math.floor(remaining / unit.seconds);
    remaining -= amount * unit.seconds;
    if (parts.length === 0) {
      if (amount === 0) continue;
      parts.push(`${amount}${unit.suffix}`);
    } else {
      if (amount > 0) parts.push(`${unit.pad ? String(amount).padStart(2, '0') : amount}${unit.suffix}`);
      break;
    }
    if (parts.length >= maxUnits) break;
  }
  return parts.join(' ');
}

/** Age in words for prose: 45s, 12 min, 3 h, 4 d. */
export function formatAge(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_MINUTE)} min`;
  if (seconds < SECONDS_PER_DAY) return `${Math.floor(seconds / SECONDS_PER_HOUR)} h`;
  return `${Math.floor(seconds / SECONDS_PER_DAY)} d`;
}

/** Timer style for a running wait: 0:14, 12:03, 1:02:09. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / SECONDS_PER_HOUR);
  const m = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const s = seconds % SECONDS_PER_MINUTE;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export type DateInput = Date | string | number;

/** Milliseconds since epoch, or null for null/invalid input. */
export function toTime(value: DateInput | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Seconds from `from` to `now`, never negative; null if `from` is missing. */
export function secondsSince(from: DateInput | null | undefined, now: number): number | null {
  const time = toTime(from);
  return time === null ? null : Math.max(0, (now - time) / MS_PER_SECOND);
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

/** "2s ago", "12 min ago", "3 h ago", "4 d ago", then a date ("Sep 12"). */
export function formatRelativeTime(value: DateInput | null | undefined, now: number): string {
  const time = toTime(value);
  if (time === null) return 'never';
  const seconds = Math.max(0, (now - time) / MS_PER_SECOND);
  if (seconds < 1) return 'just now';
  if (seconds < SECONDS_PER_DAY * DAYS_PER_WEEK) return `${formatAge(seconds)} ago`;
  return dateFormat.format(time);
}

/** 14:22:05 */
export function formatClock(value: DateInput): string {
  const time = toTime(value);
  return time === null ? EMPTY_VALUE : clockFormat.format(time);
}

/** 14:04 */
export function formatTimeOfDay(value: DateInput): string {
  const time = toTime(value);
  return time === null ? EMPTY_VALUE : timeFormat.format(time);
}

const startOfDay = (time: number): number => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** "today 14:04", "yesterday 03:12", "Sat 03:12", "Sep 12 03:12". */
export function formatDayTime(value: DateInput, now: number): string {
  const time = toTime(value);
  if (time === null) return EMPTY_VALUE;
  const days = Math.round((startOfDay(now) - startOfDay(time)) / (SECONDS_PER_DAY * MS_PER_SECOND));
  const clock = timeFormat.format(time);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `yesterday ${clock}`;
  if (days > 1 && days < DAYS_PER_WEEK) return `${weekdayFormat.format(time)} ${clock}`;
  return `${dateFormat.format(time)} ${clock}`;
}

const numberFormat = new Intl.NumberFormat();

/** 1,018 */
export function formatNumber(value: number | null | undefined): string {
  return isFiniteNumber(value) ? numberFormat.format(value) : EMPTY_VALUE;
}

/** "1 server", "3 servers". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
