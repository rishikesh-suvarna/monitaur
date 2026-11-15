import { memo, useEffect, useId } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  useActiveTooltipDataPoints,
  XAxis,
  YAxis,
} from 'recharts';

import type { SeriesRange, Severity } from '../../api/types';
import { cn } from '../../lib/cn';
import { formatTimeOfDay } from '../../lib/format';

import {
  CHART_MARGIN_TOP,
  chartBoxHeight,
  formatTick,
  placeThresholdLabels,
  quarterTicks,
  timeTicks,
  X_AXIS_HEIGHT,
  type ChartRow,
  type ChartSpec,
  type LabelPlacement,
  type SeriesTone,
  type TimeSpan,
} from './chartData';
import type { HoverStore } from './hoverStore';

// Token colours as SVG paint (the design's var(--s-in) and friends).
const SERIES_COLOR: Record<SeriesTone, string> = { in: 'rgb(var(--s-in))', out: 'rgb(var(--s-out))' };
const STALE_COLOR = 'rgb(var(--off))';
const SEVERITY_COLOR: Record<Severity, string> = { warning: 'rgb(var(--warn))', critical: 'rgb(var(--crit))' };
const GRID_COLOR = 'rgb(var(--bd))';
const SURFACE_COLOR = 'rgb(var(--s1))';
const GAP_FILL = 'rgb(var(--s3))';
const CROSSHAIR = { stroke: 'rgb(var(--tx3))', strokeDasharray: '4 3', strokeWidth: 1 };
const MONO = '"Geist Mono", ui-monospace, monospace';
const AXIS_FONT_SIZE = 11;
const COMPACT_FONT_SIZE = 10;
const MUTED_INK = 'rgb(var(--tx3))';
const LABEL_INK = 'rgb(var(--tx2))';
// Reference lines (the core count) are context, not rules: neutral ink and a dotted dash, never a status colour.
const REFERENCE_COLOR = MUTED_INK;
const REFERENCE_DASH = '2 3';

const Y_AXIS_WIDTH = 36;
const TICK_COUNT = 6;
const COMPACT_TICK_COUNT = 3;
const LINE_WIDTH = 1.6;
const THRESHOLD_WIDTH = 1.25;
const ACTIVE_DOT_RADIUS = 4;
const STALE_AREA_OPACITY = 0.06;
const HATCH_SIZE = 8;
const LABEL_OFFSET = 4;
/** The "no heartbeat since" note needs this much hatched width to fit. */
const OFFLINE_NOTE_MIN_WIDTH = 170;
/** Paint a surface-coloured halo behind labels so they stay legible over lines (the design's label background). */
const LABEL_HALO = { stroke: SURFACE_COLOR, strokeWidth: 4, paintOrder: 'stroke', strokeLinejoin: 'round' } as const;

interface ViewBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface LabelRenderProps {
  viewBox?: ViewBox;
}

interface TickRenderProps {
  x?: number;
  y?: number;
  payload?: { value?: number; index?: number };
}

/** Writes the hovered row to the shared store; works for mouse, touch, keyboard and synced charts alike. */
function HoverSync({ store }: { store: HoverStore<ChartRow> }) {
  const points = useActiveTooltipDataPoints<ChartRow>();
  const row = points?.[0] ?? null;
  useEffect(() => {
    store.set(row);
  }, [row, store]);
  return null;
}

const renderNothing = (): null => null;

export interface MetricChartProps {
  spec: ChartSpec;
  rows: readonly ChartRow[];
  range: SeriesRange;
  /** [from, to] of the response, ms epoch. */
  domain: readonly [number, number];
  gaps: readonly TimeSpan[];
  /** Agent offline since (ms epoch): hatch from here to the end of the range. */
  offlineSince: number | null;
  /** Show the "no heartbeat since" note on this chart (the first one only). */
  offlineLabel: boolean;
  syncId: string;
  /** Plot height in px, without the time axis. */
  height: number;
  /** 390 px layout: no y axis, three time labels. */
  compact: boolean;
  hover: HoverStore<ChartRow>;
  /** Accessible summary, e.g. "CPU over the last 6 hours, now 41.6%". */
  label: string;
}

