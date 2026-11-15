import { useId, useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { CheckResultsRange } from '../../api/types';
import { ErrorState } from '../../components/ErrorState';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Skeleton } from '../../components/Skeletons';
import { useCheckResults } from '../../hooks/api/checks';
import { cn } from '../../lib/cn';
import { formatLatency } from '../../lib/checks';
import { EMPTY_VALUE } from '../../lib/format';
import { formatHoverTime, formatTick, timeTicks } from '../server-detail/chartData';
import { formatUptime } from '../status/statusModel';

import {
  failingStepsLabel,
  latencyAxisMax,
  RESULTS_RANGE_LABELS,
  RESULTS_RANGES,
  resultRows,
  stepRows,
  summarizeResults,
  type ResultRow,
} from './checkModel';

// Token colours as SVG paint; data series are never status-coloured.
const UP_COLOR = 'rgb(var(--s-in))';
const AVG_COLOR = 'rgb(var(--s-in))';
const MAX_COLOR = 'rgb(var(--s-out))';
const GRID_COLOR = 'rgb(var(--bd))';
const MUTED_INK = 'rgb(var(--tx3))';
const CROSSHAIR = { stroke: 'rgb(var(--tx3))', strokeDasharray: '4 3', strokeWidth: 1 };
const MONO = '"Geist Mono", ui-monospace, monospace';
const AXIS_FONT_SIZE = 11;
const COMPACT_FONT_SIZE = 10;
const Y_AXIS_WIDTH = 56;
const X_AXIS_HEIGHT = 20;
const TICK_COUNT = 6;
const COMPACT_TICK_COUNT = 3;
const LINE_WIDTH = 1.6;
const MAX_LINE_WIDTH = 1.25;
const UP_FILL_OPACITY = 0.16;
const AVG_FILL_OPACITY = 0.12;
const PERCENT_MAX = 100;
const UP_HEIGHT = 96;
const LATENCY_HEIGHT = 168;
const COMPACT_LATENCY_HEIGHT = 140;
const LABEL_OFFSET = 4;

interface TickRenderProps {
  x?: number;
  y?: number;
  payload?: { value?: number; index?: number };
}

interface ReadoutProps {
  active?: boolean;
  payload?: readonly { payload?: ResultRow }[];
  range: CheckResultsRange;
}

/** The hover readout: time, up share, average and slowest latency of the step. */
function Readout({ active, payload, range }: ReadoutProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="num flex flex-col gap-0.5 rounded border border-line-strong bg-surface-1 px-2.5 py-2 text-[12px] shadow-float">
      <span className="text-ink-faint">{formatHoverTime(row.start, range)}</span>
      <span>
        up <span className="text-ink">{row.up === null ? EMPTY_VALUE : formatUptime(row.up)}</span>
      </span>
      <span>
        avg <span className="text-ink">{formatLatency(row.avg)}</span> · max <span className="text-ink">{formatLatency(row.max)}</span>
      </span>
    </div>
  );
}

const renderNothing = (): null => null;

export interface CheckResultsChartProps {
  checkId: number;
  range: CheckResultsRange;
  onRange: (range: CheckResultsRange) => void;
  compact: boolean;
}

/**
 * Results over 24 h, 7 d or 30 d: the share of successful results per step
 * and the latency (average area, slowest step as a line), with a shared
 * crosshair. Gaps stay gaps.
 */
