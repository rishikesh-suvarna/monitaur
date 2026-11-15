import { describe, expect, it } from 'vitest';

import { makeIncident, makeServer } from '../test/fixtures';

import { buildVerdict, countByStatus, filterServers, sortServers, verdictHeadline } from './fleet';
import { breachesByServer, compareStatus, incidentTitle, presentIncident, sortActiveIncidents, worstStatus } from './status';

describe('status ranking', () => {
  it('orders worst first: critical, warning, offline, healthy', () => {
    const sorted = (['healthy', 'offline', 'critical', 'warning'] as const).slice().sort(compareStatus);
    expect(sorted).toEqual(['critical', 'warning', 'offline', 'healthy']);
  });

  it('finds the worst status, or null for none', () => {
    expect(worstStatus(['healthy', 'offline', 'warning'])).toBe('warning');
    expect(worstStatus([])).toBeNull();
  });
});

describe('presentIncident (badge shape, word and bar)', () => {
  it.each([
    [{ state: 'open', metric: 'disk', severity: 'critical' }, { status: 'critical', label: 'Critical', bar: 'crit' }],
    [{ state: 'acked', metric: 'memory', severity: 'warning' }, { status: 'warning', label: 'Warning', bar: 'warn' }],
    [{ state: 'open', metric: 'heartbeat', severity: 'critical' }, { status: 'offline', label: 'Unreachable', bar: 'off' }],
    [{ state: 'resolved', metric: 'cpu', severity: 'critical' }, { status: 'healthy', label: 'Resolved', bar: 'resolved' }],
  ] as const)('maps %o', (incident, expected) => {
    expect(presentIncident(incident)).toEqual(expected);
  });
});

describe('incidentTitle', () => {
  it('reads like the design: metric, comparison, threshold', () => {
    expect(incidentTitle({ metric: 'disk', threshold: 90, peak: 94.6, unit: '%' })).toBe('Disk above 90%');
    expect(incidentTitle({ metric: 'memory', threshold: 20, peak: 12, unit: '%' })).toBe('Memory below 20%');
    expect(incidentTitle({ metric: 'heartbeat', threshold: 0, peak: 0, unit: '' })).toBe('No heartbeat');
  });
});

describe('breachesByServer', () => {
  it('keeps the worst severity per metric and ignores resolved incidents', () => {
    const breaches = breachesByServer([
      makeIncident({ id: 1, server_id: 7, metric: 'disk', severity: 'warning' }),
      makeIncident({ id: 2, server_id: 7, metric: 'disk', severity: 'critical' }),
      makeIncident({ id: 3, server_id: 7, metric: 'memory', severity: 'warning', state: 'acked' }),
      makeIncident({ id: 4, server_id: 7, metric: 'cpu', severity: 'critical', state: 'resolved' }),
      makeIncident({ id: 5, server_id: 7, metric: 'heartbeat', severity: 'critical' }),
    ]);
    expect(breaches.get(7)).toEqual({ disk: 'critical', mem: 'warning' });
  });
});

describe('sortActiveIncidents', () => {
  it('puts unacknowledged first, then critical, unreachable, warning, then newest', () => {
    const sorted = sortActiveIncidents([
      makeIncident({ id: 1, server_id: 1, severity: 'warning', state: 'acked' }),
      makeIncident({ id: 2, server_id: 1, severity: 'warning', started_at: '2026-11-15T14:20:00Z' }),
      makeIncident({ id: 3, server_id: 1, severity: 'critical' }),
      makeIncident({ id: 4, server_id: 1, metric: 'heartbeat', started_at: '2026-11-15T14:15:00Z' }),
      makeIncident({ id: 5, server_id: 1, state: 'resolved' }),
    ]);
    expect(sorted.map((incident) => incident.id)).toEqual([3, 4, 2, 1]);
  });
});

describe('fleet filtering and sorting', () => {
  const servers = [
    makeServer({ id: 1, name: 'api-prod-01', tags: ['prod', 'api'], status: 'healthy', latest: null }),
    makeServer({ id: 2, name: 'db-primary', tags: ['prod', 'db'], status: 'critical' }),
    makeServer({ id: 3, name: 'backup-nas', tags: ['home'], status: 'offline' }),
  ];

  it('filters by name, tag and status together', () => {
    expect(filterServers(servers, { query: 'DB', tag: null, status: null }).map((s) => s.id)).toEqual([2]);
    expect(filterServers(servers, { query: '', tag: 'prod', status: 'healthy' }).map((s) => s.id)).toEqual([1]);
  });

  it('sorts by status worst first, then name', () => {
    expect(sortServers(servers, 'status').map((s) => s.id)).toEqual([2, 3, 1]);
  });

  it('counts each status', () => {
    expect(countByStatus(servers)).toEqual({ all: 3, healthy: 1, warning: 0, critical: 1, offline: 1 });
  });
});

describe('verdict', () => {
  const now = Date.parse('2026-11-15T14:27:00Z');

  it('names the worst server and why', () => {
    const servers = [
      makeServer({ id: 1, name: 'db-primary', status: 'critical' }),
      makeServer({ id: 2, name: 'worker', status: 'warning' }),
      makeServer({ id: 3, name: 'nas', status: 'offline' }),
    ];
    const incidents = [
      makeIncident({ id: 9, server_id: 1, metric: 'disk', severity: 'critical', last_value: 94.2, started_at: '2026-11-15T14:04:00Z' }),
    ];
    const verdict = buildVerdict(servers, incidents, now);
    expect(verdict.kind).toBe('critical');
    expect(verdict.worst?.id).toBe(1);
    expect(verdict.reason).toEqual({ subject: 'disk', value: '94.2%', duration: '23 min' });
    expect(verdictHeadline(verdict)).toEqual({ primary: '1 server critical', secondary: '2 need attention' });
  });

  it('falls back to last_seen for an offline server with no incident', () => {
    const servers = [makeServer({ id: 3, name: 'nas', status: 'offline', last_seen: '2026-11-15T14:15:00Z' })];
    const verdict = buildVerdict(servers, [], now);
    expect(verdictHeadline(verdict).primary).toBe('1 server needs attention');
    expect(verdict.reason).toEqual({ subject: 'no heartbeat', value: null, duration: '12 min' });
  });

  it('reports all healthy', () => {
    const verdict = buildVerdict([makeServer({ id: 1, name: 'a' }), makeServer({ id: 2, name: 'b' })], [], now);
    expect(verdict.kind).toBe('healthy');
    expect(verdictHeadline(verdict).primary).toBe('All 2 servers healthy');
  });
});
