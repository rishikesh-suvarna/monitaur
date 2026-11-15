/**
 * Maintenance windows (docs/platform-v2.md 6.4): state from the clock, start
 * and duration maths for the form, the API bodies and the scope summary.
 * Pure, so it is unit tested.
 */
import type { CreateMaintenanceBody, MaintenanceScope, MaintenanceState, MaintenanceWindow, UpdateMaintenanceBody } from '../../api/types';
import { toTime } from '../../lib/format';

const MS_PER_SECOND = 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const MAX_WINDOW_NAME_LENGTH = 80;

/** 30 min, 1 h, 2 h, 4 h (seconds). */
export const DURATION_PRESETS: readonly number[] = [30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR];
export const DEFAULT_DURATION_SECONDS = HOUR;
/** A scheduled start may be this far in the past (the time it takes to fill the form). */
export const START_GRACE_MS = 60_000;

export type DurationChoice = number | 'custom';
export type StartMode = 'now' | 'scheduled';

// ---------------------------------------------------------------- state

/**
 * The window's state at `now`, from its times; the API's `state` is only the
 * fallback for unparsable times. Recomputing keeps the list right between
 * fetches as windows start and end.
 */
export function maintenanceState(window: Pick<MaintenanceWindow, 'starts_at' | 'ends_at' | 'state'>, now: number): MaintenanceState {
  const start = toTime(window.starts_at);
  const end = toTime(window.ends_at);
  if (start === null || end === null) return window.state;
  if (now < start) return 'scheduled';
  if (now < end) return 'active';
  return 'ended';
}

export const STATE_LABELS: Record<MaintenanceState, string> = { active: 'Active', scheduled: 'Scheduled', ended: 'Ended' };

const STATE_ORDER: Record<MaintenanceState, number> = { active: 0, scheduled: 1, ended: 2 };

export interface WindowGroup {
  state: MaintenanceState;
  windows: MaintenanceWindow[];
}

/** Active (ending soonest first), scheduled (starting soonest first), then ended (most recent first). */
export function groupWindows(windows: readonly MaintenanceWindow[], now: number): WindowGroup[] {
  const groups = new Map<MaintenanceState, MaintenanceWindow[]>();
  for (const window of windows) {
    const state = maintenanceState(window, now);
    groups.set(state, [...(groups.get(state) ?? []), window]);
  }
  const at = (value: string): number => toTime(value) ?? 0;
  const sorters: Record<MaintenanceState, (a: MaintenanceWindow, b: MaintenanceWindow) => number> = {
    active: (a, b) => at(a.ends_at) - at(b.ends_at),
    scheduled: (a, b) => at(a.starts_at) - at(b.starts_at),
    ended: (a, b) => at(b.ends_at) - at(a.ends_at),
  };
  return [...groups.entries()]
    .sort(([a], [b]) => STATE_ORDER[a] - STATE_ORDER[b])
    .map(([state, items]) => ({ state, windows: [...items].sort(sorters[state]) }));
}

// ---------------------------------------------------------------- durations

/** "30 min", "2 h", "1 h 30 min", "2 d 4 h". */
export function formatWindowLength(totalSeconds: number): string {
  // Round once at the smallest shown unit, so 19 h 59 min 40 s reads "20 h", never "19 h 60 min".
  const totalMinutes = Math.max(0, Math.round(totalSeconds / MINUTE));
  const minutesPerHour = HOUR / MINUTE;
  if (totalMinutes < minutesPerHour) return `${Math.max(1, totalMinutes)} min`;
  if (totalMinutes < DAY / MINUTE) {
    const hours = Math.floor(totalMinutes / minutesPerHour);
    const minutes = totalMinutes % minutesPerHour;
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  const totalHours = Math.round(totalSeconds / HOUR);
  const hoursPerDay = DAY / HOUR;
  const days = Math.floor(totalHours / hoursPerDay);
  const hours = totalHours % hoursPerDay;
  return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
}

/** "ends in 1 h 20 min", "starts in 3 h", "ended 2 h ago". */
export function windowTiming(window: Pick<MaintenanceWindow, 'starts_at' | 'ends_at' | 'state'>, now: number): string {
  const state = maintenanceState(window, now);
  const start = toTime(window.starts_at) ?? now;
  const end = toTime(window.ends_at) ?? now;
  if (state === 'scheduled') return `starts in ${formatWindowLength((start - now) / MS_PER_SECOND)}`;
  if (state === 'active') return `ends in ${formatWindowLength((end - now) / MS_PER_SECOND)}`;
  const endedSeconds = (now - end) / MS_PER_SECOND;
  // formatWindowLength never shows less than a minute; "ended 1 min ago" right after End now reads wrong.
  if (endedSeconds < MINUTE) return 'ended just now';
  return `ended ${formatWindowLength(endedSeconds)} ago`;
}

export function windowSeconds(window: Pick<MaintenanceWindow, 'starts_at' | 'ends_at'>): number {
  const start = toTime(window.starts_at);
  const end = toTime(window.ends_at);
  return start === null || end === null ? 0 : Math.max(0, (end - start) / MS_PER_SECOND);
}

// ---------------------------------------------------------------- datetime-local

const pad = (value: number): string => String(value).padStart(2, '0');

/** ms epoch to the `<input type="datetime-local">` value in local time: "2026-11-15T14:30". */
export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The input's local wall time back to ms epoch, or null when empty or malformed. */
export function fromLocalInput(value: string): number | null {
  const match = LOCAL_INPUT.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? '0'));
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

