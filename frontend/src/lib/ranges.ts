import type { SeriesRange } from '../api/types';

/** GET /servers/:id/series ranges, in picker order (metrics.Range on the backend). */
export const TIME_RANGES: readonly SeriesRange[] = ['live', '1h', '6h', '24h', '7d', '30d'];

export const RANGE_LABELS: Record<SeriesRange, string> = {
  live: 'Live',
  '1h': '1h',
  '6h': '6h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
};
