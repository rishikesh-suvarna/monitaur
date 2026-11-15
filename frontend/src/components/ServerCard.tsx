import { memo } from 'react';
import { Link } from 'react-router-dom';

import type { ServerSummary } from '../api/types';
import { cn } from '../lib/cn';
import { EMPTY_VALUE, formatDuration } from '../lib/format';
import type { MetricBreaches } from '../lib/status';

import { Chip } from './Chip';
import { MaintenanceBadge } from './MaintenanceBadge';
import { RelativeTime } from './RelativeTime';
import { isStale, metricCells, serverPath, STRETCHED_LINK, VALUE_TONE_CLASS } from './serverMetrics';
import { Sparkline } from './Sparkline';
import { StatusBadge } from './StatusBadge';
import { TickingNumber } from './TickingNumber';

export interface ServerCardProps {
  server: ServerSummary;
  breaches?: MetricBreaches;
  /** grid: desktop grid view (Main.dc.html); compact: mobile list (OverviewMobile.dc.html). */
  variant?: 'grid' | 'compact';
}

/** A server as a card. The whole card is clickable; the name is the link. */
export const ServerCard = memo(function ServerCard({ server, breaches, variant = 'grid' }: ServerCardProps) {
  const stale = isStale(server);
  const cells = metricCells(server, breaches);
  const name = (
    <Link to={serverPath(server.id)} title={server.name} className={cn('min-w-0 flex-1 truncate font-semibold text-ink hover:text-ink', STRETCHED_LINK)}>
      {server.name}
    </Link>
  );

  if (variant === 'compact') {
    return (
      <article
        className={cn('relative flex flex-col gap-2 rounded-lg border border-line bg-surface-1 p-3', stale && 'opacity-60')}
      >
        <div className="flex min-w-0 items-center gap-2 text-[14px]">
          <StatusBadge status={server.status} variant="icon" />
          {name}
          {server.maintenance && <MaintenanceBadge />}
          <RelativeTime value={server.last_seen} className={cn('flex-none text-[12px]', stale ? 'text-warn' : 'text-ink-faint')} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {cells.map((cell) => (
            <div key={cell.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <span className="cap text-[11px]">{cell.label}</span>
                <TickingNumber
                  value={cell.display}
                  className={cn('text-[13px]', VALUE_TONE_CLASS[cell.tone], cell.over ? 'font-semibold' : 'font-normal')}
                />
              </div>
              <Sparkline values={cell.values} height={16} fluid tone={cell.tone} dashed={stale} />
            </div>
          ))}
        </div>
      </article>
    );
  }

  return (
    <article
      className={cn(
        'relative flex flex-col gap-2.5 rounded-lg border bg-surface-1 p-3.5 transition-colors duration-150 ease-out hover:bg-surface-2',
        server.status === 'critical' ? 'border-crit' : 'border-line',
        stale && 'opacity-[0.55]',
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <StatusBadge status={server.status} variant="icon" />
        {name}
        {server.maintenance && <MaintenanceBadge />}
      </div>
      {server.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {server.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
      )}
      {cells.map((cell) => (
        <div key={cell.key} className="grid grid-cols-[40px_minmax(0,1fr)_40px] items-center gap-2">
          <span className="cap text-[11px]">{cell.label}</span>
          <Sparkline values={cell.values} fluid tone={cell.tone} dashed={stale} />
          <TickingNumber
            value={cell.display}
            className={cn('justify-end text-right text-[13px]', VALUE_TONE_CLASS[cell.tone], cell.over ? 'font-semibold' : 'font-normal')}
          />
        </div>
      ))}
      <div className="num flex justify-between border-t border-line pt-2 text-[12px] text-ink-faint">
        <RelativeTime value={server.last_seen} className={stale ? 'text-warn' : undefined} />
        <span>up {server.latest && !stale ? formatDuration(server.latest.uptime_s) : EMPTY_VALUE}</span>
      </div>
    </article>
  );
});
