import { describe, expect, it } from 'vitest';

import { makeIncident } from '../test/fixtures';

import {
  hasValueMeter,
  incidentDurationLabel,
  incidentDurationSeconds,
  incidentPeak,
  incidentThreshold,
  meterValue,
  nextNotifyLabel,
  resolvedHowLabel,
} from './incidents';

const NOW = Date.parse('2026-11-15T14:27:00Z');

describe('incident duration', () => {
  it('ticks with now while open and stops at resolved_at', () => {
    const open = makeIncident({ id: 1, server_id: 1, started_at: '2026-11-15T14:04:00Z' });
    expect(incidentDurationSeconds(open, NOW)).toBe(23 * 60);
    expect(incidentDurationSeconds(open, NOW + 10_000)).toBe(23 * 60 + 10);
    const resolved = makeIncident({
      id: 2,
      server_id: 1,
      state: 'resolved',
      started_at: '2026-11-13T02:40:00Z',
      resolved_at: '2026-11-13T02:44:30Z',
    });
    expect(incidentDurationSeconds(resolved, NOW)).toBe(270);
  });

  it('labels the state of an active incident', () => {
    const base = { id: 1, server_id: 1, started_at: '2026-11-15T14:04:00Z' };
    expect(incidentDurationLabel(makeIncident(base), NOW)).toBe('23m · open');
    expect(incidentDurationLabel(makeIncident({ ...base, state: 'acked' }), NOW)).toBe('23m · acked');
    expect(incidentDurationLabel(makeIncident({ ...base, state: 'resolved', resolved_at: '2026-11-15T14:08:30Z' }), NOW)).toBe('4m 30s');
  });

  it('reads a heartbeat peak as silence', () => {
    const heartbeat = makeIncident({ id: 3, server_id: 1, metric: 'heartbeat', unit: '', started_at: '2026-11-15T14:15:00Z' });
    expect(incidentPeak(heartbeat, NOW)).toBe('12m silent');
  });

  it('meters a heartbeat against its timeout, like the design', () => {
    const heartbeat = makeIncident({ id: 3, server_id: 1, metric: 'heartbeat', unit: '', threshold: 60, peak: 90, started_at: '2026-11-15T14:15:00Z' });
    expect(incidentThreshold(heartbeat)).toBe('60s');
    expect(incidentThreshold({ ...heartbeat, threshold: 300 })).toBe('5m');
    expect(hasValueMeter(heartbeat)).toBe(true);
    // The stored peak lags until the next flush; the live silence (12 min) wins.
    expect(meterValue(heartbeat, NOW)).toBe(720);
    expect(hasValueMeter({ metric: 'tcp' })).toBe(false);
  });
});

describe('nextNotifyLabel', () => {
  it('counts down the cooldown while open', () => {
    expect(nextNotifyLabel({ state: 'open', next_notify_at: '2026-11-15T14:34:00Z' }, NOW)).toBe('cooldown, 7 min');
    expect(nextNotifyLabel({ state: 'open', next_notify_at: '2026-11-15T14:20:00Z' }, NOW)).toBe('due now');
    expect(nextNotifyLabel({ state: 'open', next_notify_at: null }, NOW)).toBe('no reminders');
  });

  it('stops reminders once acknowledged or resolved', () => {
    expect(nextNotifyLabel({ state: 'acked', next_notify_at: '2026-11-15T14:34:00Z' }, NOW)).toBe('paused while acknowledged');
    expect(nextNotifyLabel({ state: 'resolved', next_notify_at: null }, NOW)).toBe('none, resolved');
  });
});

describe('resolvedHowLabel', () => {
  it('names known causes and falls back for unknown ones', () => {
    expect(resolvedHowLabel({ resolved_how: 'auto' })).toBe('Auto-resolved');
    expect(resolvedHowLabel({ resolved_how: 'rule_changed' })).toBe('Rule changed');
    expect(resolvedHowLabel({ resolved_how: null })).toBe('Resolved');
  });
});
