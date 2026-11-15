import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { SeriesRange, SeriesResponse, ServerSummary } from '../../api/types';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { MetricCard } from '../../components/MetricCard';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Skeleton } from '../../components/Skeletons';
import { TimeRangePicker } from '../../components/TimeRangePicker';
import { useServerSeries } from '../../hooks/api/servers';
import { useStoredState } from '../../hooks/useStoredState';
import { cn } from '../../lib/cn';
import { EMPTY_VALUE, toTime } from '../../lib/format';
import { oneOf, STORAGE_KEYS } from '../../lib/storage';

import { AlertHistory } from './AlertHistory';
import {
  buildChartSpecs,
  compactUnitHint,
  findGaps,
  formatGap,
  formatHoverTime,
  formatValue,
  latestRowIndex,
  loadAverages,
  maxDiskRate,
  maxRate,
  partitionSpecs,
  pickRateUnit,
  rangeNote,
  toChartRows,
  unreportedFields,
  valueSeverity,
  valueSuffix,
  type ChartRow,
  type ChartSpec,
  type TimeSpan,
} from './chartData';
import { hasEntries } from './hostModel';
import { FilesystemsCard, InterfacesCard } from './HostTables';
import { createHoverStore, useHoverValue, type HoverStore } from './hoverStore';
import { MetricChart } from './MetricChart';
import { OfflineBanner } from './OfflineBanner';
import { agentVersionLabel, DEFAULT_RANGE, parseRange, RANGE_PARAM } from './routes';
import { buildStatCards } from './statCards';

const LAYOUTS = ['stack', 'grid'] as const;
type ChartLayout = (typeof LAYOUTS)[number];

const STACK_HEIGHT = 132;
const GRID_HEIGHT = 150;
const MOBILE_HEIGHT = 110;
/** Empty newest steps up to this many are the bucket in progress, not a gap. */
const TRAILING_GAP_MIN_STEPS = 3;
const GAPS_IN_NOTE = 2;
const SKELETON_CHARTS = 4;

const SWATCH: Record<'in' | 'out', string> = { in: 'bg-series-1', out: 'bg-series-2' };
const SEVERITY_TEXT = { critical: 'text-crit', warning: 'text-warn' } as const;

interface ChartModel {
  rows: ChartRow[];
  /** Charts to draw. */
  specs: ChartSpec[];
  /** Charts the agent does not report in this range, folded into one note. */
  hidden: ChartSpec[];
  domain: readonly [number, number];
  gaps: TimeSpan[];
  empty: boolean;
  range: SeriesRange;
}

function buildModel(data: SeriesResponse, server: ServerSummary, offline: boolean): ChartModel {
  const rate = pickRateUnit(maxRate(data));
  const diskRate = pickRateUnit(maxDiskRate(data));
  const rows = toChartRows(data.points, rate, diskRate);
  const from = toTime(data.from) ?? rows[0]?.ts ?? 0;
  const to = toTime(data.to) ?? rows[rows.length - 1]?.ts ?? from;
  const report = findGaps(rows, to);
  const gaps = [...report.gaps];
  // An online server with a run of empty newest steps has a real gap at the end; offline, the hatch shows it instead.
  if (!offline && report.trailing && report.trailingSteps >= TRAILING_GAP_MIN_STEPS) gaps.push(report.trailing);
  const { shown, hidden } = partitionSpecs(
    buildChartSpecs({ rows, rate, diskRate, thresholds: data.thresholds, latest: server.latest }),
    unreportedFields(rows),
  );
  return { rows, specs: shown, hidden, domain: [from, to], gaps, empty: report.empty, range: data.range };
}

function gapNote(gaps: readonly TimeSpan[], range: SeriesRange): string | null {
  if (gaps.length === 0) return null;
  const shown = gaps.slice(-GAPS_IN_NOTE).map((gap) => formatGap(gap, range));
  const more = gaps.length > GAPS_IN_NOTE ? ` and ${gaps.length - GAPS_IN_NOTE} more` : '';
  return `No data ${shown.join(', ')}${more} · lines break; we never interpolate across a gap.`;
}