export function CheckResultsChart({ checkId, range, onRange, compact }: CheckResultsChartProps) {
  const results = useCheckResults(checkId, range);
  const syncId = `check-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const rows = useMemo(() => resultRows(results.data?.points ?? []), [results.data]);
  const summary = useMemo(() => summarizeResults(rows), [rows]);
  const failing = results.data ? failingStepsLabel(summary, results.data.step_seconds) : null;
  const latencyMax = latencyAxisMax(rows);
  const hasData = rows.some((row) => row.up !== null);
  const chartRows = useMemo(() => stepRows(rows, results.data?.step_seconds ?? 0), [rows, results.data]);
  const first = chartRows[0]?.ts ?? 0;
  const last = chartRows[chartRows.length - 1]?.ts ?? 0;
  const ticks = timeTicks(first, last, compact ? COMPACT_TICK_COUNT : TICK_COUNT);
  const fontSize = compact ? COMPACT_FONT_SIZE : AXIS_FONT_SIZE;

  const renderTick = ({ x = 0, y = 0, payload }: TickRenderProps) => {
    const index = payload?.index ?? 0;
    const anchor = index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle';
    return (
      <text x={x} y={y + LABEL_OFFSET} dy="0.71em" textAnchor={anchor} fill={MUTED_INK} fontSize={fontSize} fontFamily={MONO}>
        {payload?.value === undefined ? '' : formatTick(payload.value, range, index === 0)}
      </text>
    );
  };

  const xAxis = (hide: boolean) => (
    <XAxis
      dataKey="ts"
      type="number"
      scale="time"
      domain={[first, last]}
      ticks={ticks}
      interval={0}
      tick={hide ? false : renderTick}
      axisLine={false}
      tickLine={false}
      height={hide ? 0 : X_AXIS_HEIGHT}
      hide={hide}
    />
  );

  const summaryLine = hasData
    ? `Up ${formatUptime(summary.upPct)} · avg ${formatLatency(summary.avgMs)} · slowest ${formatLatency(summary.maxMs)}${
        failing ? ` · ${failing}` : ''
      }`
    : null;

  let body;
  if (results.isPending) {
    body = (
      <div aria-busy="true" aria-label="Loading results" className="flex flex-col gap-3">
        <Skeleton className="h-[96px] w-full" />
        <Skeleton className="h-[168px] w-full" />
      </div>
    );
  } else if (results.isError && !results.data) {
    body = (
      <ErrorState
        variant="widget"
        error={results.error}
        title="Couldn’t load results for this range."
        onRetry={() => void results.refetch()}
        retrying={results.isFetching}
      />
    );
  } else if (!hasData) {
    body = <p className="m-0 py-10 text-center text-[13px] text-ink-muted">No results in this range yet. The first ones land after one interval.</p>;
  } else {
    body = (
      <div className={cn('flex flex-col gap-3', results.isPlaceholderData && 'opacity-60')}>
        <figure className="m-0 flex flex-col gap-1">
          <figcaption className="cap">Up</figcaption>
          <div style={{ height: UP_HEIGHT }} role="img" aria-label={`Share of successful results per step, ${formatUptime(summary.upPct)} overall`}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} syncId={syncId} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID_COLOR} horizontalValues={[PERCENT_MAX / 2]} />
                {xAxis(true)}
                <YAxis
                  domain={[0, PERCENT_MAX]}
                  ticks={[0, PERCENT_MAX]}
                  hide={compact}
                  width={Y_AXIS_WIDTH}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: MUTED_INK, fontSize, fontFamily: MONO }}
                  tickFormatter={(value: number) => `${value}%`}
                />
                <Tooltip content={renderNothing} cursor={CROSSHAIR} isAnimationActive={false} />
                <Area
                  type="stepAfter"
                  dataKey="up"
                  name="Up"
                  stroke={UP_COLOR}
                  strokeWidth={LINE_WIDTH}
                  fill={UP_COLOR}
                  fillOpacity={UP_FILL_OPACITY}
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </figure>
        <figure className="m-0 flex flex-col gap-1">
          <figcaption className="flex items-center gap-3">
            <span className="cap">Latency</span>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
              <span aria-hidden="true" className="h-0.5 w-3 rounded bg-series-1" />
              average
            </span>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
              <span aria-hidden="true" className="h-0.5 w-3 rounded bg-series-2" />
              slowest
            </span>
          </figcaption>
          <div
            style={{ height: compact ? COMPACT_LATENCY_HEIGHT : LATENCY_HEIGHT }}
            role="img"
            aria-label={`Latency per step: average ${formatLatency(summary.avgMs)}, slowest ${formatLatency(summary.maxMs)}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} syncId={syncId} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID_COLOR} horizontalValues={[latencyMax / 2]} />
                {xAxis(false)}
                <YAxis
                  domain={[0, latencyMax]}
                  ticks={[0, latencyMax / 2, latencyMax]}
                  hide={compact}
                  width={Y_AXIS_WIDTH}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: MUTED_INK, fontSize, fontFamily: MONO }}
                  tickFormatter={(value: number) => formatLatency(value)}
                />
                <Tooltip content={<Readout range={range} />} cursor={CROSSHAIR} isAnimationActive={false} />
                <Area
                  type="linear"
                  dataKey="avg"
                  name="Average"
                  stroke={AVG_COLOR}
                  strokeWidth={LINE_WIDTH}
                  fill={AVG_COLOR}
                  fillOpacity={AVG_FILL_OPACITY}
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={false}
                />
                <Line
                  type="linear"
                  dataKey="max"
                  name="Slowest"
                  stroke={MAX_COLOR}
                  strokeWidth={MAX_LINE_WIDTH}
                  strokeDasharray="4 3"
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </figure>
      </div>
    );
  }

  return (
    <section aria-labelledby="check-results-heading" className="flex flex-col gap-3 rounded-lg border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id="check-results-heading" className="m-0 text-h3 font-semibold">
            Results
          </h2>
          {summaryLine && <span className="num text-[12px] text-ink-muted">{summaryLine}</span>}
        </div>
        <SegmentedControl<CheckResultsRange>
          aria-label="Results range"
          value={range}
          onChange={onRange}
          size={compact ? 'touch' : 'md'}
          options={RESULTS_RANGES.map((value) => ({ value, label: RESULTS_RANGE_LABELS[value] }))}
        />
      </div>
      {body}
    </section>
  );
}
