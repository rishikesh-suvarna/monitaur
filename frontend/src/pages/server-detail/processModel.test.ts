import { describe, expect, it } from 'vitest';

import type { ProcessesResponse, ServerProcess } from '../../api/types';
import { EMPTY_VALUE } from '../../lib/format';

import {
  ariaSort,
  DEFAULT_PROCESS_SORT,
  formatShare,
  matchesProcess,
  processCount,
  processName,
  shapeProcesses,
  sortProcesses,
  toggleSort,
  type ProcessSort,
} from './processModel';

const MB = 1024 ** 2;

const proc = (overrides: Partial<ServerProcess> & Pick<ServerProcess, 'pid'>): ServerProcess => ({
  name: `proc-${overrides.pid}`,
  user: 'root',
  cpu: 0,
  mem: 0,
  rss: 0,
  cmd: '',
  ...overrides,
});

const LIST = [
  proc({ pid: 812, name: 'postgres', user: 'postgres', cpu: 12.5, mem: 3.1, rss: 120 * MB, cmd: 'postgres -D /var/lib/postgresql/16/main' }),
  proc({ pid: 1, name: 'systemd', cpu: 0.1, mem: 0.2, rss: 12 * MB, cmd: '/sbin/init' }),
  proc({ pid: 2044, name: 'node', user: 'app', cpu: 48, mem: 9.8, rss: 640 * MB, cmd: 'node /srv/api/server.js --port 8080' }),
  proc({ pid: 4410, name: 'Nginx', user: 'www-data', cpu: 2, mem: 0.4, rss: 30 * MB, cmd: 'nginx: worker process' }),
];

const pids = (list: readonly ServerProcess[]) => list.map((item) => item.pid);
const sorted = (sort: ProcessSort) => pids(sortProcesses(LIST, sort));

describe('sortProcesses', () => {
  it('starts with the busiest CPU first, like top', () => {
    expect(DEFAULT_PROCESS_SORT).toEqual({ key: 'cpu', direction: 'desc' });
    expect(sorted(DEFAULT_PROCESS_SORT)).toEqual([2044, 812, 4410, 1]);
  });

  it('sorts by memory, RSS and name (case-insensitive) in either direction', () => {
    expect(sorted({ key: 'mem', direction: 'desc' })).toEqual([2044, 812, 4410, 1]);
    expect(sorted({ key: 'rss', direction: 'asc' })).toEqual([1, 4410, 812, 2044]);
    expect(sorted({ key: 'name', direction: 'asc' })).toEqual([4410, 2044, 812, 1]);
    expect(sorted({ key: 'name', direction: 'desc' })).toEqual([1, 812, 2044, 4410]);
  });

  it('does not reorder the input', () => {
    const input = [...LIST];
    sortProcesses(input, { key: 'name', direction: 'asc' });
    expect(pids(input)).toEqual(pids(LIST));
  });

  it('breaks ties by name then pid so rows hold still between polls', () => {
    const ties = [proc({ pid: 9, name: 'b', cpu: 1 }), proc({ pid: 7, name: 'a', cpu: 1 }), proc({ pid: 3, name: 'a', cpu: 1 })];
    expect(pids(sortProcesses(ties, DEFAULT_PROCESS_SORT))).toEqual([3, 7, 9]);
  });

  it('puts unknown values last whichever way the column runs', () => {
    const list = [proc({ pid: 1, cpu: Number.NaN }), proc({ pid: 2, cpu: 5 }), proc({ pid: 3, cpu: 1 })];
    expect(pids(sortProcesses(list, { key: 'cpu', direction: 'desc' }))).toEqual([2, 3, 1]);
    expect(pids(sortProcesses(list, { key: 'cpu', direction: 'asc' }))).toEqual([3, 2, 1]);
  });
});

describe('sort headers', () => {
  it('flips the active column and starts others at their natural direction', () => {
    expect(toggleSort({ key: 'cpu', direction: 'desc' }, 'cpu')).toEqual({ key: 'cpu', direction: 'asc' });
    expect(toggleSort({ key: 'cpu', direction: 'asc' }, 'rss')).toEqual({ key: 'rss', direction: 'desc' });
    expect(toggleSort({ key: 'cpu', direction: 'desc' }, 'name')).toEqual({ key: 'name', direction: 'asc' });
  });

  it('announces the sorted column only', () => {
    expect(ariaSort({ key: 'mem', direction: 'desc' }, 'mem')).toBe('descending');
    expect(ariaSort({ key: 'name', direction: 'asc' }, 'name')).toBe('ascending');
    expect(ariaSort({ key: 'mem', direction: 'desc' }, 'cpu')).toBe('none');
  });
});

describe('search', () => {
  const match = (query: string) => pids(LIST.filter((item) => matchesProcess(item, query)));

  it('matches name, user and command line, ignoring case and padding', () => {
    expect(match('  POST ')).toEqual([812]);
    expect(match('www-data')).toEqual([4410]);
    expect(match('--port 8080')).toEqual([2044]);
    expect(match('')).toEqual(pids(LIST));
  });

  it('matches pids by prefix', () => {
    expect(match('44')).toEqual([4410]);
    expect(match('20')).toEqual([2044]);
  });
});

describe('processName', () => {
  it('falls back to the program in the command line, then the pid', () => {
    expect(processName({ pid: 5, name: 'redis', cmd: '' })).toBe('redis');
    expect(processName({ pid: 5, name: ' ', cmd: '/usr/bin/redis-server *:6379' })).toBe('redis-server');
    expect(processName({ pid: 5, name: '', cmd: '' })).toBe('pid 5');
  });
});

describe('shapeProcesses', () => {
  const response: ProcessesResponse = { at: '2026-11-15T14:27:00Z', total: 312, processes: LIST };

  it('filters, then sorts, and keeps the listed and host totals apart', () => {
    // 'p' is in postgres, in node's --port and in nginx's 'process'; not in systemd, /sbin/init or root.
    const view = shapeProcesses(response, 'p', { key: 'rss', direction: 'desc' });
    expect(pids(view.rows)).toEqual([2044, 812, 4410]);
    expect(view).toMatchObject({ listed: 4, total: 312, reported: true });
  });

  it('marks an older agent (at null, empty list) as not reporting', () => {
    expect(shapeProcesses({ at: null, total: 0, processes: [] }, '', DEFAULT_PROCESS_SORT)).toEqual({ rows: [], listed: 0, total: 0, reported: false });
    expect(shapeProcesses(undefined, '', DEFAULT_PROCESS_SORT).reported).toBe(false);
  });

  it('never claims fewer processes on the host than it lists', () => {
    expect(shapeProcesses({ ...response, total: 2 }, '', DEFAULT_PROCESS_SORT).total).toBe(4);
    expect(shapeProcesses({ ...response, total: Number.NaN }, '', DEFAULT_PROCESS_SORT).total).toBe(4);
  });

  it('tolerates a null list from the backend', () => {
    const view = shapeProcesses({ at: '2026-11-15T14:27:00Z', total: 3, processes: null } as unknown as ProcessesResponse, '', DEFAULT_PROCESS_SORT);
    expect(view).toMatchObject({ rows: [], listed: 0, reported: true });
  });
});

describe('formatting', () => {
  it('shows shares with one decimal and counts in words', () => {
    expect(formatShare(12.46)).toBe('12.5');
    expect(formatShare(Number.NaN)).toBe(EMPTY_VALUE);
    expect(processCount(1)).toBe('1 process');
    expect(processCount(312)).toBe('312 processes');
  });
});
