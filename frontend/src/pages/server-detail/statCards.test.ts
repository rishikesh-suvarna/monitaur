import { describe, expect, it } from 'vitest';

import { EMPTY_VALUE } from '../../lib/format';
import { makeLatest } from '../../test/fixtures';

import { pickRateUnit } from './chartData';
import { buildStatCards } from './statCards';

const MB = 1024 * 1024;
const GB = 1024 * MB;

// An older agent: no section 6.1 host metrics.
const latest = makeLatest({ cpu: 41.62, mem: 71.2, disk: 94.6, net_in: 38.2 * MB, net_out: 10.1 * MB, cpu_cores: 8, at: '2026-11-15T14:27:00Z' });

const hostLatest = makeLatest({
  ...latest,
  load1: 0.52,
  load5: 0.4,
  load15: 0.31,
  swap: 25,
  swap_total: 2 * GB,
  swap_used: 0.5 * GB,
  disk_read: 3 * MB,
  disk_write: 12 * MB,
});

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

describe('host metric cards (section 6.1)', () => {
  const rate = pickRateUnit(96 * MB);
  const diskRate = pickRateUnit(12 * MB);
  const keys = (cards: readonly { key: string }[]) => cards.map((card) => card.key);

  it('leaves the host cards out for an agent that does not report them', () => {
    expect(keys(buildStatCards({ latest, thresholds: {} }, stats, rate, diskRate))).toEqual(['cpu', 'mem', 'disk', 'net_in']);
    expect(keys(buildStatCards({ latest: null, thresholds: {} }, undefined, rate, diskRate))).toEqual(['cpu', 'mem', 'disk', 'net_in']);
  });

  it('adds load, swap, disk read and disk write as a second row when the agent sends them', () => {
    const cards = buildStatCards({ latest: hostLatest, thresholds: {} }, stats, rate, diskRate);
    expect(keys(cards)).toEqual(['cpu', 'mem', 'disk', 'net_in', 'load1', 'swap', 'disk_read', 'disk_write']);
  });

  it('shows load unitless with two decimals and the other averages', () => {
    const load = buildStatCards({ latest: hostLatest, thresholds: {} }, { load1: { min: 0.1, avg: 0.45, max: 1.9, now: 0.5 } }, rate, diskRate).find(
      (card) => card.key === 'load1',
    );
    expect(load).toMatchObject({
      label: 'Load (1 min)',
      value: '0.52',
      unit: '',
      stats: { min: '0.10', avg: '0.45', max: '1.90' },
      detail: '5 min 0.40 · 15 min 0.31',
      footnote: '5m 0.40 · 15m 0.31',
      alert: null,
    });
  });

  it('badges load and swap against their own thresholds', () => {
    const cards = buildStatCards(
      { latest: { ...hostLatest, load1: 9.5 }, thresholds: { load1: { warning: 4, critical: 8 }, swap: { warning: 20, critical: null } } },
      undefined,
      rate,
      diskRate,
    );
    expect(cards.find((card) => card.key === 'load1')).toMatchObject({ alert: { status: 'critical', text: '> 8' }, footnote: 'crit > 8' });
    expect(cards.find((card) => card.key === 'swap')).toMatchObject({ value: '25.0', unit: '%', alert: { status: 'warning', text: '> 20%' } });
  });

  it('reads swap usage in bytes, or says there is no swap space', () => {
    const swapOf = (overrides: Parameters<typeof makeLatest>[0]) =>
      buildStatCards({ latest: makeLatest({ ...hostLatest, ...overrides }), thresholds: {} }, undefined, rate, diskRate).find((card) => card.key === 'swap');
    expect(swapOf({})?.detail).toBe('512 MB of 2.0 GB');
    expect(swapOf({ swap: 0, swap_total: 0, swap_used: 0 })).toMatchObject({ value: '0.0', detail: 'No swap space' });
  });

  it('reads disk I/O in its own unit, separate from the network unit', () => {
    const cards = buildStatCards({ latest: hostLatest, thresholds: {} }, { disk_write: { min: 0, avg: 4 * MB, max: 12 * MB, now: 12 * MB } }, rate, pickRateUnit(12 * MB));
    expect(cards.find((card) => card.key === 'disk_read')).toMatchObject({ value: '3.0', unit: 'MB/s', stats: null, footnote: 'MB/s' });
    expect(cards.find((card) => card.key === 'disk_write')).toMatchObject({ value: '12.0', unit: 'MB/s', footnote: 'MB/s · max 12.0' });
  });

  it('keeps a host card from the range stats after the live sample lost it', () => {
    const cards = buildStatCards({ latest, thresholds: {} }, { swap: { min: 1, avg: 2, max: 3, now: 2.5 } }, rate, diskRate);
    expect(cards.find((card) => card.key === 'swap')?.value).toBe('2.5');
  });
});
