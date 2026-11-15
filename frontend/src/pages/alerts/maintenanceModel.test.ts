import { describe, expect, it } from 'vitest';

import { makeWindow } from '../../test/fixtures';

import {
  buildCreateBody,
  buildUpdateBody,
  emptyMaintenanceForm,
  endNowBody,
  formatWindowLength,
  formFromWindow,
  formTimes,
  fromLocalInput,
  groupWindows,
  maintenanceState,
  nextQuarterHour,
  scopeSummary,
  toLocalInput,
  validateMaintenanceForm,
  windowCoversServer,
  windowTiming,
  type MaintenanceForm,
} from './maintenanceModel';

const NOW = Date.parse('2026-11-15T14:00:00Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('maintenance state', () => {
  const window = makeWindow({ id: 1, starts_at: iso(NOW), ends_at: iso(NOW + HOUR_MS), state: 'active' });

  it('follows the clock: scheduled, active, then ended', () => {
    expect(maintenanceState(window, NOW - 1)).toBe('scheduled');
    expect(maintenanceState(window, NOW)).toBe('active');
    expect(maintenanceState(window, NOW + HOUR_MS - 1)).toBe('active');
    expect(maintenanceState(window, NOW + HOUR_MS)).toBe('ended');
  });

  it('falls back to the API state for unparsable times', () => {
    expect(maintenanceState({ ...window, starts_at: 'soon', state: 'scheduled' }, NOW)).toBe('scheduled');
  });

  it('groups active, scheduled and ended, each in a useful order', () => {
    const windows = [
      makeWindow({ id: 1, starts_at: iso(NOW - 2 * HOUR_MS), ends_at: iso(NOW - HOUR_MS) }),
      makeWindow({ id: 2, starts_at: iso(NOW + 2 * HOUR_MS), ends_at: iso(NOW + 3 * HOUR_MS) }),
      makeWindow({ id: 3, starts_at: iso(NOW - HOUR_MS), ends_at: iso(NOW + 2 * HOUR_MS) }),
      makeWindow({ id: 4, starts_at: iso(NOW + HOUR_MS), ends_at: iso(NOW + 4 * HOUR_MS) }),
      makeWindow({ id: 5, starts_at: iso(NOW - HOUR_MS), ends_at: iso(NOW + HOUR_MS) }),
      makeWindow({ id: 6, starts_at: iso(NOW - 5 * HOUR_MS), ends_at: iso(NOW - 4 * HOUR_MS) }),
    ];
    expect(groupWindows(windows, NOW).map((group) => [group.state, group.windows.map((item) => item.id)])).toEqual([
      ['active', [5, 3]],
      ['scheduled', [4, 2]],
      ['ended', [1, 6]],
    ]);
  });
});

describe('durations and timing', () => {
  it.each([
    [30 * 60, '30 min'],
    [3600, '1 h'],
    [5400, '1 h 30 min'],
    [4 * 3600, '4 h'],
    [52 * 3600, '2 d 4 h'],
    [20, '1 min'],
    [19 * 3600 + 59 * 60 + 40, '20 h'],
    [59 * 60 + 50, '1 h'],
    [24 * 3600 - 10, '1 d'],
  ])('%i s reads %s', (seconds, text) => {
    expect(formatWindowLength(seconds)).toBe(text);
  });

  it('says when a window starts, ends or ended', () => {
    const window = makeWindow({ id: 1, starts_at: iso(NOW + 3 * HOUR_MS), ends_at: iso(NOW + 5 * HOUR_MS) });
    expect(windowTiming(window, NOW)).toBe('starts in 3 h');
    expect(windowTiming(window, NOW + 3 * HOUR_MS + 40 * MINUTE_MS)).toBe('ends in 1 h 20 min');
    expect(windowTiming(window, NOW + 7 * HOUR_MS)).toBe('ended 2 h ago');
  });

  it('round-trips datetime-local values in local time', () => {
    const local = toLocalInput(NOW);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe(NOW);
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
  });

  it('defaults a scheduled start to the next quarter hour', () => {
    expect(nextQuarterHour(NOW)).toBe(NOW + 15 * MINUTE_MS);
    expect(nextQuarterHour(NOW + MINUTE_MS)).toBe(NOW + 15 * MINUTE_MS);
  });
});

