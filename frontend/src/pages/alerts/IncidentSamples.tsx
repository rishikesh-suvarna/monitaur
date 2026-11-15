import type { Incident } from '../../api/types';
import { useServerSeries } from '../../hooks/api/servers';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { incidentSeriesField, incidentWindow, rangeFor, samplesDomain, windowValues } from '../../lib/incidentSamples';
import { sparkAreaPath, sparkLinePath } from '../../lib/sparkline';
import { presentIncident } from '../../lib/status';

// Alerts.dc.html: a 400 x 48 plot, area at 14%, a 1.5 px line, a dashed threshold in tx2.
const WIDTH = 400;
const HEIGHT = 48;
const AREA_OPACITY = 0.14;
const LINE_WIDTH = 1.5;
const THRESHOLD_DASH = '5 4';
const THRESHOLD_COLOR = 'rgb(var(--tx2))';

/** An open incident in its severity's colour; a resolved one in neutral ink. */
const OPEN_TONE = { crit: 'text-crit', warn: 'text-warn', off: 'text-off', resolved: 'text-ink-muted' } as const;

/**
 * The metric around a server incident, for the expanded alert row. Uptime
 * checks and heartbeats have no series and render nothing.
 */
export function IncidentSamples({ incident }: { incident: Incident }) {
  const now = useNow();
  const field = incidentSeriesField(incident.metric);
  const window = incidentWindow(incident, now);
  const open = incident.state !== 'resolved';
  const range = window ? rangeFor(window, now) : '1h';
  const series = useServerSeries(field && window ? incident.server_id : null, range, open ? {} : { refetchInterval: false });

  if (!field || !window || incident.server_id === null) return null;
  if (series.isPending) {
    return <div aria-hidden="true" className="h-12 w-full max-w-[400px] rounded bg-surface-2" />;
  }
  const values = series.data ? windowValues(series.data.points, field, window) : [];
  if (values.every((value) => value === null)) return null;

  const domain = samplesDomain(values, incident);
  const geometry = { width: WIDTH, height: HEIGHT, ...domain };
  const thresholdY = HEIGHT - ((incident.threshold - domain.min) / (domain.max - domain.min)) * HEIGHT;
  const tone = open ? OPEN_TONE[presentIncident(incident).bar] : OPEN_TONE.resolved;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label="Values during the incident"
      className={cn('max-w-full flex-none', tone)}
    >
      <path d={sparkAreaPath(values, geometry)} fill="currentColor" fillOpacity={AREA_OPACITY} />
      <path d={sparkLinePath(values, geometry)} fill="none" stroke="currentColor" strokeWidth={LINE_WIDTH} vectorEffect="non-scaling-stroke" />
      <path
        d={`M0 ${thresholdY.toFixed(1)} H${WIDTH}`}
        stroke={THRESHOLD_COLOR}
        strokeDasharray={THRESHOLD_DASH}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
