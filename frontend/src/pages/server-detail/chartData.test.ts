import { describe, expect, it } from 'vitest';

import type { SeriesPoint } from '../../api/types';
import { EMPTY_VALUE } from '../../lib/format';

import {
  buildChartSpecs,
  compactUnitHint,
  findGaps,
  formatLoadLimit,
  formatValue,
  isUnreportedSpec,
  loadAverages,
  loadAxisMax,
  maxDiskRate,
  partitionSpecs,
  valueSuffix,
  formatSpan,
  formatStep,
  latestRowIndex,
  maxRate,
  niceCeil,
  pickRateUnit,
  placeThresholdLabels,
  quarterTicks,
  rangeNote,
  rateAxisMax,
  statChips,
  timeTicks,
  toChartRows,
  unreportedFields,
  valueSeverity,
  type ChartRow,
  type ChartSpec,
} from './chartData';

const MB = 1024 * 1024;
const START = Date.parse('2026-11-15T12:00:00Z');
const STEP_MS = 60_000;

function point(index: number, values: Partial<Omit<SeriesPoint, 't'>> | null): SeriesPoint {
  const empty = { cpu: null, mem: null, disk: null, net_in: null, net_out: null, load1: null, swap: null, disk_read: null, disk_write: null };
  return { t: new Date(START + index * STEP_MS).toISOString(), ...empty, ...(values ?? {}) };
}

const sample = { cpu: 40, mem: 70, disk: 88, net_in: 2 * MB, net_out: MB / 2 };
const noHost = { load1: null, swap: null, disk_read: null, disk_write: null };
const byKey = (specs: readonly ChartSpec[], key: ChartSpec['key']): ChartSpec | undefined => specs.find((spec) => spec.key === key);

describe('toChartRows', () => {
  it('keeps nulls as breaks and scales network into the chosen unit', () => {
    const rows = toChartRows([point(0, sample), point(1, null)], pickRateUnit(2 * MB));
    expect(rows).toEqual<ChartRow[]>([
      { ts: START, cpu: 40, mem: 70, disk: 88, net_in: 2, net_out: 0.5, ...noHost },
      { ts: START + STEP_MS, cpu: null, mem: null, disk: null, net_in: null, net_out: null, ...noHost },
    ]);
  });

  it('drops points with an unreadable timestamp', () => {
    expect(toChartRows([{ ...point(0, sample), t: 'not a date' }], pickRateUnit(0))).toEqual([]);
  });
});

describe('pickRateUnit and maxRate', () => {
  it.each([
    [0, 'B/s', 1],
    [900, 'B/s', 1],
    [1024, 'KB/s', 1024],
    [38 * MB, 'MB/s', MB],
    [3 * 1024 * MB, 'GB/s', 1024 * MB],
  ] as const)('%d B/s reads in %s', (bytes, label, divisor) => {
    expect(pickRateUnit(bytes)).toEqual({ label, divisor });
  });

  it('looks at points and stats', () => {
    expect(maxRate({ points: [point(0, { net_in: 10, net_out: 300 })], stats: { net_in: { min: 0, avg: 1, max: 500, now: 1 } } })).toBe(500);
  });
});

describe('findGaps', () => {
  const rows = (pattern: string): ChartRow[] =>
    toChartRows(
      Array.from(pattern, (char, index) => point(index, char === 'x' ? sample : null)),
      pickRateUnit(MB),
    );
  const at = (index: number): number => START + index * STEP_MS;

  it('reports interior gaps from the last point before to the first after', () => {
    const report = findGaps(rows('xx...xx'), at(6));
    expect(report.gaps).toEqual([{ from: at(1), to: at(5) }]);
    expect(report.trailing).toBeNull();
    expect(report.empty).toBe(false);
  });

  it('ignores leading empty steps and reports a trailing run separately', () => {
    const report = findGaps(rows('..xx..'), at(8));
    expect(report.gaps).toEqual([]);
    expect(report.trailing).toEqual({ from: at(3), to: at(8) });
    expect(report.trailingSteps).toBe(2);
  });

  it('flags an all-empty range', () => {
    expect(findGaps(rows('...'), at(3))).toMatchObject({ gaps: [], trailing: null, empty: true });
  });

  it('finds the newest row with data', () => {
    expect(latestRowIndex(rows('x.x..'))).toBe(2);
    expect(latestRowIndex(rows('...'))).toBeNull();
  });
});

