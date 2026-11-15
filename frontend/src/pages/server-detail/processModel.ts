/**
 * The Processes tab (GET /servers/:id/processes, section 6.2): sorting,
 * search and the counts in its header and footer. Pure, so it is unit tested.
 */
import type { ProcessesResponse, ServerProcess } from '../../api/types';
import { EMPTY_VALUE, formatBytes } from '../../lib/format';

/** The agent lists the union of its top this-many by CPU and by memory (section 6.2). */
export const AGENT_TOP_PER_METRIC = 15;

export const PROCESS_SORT_KEYS = ['cpu', 'mem', 'rss', 'name'] as const;
export type ProcessSortKey = (typeof PROCESS_SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

export interface ProcessSort {
  key: ProcessSortKey;
  direction: SortDirection;
}

/** Busiest first, like top. */
export const DEFAULT_PROCESS_SORT: ProcessSort = { key: 'cpu', direction: 'desc' };

export const PROCESS_SORT_LABELS: Record<ProcessSortKey, string> = { cpu: 'CPU', mem: 'Memory', rss: 'RSS', name: 'Name' };

/** What a fresh click on a column means: numbers biggest first, names A to Z. */
export const defaultDirection = (key: ProcessSortKey): SortDirection => (key === 'name' ? 'asc' : 'desc');

/** A header click: the same column flips direction, another column starts at its default. */
export function toggleSort(current: ProcessSort, key: ProcessSortKey): ProcessSort {
  if (current.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  return { key, direction: defaultDirection(key) };
}

/** aria-sort for a column header. */
export function ariaSort(sort: ProcessSort, key: ProcessSortKey): 'ascending' | 'descending' | 'none' {
  if (sort.key !== key) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** The name to show: the agent's, else the command's program, else "pid 42". */
export function processName(process: Pick<ServerProcess, 'name' | 'cmd' | 'pid'>): string {
  const name = process.name.trim();
  if (name !== '') return name;
  const program = process.cmd.trim().split(/\s+/)[0] ?? '';
  const base = program.split('/').pop() ?? '';
  return base !== '' ? base : `pid ${process.pid}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function numberFor(process: ServerProcess, key: Exclude<ProcessSortKey, 'name'>): number | null {
  const value = process[key];
  return finite(value) ? value : null;
}

/**
 * Sorted copy. Unknown numbers go last whichever way the column runs; ties
 * fall back to the name, then the pid, so rows hold still between polls.
 */
export function sortProcesses(processes: readonly ServerProcess[], sort: ProcessSort): ServerProcess[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const byName = (a: ServerProcess, b: ServerProcess): number => collator.compare(processName(a), processName(b)) || a.pid - b.pid;
  return [...processes].sort((a, b) => {
    if (sort.key === 'name') return sign * byName(a, b);
    const left = numberFor(a, sort.key);
    const right = numberFor(b, sort.key);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
      return byName(a, b);
    }
    return sign * (left - right) || byName(a, b);
  });
}

/**
 * Case-insensitive search over the name, user and command line; a number
 * also matches pids that start with it.
 */
export function matchesProcess(process: ServerProcess, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  if (String(process.pid).startsWith(needle)) return true;
  return [processName(process), process.user, process.cmd].some((text) => text.toLowerCase().includes(needle));
}

export interface ProcessView {
  /** Matching processes, sorted. */
  rows: ServerProcess[];
  /** How many the agent listed (at most 30). */
  listed: number;
  /** Processes on the host. */
  total: number;
  /** False until the agent has sent a list (older agents never do). */
  reported: boolean;
}

export function shapeProcesses(response: ProcessesResponse | undefined, query: string, sort: ProcessSort): ProcessView {
  if (!response) return { rows: [], listed: 0, total: 0, reported: false };
  // Section 6.2: `at` is null and the list empty until the agent sends one.
  const processes = Array.isArray(response.processes) ? response.processes : [];
  const reported = response.at !== null;
  const rows = sortProcesses(
    processes.filter((process) => matchesProcess(process, query)),
    sort,
  );
  return { rows, listed: processes.length, total: finite(response.total) ? Math.max(response.total, processes.length) : processes.length, reported };
}

/** "12.5" for CPU and memory percentages (the column header carries the %). */
export const formatShare = (value: number | null | undefined): string => (finite(value) ? value.toFixed(1) : EMPTY_VALUE);

/** "120 MB" */
export const formatRss = (bytes: number | null | undefined): string => formatBytes(bytes);

/** "312 processes", "1 process". */
export const processCount = (count: number): string => `${count} ${count === 1 ? 'process' : 'processes'}`;