describe('maintenance form maths', () => {
  const base = (patch: Partial<MaintenanceForm> = {}): MaintenanceForm => ({ ...emptyMaintenanceForm(NOW), name: 'Postgres upgrade', ...patch });

  it('starts now and ends after the preset', () => {
    expect(formTimes(base({ duration: 2 * 3600 }), NOW)).toEqual({ start: NOW, end: NOW + 2 * HOUR_MS });
  });

  it('takes a scheduled start and a custom end as typed', () => {
    const start = NOW + HOUR_MS;
    const end = NOW + 5 * HOUR_MS;
    const form = base({ startMode: 'scheduled', startLocal: toLocalInput(start), duration: 'custom', endLocal: toLocalInput(end) });
    expect(formTimes(form, NOW)).toEqual({ start, end });
  });

  it('keeps the recorded start of an active window', () => {
    expect(formTimes(base({ duration: 3600 }), NOW, NOW - HOUR_MS)).toEqual({ start: NOW - HOUR_MS, end: NOW });
  });

  it('validates name, scope, start and end', () => {
    expect(validateMaintenanceForm(base(), { now: NOW })).toEqual({});
    expect(validateMaintenanceForm(base({ name: ' ' }), { now: NOW }).name).toMatch(/Name the window/);
    expect(validateMaintenanceForm(base({ scopeAll: false }), { now: NOW }).scope).toBe('Pick at least one server, tag or check, or cover everything.');
    expect(validateMaintenanceForm(base({ scopeAll: false, checkIds: [3] }), { now: NOW }).scope).toBeUndefined();
    expect(validateMaintenanceForm(base({ startMode: 'scheduled', startLocal: toLocalInput(NOW - HOUR_MS) }), { now: NOW }).start).toMatch(/passed/);
    expect(validateMaintenanceForm(base({ duration: 'custom', endLocal: toLocalInput(NOW - MINUTE_MS) }), { now: NOW }).end).toBe(
      'The end must be after the start.',
    );
    // Shortening an active window to an end already past is refused.
    expect(validateMaintenanceForm(base({ duration: 'custom', endLocal: toLocalInput(NOW - MINUTE_MS) }), { now: NOW, fixedStart: NOW - HOUR_MS }).end).toBe(
      'That end has already passed.',
    );
  });

  it('builds the POST body with ISO times and the scope', () => {
    expect(buildCreateBody(base({ scopeAll: false, serverIds: [1], tags: ['prod'], checkIds: [9] }), NOW)).toEqual({
      name: 'Postgres upgrade',
      scope: { all: false, server_ids: [1], tags: ['prod'], check_ids: [9] },
      starts_at: iso(NOW),
      ends_at: iso(NOW + HOUR_MS),
    });
    // "Everything" sends empty lists.
    expect(buildCreateBody(base({ serverIds: [1] }), NOW)?.scope).toEqual({ all: true, server_ids: [], tags: [], check_ids: [] });
  });

  it('patches only what changed and never moves an active window’s start', () => {
    const scheduled = makeWindow({ id: 2, name: 'Upgrade', starts_at: iso(NOW + HOUR_MS), ends_at: iso(NOW + 2 * HOUR_MS) });
    const form = formFromWindow(scheduled);
    expect(form.duration).toBe(3600);
    expect(buildUpdateBody(scheduled, form, NOW)).toEqual({});
    expect(buildUpdateBody(scheduled, { ...form, duration: 2 * 3600 }, NOW)).toEqual({ ends_at: iso(NOW + 3 * HOUR_MS) });

    const active = makeWindow({ id: 3, name: 'Reboot', starts_at: iso(NOW - HOUR_MS), ends_at: iso(NOW + HOUR_MS) });
    const activeForm = { ...formFromWindow(active), duration: 'custom' as const, endLocal: toLocalInput(NOW + 3 * HOUR_MS), name: 'Reboot db' };
    expect(buildUpdateBody(active, activeForm, NOW)).toEqual({ name: 'Reboot db', ends_at: iso(NOW + 3 * HOUR_MS) });
  });

  it('ends now with a PATCH of ends_at only', () => {
    expect(endNowBody(NOW)).toEqual({ ends_at: iso(NOW) });
  });
});

describe('scope summaries', () => {
  const servers = new Map([
    [1, 'db-primary'],
    [2, 'api-01'],
  ]);
  const checks = new Map([[9, 'API health']]);

  it('names everything, or up to three items then a count', () => {
    expect(scopeSummary({ all: true, server_ids: [1], tags: [], check_ids: [] }, servers, checks)).toBe('Everything (all servers and checks)');
    expect(scopeSummary({ all: false, server_ids: [1], tags: ['prod'], check_ids: [9] }, servers, checks)).toBe('db-primary, tag: prod, check: API health');
    expect(scopeSummary({ all: false, server_ids: [1, 2, 7], tags: ['prod'], check_ids: [9] }, servers, checks)).toBe(
      'db-primary, api-01, server #7 +2 more',
    );
    expect(scopeSummary({ all: false, server_ids: [], tags: [], check_ids: [4] }, servers, checks)).toBe('check: #4');
  });

  it('covers a server by scope all, its id or one of its tags', () => {
    const server = { id: 2, tags: ['prod', 'api'] };
    expect(windowCoversServer({ all: true, server_ids: [], tags: [], check_ids: [] }, server)).toBe(true);
    expect(windowCoversServer({ all: false, server_ids: [2], tags: [], check_ids: [] }, server)).toBe(true);
    expect(windowCoversServer({ all: false, server_ids: [], tags: ['api'], check_ids: [] }, server)).toBe(true);
    expect(windowCoversServer({ all: false, server_ids: [1], tags: ['db'], check_ids: [9] }, server)).toBe(false);
  });
});
