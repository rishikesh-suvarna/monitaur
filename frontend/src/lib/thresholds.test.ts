import { describe, expect, it } from 'vitest';

import { metricCells, metricSeverity } from '../components/serverMetrics';
import { makeLatest, makeServer } from '../test/fixtures';

import { incidentTitle } from './status';
import { hasThreshold, thresholdLines, thresholdSeverity } from './thresholds';

const LATEST = makeLatest({ cpu: 50, mem: 82, disk: 96, cpu_cores: 4 });

describe('thresholdSeverity', () => {
  it.each([
    [95.1, 'critical'],
    [95, 'warning'],
    [90.5, 'warning'],
    [90, null],
    [10, null],
  ] as const)('%d against warn 90 / crit 95 is %s (strictly above, like the backend)', (value, expected) => {
    expect(thresholdSeverity(value, { warning: 90, critical: 95 })).toBe(expected);
  });

  it('handles one-sided pairs and missing input', () => {
    expect(thresholdSeverity(99, { warning: null, critical: 95 })).toBe('critical');
    expect(thresholdSeverity(99, { warning: 80, critical: null })).toBe('warning');
    expect(thresholdSeverity(null, { warning: 80, critical: 90 })).toBeNull();
    expect(thresholdSeverity(99, undefined)).toBeNull();
  });
});

describe('hasThreshold and thresholdLines', () => {
  it('treats an all-null pair as no threshold', () => {
    expect(hasThreshold({ warning: null, critical: null })).toBe(false);
    expect(hasThreshold(undefined)).toBe(false);
    expect(hasThreshold({ warning: 80, critical: null })).toBe(true);
  });

  it('lists warning before critical and skips nulls', () => {
    expect(thresholdLines({ warning: 80, critical: 95 })).toEqual([
      { severity: 'warning', value: 80 },
      { severity: 'critical', value: 95 },
    ]);
    expect(thresholdLines({ warning: null, critical: 95 })).toEqual([{ severity: 'critical', value: 95 }]);
  });
});

describe('overview metric colouring', () => {
  it('uses the server thresholds when the metric has one, ignoring incidents', () => {
    const server = makeServer({ id: 1, name: 'db', latest: LATEST, thresholds: { disk: { warning: 90, critical: 95 }, mem: { warning: 85, critical: null } } });
    // Disk is over its critical line; memory is under its warning line even though an incident says otherwise.
    expect(metricSeverity(server, 'disk', undefined)).toBe('critical');
    expect(metricSeverity(server, 'mem', { mem: 'warning' })).toBeUndefined();
  });

  it('falls back to active incidents when the metric has no threshold', () => {
    const server = makeServer({ id: 1, name: 'db', latest: LATEST, thresholds: { disk: { warning: 90, critical: 95 } } });
    expect(metricSeverity(server, 'cpu', { cpu: 'warning' })).toBe('warning');
    expect(metricSeverity(server, 'cpu', undefined)).toBeUndefined();
  });

  it('tones the cells, but never a stale (offline) server', () => {
    const thresholds = { cpu: { warning: 40, critical: 90 } };
    const live = metricCells(makeServer({ id: 1, name: 'a', latest: LATEST, thresholds }), undefined);
    expect(live.find((cell) => cell.key === 'cpu')).toMatchObject({ tone: 'warn', over: true });
    const stale = metricCells(makeServer({ id: 2, name: 'b', status: 'offline', latest: LATEST, thresholds }), undefined);
    expect(stale.find((cell) => cell.key === 'cpu')).toMatchObject({ tone: 'off', over: false });
  });
});

describe('incidentTitle with comparison', () => {
  it('trusts the comparison over the peak', () => {
    expect(incidentTitle({ metric: 'memory', threshold: 20, peak: 25, unit: '%', comparison: 'below' })).toBe('Memory below 20%');
    expect(incidentTitle({ metric: 'cpu', threshold: 85, peak: 91, unit: '%', comparison: 'above' })).toBe('CPU above 85%');
  });
});
