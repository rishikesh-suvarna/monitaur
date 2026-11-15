import { describe, expect, it } from 'vitest';

import type { ServerLatest } from '../../api/types';
import { EMPTY_VALUE } from '../../lib/format';

import { pickRateUnit } from './chartData';
import { buildStatCards } from './statCards';

const MB = 1024 * 1024;

const latest: ServerLatest = {
  cpu: 41.62,
  mem: 71.2,
  disk: 94.6,
  net_in: 38.2 * MB,
  net_out: 10.1 * MB,
  mem_total: 0,
  mem_used: 0,
  disk_total: 0,
  disk_used: 0,
  cpu_cores: 8,
  uptime_s: 0,
  at: '2026-11-15T14:27:00Z',
};

const stats = {
  cpu: { min: 4, avg: 41.84, max: 67, now: 40 },
  disk: { min: 86.5, avg: 90.1, max: 94.6, now: 94.6 },
  net_in: { min: 2 * MB, avg: 30 * MB, max: 96 * MB, now: 38 * MB },
};

describe('buildStatCards', () => {
  const rate = pickRateUnit(96 * MB);

  it('shows the live value from the stream, not the series stats', () => {
    const [cpu] = buildStatCards({ latest, thresholds: {} }, stats, rate);
    expect(cpu).toMatchObject({ label: 'CPU', value: '41.6', unit: '%', stats: { min: '4.0', avg: '41.8', max: '67.0' }, alert: null });
    expect(cpu?.footnote).toBe('avg 41.8 · max 67.0');
  });

  it('falls back to stats.now without a live sample', () => {
    const [cpu] = buildStatCards({ latest: null, thresholds: {} }, stats, rate);
    expect(cpu?.value).toBe('40.0');
  });

  it('badges the worst crossed threshold', () => {
    const cards = buildStatCards({ latest, thresholds: { disk: { warning: 80, critical: 90 }, mem: { warning: 85, critical: null } } }, stats, rate);
    expect(cards.find((card) => card.key === 'disk')).toMatchObject({ alert: { status: 'critical', text: '> 90%' }, footnote: 'crit > 90%' });
    expect(cards.find((card) => card.key === 'mem')?.alert).toBeNull();
  });

  it('reads network in the chosen rate unit, with out in the footnote', () => {
    const net = buildStatCards({ latest, thresholds: { net_in: { warning: 30 * MB, critical: null } } }, stats, rate).find((card) => card.key === 'net_in');
    expect(net).toMatchObject({
      label: 'Network in',
      shortLabel: 'Net in',
      value: '38.2',
      unit: 'MB/s',
      stats: { max: '96.0' },
      alert: { status: 'warning', text: '> 30.0 MB/s' },
      footnote: 'MB/s · out 10.1',
    });
  });

  it('shows network as unknown when the range has no network stats (old agents)', () => {
    const net = buildStatCards({ latest, thresholds: {} }, { cpu: stats.cpu }, rate).find((card) => card.key === 'net_in');
    expect(net).toMatchObject({ value: EMPTY_VALUE, footnote: `MB/s · out ${EMPTY_VALUE}` });
  });

  it('shows empty values with no data at all', () => {
    const [cpu] = buildStatCards({ latest: null, thresholds: {} }, undefined, rate);
    expect(cpu).toMatchObject({ value: EMPTY_VALUE, stats: null, footnote: '' });
  });
});
