import { describe, expect, it } from 'vitest';

import type { SeriesPoint } from '../api/types';

import { incidentSeriesField, incidentWindow, rangeFor, samplesDomain, windowValues } from './incidentSamples';

const NOW = Date.parse('2026-11-15T14:27:00Z');
const MINUTE = 60_000;

function point(t: string, cpu: number | null): SeriesPoint {
  return {
    t,
    cpu,
    mem: null,
    disk: null,
    net_in: null,
    net_out: null,
    load1: null,
    swap: null,
    disk_read: null,
    disk_write: null,
  };
}

describe('incident samples', () => {
  it('maps server metrics to series fields and skips the rest', () => {
    expect(incidentSeriesField('memory')).toBe('mem');
    expect(incidentSeriesField('load1')).toBe('load1');
    expect(incidentSeriesField('heartbeat')).toBeNull();
    expect(incidentSeriesField('tcp')).toBeNull();
  });

  it('shows a lead before the start and stops at the resolve', () => {
    const open = incidentWindow({ started_at: '2026-11-15T14:15:00Z', resolved_at: null }, NOW);
    // 12 min open: the lead is the 5 min minimum.
    expect(open).toEqual({ from: Date.parse('2026-11-15T14:10:00Z'), to: NOW });
    const long = incidentWindow({ started_at: '2026-11-15T10:00:00Z', resolved_at: '2026-11-15T14:00:00Z' }, NOW);
    // 4 h long: a quarter of it (1 h) before.
    expect(long).toEqual({ from: Date.parse('2026-11-15T09:00:00Z'), to: Date.parse('2026-11-15T14:00:00Z') });
    expect(incidentWindow({ started_at: 'garbage', resolved_at: null }, NOW)).toBeNull();
  });

  it('picks the shortest range that reaches the window', () => {
    expect(rangeFor({ from: NOW - 30 * MINUTE, to: NOW }, NOW)).toBe('1h');
    expect(rangeFor({ from: NOW - 5 * 60 * MINUTE, to: NOW }, NOW)).toBe('6h');
    expect(rangeFor({ from: NOW - 3 * 24 * 60 * MINUTE, to: NOW }, NOW)).toBe('7d');
    expect(rangeFor({ from: NOW - 90 * 24 * 60 * MINUTE, to: NOW }, NOW)).toBe('30d');
  });

  it('keeps only the window and its gaps', () => {
    const points = [point('2026-11-15T14:05:00Z', 40), point('2026-11-15T14:12:00Z', 85), point('2026-11-15T14:13:00Z', null), point('2026-11-15T14:20:00Z', 97)];
    expect(windowValues(points, 'cpu', { from: Date.parse('2026-11-15T14:10:00Z'), to: NOW })).toEqual([85, null, 97]);
  });

  it('zooms on the threshold like the design', () => {
    expect(samplesDomain([85, 97], { threshold: 90, unit: '%', comparison: 'above' })).toEqual({ min: 81, max: 102 });
    // Rates have no fixed top: a quarter over the highest of peak and threshold.
    const rate = samplesDomain([800, 1200], { threshold: 1000, unit: 'B/s', comparison: 'above' });
    expect(rate.min).toBe(900);
    expect(rate.max).toBeCloseTo(1200 * 1.25 * 1.02);
    // A "below" rule breaches under its threshold, so zero stays visible.
    expect(samplesDomain([3, 4], { threshold: 5, unit: '%', comparison: 'below' }).min).toBe(0);
  });
});
