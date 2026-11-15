import type { ReactNode } from 'react';

import type { ServerStatus } from '../api/types';
import { cn } from '../lib/cn';

import { Chip } from './Chip';
import { Sparkline, type SparklineThreshold, type SparkTone } from './Sparkline';
import { StatusBadge } from './StatusBadge';
import { TickingNumber } from './TickingNumber';

export interface MetricCardStats {
  min: string;
  avg: string;
  max: string;
}

export interface MetricCardProps {
  /** Caption, e.g. "CPU", "Disk /", "Network in". */
  label: string;
  /** Formatted value without the unit, e.g. "94.2". */
  value: string;
  /** Unit shown at 60% ink, e.g. "%", "MB/s". */
  unit?: string;
  /** Badge beside the label when a rule is firing, e.g. { status: 'critical', text: '≥ 90%' }. */
  alert?: { status: ServerStatus; text: string };
  /** Sparkline values (30 points in the design). */
  values?: readonly (number | null)[];
  sparkMax?: number;
  sparkTone?: SparkTone;
  threshold?: SparklineThreshold;
  stats?: MetricCardStats;
  /** text: "min 12 avg 30 max 61" (Components.dc.html); chips: one chip each (ServerDetail.dc.html). */
  statsVariant?: 'text' | 'chips';
  /** compact: the 390 px card (ServerDetailMobile.dc.html), 22 px value and a one-line footnote. */
  density?: 'default' | 'compact';
  /** Free-form line under the value, e.g. "avg 41.8 · max 67.0" or "crit ≥ 90%". */
  footnote?: ReactNode;
  /** Stale data: greyed card with a dashed border and sparkline. */
  stale?: boolean;
  className?: string;
}

const VALUE_TONE: Partial<Record<ServerStatus, string>> = { critical: 'text-crit', warning: 'text-warn' };
const BORDER_TONE: Partial<Record<ServerStatus, string>> = { critical: 'border-crit', warning: 'border-warn' };

/**
 * Components.dc.html MetricCard + Sparkline: value in mono 28, unit muted, a
 * 40 px area sparkline and min/avg/max. A critical alert turns the border and
 * value red.
 */
export function MetricCard({
  label,
  value,
  unit,
  alert,
  values,
  sparkMax = 100,
  sparkTone = 'series',
  threshold,
  stats,
  statsVariant = 'text',
  density = 'default',
  footnote,
  stale = false,
  className,
}: MetricCardProps) {
  const tone = stale ? undefined : alert?.status;
  const compact = density === 'compact';
  const chips = statsVariant === 'chips';
  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-surface-1',
        compact ? 'gap-1 p-3' : values ? 'gap-2.5 p-4' : 'gap-1.5 px-4 py-3.5',
        (tone && BORDER_TONE[tone]) ?? 'border-line',
        stale && 'border-dashed opacity-[0.55]',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn('cap', compact && 'text-[11px]')}>{label}</span>
        {alert && !compact && <StatusBadge status={alert.status} size="sm" text={alert.text} />}
      </div>
      <div className="flex items-baseline gap-1">
        <TickingNumber
          value={value}
          className={cn(
            'font-medium tracking-[-0.02em]',
            compact ? 'text-[22px] leading-7' : 'text-metric',
            (tone && VALUE_TONE[tone]) ?? 'text-ink',
          )}
        />
        {unit && <span className={cn('num text-ink-faint', compact ? 'text-[11px]' : 'text-[13px]')}>{unit}</span>}
      </div>
      {values && (
        <Sparkline
          values={values}
          width={200}
          height={40}
          fluid
          max={sparkMax}
          area
          tone={stale ? 'off' : sparkTone}
          dashed={stale}
          {...(threshold ? { threshold } : {})}
        />
      )}
      {stats && chips && (
        <div className="num flex flex-wrap gap-1.5 text-[12px] text-ink-muted">
          <Chip className="num">min {stats.min}</Chip>
          <Chip className="num">avg {stats.avg}</Chip>
          <Chip className="num">max {stats.max}</Chip>
        </div>
      )}
      {stats && !chips && (
        <div className="num flex gap-3 text-[12px] text-ink-muted">
          <span>min {stats.min}</span>
          <span>avg {stats.avg}</span>
          <span>max {stats.max}</span>
        </div>
      )}
      {footnote && <div className={cn('num text-ink-faint', compact ? 'text-[11px]' : 'text-[12px]')}>{footnote}</div>}
    </div>
  );
}