/** Rounds up to the next quarter hour: the default scheduled start. */
const QUARTER_HOUR_MS = 15 * MINUTE * MS_PER_SECOND;

export function nextQuarterHour(now: number): number {
  return Math.ceil((now + 1) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
}

// ---------------------------------------------------------------- form

export interface MaintenanceForm {
  name: string;
  startMode: StartMode;
  /** datetime-local value, used when scheduled. */
  startLocal: string;
  duration: DurationChoice;
  /** datetime-local value, used with a custom end. */
  endLocal: string;
  scopeAll: boolean;
  serverIds: number[];
  tags: string[];
  checkIds: number[];
}

export function emptyMaintenanceForm(now: number): MaintenanceForm {
  const start = nextQuarterHour(now);
  return {
    name: '',
    startMode: 'now',
    startLocal: toLocalInput(start),
    duration: DEFAULT_DURATION_SECONDS,
    endLocal: toLocalInput(start + DEFAULT_DURATION_SECONDS * MS_PER_SECOND),
    scopeAll: true,
    serverIds: [],
    tags: [],
    checkIds: [],
  };
}

export function formFromWindow(window: MaintenanceWindow): MaintenanceForm {
  const start = toTime(window.starts_at) ?? Date.now();
  const end = toTime(window.ends_at) ?? start;
  const length = Math.round((end - start) / MS_PER_SECOND);
  return {
    name: window.name,
    startMode: 'scheduled',
    startLocal: toLocalInput(start),
    duration: DURATION_PRESETS.includes(length) ? length : 'custom',
    endLocal: toLocalInput(end),
    scopeAll: window.scope.all,
    serverIds: [...window.scope.server_ids],
    tags: [...window.scope.tags],
    checkIds: [...window.scope.check_ids],
  };
}

export interface WindowTimes {
  start: number;
  end: number;
}

/**
 * Start and end in ms. "Now" starts at `now`; an active window being edited
 * keeps its recorded start (`fixedStart`). A preset duration counts from the
 * start; a custom end is taken as typed. Null when a time is malformed.
 */
export function formTimes(form: MaintenanceForm, now: number, fixedStart: number | null = null): WindowTimes | null {
  const start = fixedStart ?? (form.startMode === 'now' ? now : fromLocalInput(form.startLocal));
  if (start === null) return null;
  const end = form.duration === 'custom' ? fromLocalInput(form.endLocal) : start + form.duration * MS_PER_SECOND;
  if (end === null) return null;
  return { start, end };
}

export interface MaintenanceFormErrors {
  name?: string;
  start?: string;
  end?: string;
  scope?: string;
}

export interface MaintenanceValidationContext {
  now: number;
  /** The recorded start of an active window being edited (it can no longer move). */
  fixedStart?: number | null;
}

export function validateMaintenanceForm(form: MaintenanceForm, { now, fixedStart = null }: MaintenanceValidationContext): MaintenanceFormErrors {
  const errors: MaintenanceFormErrors = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'Name the window, for example “Postgres upgrade”.';
  else if (name.length > MAX_WINDOW_NAME_LENGTH) errors.name = `At most ${MAX_WINDOW_NAME_LENGTH} characters.`;

  if (!form.scopeAll && form.serverIds.length === 0 && form.tags.length === 0 && form.checkIds.length === 0) {
    errors.scope = 'Pick at least one server, tag or check, or cover everything.';
  }

  if (fixedStart === null && form.startMode === 'scheduled') {
    const start = fromLocalInput(form.startLocal);
    if (start === null) errors.start = 'Pick a start date and time.';
    else if (start < now - START_GRACE_MS) errors.start = 'That time has passed. Pick a later one, or start now.';
  }
  if (form.duration === 'custom' && fromLocalInput(form.endLocal) === null) errors.end = 'Pick an end date and time.';

  const times = formTimes(form, now, fixedStart);
  if (times && errors.start === undefined && errors.end === undefined) {
    if (times.end <= times.start) errors.end = 'The end must be after the start.';
    else if (times.end <= now) errors.end = 'That end has already passed.';
  }
  return errors;
}

export const hasMaintenanceErrors = (errors: MaintenanceFormErrors): boolean => Object.keys(errors).length > 0;

export function formScope(form: Pick<MaintenanceForm, 'scopeAll' | 'serverIds' | 'tags' | 'checkIds'>): MaintenanceScope {
  return form.scopeAll
    ? { all: true, server_ids: [], tags: [], check_ids: [] }
    : { all: false, server_ids: [...form.serverIds], tags: [...form.tags], check_ids: [...form.checkIds] };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** POST /maintenance body, or null when the times are malformed (validate first). */
export function buildCreateBody(form: MaintenanceForm, now: number): CreateMaintenanceBody | null {
  const times = formTimes(form, now);
  if (!times) return null;
  return { name: form.name.trim(), scope: formScope(form), starts_at: iso(times.start), ends_at: iso(times.end) };
}

const sameScope = (a: MaintenanceScope, b: MaintenanceScope): boolean => {
  const sorted = (values: readonly (number | string)[]): string => [...values].map(String).sort().join(',');
  return (
    a.all === b.all &&
    sorted(a.server_ids) === sorted(b.server_ids) &&
    sorted(a.tags) === sorted(b.tags) &&
    sorted(a.check_ids) === sorted(b.check_ids)
  );
};

/** PATCH /maintenance/:id body: only what changed. An active window keeps its start. */
export function buildUpdateBody(window: MaintenanceWindow, form: MaintenanceForm, now: number): UpdateMaintenanceBody | null {
  const active = maintenanceState(window, now) === 'active';
  const times = formTimes(form, now, active ? toTime(window.starts_at) : null);
  if (!times) return null;
  const patch: UpdateMaintenanceBody = {};
  const name = form.name.trim();
  if (name !== window.name) patch.name = name;
  const scope = formScope(form);
  if (!sameScope(scope, window.scope)) patch.scope = scope;
  if (!active && times.start !== toTime(window.starts_at)) patch.starts_at = iso(times.start);
  if (times.end !== toTime(window.ends_at)) patch.ends_at = iso(times.end);
  return patch;
}

/** "End now": PATCH {ends_at: now}. */
export const endNowBody = (now: number): UpdateMaintenanceBody => ({ ends_at: iso(now) });

// ---------------------------------------------------------------- scope summary

const SUMMARY_ITEMS = 3;

/**
 * "Everything (all servers and checks)", or up to three names then "+2 more":
 * "db-primary, tag: prod, check: API health +1 more".
 */
export function scopeSummary(
  scope: MaintenanceScope,
  serverNames: ReadonlyMap<number, string>,
  checkNames: ReadonlyMap<number, string>,
): string {
  if (scope.all) return 'Everything (all servers and checks)';
  const items = [
    ...scope.server_ids.map((id) => serverNames.get(id) ?? `server #${id}`),
    ...scope.tags.map((tag) => `tag: ${tag}`),
    ...scope.check_ids.map((id) => `check: ${checkNames.get(id) ?? `#${id}`}`),
  ];
  if (items.length === 0) return 'Nothing';
  const shown = items.slice(0, SUMMARY_ITEMS).join(', ');
  return items.length > SUMMARY_ITEMS ? `${shown} +${items.length - SUMMARY_ITEMS} more` : shown;
}

/** Whether a window covers a server right now: scope all, its id, or one of its tags. */
export function windowCoversServer(scope: MaintenanceScope, server: { id: number; tags: readonly string[] }): boolean {
  return scope.all || scope.server_ids.includes(server.id) || scope.tags.some((tag) => server.tags.includes(tag));
}
