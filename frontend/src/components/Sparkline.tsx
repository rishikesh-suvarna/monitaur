import { useLayoutEffect, useRef, useState } from 'react';

import { cn } from '../lib/cn';
import { isOneStepShift, sparkAreaPath, sparkLinePath } from '../lib/sparkline';
import { useReducedMotion } from '../providers/MotionProvider';

/** Tokens.dc.html: sparklines shift left 600 ms linear as a point lands. */
export const SPARK_SHIFT_MS = 600;
const AREA_OPACITY = 0.14;

/**
 * Line colours. Series colours for data; warn/crit only when the value is over
 * a threshold (a red line always means a threshold); off for stale data.
 */
export type SparkTone = 'series' | 'series-2' | 'warn' | 'crit' | 'off';

const TONE_COLOR: Record<SparkTone, string> = {
  series: 'rgb(var(--s-in))',
  'series-2': 'rgb(var(--s-out))',
  warn: 'rgb(var(--warn))',
  crit: 'rgb(var(--crit))',
  off: 'rgb(var(--off))',
};

export interface SparklineThreshold {
  value: number;
  tone: 'warn' | 'crit';
}

export interface SparklineProps {
  values: readonly (number | null)[];
  /** viewBox width; also the rendered width unless `fluid`. */
  width?: number;
  height?: number;
  /** Stretch to the container width (preserveAspectRatio none). */
  fluid?: boolean;
  min?: number;
  /** Top of the scale; defaults to 100 (percent metrics). */
  max?: number;
  tone?: SparkTone;
  area?: boolean;
  /** Dashed line for stale (offline) data. */
  dashed?: boolean;
  threshold?: SparklineThreshold;
  /** Accessible description; omitted means decorative (aria-hidden). */
  label?: string;
  className?: string;
}

interface ShiftState {
  values: readonly (number | null)[];
  /** The point that just scrolled off the left edge, drawn at x = -step. */
  lead: number | null;
  shift: number;
}

/**
 * SVG sparkline. When the series advances by one bucket it slides left by
 * one step instead of redrawing; with reduced motion it redraws in place.
 */
export function Sparkline({
  values,
  width = 64,
  height = 20,
  fluid = false,
  min = 0,
  max = 100,
  tone = 'series',
  area = false,
  dashed = false,
  threshold,
  label,
  className,
}: SparklineProps) {
  const reduced = useReducedMotion();
  const group = useRef<SVGGElement>(null);
  const [state, setState] = useState<ShiftState>({ values, lead: null, shift: 0 });

  // Derive the shift from the previous values during render (no extra paint).
  if (state.values !== values) {
    const shifted = !reduced && isOneStepShift(state.values, values);
    setState({ values, lead: shifted ? (state.values[0] ?? null) : null, shift: shifted ? state.shift + 1 : state.shift });
  }

  const step = values.length > 1 ? width / (values.length - 1) : 0;

  useLayoutEffect(() => {
    const node = group.current;
    if (!node || state.shift === 0 || reduced) return;
    node.style.transition = 'none';
    node.style.transform = `translateX(${step}px)`;
    // Commit the start position before transitioning back to 0.
    node.getBoundingClientRect();
    node.style.transition = `transform ${SPARK_SHIFT_MS}ms linear`;
    node.style.transform = 'translateX(0px)';
  }, [state.shift, step, reduced]);

  const hasLead = state.lead !== null && step > 0;
  const drawn = hasLead ? [state.lead, ...values] : values;
  const geometry = { width: hasLead ? width + step : width, height, min, max };
  const color = TONE_COLOR[tone];
  const thresholdY =
    threshold === undefined ? null : height - ((Math.min(max, Math.max(min, threshold.value)) - min) / (max - min || 1)) * height;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width={fluid ? '100%' : width}
      height={height}
      className={cn('block overflow-hidden', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g ref={group}>
        <g transform={hasLead ? `translate(${-step} 0)` : undefined}>
          {area && <path d={sparkAreaPath(drawn, geometry)} fill={color} fillOpacity={AREA_OPACITY} />}
          <path
            d={sparkLinePath(drawn, geometry)}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray={dashed ? '3 3' : undefined}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </g>
      </g>
      {thresholdY !== null && threshold && (
        <path
          d={`M0 ${thresholdY.toFixed(1)} H${width}`}
          stroke={TONE_COLOR[threshold.tone]}
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