describe('unreportedFields', () => {
  it('names metrics an old agent never sends', () => {
    const series = toChartRows([point(0, { cpu: 1, mem: 2, disk: 3 }), point(1, { cpu: 1, mem: 2, disk: 3 })], pickRateUnit(0));
    expect(unreportedFields(series)).toEqual(['net_in', 'net_out', 'load1', 'swap', 'disk_read', 'disk_write']);
  });

  it('says nothing when there is no data at all', () => {
    expect(unreportedFields(toChartRows([point(0, null)], pickRateUnit(0)))).toEqual([]);
  });
});

describe('axis scales', () => {
  it.each([
    [0, 1],
    [0.7, 1],
    [1.3, 2],
    [2.2, 2.5],
    [37, 50],
    [96, 100],
    [101, 200],
  ])('niceCeil(%d) = %d', (value, expected) => {
    expect(niceCeil(value)).toBe(expected);
  });

  it('keeps rate thresholds on screen with headroom', () => {
    const series = toChartRows([point(0, { net_in: 30 * MB, net_out: 5 * MB })], pickRateUnit(30 * MB));
    expect(rateAxisMax(series, [])).toBe(50);
    expect(rateAxisMax(series, [100])).toBe(200);
  });

  it('spaces time ticks evenly, ends included', () => {
    expect(timeTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(timeTicks(10, 10, 6)).toEqual([10]);
    expect(quarterTicks(100)).toEqual([0, 25, 50, 75, 100]);
  });
});

describe('range note', () => {
  it('describes the span and resolution the backend actually returned', () => {
    expect(rangeNote({ from: '2026-11-15T08:00:00Z', to: '2026-11-15T14:00:00Z', step_seconds: 60 })).toBe('last 6 hours · 1 min resolution');
    expect(rangeNote({ from: '2026-11-15T13:45:00Z', to: '2026-11-15T14:00:00Z', step_seconds: 5 })).toBe('last 15 min · 5 s resolution');
    expect(rangeNote({ from: '2026-11-08T14:00:00Z', to: '2026-11-15T14:00:00Z', step_seconds: 3600 })).toBe('last 7 days · 1 h resolution');
    expect(rangeNote({ from: 'bad', to: '2026-11-15T14:00:00Z', step_seconds: 5 })).toBe('');
  });

  it('formats steps and spans', () => {
    expect(formatStep(10)).toBe('10 s');
    expect(formatStep(240)).toBe('4 min');
    expect(formatStep(7200)).toBe('2 h');
    expect(formatSpan(3600)).toBe('hour');
    expect(formatSpan(86_400)).toBe('24 hours');
    expect(formatSpan(30 * 86_400)).toBe('30 days');
  });
});

describe('statChips', () => {
  it('formats percent with one decimal and rates in the chosen unit', () => {
    expect(statChips({ min: 4, avg: 41.84, max: 67, now: 41.6 }, 'percent')).toEqual({ min: '4.0', avg: '41.8', max: '67.0', now: '41.6' });
    expect(statChips({ min: 0, avg: 2 * MB, max: 120 * MB, now: MB }, 'rate', pickRateUnit(120 * MB))).toEqual({
      min: '0.0',
      avg: '2.0',
      max: '120',
      now: '1.0',
    });
    expect(statChips(undefined, 'percent')).toBeNull();
  });
});

describe('placeThresholdLabels', () => {
  // A 132 px stacked chart: 6 px top margin, 20 px axis, 11 px labels 4 px off the line.
  const box = { max: 100, top: 6, height: 106, labelHeight: 11, gap: 4 };

  it('puts labels above their lines when there is room', () => {
    expect(placeThresholdLabels([80, 50], box)).toEqual(['above', 'above']);
  });

  it('moves a label under its line at the very top of the plot', () => {
    expect(placeThresholdLabels([97], box)).toEqual(['below']);
  });

  it('keeps close lines from overprinting, in input order', () => {
    // warn 80 and crit 90 are ~11 px apart: crit stays above, warn drops below its line.
    expect(placeThresholdLabels([80, 90], box)).toEqual(['below', 'above']);
    // crit 95 has no room above, so it goes under; warn 80 then has to go under too.
    expect(placeThresholdLabels([80, 95], { ...box, height: 84 })).toEqual(['below', 'below']);
  });
});

describe('buildChartSpecs', () => {
  const rate = pickRateUnit(40 * MB);
  const rows = toChartRows([point(0, { ...sample, net_in: 40 * MB })], rate);

  it('draws the warning and critical lines and names the totals', () => {
    const specs = buildChartSpecs({
      rows,
      rate,
      thresholds: { cpu: { warning: 85, critical: null }, disk: { warning: 80, critical: 90 }, net_in: { warning: 100 * MB, critical: null } },
      latest: { cpu_cores: 8, mem_total: 32 * 1024 * MB, disk_total: 480 * 1024 * MB },
    });
    const [cpu, mem, disk, net] = (['cpu', 'mem', 'disk', 'net'] as const).map((key) => byKey(specs, key));
    expect(cpu).toMatchObject({ title: 'CPU', unitHint: '% of 8 cores', max: 100, thresholds: [{ severity: 'warning', value: 85, label: 'warn 85%' }] });
    expect(mem?.thresholds).toEqual([]);
    expect(mem?.unitHint).toBe('% of 32.0 GB');
    expect(disk?.thresholds.map((line) => line.label)).toEqual(['warn 80%', 'crit 90%']);
    // The 100 MB/s threshold stretches the network axis past the 40 MB/s peak.
    expect(net).toMatchObject({ unitHint: 'MB/s', max: 200, thresholds: [{ value: 100, label: 'warn 100 MB/s' }] });
  });

  it('falls back to a bare unit without totals', () => {
    const specs = buildChartSpecs({ rows, rate, thresholds: {}, latest: null });
    expect(byKey(specs, 'cpu')?.unitHint).toBe('%');
    expect(byKey(specs, 'swap')?.unitHint).toBe('%');
    expect(byKey(specs, 'load')?.references).toEqual([]);
  });

  it('colours readout values by the chart lines, strictly above', () => {
    const disk = byKey(buildChartSpecs({ rows, rate, thresholds: { disk: { warning: 80, critical: 90 } }, latest: null }), 'disk');
    const lines = disk?.thresholds ?? [];
    expect(valueSeverity(94, 'disk', lines)).toBe('critical');
    expect(valueSeverity(90, 'disk', lines)).toBe('warning');
    expect(valueSeverity(50, 'disk', lines)).toBeNull();
    expect(valueSeverity(null, 'disk', lines)).toBeNull();
    expect(valueSeverity(99, 'cpu', lines)).toBeNull();
  });
});

describe('host metrics (section 6.1)', () => {
  const host = { load1: 1.25, swap: 12.5, disk_read: 4 * MB, disk_write: MB };

  it('keeps load and swap as reported and scales disk I/O into its own unit', () => {
    const [row] = toChartRows([point(0, { ...sample, ...host })], pickRateUnit(2 * MB), pickRateUnit(4 * MB));
    expect(row).toMatchObject({ load1: 1.25, swap: 12.5, disk_read: 4, disk_write: 1, net_in: 2 });
  });

  it('reads keys an older backend leaves out as null, never 0', () => {
    const legacy = { t: new Date(START).toISOString(), cpu: 5, mem: 6, disk: 7, net_in: 0, net_out: 0 } as unknown as SeriesPoint;
    expect(toChartRows([legacy], pickRateUnit(0))[0]).toMatchObject({ cpu: 5, load1: null, swap: null, disk_read: null, disk_write: null });
  });

  it('finds the busiest disk rate apart from the network one', () => {
    const series = {
      points: [point(0, { net_in: 900 * MB, disk_read: 3 * MB, disk_write: 7 * MB })],
      stats: { disk_read: { min: 0, avg: 1, max: 9 * MB, now: 1 } },
    };
    expect(maxDiskRate(series)).toBe(9 * MB);
  });

  it('formats load with two decimals and limits without trailing zeros', () => {
    expect(formatValue(0.5, 'number')).toBe('0.50');
    expect(formatValue(null, 'number')).toBe(EMPTY_VALUE);
    expect(formatLoadLimit(4)).toBe('4');
    expect(formatLoadLimit(0.75)).toBe('0.75');
  });

  it('keeps the busiest load, the core count and load thresholds on the axis', () => {
    const rows = toChartRows([point(0, { load1: 2.2 }), point(1, { load1: 3.1 })], pickRateUnit(0));
    expect(loadAxisMax(rows, 0, [])).toBe(5);
    expect(loadAxisMax(rows, 8, [])).toBe(10);
    expect(loadAxisMax(rows, 2, [12])).toBe(20);
  });

  it('draws load with a neutral core-count reference, swap in percent and disk I/O as read and write', () => {
    const diskRate = pickRateUnit(4 * MB);
    const rows = toChartRows([point(0, { ...sample, ...host })], pickRateUnit(2 * MB), diskRate);
    const specs = buildChartSpecs({
      rows,
      rate: pickRateUnit(2 * MB),
      diskRate,
      thresholds: { load1: { warning: 6, critical: 12.5 }, swap: { warning: 50, critical: null } },
      latest: { cpu_cores: 8, mem_total: 0, disk_total: 0, swap_total: 2 * 1024 * MB },
    });
    // Each host metric sits beside the one it explains, so small multiples pair them.
    expect(specs.map((spec) => spec.key)).toEqual(['cpu', 'load', 'mem', 'swap', 'disk', 'disk_io', 'net']);
    expect(byKey(specs, 'load')).toMatchObject({
      kind: 'number',
      unitHint: '1 min average',
      max: 20,
      references: [{ value: 8, label: '8 cores' }],
      thresholds: [
        { severity: 'warning', value: 6, label: 'warn 6', field: 'load1' },
        { severity: 'critical', value: 12.5, label: 'crit 12.5', field: 'load1' },
      ],
    });
    expect(byKey(specs, 'swap')).toMatchObject({ unitHint: '% of 2.0 GB', thresholds: [{ label: 'warn 50%', field: 'swap' }] });
    expect(byKey(specs, 'disk_io')).toMatchObject({ kind: 'rate', unitHint: 'MB/s', max: 5, thresholds: [], references: [] });
    expect(byKey(specs, 'disk_io')?.series.map((series) => [series.field, series.label, series.tone])).toEqual([
      ['disk_read', 'Read', 'in'],
      ['disk_write', 'Write', 'out'],
    ]);
  });

  it('labels readout values and the 390 px header per kind', () => {
    const specs = buildChartSpecs({ rows: [], rate: pickRateUnit(MB), diskRate: pickRateUnit(2048), thresholds: {}, latest: null });
    expect(valueSuffix(byKey(specs, 'cpu')!)).toBe('%');
    expect(valueSuffix(byKey(specs, 'net')!)).toBe(' MB/s');
    expect(valueSuffix(byKey(specs, 'load')!)).toBe('');
    expect(compactUnitHint(byKey(specs, 'net')!)).toBe('MB/s in / out');
    expect(compactUnitHint(byKey(specs, 'disk_io')!)).toBe('KB/s read / write');
    expect(compactUnitHint(byKey(specs, 'load')!)).toBe('1 min average');
  });

  it('shows the 5 and 15 minute averages only when the agent sends both', () => {
    expect(loadAverages({ load5: 0.4, load15: 0.31 })).toBe('5 min 0.40 · 15 min 0.31');
    expect(loadAverages({ load5: 0.4, load15: 0.31 }, true)).toBe('5m 0.40 · 15m 0.31');
    expect(loadAverages({ load5: 0.4, load15: null })).toBeNull();
    expect(loadAverages(null)).toBeNull();
  });
});

describe('chart hide rule', () => {
  const partition = (points: SeriesPoint[]) => {
    const rows = toChartRows(points, pickRateUnit(MB));
    return partitionSpecs(buildChartSpecs({ rows, rate: pickRateUnit(MB), thresholds: {}, latest: null }), unreportedFields(rows));
  };
  const keys = (specs: readonly ChartSpec[]) => specs.map((spec) => spec.key);

  it('hides load, swap and disk I/O for an agent that never sends them', () => {
    const { shown, hidden } = partition([point(0, sample), point(1, sample)]);
    expect(keys(shown)).toEqual(['cpu', 'mem', 'disk', 'net']);
    expect(keys(hidden)).toEqual(['load', 'swap', 'disk_io']);
  });

  it('keeps a chart that has data anywhere in the range, e.g. after an agent upgrade', () => {
    const { shown, hidden } = partition([point(0, sample), point(1, { ...sample, load1: 0.3, swap: 1, disk_read: 2, disk_write: 10 })]);
    expect(keys(shown)).toEqual(['cpu', 'load', 'mem', 'swap', 'disk', 'disk_io', 'net']);
    expect(hidden).toEqual([]);
  });

  it('treats zero as reported, and keeps a two-series chart while either series has data', () => {
    const { shown } = partition([point(0, { ...sample, swap: 0, disk_write: 5 })]);
    expect(keys(shown)).toEqual(expect.arrayContaining(['swap', 'disk_io']));
    expect(keys(shown)).not.toContain('load');
    expect(isUnreportedSpec({ series: [{ field: 'disk_read', label: 'Read', tone: 'in', fillOpacity: 0 }] }, ['disk_read'])).toBe(true);
  });

  it('hides nothing while the range has no data at all (the empty state covers it)', () => {
    expect(partition([point(0, null)]).hidden).toEqual([]);
  });
});