/**
 * One metric chart (ServerDetail.dc.html): area series, dashed warning and
 * critical lines, gaps drawn as breaks with a shaded band, and the shared
 * crosshair through syncId. Animations are off: data refreshes every few
 * seconds and should not slide around.
 */
export const MetricChart = memo(function MetricChart({
  spec,
  rows,
  range,
  domain,
  gaps,
  offlineSince,
  offlineLabel,
  syncId,
  height,
  compact,
  hover,
  label,
}: MetricChartProps) {
  const hatchId = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [from, to] = domain;
  const stale = offlineSince !== null;
  const ticks = timeTicks(from, to, compact ? COMPACT_TICK_COUNT : TICK_COUNT);
  const yTicks = quarterTicks(spec.max);
  const fontSize = compact ? COMPACT_FONT_SIZE : AXIS_FONT_SIZE;
  const hatchFrom = offlineSince === null ? null : Math.min(to, Math.max(from, offlineSince));

  const renderTick = ({ x = 0, y = 0, payload }: TickRenderProps) => {
    const index = payload?.index ?? 0;
    const anchor = index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle';
    return (
      <text x={x} y={y + LABEL_OFFSET} dy="0.71em" textAnchor={anchor} fill={MUTED_INK} fontSize={fontSize} fontFamily={MONO}>
        {payload?.value === undefined ? '' : formatTick(payload.value, range, index === 0)}
      </text>
    );
  };

  // Lines a few pixels apart (warn 80 / crit 95 on a short chart) or at the very top would print
  // their labels over each other or off the chart; place each above or below its line.
  const placements = placeThresholdLabels(
    spec.thresholds.map((line) => line.value),
    { max: spec.max, top: CHART_MARGIN_TOP, height, labelHeight: fontSize, gap: LABEL_OFFSET },
  );

  const thresholdLabel =
    (text: string, color: string, placement: LabelPlacement | undefined) =>
    ({ viewBox }: LabelRenderProps) => {
      const x = viewBox?.x ?? 0;
      const y = viewBox?.y ?? 0;
      const width = viewBox?.width ?? 0;
      const under = placement === 'below';
      return (
        <text
          x={compact ? x + 2 : x + width - LABEL_OFFSET}
          y={under ? y + LABEL_OFFSET : y - LABEL_OFFSET}
          dy={under ? '0.71em' : undefined}
          textAnchor={compact ? 'start' : 'end'}
          fill={color}
          fontSize={fontSize}
          fontWeight={600}
          fontFamily={MONO}
          {...LABEL_HALO}
        >
          {text}
        </text>
      );
    };

  // Opposite the threshold labels (left on desktop, right at 390 px) so the two never collide.
  const referenceLabel =
    (text: string) =>
    ({ viewBox }: LabelRenderProps) => {
      const x = viewBox?.x ?? 0;
      const y = viewBox?.y ?? 0;
      const width = viewBox?.width ?? 0;
      return (
        <text
          x={compact ? x + width - LABEL_OFFSET : x + LABEL_OFFSET}
          y={y - LABEL_OFFSET}
          textAnchor={compact ? 'end' : 'start'}
          fill={LABEL_INK}
          fontSize={fontSize}
          fontFamily={MONO}
          {...LABEL_HALO}
        >
          {text}
        </text>
      );
    };

  const gapLabel = ({ viewBox }: LabelRenderProps) => (
    <text
      x={(viewBox?.x ?? 0) + (viewBox?.width ?? 0) / 2}
      y={(viewBox?.y ?? 0) + LABEL_OFFSET}
      dy="0.71em"
      textAnchor="middle"
      fill={LABEL_INK}
      fontSize={COMPACT_FONT_SIZE}
      fontFamily={MONO}
    >
      gap
    </text>
  );

  // Inside the hatched span (no data there, so nothing to collide with but the dashed thresholds),
  // vertically centred; skipped when the span is too narrow, the offline banner says it anyway.
  const offlineNote = ({ viewBox }: LabelRenderProps) => {
    const width = viewBox?.width ?? 0;
    if (hatchFrom === null || width < OFFLINE_NOTE_MIN_WIDTH) return <g />;
    return (
      <text
        x={(viewBox?.x ?? 0) + LABEL_OFFSET + 2}
        y={(viewBox?.y ?? 0) + (viewBox?.height ?? 0) / 2}
        dy="0.35em"
        fill={LABEL_INK}
        fontSize={fontSize}
        fontFamily={MONO}
        {...LABEL_HALO}
      >
        no heartbeat since {formatTimeOfDay(hatchFrom)}
      </text>
    );
  };

  return (
    <div style={{ height: chartBoxHeight(height) }} className={cn('min-w-0', stale && 'opacity-90')}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows as ChartRow[]}
          syncId={syncId}
          margin={{ top: CHART_MARGIN_TOP, right: 0, bottom: 0, left: 0 }}
          title={label}
          className="focus-visible:outline-none"
        >
          <defs>
            <pattern id={hatchId} width={HATCH_SIZE} height={HATCH_SIZE} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="2" height={HATCH_SIZE} fill={STALE_COLOR} fillOpacity={0.25} />
            </pattern>
          </defs>
          <CartesianGrid
            vertical={false}
            stroke={GRID_COLOR}
            horizontalValues={compact ? [spec.max / 2] : yTicks.slice(1, -1)}
          />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={[from, to]}
            ticks={ticks}
            interval={0}
            tick={renderTick}
            axisLine={false}
            tickLine={false}
            height={X_AXIS_HEIGHT}
            allowDataOverflow
          />
          <YAxis
            domain={[0, spec.max]}
            ticks={yTicks}
            interval={0}
            hide={compact}
            width={Y_AXIS_WIDTH}
            axisLine={false}
            tickLine={false}
            tick={{ fill: MUTED_INK, fontSize, fontFamily: MONO }}
            tickFormatter={(value: number, index: number) => (index % 2 === 0 ? String(Math.round(value * 10) / 10) : '')}
            allowDataOverflow
          />
          <Tooltip content={renderNothing} cursor={CROSSHAIR} isAnimationActive={false} />
          {gaps.map((gap) => (
            <ReferenceArea key={`${gap.from}-${gap.to}`} x1={gap.from} x2={gap.to} fill={GAP_FILL} fillOpacity={1} ifOverflow="hidden" label={gapLabel} />
          ))}
          {hatchFrom !== null && hatchFrom < to && (
            <ReferenceArea
              x1={hatchFrom}
              x2={to}
              fill={`url(#${hatchId})`}
              fillOpacity={1}
              ifOverflow="hidden"
              {...(offlineLabel ? { label: offlineNote } : {})}
            />
          )}
          {hatchFrom !== null && (
            <ReferenceLine x={hatchFrom} stroke={STALE_COLOR} strokeDasharray="4 3" ifOverflow="hidden" />
          )}
          {spec.series.map((series) => {
            const color = stale ? STALE_COLOR : SERIES_COLOR[series.tone];
            return (
              <Area
                key={series.field}
                type="linear"
                dataKey={series.field}
                name={series.label}
                stroke={color}
                strokeWidth={LINE_WIDTH}
                strokeLinejoin="round"
                fill={color}
                fillOpacity={stale ? STALE_AREA_OPACITY : series.fillOpacity}
                connectNulls={false}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: ACTIVE_DOT_RADIUS, fill: SURFACE_COLOR, stroke: color, strokeWidth: 2 }}
              />
            );
          })}
          {spec.references.map((line) => (
            <ReferenceLine
              key={`reference-${line.value}`}
              y={line.value}
              stroke={REFERENCE_COLOR}
              strokeWidth={1}
              strokeDasharray={REFERENCE_DASH}
              ifOverflow="hidden"
              label={referenceLabel(line.label)}
            />
          ))}
          {spec.thresholds.map((line, index) => (
            <ReferenceLine
              key={`${line.field}-${line.severity}`}
              y={line.value}
              stroke={SEVERITY_COLOR[line.severity]}
              strokeWidth={THRESHOLD_WIDTH}
              strokeDasharray="6 4"
              ifOverflow="hidden"
              label={thresholdLabel(line.label, SEVERITY_COLOR[line.severity], placements[index])}
            />
          ))}
          <HoverSync store={hover} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
});
