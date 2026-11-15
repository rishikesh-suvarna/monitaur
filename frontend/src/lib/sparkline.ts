/** SVG path geometry for sparklines. Gaps (null) break the line; never interpolated. */

export interface SparkGeometry {
  width: number;
  height: number;
  min: number;
  max: number;
}

const PRECISION = 1;

const point = (x: number, y: number): string => `${x.toFixed(PRECISION)} ${y.toFixed(PRECISION)}`;

function project(values: readonly (number | null)[], geo: SparkGeometry): ({ x: number; y: number } | null)[] {
  const span = geo.max - geo.min || 1;
  const step = values.length > 1 ? geo.width / (values.length - 1) : 0;
  return values.map((value, index) => {
    if (value === null || !Number.isFinite(value)) return null;
    const clamped = Math.min(geo.max, Math.max(geo.min, value));
    return { x: index * step, y: geo.height - ((clamped - geo.min) / span) * geo.height };
  });
}

/** Continuous runs of points, split at gaps. */
function segments(values: readonly (number | null)[], geo: SparkGeometry): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const p of project(values, geo)) {
    if (p === null) {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function sparkLinePath(values: readonly (number | null)[], geo: SparkGeometry): string {
  return segments(values, geo)
    .map((run) => run.map((p, i) => `${i === 0 ? 'M' : 'L'}${point(p.x, p.y)}`).join(' '))
    .join(' ');
}

export function sparkAreaPath(values: readonly (number | null)[], geo: SparkGeometry): string {
  return segments(values, geo)
    .filter((run) => run.length > 1)
    .map((run) => {
      const first = run[0];
      const last = run[run.length - 1];
      if (!first || !last) return '';
      const line = run.map((p, i) => `${i === 0 ? 'M' : 'L'}${point(p.x, p.y)}`).join(' ');
      return `${line} L${point(last.x, geo.height)} L${point(first.x, geo.height)} Z`;
    })
    .join(' ');
}

const SHIFT_TOLERANCE = 1e-6;

/**
 * True when `next` looks like `previous` advanced by one bucket: everything
 * but the last two points moved left by one. The last two are excluded
 * because the previous partial bucket closes with a different average.
 */
export function isOneStepShift(previous: readonly (number | null)[], next: readonly (number | null)[]): boolean {
  const comparable = next.length - 2;
  if (previous.length !== next.length || comparable < 1) return false;
  for (let i = 0; i < comparable; i++) {
    const a = previous[i + 1];
    const b = next[i];
    if (a === null || b === null || a === undefined || b === undefined) {
      if (a !== b) return false;
    } else if (Math.abs(a - b) > SHIFT_TOLERANCE) {
      return false;
    }
  }
  return true;
}
