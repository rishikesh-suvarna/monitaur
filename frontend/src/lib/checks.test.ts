import { describe, expect, it } from 'vitest';

import { makeCheck, makeIncident } from '../test/fixtures';

import {
  CHECK_STATUS_META,
  checkBadgeStatus,
  countChecksByStatus,
  describeResult,
  formatLatency,
  formatTlsDays,
  isCheckMetric,
  latencyParts,
  latencyScaleMax,
  reportsTls,
  sortChecks,
  tlsTone,
} from './checks';
import { EMPTY_VALUE } from './format';
import { hasValueMeter, incidentCheckId, incidentPeak, incidentSubject, incidentThreshold } from './incidents';
import { breachesByServer, incidentTitle, metricLabel, presentIncident } from './status';

describe('check status mapping (StatusBadge shapes with the check word)', () => {
  it.each([
    ['up', 'healthy', 'Up'],
    ['down', 'critical', 'Down'],
    ['degraded', 'warning', 'Degraded'],
    ['paused', 'offline', 'Paused'],
    ['pending', 'offline', 'Pending'],
  ] as const)('%s reads as the %s shape with the word %s', (status, shape, word) => {
    expect(checkBadgeStatus(status)).toBe(shape);
    expect(CHECK_STATUS_META[status].label).toBe(word);
  });

  it('sorts worst first, then by name', () => {
    const checks = [
      makeCheck({ id: 1, name: 'b', status: 'up' }),
      makeCheck({ id: 2, name: 'a', status: 'up' }),
      makeCheck({ id: 3, name: 'z', status: 'down' }),
      makeCheck({ id: 4, name: 'y', status: 'paused' }),
      makeCheck({ id: 5, name: 'x', status: 'degraded' }),
    ];
    expect(sortChecks(checks).map((check) => check.id)).toEqual([3, 5, 4, 2, 1]);
  });

  it('counts per status', () => {
    const counts = countChecksByStatus([makeCheck({ id: 1, name: 'a', status: 'down' }), makeCheck({ id: 2, name: 'b', status: 'up' })]);
    expect(counts).toMatchObject({ all: 2, down: 1, up: 1, degraded: 0 });
  });
});

describe('check values', () => {
  it('formats latency in ms, then seconds', () => {
    expect(formatLatency(212.4)).toBe('212 ms');
    expect(formatLatency(1240)).toBe('1.24 s');
    expect(formatLatency(null)).toBe(EMPTY_VALUE);
    expect(latencyParts(212)).toEqual({ value: '212', unit: 'ms' });
    expect(latencyParts(undefined)).toEqual({ value: EMPTY_VALUE, unit: undefined });
  });

  it('tones certificate days against the warning window', () => {
    expect(tlsTone(41, 14)).toBe('ok');
    expect(tlsTone(14, 14)).toBe('warn');
    expect(tlsTone(0, 14)).toBe('crit');
    expect(tlsTone(null, 14)).toBe('none');
    expect(formatTlsDays(41.7)).toBe('41 d');
    expect(formatTlsDays(-2)).toBe('expired');
  });

  it('knows which targets report certificates', () => {
    expect(reportsTls({ type: 'tls', target: 'example.com' })).toBe(true);
    expect(reportsTls({ type: 'http', target: 'https://example.com' })).toBe(true);
    expect(reportsTls({ type: 'http', target: 'http://example.com' })).toBe(false);
    expect(reportsTls({ type: 'tcp', target: 'example.com:443' })).toBe(false);
  });

  it('scales the sparkline with headroom and a floor', () => {
    expect(latencyScaleMax([])).toBe(100);
    expect(latencyScaleMax([200, 500])).toBe(600);
  });

  it('describes a result in one line', () => {
    expect(describeResult({ ok: true, latency_ms: 212, status_code: 200, error: null })).toBe('HTTP 200 · 212 ms');
    expect(describeResult({ ok: false, latency_ms: 3000, status_code: null, error: 'connection refused' })).toBe('connection refused · 3.00 s');
  });
});

describe('check incidents', () => {
  const down = makeIncident({ id: 1, server_id: null, server_name: 'API', check_id: 7, check_name: 'API', metric: 'http', severity: 'critical' });
  const cert = makeIncident({ id: 2, server_id: null, check_id: 8, check_name: 'Site', metric: 'tls_expiry', severity: 'warning', last_value: 9, threshold: 14 });

  it('recognises check metrics', () => {
    expect(isCheckMetric('http')).toBe(true);
    expect(isCheckMetric('tls_expiry')).toBe(true);
    expect(isCheckMetric('cpu')).toBe(false);
    expect(metricLabel('tcp')).toBe('TCP check');
    expect(metricLabel('disk')).toBe('Disk');
  });

  it('reads a failing check as Down and a certificate by its severity', () => {
    expect(presentIncident(down)).toEqual({ status: 'critical', label: 'Down', bar: 'crit' });
    expect(presentIncident(cert)).toEqual({ status: 'warning', label: 'Expiring', bar: 'warn' });
    expect(presentIncident({ ...down, state: 'resolved' })).toEqual({ status: 'healthy', label: 'Resolved', bar: 'resolved' });
  });

  it('titles and values check incidents without a meter', () => {
    expect(incidentTitle(down)).toBe('HTTP check failing');
    expect(incidentTitle(cert)).toBe('Certificate expires in 9 d');
    expect(incidentTitle({ ...cert, last_value: 0 })).toBe('Certificate expired');
    expect(incidentPeak(cert, Date.parse('2026-11-15T14:10:00Z'))).toBe('9 d left');
    expect(incidentPeak(down, Date.parse('2026-11-15T14:04:00Z'))).toBe('4m down');
    expect(incidentThreshold(cert)).toBe('14 d');
    expect(incidentThreshold(down)).toBeNull();
    expect(hasValueMeter(down)).toBe(false);
    expect(hasValueMeter(makeIncident({ id: 3, server_id: 1 }))).toBe(true);
  });

  it('links a check incident to its check, and tolerates payloads without check fields', () => {
    expect(incidentSubject(down)).toEqual({ kind: 'check', id: 7, name: 'API' });
    expect(incidentSubject(makeIncident({ id: 4, server_id: 2, server_name: 'db' }))).toEqual({ kind: 'server', id: 2, name: 'db' });
    const legacy = { ...makeIncident({ id: 5, server_id: 3 }), check_id: undefined } as unknown as Parameters<typeof incidentCheckId>[0];
    expect(incidentCheckId(legacy)).toBeNull();
  });

  it('keeps check incidents out of the server breach map', () => {
    expect(breachesByServer([down, cert]).size).toBe(0);
  });
});
