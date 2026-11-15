import { describe, expect, it } from 'vitest';

import {
  EMPTY_VALUE,
  formatAge,
  formatBytes,
  formatClock,
  formatDuration,
  formatElapsed,
  formatMBps,
  formatPercent,
  formatRate,
  formatRelativeTime,
  secondsSince,
} from './format';

const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1.5 * KIB, '1.5 KB'],
    [512 * MIB, '512 MB'],
    [16 * GIB, '16.0 GB'],
    [142.4 * MIB, '142 MB'],
  ])('formats %d bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('shows the empty marker for unknown or invalid values', () => {
    expect(formatBytes(null)).toBe(EMPTY_VALUE);
    expect(formatBytes(undefined)).toBe(EMPTY_VALUE);
    expect(formatBytes(Number.NaN)).toBe(EMPTY_VALUE);
    expect(formatBytes(-1)).toBe(EMPTY_VALUE);
  });
});

describe('rates', () => {
  it('auto-scales bytes per second', () => {
    expect(formatRate(38.2 * MIB)).toBe('38.2 MB/s');
    expect(formatRate(null)).toBe(EMPTY_VALUE);
  });

  it('renders a bare MB/s number with one decimal under 100', () => {
    expect(formatMBps(0.4 * MIB)).toBe('0.4');
    expect(formatMBps(38.2 * MIB)).toBe('38.2');
    expect(formatMBps(142 * MIB)).toBe('142');
  });
});

describe('formatPercent', () => {
  it('uses one decimal by default and can round to whole numbers', () => {
    expect(formatPercent(94.24)).toBe('94.2%');
    expect(formatPercent(94.6, 0)).toBe('95%');
    expect(formatPercent(null)).toBe(EMPTY_VALUE);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [12, '12s'],
    [250, '4m 10s'],
    [23 * 60, '23m'],
    [2 * 3600 + 3 * 60 + 5, '2h 03m'],
    [63 * 86_400 + 4 * 3600, '63d 4h'],
    [102 * 86_400, '102d'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it('can limit to a single unit for compact rails', () => {
    expect(formatDuration(23 * 60 + 14, 1)).toBe('23m');
  });

  it('formats a running wait timer', () => {
    expect(formatElapsed(14)).toBe('0:14');
    expect(formatElapsed(65)).toBe('1:05');
    expect(formatElapsed(3600 + 2 * 60 + 9)).toBe('1:02:09');
  });

  it('words an age for prose', () => {
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(12 * 60)).toBe('12 min');
    expect(formatAge(3 * 3600)).toBe('3 h');
  });
});

describe('relative time', () => {
  const now = Date.UTC(2026, 10, 15, 14, 30, 0);

  it.each([
    [now - 500, 'just now'],
    [now - 2000, '2s ago'],
    [now - 12 * 60_000, '12 min ago'],
    [now - 3 * 3_600_000, '3 h ago'],
    [now - 4 * 86_400_000, '4 d ago'],
  ])('formats %d relative to now', (time, expected) => {
    expect(formatRelativeTime(time, now)).toBe(expected);
  });

  it('accepts ISO strings and handles missing values', () => {
    expect(formatRelativeTime(new Date(now - 5000).toISOString(), now)).toBe('5s ago');
    expect(formatRelativeTime(null, now)).toBe('never');
  });

  it('never reports a negative age for clock skew', () => {
    expect(formatRelativeTime(now + 3000, now)).toBe('just now');
    expect(secondsSince(now + 3000, now)).toBe(0);
  });

  it('formats a 24 h clock from local time', () => {
    expect(formatClock(new Date(2026, 10, 15, 14, 22, 5))).toBe('14:22:05');
  });
});
