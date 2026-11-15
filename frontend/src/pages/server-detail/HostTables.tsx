import type { ServerSummary, Severity } from '../../api/types';
import { Card } from '../../components/Card';
import { StatusIcon } from '../../components/StatusBadge';
import { cn } from '../../lib/cn';
import { STATUS_META } from '../../lib/status';

import { interfaceRows, mountRows, type MountRow } from './hostModel';

// Over a disk line: the bar and the figure take the status colour, with its shape and word.
const SEVERITY_FILL: Record<Severity, string> = { warning: 'bg-warn', critical: 'bg-crit' };
const SEVERITY_TEXT: Record<Severity, string> = { warning: 'text-warn', critical: 'text-crit' };

const TH = 'px-2 py-2.5 font-medium';
const TD = 'px-2 py-2.5';

function UsageBar({ row, className }: { row: MountRow; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('block h-1.5 overflow-hidden rounded-full bg-surface-3', className)}>
      <span className={cn('block h-full rounded-full', row.severity ? SEVERITY_FILL[row.severity] : 'bg-series-1')} style={{ width: `${row.fill}%` }} />
    </span>
  );
}

function UsageFigure({ row }: { row: MountRow }) {
  if (!row.severity) return <span className="num text-ink">{row.pctText}</span>;
  return (
    <span className={cn('num inline-flex items-center gap-1 font-semibold', SEVERITY_TEXT[row.severity])}>
      <StatusIcon status={row.severity} size={12} />
      <span className="sr-only">{STATUS_META[row.severity].label}: </span>
      {row.pctText}
    </span>
  );
}

function CardTitle({ id, title, hint, compact }: { id: string; title: string; hint: string; compact: boolean }) {
  return (
    <div className={cn('flex items-baseline gap-2', compact ? 'px-3 pb-2 pt-3' : 'px-4 pb-3 pt-4')}>
      <h2 id={id} className={cn('m-0 font-semibold', compact ? 'text-[15px]' : 'text-h3')}>
        {title}
      </h2>
      <span className="text-[12px] text-ink-faint">{hint}</span>
    </div>
  );
}

export interface HostTableProps {
  server: ServerSummary;
  desktop: boolean;
}

/** Physical filesystems with a usage bar; the bar turns warn or crit past the server's disk thresholds. */
export function FilesystemsCard({ server, desktop }: HostTableProps) {
  const rows = mountRows(server.latest?.mounts, server.thresholds.disk);
  if (rows.length === 0) return null;
  const stale = server.status === 'offline';
  const headingId = `filesystems-${server.id}`;
  const hint = rows.length === 1 ? '1 mount' : `${rows.length} mounts`;

  return (
    <Card as="section" aria-labelledby={headingId} className={cn('min-w-0 overflow-hidden', stale && 'opacity-[0.55]')}>
      <CardTitle id={headingId} title="Filesystems" hint={hint} compact={!desktop} />
      {desktop ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-[13px]">
            <caption className="sr-only">Mounted filesystems and how full they are</caption>
            <thead>
              <tr className="cap bg-surface-2 text-left">
                <th scope="col" className={cn(TH, 'pl-4')}>
                  Mount
                </th>
                <th scope="col" className={TH}>
                  Type
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Used
                </th>
                <th scope="col" className={cn(TH, 'w-[38%] pr-4')}>
                  Usage
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.path} className="border-t border-line transition-colors duration-150 ease-out hover:bg-surface-2">
                  <th scope="row" className={cn(TD, 'num max-w-[220px] truncate pl-4 text-left font-medium')} title={row.path}>
                    {row.path}
                  </th>
                  <td className={cn(TD, 'num text-ink-muted')}>{row.fstype}</td>
                  <td className={cn(TD, 'num whitespace-nowrap text-right text-ink-muted')}>
                    {row.used} <span className="text-ink-faint">of {row.total}</span>
                  </td>
                  <td className={cn(TD, 'pr-4')}>
                    <span className="flex items-center gap-3">
                      <UsageBar row={row} className="flex-1" />
                      <span className="w-[68px] text-right">
                        <UsageFigure row={row} />
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((row) => (
            <li key={row.path} className="flex flex-col gap-1.5 border-t border-line px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="num min-w-0 flex-1 truncate text-[13px] font-medium" title={row.path}>
                  {row.path}
                </span>
                <span className="text-[13px]">
                  <UsageFigure row={row} />
                </span>
              </div>
              <UsageBar row={row} />
              <span className="num text-[12px] text-ink-faint">
                {row.fstype} · {row.used} of {row.total}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Per-interface throughput (loopback excluded by the agent). */
export function InterfacesCard({ server, desktop }: HostTableProps) {
  const rows = interfaceRows(server.latest?.interfaces);
  if (rows.length === 0) return null;
  const stale = server.status === 'offline';
  const headingId = `interfaces-${server.id}`;
  const left = desktop ? 'pl-4' : 'pl-3';
  const right = desktop ? 'pr-4' : 'pr-3';

  return (
    <Card as="section" aria-labelledby={headingId} className={cn('min-w-0 overflow-hidden', stale && 'opacity-[0.55]')}>
      <CardTitle id={headingId} title="Interfaces" hint={rows.length === 1 ? '1 interface' : `${rows.length} interfaces`} compact={!desktop} />
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">Network interfaces with their current receive and send rates</caption>
        <thead>
          <tr className="cap bg-surface-2 text-left">
            <th scope="col" className={cn(TH, left)}>
              Interface
            </th>
            <th scope="col" className={cn(TH, 'text-right')}>
              <span aria-hidden="true" className="mr-1.5 inline-block h-0.5 w-2.5 bg-series-1 align-middle" />
              In
            </th>
            <th scope="col" className={cn(TH, right, 'text-right')}>
              <span aria-hidden="true" className="mr-1.5 inline-block h-0.5 w-2.5 bg-series-2 align-middle" />
              Out
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-t border-line transition-colors duration-150 ease-out hover:bg-surface-2">
              <th scope="row" className={cn(TD, left, 'num max-w-[160px] truncate text-left font-medium')} title={row.name}>
                {row.name}
              </th>
              <td className={cn(TD, 'num whitespace-nowrap text-right')}>{row.in}</td>
              <td className={cn(TD, right, 'num whitespace-nowrap text-right')}>{row.out}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
