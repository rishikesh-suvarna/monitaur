import { describe, expect, it } from 'vitest';

import { EMPTY_VALUE } from '../../lib/format';

import {
  agentVersionLabel,
  alertsForServer,
  parseRange,
  parseServerId,
  parseTab,
  serverAlertsTabPath,
  serverProcessesTabPath,
  serverSettingsPath,
} from './routes';

describe('route params', () => {
  it.each([
    ['12', 12],
    ['0', null],
    ['-3', null],
    ['1.5', null],
    ['abc', null],
    ['99999999999999999999', null],
    [undefined, null],
  ])('parses server id %j as %j', (raw, expected) => {
    expect(parseServerId(raw)).toBe(expected);
  });

  it('defaults the range to 6h and the tab to metrics', () => {
    expect(parseRange('24h')).toBe('24h');
    expect(parseRange('live')).toBe('live');
    expect(parseRange('2h')).toBe('6h');
    expect(parseRange(null)).toBe('6h');
    expect(parseTab('alerts')).toBe('alerts');
    expect(parseTab('processes')).toBe('processes');
    expect(parseTab('settings')).toBe('metrics');
    expect(parseTab(null)).toBe('metrics');
  });

  it('builds the tab and cross-page links', () => {
    expect(serverAlertsTabPath(4)).toBe('/servers/4?tab=alerts');
    expect(serverProcessesTabPath(4)).toBe('/servers/4?tab=processes');
    expect(serverSettingsPath(4)).toBe('/servers/4/settings');
    expect(alertsForServer(4)).toBe('/alerts?server=4&state=all');
  });
});

describe('agentVersionLabel', () => {
  it('adds a single v and shows a dash when unknown', () => {
    expect(agentVersionLabel('0.9.4')).toBe('v0.9.4');
    expect(agentVersionLabel('v0.9.4')).toBe('v0.9.4');
    expect(agentVersionLabel('  ')).toBe(EMPTY_VALUE);
  });
});