/** The desktop readout over the charts: the crosshair time and every series' value there. */
function Readout({ model, hover }: { model: ChartModel; hover: HoverStore<ChartRow> }) {
  const hovered = useHoverValue(hover);
  const row = hovered ?? model.rows[latestRowIndex(model.rows) ?? -1] ?? null;
  const items = model.specs.flatMap((spec) =>
    spec.series.map((series) => {
      const value = row ? row[series.field] : null;
      const severity = valueSeverity(value, series.field, spec.thresholds);
      return {
        key: series.field,
        label: series.label,
        tone: series.tone,
        text: value === null ? EMPTY_VALUE : `${formatValue(value, spec.kind)}${valueSuffix(spec)}`,
        severity,
      };
    }),
  );
  return (
    <div aria-live="off" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-surface-2 px-4 py-2.5 text-[12px]">
      <span className="num font-semibold text-ink">{row ? formatHoverTime(row.ts, model.range) : EMPTY_VALUE}</span>
      {items.map((item) => (
        <span key={item.key} className="inline-flex items-center gap-1.5 text-ink-muted">
          <span aria-hidden="true" className={cn('h-0.5 w-2.5', SWATCH[item.tone])} />
          {item.label}{' '}
          <span className={cn('num font-medium', item.severity ? SEVERITY_TEXT[item.severity] : 'text-ink')}>{item.text}</span>
        </span>
      ))}
      <span className="flex-1" />
      <span className="text-[12px] text-ink-faint">Hover any chart; the crosshair is shared</span>
    </div>
  );
}

/** The 390 px chart header value: the scrubbed point while touching, else the latest. */
function HeaderValue({ spec, model, hover }: { spec: ChartSpec; model: ChartModel; hover: HoverStore<ChartRow> }) {
  const hovered = useHoverValue(hover);
  const row = hovered ?? model.rows[latestRowIndex(model.rows) ?? -1] ?? null;
  const values = spec.series.map((series) => (row ? row[series.field] : null));
  const severity = spec.series.reduce<'critical' | 'warning' | null>((worst, series, index) => {
    const next = valueSeverity(values[index] ?? null, series.field, spec.thresholds);
    return worst === 'critical' || next === null ? worst : next;
  }, null);
  const text = values.map((value) => formatValue(value, spec.kind)).join(' / ') + (spec.kind === 'percent' ? '%' : '');
  return <span className={cn('num text-[12px] font-semibold', severity ? SEVERITY_TEXT[severity] : 'text-ink')}>{text}</span>;
}

/** One line for every chart the agent does not send, instead of empty charts. */
function NotReported({ specs, agentVersion, className }: { specs: readonly ChartSpec[]; agentVersion: string; className?: string }) {
  if (specs.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded border border-dashed border-line-strong px-3 py-2.5 text-[13px]', className)}>
      <span className="cap flex-none">{specs.map((spec) => spec.title).join(' · ')}</span>
      <span className="min-w-0 flex-1 text-ink-muted">
        Not reported by agent {agentVersionLabel(agentVersion)}. Re-run the install command to update it.
      </span>
    </div>
  );
}

function Legend({ spec }: { spec: ChartSpec }) {
  if (spec.series.length < 2) return null;
  return (
    <>
      {spec.series.map((series) => (
        <span key={series.field} className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
          <span aria-hidden="true" className={cn('h-0.5 w-3', SWATCH[series.tone])} />
          {series.label.toLowerCase()}
        </span>
      ))}
    </>
  );
}

/** Beside a chart title: the legend, or for load the live 5 and 15 min averages. */
function ChartAside({ spec, server }: { spec: ChartSpec; server: ServerSummary }) {
  if (spec.key === 'load') {
    const averages = loadAverages(server.latest);
    return averages === null ? null : <span className="num text-[12px] text-ink-muted">{averages}</span>;
  }
  return <Legend spec={spec} />;
}

interface ChartsProps {
  model: ChartModel;
  server: ServerSummary;
  layout: ChartLayout;
  desktop: boolean;
  hover: HoverStore<ChartRow>;
  rangeLabel: string;
}

function chartLabel(spec: ChartSpec, rangeLabel: string): string {
  const lines = [...spec.thresholds.map((line) => line.label), ...spec.references.map((line) => `a ${line.label} reference`)];
  return `${spec.title} over the ${rangeLabel}${lines.length > 0 ? `, with ${lines.join(' and ')} lines` : ''}`;
}

