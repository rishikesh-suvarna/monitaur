import { ArrowDownIcon, ArrowUpIcon, ChevronUpDownIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { useId, useMemo, useState } from 'react';

import type { ServerProcess, ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CopyableCode } from '../../components/CopyableCode';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Input } from '../../components/Input';
import { RelativeTime } from '../../components/RelativeTime';
import { Select } from '../../components/Select';
import { TableRowsSkeleton } from '../../components/Skeletons';
import { PROCESSES_REFRESH_MS, useServerProcesses } from '../../hooks/api/servers';
import { AGENT_INSTALL_COMMAND } from '../../lib/agentInstall';
import { cn } from '../../lib/cn';

import { OfflineBanner } from './OfflineBanner';
import {
  AGENT_TOP_PER_METRIC,
  ariaSort,
  DEFAULT_PROCESS_SORT,
  defaultDirection,
  formatRss,
  formatShare,
  PROCESS_SORT_KEYS,
  PROCESS_SORT_LABELS,
  processCount,
  processName,
  shapeProcesses,
  toggleSort,
  type ProcessSort,
  type ProcessSortKey,
  type ProcessView,
} from './processModel';
import { agentVersionLabel } from './routes';

const MS_PER_SECOND = 1000;
const REFRESH_SECONDS = PROCESSES_REFRESH_MS / MS_PER_SECOND;
const SKELETON_ROWS = 8;

const TH = 'px-2 py-2.5 font-medium';
const TD = 'px-2 py-2.5';

interface SortProps {
  sort: ProcessSort;
  onSort: (key: ProcessSortKey) => void;
}

/** A sortable column header: a real button, with aria-sort on the header cell. */
function SortHeader({ sortKey, label, sort, onSort, align = 'left', className }: SortProps & { sortKey: ProcessSortKey; label: string; align?: 'left' | 'right'; className?: string }) {
  const active = sort.key === sortKey;
  const Icon = !active ? ChevronUpDownIcon : sort.direction === 'asc' ? ArrowUpIcon : ArrowDownIcon;
  return (
    <th scope="col" aria-sort={ariaSort(sort, sortKey)} className={cn(TH, align === 'right' && 'text-right', className)}>
      <button
        type="button"
        onClick={() => {
          onSort(sortKey);
        }}
        className={cn(
          'cap -mx-1 inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1 transition-colors duration-150 ease-out hover:text-ink',
          align === 'right' && 'flex-row-reverse',
          active && 'text-ink',
        )}
      >
        {label}
        <Icon className={cn('h-3.5 w-3.5 flex-none', !active && 'text-ink-faint')} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </th>
  );
}

function ProcessRow({ process }: { process: ServerProcess }) {
  const name = processName(process);
  return (
    <tr className="border-t border-line transition-colors duration-150 ease-out hover:bg-surface-2">
      <th scope="row" className={cn(TD, 'num max-w-[220px] truncate pl-4 text-left font-medium')} title={name}>
        {name}
      </th>
      <td className={cn(TD, 'num text-right text-ink-muted')}>{process.pid}</td>
      <td className={cn(TD, 'num max-w-[140px] truncate text-ink-muted')} title={process.user}>
        {process.user}
      </td>
      <td className={cn(TD, 'num text-right')}>{formatShare(process.cpu)}</td>
      <td className={cn(TD, 'num text-right')}>{formatShare(process.mem)}</td>
      <td className={cn(TD, 'num whitespace-nowrap text-right')}>{formatRss(process.rss)}</td>
      {/* max-w-0 + w-full lets the command take the spare width and truncate inside it. */}
      <td className={cn(TD, 'num w-full max-w-0 truncate pr-4 text-[12px] text-ink-faint')} title={process.cmd}>
        {process.cmd}
      </td>
    </tr>
  );
}

