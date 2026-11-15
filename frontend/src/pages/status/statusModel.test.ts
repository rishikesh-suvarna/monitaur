import { describe, expect, it } from 'vitest';

import type { PublicStatusDay } from '../../api/types';

import {
  dayKind,
  formatUptime,
  incidentView,
  normalizeService,
  pageHeading,
  serviceStatus,
  shapeUptimeDays,
  statusVerdict,
  uptimeSummary,
} from './statusModel';

const day = (date: string, pct: number | null, worst: PublicStatusDay['worst'] = null): PublicStatusDay => ({ day: date, pct, worst });

describe('uptime bar shaping', () => {
  it('colours by the worst incident and draws null days as no data', () => {
    expect(dayKind(day('2026-11-01', 100))).toBe('ok');
    expect(dayKind(day('2026-11-01', 99.2, 'warning'))).toBe('warn');
    expect(dayKind(day('2026-11-01', 80, 'critical'))).toBe('crit');
    expect(dayKind(day('2026-11-01', null))).toBe('none');
  });

  it('always yields 90 cells with today last, padding missing old days as no data', () => {
    const cells = shapeUptimeDays([day('2026-11-14', 100), day('2026-11-15', 98.5, 'warning')]);
    expect(cells).toHaveLength(90);
    expect(cells[0]).toMatchObject({ kind: 'none', heightPct: 25 });
    expect(cells[87]?.day).toBe('2026-11-13');
    expect(cells[88]).toMatchObject({ day: '2026-11-14', kind: 'ok', heightPct: 100 });
    expect(cells[89]).toMatchObject({ day: '2026-11-15', kind: 'warn', heightPct: 70 });
    expect(cells[89]?.label).toMatch(/98\.50% up · degraded$/);
    expect(cells[0]?.label).toMatch(/No data$/);
  });

  it('keeps only the newest 90 days', () => {
    const many = Array.from({ length: 95 }, (_, index) => day(`2026-08-${String((index % 28) + 1).padStart(2, '0')}`, index));
    const cells = shapeUptimeDays(many);
    expect(cells).toHaveLength(90);
    expect(cells[0]?.label).toMatch(/5\.00% up/);
  });

  it('formats uptime without rounding up to 100%', () => {
    expect(formatUptime(100)).toBe('100%');
    expect(formatUptime(99.999)).toBe('99.99%');
    // Unknown before the backend's first flush.
    expect(formatUptime(null)).toBe(formatUptime(Number.NaN));
    expect(formatUptime(99.71)).toBe('99.71%');
  });

  it('summarises a bar for screen readers', () => {
    const cells = shapeUptimeDays([day('2026-11-15', 99, 'critical')]);
    expect(uptimeSummary({ name: 'api', uptime_pct: 99.5, status: 'healthy' }, cells)).toBe(
      'api: 99.50% uptime over 90 days, 1 day with incidents, currently operational.',
    );
  });
});

describe('verdict line', () => {
  it('reads all-clear, single and mixed states', () => {
    expect(statusVerdict([{ name: 'api', status: 'healthy' }, { name: 'db', status: 'healthy' }])).toBe('All systems operational');
    expect(statusVerdict([{ name: 'Database', status: 'warning' }, { name: 'API', status: 'healthy' }])).toBe(
      'Database is degraded; everything else is operational',
    );
    expect(statusVerdict([{ name: 'api', status: 'critical' }, { name: 'db', status: 'warning' }, { name: 'edge', status: 'warning' }])).toBe(
      'api is having an outage and db and edge are degraded',
    );
    expect(statusVerdict([])).toMatch(/No services/);
  });
});

describe('incidents', () => {
  const now = Date.parse('2026-11-15T14:30:00Z');

  it('shows resolved incidents with their length and open ones as ongoing', () => {
    const resolved = incidentView({ service: 'db', metric: 'disk', severity: 'critical', started_at: '2026-11-15T13:00:00Z', resolved_at: '2026-11-15T13:38:00Z' }, now);
    expect(resolved).toMatchObject({ status: 'healthy', badge: 'Resolved', title: 'db: Disk / critical' });
    expect(resolved.when).toMatch(/38m$/);
    const open = incidentView({ service: 'edge', metric: 'heartbeat', severity: 'critical', started_at: '2026-11-15T14:00:00Z', resolved_at: null }, now);
    expect(open).toMatchObject({ status: 'offline', badge: 'Ongoing', title: 'edge: Unreachable' });
  });

  it('does not double the word status in the heading', () => {
    expect(pageHeading('Acme')).toBe('Acme status');
    expect(pageHeading('Acme Status')).toBe('Acme Status');
  });
});

describe('check services (F7)', () => {
  it('maps check words onto the server vocabulary and keeps server words', () => {
    expect(serviceStatus('up')).toBe('healthy');
    expect(serviceStatus('down')).toBe('critical');
    expect(serviceStatus('degraded')).toBe('warning');
    expect(serviceStatus('paused')).toBe('offline');
    expect(serviceStatus('warning')).toBe('warning');
    expect(serviceStatus('mystery')).toBe('offline');
  });

  it('defaults the kind to server for older backends', () => {
    expect(normalizeService({ name: 'db', status: 'healthy', uptime_pct: 100, days: [] }).kind).toBe('server');
    expect(normalizeService({ name: 'API', status: 'down', uptime_pct: 99, days: [], kind: 'check' })).toMatchObject({ kind: 'check', status: 'critical' });
  });

  it('words check incidents for visitors', () => {
    const now = Date.parse('2026-11-15T14:30:00Z');
    const down = incidentView({ service: 'API', metric: 'http', severity: 'critical', started_at: '2026-11-15T14:00:00Z', resolved_at: null }, now);
    expect(down).toMatchObject({ status: 'critical', title: 'API: Down', badge: 'Ongoing' });
    const cert = incidentView({ service: 'Site', metric: 'tls_expiry', severity: 'warning', started_at: '2026-11-15T14:00:00Z', resolved_at: null }, now);
    expect(cert).toMatchObject({ status: 'warning', title: 'Site: Certificate expiring' });
  });
});