function Charts({ model, server, layout, desktop, hover, rangeLabel }: ChartsProps) {
  const offline = server.status === 'offline';
  const offlineSince = offline ? (toTime(server.last_seen) ?? model.domain[0]) : null;
  const syncId = `server-${server.id}`;
  const height = !desktop ? MOBILE_HEIGHT : layout === 'grid' ? GRID_HEIGHT : STACK_HEIGHT;
  const grid = layout === 'grid';

  const chart = (spec: ChartSpec, index: number) => (
    <MetricChart
      spec={spec}
      rows={model.rows}
      range={model.range}
      domain={model.domain}
      gaps={model.gaps}
      offlineSince={offlineSince}
      offlineLabel={index === 0}
      syncId={syncId}
      height={height}
      compact={!desktop}
      hover={hover}
      label={chartLabel(spec, rangeLabel)}
    />
  );

  if (!desktop) {
    return (
      <>
        {model.specs.map((spec, index) => (
          <Card as="section" key={spec.key} aria-label={spec.title} className="flex flex-col gap-1.5 px-3 pb-2 pt-3">
            <div className="flex items-baseline gap-2">
              <h2 className="m-0 text-[13px] font-semibold">{spec.title}</h2>
              <span className="text-[12px] text-ink-faint">{compactUnitHint(spec)}</span>
              <span className="flex-1" />
              <HeaderValue spec={spec} model={model} hover={hover} />
            </div>
            {chart(spec, index)}
          </Card>
        ))}
        <NotReported specs={model.hidden} agentVersion={server.agent_version} />
        {model.specs.length > 1 && <span className="text-center text-[12px] text-ink-faint">Tap and drag a chart to scrub; the others follow.</span>}
      </>
    );
  }

  // Small multiples pair related charts; an odd one out spans the last row instead of leaving a hole.
  const oddLast = grid && model.specs.length % 2 === 1;
  return (
    <>
      <div className={cn('grid gap-px bg-line', grid ? 'grid-cols-2' : 'grid-cols-1')}>
        {model.specs.map((spec, index) => (
          <div
            key={spec.key}
            className={cn('flex min-w-0 flex-col gap-1.5 bg-surface-1 px-4 pb-2.5 pt-3.5', oddLast && index === model.specs.length - 1 && 'col-span-2')}
          >
            <div className="flex items-baseline gap-2">
              <h3 className="m-0 text-[13px] font-semibold">{spec.title}</h3>
              <span className="text-[12px] text-ink-faint">{spec.unitHint}</span>
              <span className="flex-1" />
              <ChartAside spec={spec} server={server} />
            </div>
            {chart(spec, index)}
          </div>
        ))}
      </div>
      {model.hidden.length > 0 && (
        <div className="border-t border-line p-3">
          <NotReported specs={model.hidden} agentVersion={server.agent_version} />
        </div>
      )}
    </>
  );
}

function ChartsSkeleton({ desktop, layout }: { desktop: boolean; layout: ChartLayout }) {
  const height = !desktop ? MOBILE_HEIGHT : layout === 'grid' ? GRID_HEIGHT : STACK_HEIGHT;
  const cells = Array.from({ length: SKELETON_CHARTS }, (_, index) => (
    <div key={index} className="flex flex-col gap-2.5 bg-surface-1 px-4 pb-3 pt-3.5">
      <Skeleton className="h-3 w-20" />
      <Skeleton style={{ height }} />
    </div>
  ));
  return (
    <div aria-busy="true" aria-label="Loading charts" className={cn('grid gap-px bg-line', desktop && layout === 'grid' ? 'grid-cols-2' : 'grid-cols-1')}>
      {cells}
    </div>
  );
}

export interface MetricsTabProps {
  server: ServerSummary;
  desktop: boolean;
}

/**
 * The Metrics tab: range picker (live to 30 d), stacked or small-multiple
 * layout, the stat cards, the synced charts, the filesystems and interfaces
 * cards and the recent alert history.
 */
