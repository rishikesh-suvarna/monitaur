import type { ServerStatus } from '../api/types';
import { cn } from '../lib/cn';

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
  /** Stale data: dashed, greyed sparkline. */
  stale?: boolean;
  className?: string;
}

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
  stale = false,
  className,
}: MetricCardProps) {
  const critical = alert?.status === 'critical';
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border bg-surface-1 p-4',
        critical ? 'border-crit' : 'border-line',
        stale && 'opacity-[0.55]',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="cap">{label}</span>
        {alert && <StatusBadge status={alert.status} size="sm" text={alert.text} />}
      </div>
      <div className="flex items-baseline gap-1">
        <TickingNumber value={value} className={cn('text-metric font-medium tracking-[-0.02em]', critical ? 'text-crit' : 'text-ink')} />
        {unit && <span className="num text-[13px] text-ink-faint">{unit}</span>}
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
      {stats && (
        <div className="num flex gap-3 text-[12px] text-ink-muted">
          <span>min {stats.min}</span>
          <span>avg {stats.avg}</span>
          <span>max {stats.max}</span>
        </div>
      )}
    </div>
  );
}
