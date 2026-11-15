import { describe, expect, it } from 'vitest';

import type { ServerMount } from '../../api/types';
import { EMPTY_VALUE } from '../../lib/format';

import { hasEntries, interfaceRows, mountRows, mountUsagePercent, usageFill } from './hostModel';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const mount = (overrides: Partial<ServerMount>): ServerMount => ({ path: '/', fstype: 'ext4', total: 100 * GB, used: 50 * GB, pct: 50, ...overrides });

describe('mount usage maths', () => {
  it('prefers the agent percentage, which leaves out root-reserved blocks like df', () => {
    // 95 GB used of 100 GB, but 5 GB is reserved, so df (and the agent) says 100%.
    expect(mountUsagePercent(mount({ used: 95 * GB, pct: 100 }))).toBe(100);
  });

  it('falls back to used over total when the percentage is missing', () => {
    expect(mountUsagePercent(mount({ used: 25 * GB, pct: Number.NaN }))).toBe(25);
    expect(mountUsagePercent({ used: 25 * GB, total: 100 * GB } as ServerMount)).toBe(25);
  });

  it('is unknown without a percentage or a usable total', () => {
    expect(mountUsagePercent(mount({ pct: Number.NaN, total: 0 }))).toBeNull();
    expect(mountUsagePercent(mount({ pct: -1, total: Number.NaN }))).toBeNull();
  });

  it('clamps only the bar, never the figure', () => {
    expect(usageFill(104.2)).toBe(100);
    expect(usageFill(-3)).toBe(0);
    expect(usageFill(null)).toBe(0);
    expect(mountRows([mount({ pct: 104.2 })], undefined)[0]).toMatchObject({ pctText: '104.2%', fill: 100 });
  });
});

describe('mountRows', () => {
  const disk = { warning: 80, critical: 90 };

  it('lists / first, then by path, with sizes in binary units', () => {
    const rows = mountRows([mount({ path: '/var' }), mount({ path: '/', used: 312 * GB, total: 480 * GB, pct: 65 }), mount({ path: '/boot' })], disk);
    expect(rows.map((row) => row.path)).toEqual(['/', '/boot', '/var']);
    expect(rows[0]).toMatchObject({ fstype: 'ext4', used: '312 GB', total: '480 GB', pct: 65, pctText: '65.0%', fill: 65, severity: null });
  });

  it('colours usage by the server disk thresholds, strictly above', () => {
    const rows = mountRows([mount({ path: '/a', pct: 80 }), mount({ path: '/b', pct: 85 }), mount({ path: '/c', pct: 97 })], disk);
    expect(rows.map((row) => row.severity)).toEqual([null, 'warning', 'critical']);
  });

  it('stays neutral without disk rules', () => {
    expect(mountRows([mount({ pct: 99 })], undefined)[0]?.severity).toBeNull();
  });

  it('shows a dash for unknown type and usage', () => {
    expect(mountRows([mount({ fstype: ' ', pct: Number.NaN, total: 0, used: Number.NaN })], disk)[0]).toMatchObject({
      fstype: EMPTY_VALUE,
      used: EMPTY_VALUE,
      pctText: EMPTY_VALUE,
      fill: 0,
      severity: null,
    });
  });

  it('tolerates a backend that sends no list', () => {
    expect(mountRows(undefined, disk)).toEqual([]);
    expect(mountRows(null, disk)).toEqual([]);
    expect(hasEntries(undefined)).toBe(false);
    expect(hasEntries([])).toBe(false);
    expect(hasEntries([mount({})])).toBe(true);
  });
});

describe('interfaceRows', () => {
  it('sorts names naturally so eth2 comes before eth10, with auto-scaled rates', () => {
    const rows = interfaceRows([
      { name: 'eth10', in: 0, out: 0 },
      { name: 'eth2', in: 38.2 * MB, out: 512 },
      { name: 'docker0', in: Number.NaN, out: 2048 },
    ]);
    expect(rows).toEqual([
      { name: 'docker0', in: EMPTY_VALUE, out: '2.0 KB/s' },
      { name: 'eth2', in: '38.2 MB/s', out: '512 B/s' },
      { name: 'eth10', in: '0 B/s', out: '0 B/s' },
    ]);
  });

  it('is empty for older agents', () => {
    expect(interfaceRows(undefined)).toEqual([]);
  });
});