function ProcessTable({ rows, sort, onSort }: SortProps & { rows: readonly ServerProcess[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-[13px]">
        <caption className="sr-only">Processes on this server. Column headers with buttons sort the table.</caption>
        <thead>
          <tr className="cap bg-surface-2 text-left">
            <SortHeader sortKey="name" label="Process" sort={sort} onSort={onSort} className="pl-4" />
            <th scope="col" className={cn(TH, 'text-right')}>
              PID
            </th>
            <th scope="col" className={TH}>
              User
            </th>
            <SortHeader sortKey="cpu" label="CPU %" sort={sort} onSort={onSort} align="right" />
            <SortHeader sortKey="mem" label="Mem %" sort={sort} onSort={onSort} align="right" />
            <SortHeader sortKey="rss" label="RSS" sort={sort} onSort={onSort} align="right" />
            <th scope="col" className={cn(TH, 'pr-4')}>
              Command
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((process) => (
            <ProcessRow key={process.pid} process={process} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProcessCard({ process }: { process: ServerProcess }) {
  const name = processName(process);
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-line bg-surface-1 p-3">
      <div className="flex items-baseline gap-2">
        <span className="num min-w-0 flex-1 truncate text-[13px] font-semibold" title={name}>
          {name}
        </span>
        <span className="num text-[13px] font-semibold">
          {formatShare(process.cpu)}
          <span className="font-normal text-ink-faint">% cpu</span>
        </span>
      </div>
      <span className="num text-[12px] text-ink-muted">
        pid {process.pid} · {process.user !== '' ? process.user : 'unknown user'} · mem {formatShare(process.mem)}% · {formatRss(process.rss)}
      </span>
      {process.cmd !== '' && (
        <span className="num truncate text-[11px] text-ink-faint" title={process.cmd}>
          {process.cmd}
        </span>
      )}
    </li>
  );
}

/** Older agents never send processes (section 6.2); a new one sends its first list within a minute. */
function NotReported({ server }: { server: ServerSummary }) {
  return (
    <EmptyState
      variant="plain"
      mood="waiting"
      dinoSize={110}
      title="Update the agent to see processes"
      description={
        <>
          Agent {agentVersionLabel(server.agent_version)} doesn’t send a process list. Re-run the install command on the server to update it; the first
          list arrives within a minute.
        </>
      }
      action={<CopyableCode code={AGENT_INSTALL_COMMAND} prompt copyLabel="Copy install command" className="max-w-[560px] text-left" />}
    />
  );
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <EmptyState
      variant="plain"
      mood="lost"
      dinoSize={96}
      title={`No processes match “${query.trim()}”`}
      description="The list holds the busiest processes by CPU and memory. Try a name, user, command or PID."
      action={
        <Button size="sm" onClick={onClear}>
          Clear search
        </Button>
      }
    />
  );
}

function countLine(view: ProcessView): string {
  return view.rows.length === view.listed ? `Showing ${view.listed}` : `Showing ${view.rows.length} of ${view.listed}`;
}

export interface ProcessesTabProps {
  server: ServerSummary;
  desktop: boolean;
}

/**
 * /servers/:id?tab=processes: the agent's latest process list (the top 15 by
 * CPU and the top 15 by memory), polled every 15 s while this tab is open.
 */
export function ProcessesTab({ server, desktop }: ProcessesTabProps) {
  const offline = server.status === 'offline';
  // An offline agent sends nothing new, so there is nothing to poll for.
  const processes = useServerProcesses(server.id, { refetchInterval: offline ? false : PROCESSES_REFRESH_MS });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProcessSort>(DEFAULT_PROCESS_SORT);
  const view = useMemo(() => shapeProcesses(processes.data, query, sort), [processes.data, query, sort]);
  const headingId = useId();
  const at = processes.data?.at ?? null;

  const onSort = (key: ProcessSortKey): void => {
    setSort((current) => toggleSort(current, key));
  };
  const clear = (): void => {
    setQuery('');
  };

  const error =
    processes.error !== null ? (
      <ErrorState
        variant="widget"
        error={processes.error}
        title="Couldn’t load the process list."
        onRetry={() => void processes.refetch()}
        retrying={processes.isFetching}
        className={desktop ? 'mx-4 mb-3' : undefined}
      />
    ) : null;

  const search = (
    <Input
      label="Search processes"
      hideLabel
      type="search"
      placeholder={desktop ? 'Filter by name, user, command or PID…' : 'Filter processes…'}
      value={query}
      onChange={(event) => {
        setQuery(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && query !== '') {
          event.preventDefault();
          clear();
        }
      }}
      leading={<MagnifyingGlassIcon className="h-4 w-4" strokeWidth={1.8} />}
      size={desktop ? 'md' : 'xl'}
      fieldClassName={desktop ? 'flex-[1_1_240px] max-w-[340px]' : 'min-w-0 flex-1'}
    />
  );

  const updated = at !== null && (
    <span className={cn('num', offline ? 'text-warn' : undefined)}>
      <RelativeTime value={at} prefix="updated " />
      {!offline && ` · refreshes every ${REFRESH_SECONDS} s`}
    </span>
  );

  // On a phone the list is a stack of cards; every other state sits in one card, like the desktop table.
  let carded = !desktop;
  let body;
  if (processes.isPending) {
    body = <TableRowsSkeleton rows={SKELETON_ROWS} />;
  } else if (!processes.data) {
    body = error;
    carded = false;
  } else if (!view.reported) {
    body = <NotReported server={server} />;
  } else if (view.rows.length === 0) {
    body = view.listed === 0 ? <p className="m-0 px-4 py-8 text-center text-[13px] text-ink-muted">The agent sent an empty list.</p> : <NoMatches query={query} onClear={clear} />;
  } else if (desktop) {
    body = <ProcessTable rows={view.rows} sort={sort} onSort={onSort} />;
  } else {
    carded = false;
    body = (
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {view.rows.map((process) => (
          <ProcessCard key={process.pid} process={process} />
        ))}
      </ul>
    );
  }

  const staleError = processes.data && error;
  const searchable = view.reported && view.listed > 0;

  if (!desktop) {
    return (
      <div className="flex flex-col gap-3.5">
        {offline && <OfflineBanner server={server} />}
        <section aria-labelledby={headingId} className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <h2 id={headingId} className="m-0 flex-1 text-[15px] font-semibold">
              Processes
            </h2>
            {view.reported && <span className="num text-[12px] text-ink-faint">{processCount(view.total)}</span>}
          </div>
          {searchable && (
            <div className="flex items-end gap-2">
              {search}
              <Select
                label="Sort by"
                hideLabel
                value={sort.key}
                onChange={(key) => {
                  setSort({ key, direction: defaultDirection(key) });
                }}
                options={PROCESS_SORT_KEYS.map((key) => ({ value: key, label: PROCESS_SORT_LABELS[key] }))}
                size="xl"
                className="w-[118px] flex-none"
              />
            </div>
          )}
          {staleError}
          {carded ? <Card className="overflow-hidden">{body}</Card> : body}
          {searchable && (
            <span className="py-2 text-center text-[12px] text-ink-faint">
              {countLine(view)}
              {updated && <> · {updated}</>}
            </span>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {offline && <OfflineBanner server={server} />}
      <Card as="section" aria-labelledby={headingId} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <h2 id={headingId} className="m-0 text-h3 font-semibold">
            Processes
          </h2>
          {view.reported && <span className="num text-[13px] text-ink-muted">{processCount(view.total)} on the host</span>}
          <span className="flex-1" />
          {searchable && search}
        </div>
        {staleError}
        {body}
        {searchable && (
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-[12px] text-ink-faint">
            <span>
              {countLine(view)} · the agent sends its top {AGENT_TOP_PER_METRIC} by CPU and top {AGENT_TOP_PER_METRIC} by memory
            </span>
            {updated}
          </div>
        )}
      </Card>
    </div>
  );
}