export function MetricsTab({ server, desktop }: MetricsTabProps) {
  const [params, setParams] = useSearchParams();
  const range = parseRange(params.get(RANGE_PARAM));
  const [layout, setLayout] = useStoredState<ChartLayout>(STORAGE_KEYS.serverChartLayout, 'stack', oneOf(LAYOUTS));
  const series = useServerSeries(server.id, range);
  const hover = useMemo(() => createHoverStore<ChartRow>(), []);
  const offline = server.status === 'offline';
  const latest = server.latest;

  const data = series.data;
  // Rebuilt only when the series (or the agent totals in its labels) change, not on every live tick.
  const totalsKey = `${latest?.cpu_cores ?? 0}:${latest?.mem_total ?? 0}:${latest?.disk_total ?? 0}:${latest?.swap_total ?? 0}`;
  const model = useMemo(
    () => (data ? buildModel(data, server, offline) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, offline, totalsKey],
  );
  const rate = pickRateUnit(data ? maxRate(data) : Math.max(latest?.net_in ?? 0, latest?.net_out ?? 0));
  const diskRate = pickRateUnit(data ? maxDiskRate(data) : Math.max(latest?.disk_read ?? 0, latest?.disk_write ?? 0));
  const cards = buildStatCards(server, data?.stats, rate, diskRate);
  const note = data ? rangeNote(data) : '';
  const rangeLabel = note === '' ? 'selected range' : note.split(' · ')[0] ?? 'selected range';
  const gapText = model ? gapNote(model.gaps, model.range) : null;

  const setRange = (next: SeriesRange): void => {
    setParams(
      (current) => {
        const out = new URLSearchParams(current);
        if (next === DEFAULT_RANGE) out.delete(RANGE_PARAM);
        else out.set(RANGE_PARAM, next);
        return out;
      },
      { replace: true },
    );
  };

  const widgetError =
    series.error !== null ? (
      <ErrorState
        variant="widget"
        error={series.error}
        title="Couldn’t load metrics history for this range."
        onRetry={() => void series.refetch()}
        retrying={series.isFetching}
        className={desktop && data ? 'm-3' : undefined}
      />
    ) : null;

  let charts;
  if (!model) {
    charts = series.isPending ? <ChartsSkeleton desktop={desktop} layout={layout} /> : <div className="p-3">{widgetError}</div>;
  } else if (model.empty) {
    charts = (
      <EmptyState
        variant="plain"
        mood={offline ? 'sleep' : 'waiting'}
        dinoSize={110}
        title={`No metrics in the ${rangeLabel}`}
        description={offline ? 'The agent hasn’t reported in this range.' : 'The agent reports every few seconds; data shows up here as it arrives.'}
      />
    );
  } else {
    charts = (
      <>
        {data && series.error !== null && widgetError}
        <Charts model={model} server={server} layout={layout} desktop={desktop} hover={hover} rangeLabel={rangeLabel} />
      </>
    );
  }

  const filesystems = <FilesystemsCard server={server} desktop={desktop} />;
  const interfaces = <InterfacesCard server={server} desktop={desktop} />;
  const hasMounts = hasEntries(latest?.mounts);
  const hasInterfaces = hasEntries(latest?.interfaces);

  return (
    <div className={cn('flex flex-col', desktop ? 'gap-5' : 'gap-3.5')}>
      {offline && <OfflineBanner server={server} />}

      <div className="flex flex-wrap items-center gap-3">
        <div className={desktop ? undefined : '-mx-4 overflow-x-auto px-4'}>
          <TimeRangePicker value={range} onChange={setRange} size={desktop ? 'md' : 'touch'} />
        </div>
        {desktop && <span className="num text-[12px] text-ink-faint">{note}</span>}
        {series.isPlaceholderData && <span className="text-[12px] text-ink-faint">Loading {range}…</span>}
        <span className="flex-1" />
        {desktop && (
          <SegmentedControl<ChartLayout>
            aria-label="Chart layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'stack', label: 'Stacked' },
              { value: 'grid', label: 'Small multiples' },
            ]}
          />
        )}
      </div>

      <div className={cn('grid gap-3', desktop ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 gap-2')}>
        {cards.map((card) => {
          const footnote = desktop ? card.detail : card.footnote;
          return (
            <MetricCard
              key={card.key}
              label={desktop ? card.label : card.shortLabel}
              value={card.value}
              unit={card.unit}
              {...(card.alert ? { alert: card.alert } : {})}
              {...(desktop && card.stats ? { stats: card.stats } : {})}
              statsVariant="chips"
              density={desktop ? 'default' : 'compact'}
              {...(footnote !== '' ? { footnote } : {})}
              stale={offline}
            />
          );
        })}
      </div>

      {desktop ? (
        <Card as="section" aria-label="Charts" className={cn('overflow-hidden', series.isPlaceholderData && 'opacity-70')}>
          {model && !model.empty && <Readout model={model} hover={hover} />}
          {charts}
          {gapText && <p className="num m-0 border-t border-line px-4 py-2.5 text-[12px] text-ink-muted">{gapText}</p>}
        </Card>
      ) : (
        <div className={cn('flex flex-col gap-3.5', series.isPlaceholderData && 'opacity-70')}>
          {model && !model.empty ? charts : <Card className="overflow-hidden">{charts}</Card>}
          {gapText && <p className="num m-0 text-[12px] text-ink-muted">{gapText}</p>}
        </div>
      )}

      {desktop && hasMounts && hasInterfaces ? (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {filesystems}
          {interfaces}
        </div>
      ) : (
        <>
          {filesystems}
          {interfaces}
        </>
      )}

      <AlertHistory serverId={server.id} mode="recent" compact={!desktop} />
    </div>
  );
}
