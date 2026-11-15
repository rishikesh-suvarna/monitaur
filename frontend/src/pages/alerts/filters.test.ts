import { describe, expect, it } from 'vitest';

import { makeIncident } from '../../test/fixtures';

import {
  canMatch,
  DEFAULT_FILTERS,
  groupIncidents,
  isFiltered,
  matchesFilters,
  parseFilters,
  toApiFilters,
  writeFilters,
  type AlertFilters,
} from './filters';

const params = (query: string): URLSearchParams => new URLSearchParams(query);

describe('parseFilters', () => {
  it('defaults to open incidents of every severity, type and server', () => {
    expect(parseFilters(params(''))).toEqual(DEFAULT_FILTERS);
  });

  it('reads every filter from the URL', () => {
    expect(parseFilters(params('state=all&severity=critical&type=network&server=12'))).toEqual({
      state: 'all',
      severities: ['critical'],
      type: 'network',
      serverId: 12,
    });
  });

  it('ignores junk and keeps an explicit "none"', () => {
    expect(parseFilters(params('state=nope&type=gpu&server=-1&severity=bogus'))).toEqual(DEFAULT_FILTERS);
    expect(parseFilters(params('severity=none')).severities).toEqual([]);
  });

  it('round-trips through writeFilters, leaving defaults out', () => {
    const filters: AlertFilters = { state: 'resolved', severities: ['warning'], type: 'unreachable', serverId: 3 };
    const written = writeFilters(params('foo=bar'), filters);
    expect(written.toString()).toBe('foo=bar&state=resolved&type=unreachable&server=3&severity=warning');
    expect(parseFilters(written)).toEqual(filters);
    expect(writeFilters(params(''), DEFAULT_FILTERS).toString()).toBe('');
    expect(writeFilters(params(''), { ...DEFAULT_FILTERS, severities: [] }).toString()).toBe('severity=none');
  });
});

describe('toApiFilters', () => {
  it('maps types to the API metric, and unreachable to heartbeat', () => {
    expect(toApiFilters({ ...DEFAULT_FILTERS, type: 'memory' })).toEqual({ state: 'open', metric: 'memory' });
    expect(toApiFilters({ ...DEFAULT_FILTERS, type: 'unreachable' })).toEqual({ state: 'open', metric: 'heartbeat' });
  });

  it('leaves network to the client: the API filters one metric at a time', () => {
    expect(toApiFilters({ ...DEFAULT_FILTERS, type: 'network' })).toEqual({ state: 'open' });
  });

  it('sends a severity only when exactly one is chosen, and the server', () => {
    expect(toApiFilters({ ...DEFAULT_FILTERS, severities: ['warning'], serverId: 4 })).toEqual({ state: 'open', severity: 'warning', server_id: 4 });
    expect(toApiFilters({ ...DEFAULT_FILTERS, state: 'all' })).toEqual({ state: 'all' });
  });
});

describe('matchesFilters', () => {
  const netOut = makeIncident({ id: 1, server_id: 2, metric: 'net_out', severity: 'warning' });
  const disk = makeIncident({ id: 2, server_id: 3, metric: 'disk', severity: 'critical', state: 'acked' });

  it('treats network as net_in or net_out', () => {
    const network: AlertFilters = { ...DEFAULT_FILTERS, type: 'network' };
    expect(matchesFilters(netOut, network)).toBe(true);
    expect(matchesFilters(makeIncident({ id: 3, server_id: 2, metric: 'net_in' }), network)).toBe(true);
    expect(matchesFilters(makeIncident({ id: 4, server_id: 2, metric: 'cpu' }), network)).toBe(false);
  });

  it('checks state, severity and server', () => {
    expect(matchesFilters(disk, DEFAULT_FILTERS)).toBe(false);
    expect(matchesFilters(disk, { ...DEFAULT_FILTERS, state: 'acked' })).toBe(true);
    expect(matchesFilters(disk, { ...DEFAULT_FILTERS, state: 'all', severities: ['warning'] })).toBe(false);
    expect(matchesFilters(disk, { ...DEFAULT_FILTERS, state: 'all', serverId: 9 })).toBe(false);
  });

  it('knows when filters are active or cannot match', () => {
    expect(isFiltered(DEFAULT_FILTERS)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTERS, state: 'all' })).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTERS, severities: ['critical'] })).toBe(true);
    expect(canMatch({ ...DEFAULT_FILTERS, severities: [] })).toBe(false);
  });
});

describe('groupIncidents', () => {
  const incidents = [
    makeIncident({ id: 10, server_id: 1, severity: 'warning', started_at: '2026-11-15T14:20:00Z' }),
    makeIncident({ id: 9, server_id: 1, severity: 'critical', started_at: '2026-11-15T14:04:00Z' }),
    makeIncident({ id: 8, server_id: 1, metric: 'heartbeat', severity: 'critical', started_at: '2026-11-15T14:15:00Z' }),
    makeIncident({ id: 7, server_id: 1, state: 'acked' }),
    makeIncident({ id: 6, server_id: 1, state: 'resolved' }),
    makeIncident({ id: 5, server_id: 1, state: 'resolved' }),
  ];

  it('groups by state and sorts active incidents worst first: critical, unreachable, warning', () => {
    const groups = groupIncidents(incidents, 'all');
    expect(groups.map((group) => [group.label, group.incidents.map((item) => item.id)])).toEqual([
      ['Open', [9, 8, 10]],
      ['Acknowledged', [7]],
      ['Resolved', [6, 5]],
    ]);
  });

  it('always shows the chosen state, even empty, but hides empty groups under "all"', () => {
    expect(groupIncidents([], 'acked')).toEqual([{ state: 'acked', label: 'Acknowledged', incidents: [] }]);
    expect(groupIncidents(incidents.slice(4), 'all').map((group) => group.state)).toEqual(['resolved']);
  });
});
