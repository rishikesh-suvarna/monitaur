import { memo } from 'react';
import { Link } from 'react-router-dom';

import type { ServerSummary } from '../api/types';
import { cn } from '../lib/cn';
import type { MetricBreaches } from '../lib/status';

import { Chip } from './Chip';
import { RelativeTime } from './RelativeTime';
import { STRETCHED_LINK, metricCells, isStale, netThroughput, serverPath, VALUE_TONE_CLASS } from './serverMetrics';
import { Sparkline } from './Sparkline';
import { StatusBadge } from './StatusBadge';
import { TickingNumber } from './TickingNumber';

// Main.dc.html table: status, server, CPU, memory, disk, net MB/s, last seen.
const ROW_GRID = 'grid grid-cols-[36px_minmax(220px,2.2fr)_repeat(3,minmax(130px,1fr))_84px_96px] items-center px-4';

export interface ServerRowProps {
  server: ServerSummary;
  breaches?: MetricBreaches;
}

/**
 * Components.dc.html ServerRow: 44 px, whole row is a link, stale rows at 55%
 * with a "last seen" warning. Render inside <ServerTable>.
 */
export const ServerRow = memo(function ServerRow({ server, breaches }: ServerRowProps) {
  const stale = isStale(server);
  const cells = metricCells(server, breaches);
  return (
    <div
      role="row"
      className={cn(ROW_GRID, 'relative min-h-11 border-b border-line transition-colors duration-150 ease-out hover:bg-surface-2', stale && 'opacity-[0.55]')}
    >
      <span role="cell">
        <StatusBadge status={server.status} variant="icon" />
      </span>
      <span role="cell" className="flex min-w-0 items-center gap-2 pr-3">
        <Link
          to={serverPath(server.id)}
          title={server.name}
          className={cn('min-w-0 truncate font-medium text-ink hover:text-ink', STRETCHED_LINK)}
        >
          {server.name}
        </Link>
        {server.tags.map((tag) => (
          <Chip key={tag}>{tag}</Chip>
        ))}
      </span>
      {cells.map((cell) => (
        <span role="cell" key={cell.key} className="flex items-center gap-2.5 pr-3">
          <Sparkline values={cell.values} tone={cell.tone} dashed={stale} />
          <TickingNumber
            value={cell.display}
            className={cn('w-10 justify-end text-right', VALUE_TONE_CLASS[cell.tone], cell.over ? 'font-semibold' : 'font-normal')}
          />
        </span>
      ))}
      <span role="cell" className="num text-right text-ink-muted">
        {netThroughput(server)}
      </span>
      <span role="cell" className="text-right">
        <RelativeTime value={server.last_seen} className={stale ? 'text-warn' : 'text-ink-muted'} />
      </span>
    </div>
  );
});

export interface ServerTableProps {
  servers: readonly ServerSummary[];
  breaches?: ReadonlyMap<number, MetricBreaches>;
  'aria-label'?: string;
}

/** The dense server table (scrolls horizontally under 860 px). */
export function ServerTable({ servers, breaches, 'aria-label': ariaLabel = 'Servers' }: ServerTableProps) {
  return (
    <div className="overflow-x-auto">
      <div role="table" aria-label={ariaLabel} aria-rowcount={servers.length + 1} className="min-w-[860px] text-[13px]">
        <div role="rowgroup">
          <div role="row" className={cn(ROW_GRID, 'cap h-9 border-b border-line bg-surface-2')}>
            <span role="columnheader">
              <span className="sr-only">Status</span>
            </span>
            <span role="columnheader">Server</span>
            <span role="columnheader">CPU</span>
            <span role="columnheader">Memory</span>
            <span role="columnheader">Disk</span>
            <span role="columnheader" className="text-right">
              Net MB/s
            </span>
            <span role="columnheader" className="text-right">
              Last seen
            </span>
          </div>
        </div>
        <div role="rowgroup">
          {servers.map((server) => (
            <ServerRow key={server.id} server={server} {...(breaches?.has(server.id) ? { breaches: breaches.get(server.id) } : {})} />
          ))}
        </div>
      </div>
    </div>
  );
}
