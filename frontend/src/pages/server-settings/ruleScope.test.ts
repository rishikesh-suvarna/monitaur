import { describe, expect, it } from 'vitest';

import type { Rule } from '../../api/types';

import { channelNames, describeRule, formatForDuration, newRulePath, ruleEditPath, ruleMatchesServer, rulesForServer, scopeReason } from './ruleScope';

function rule(overrides: Partial<Rule> & Pick<Rule, 'id'>): Rule {
  return {
    name: `rule-${overrides.id}`,
    enabled: true,
    scope: { all: false, server_ids: [], tags: [] },
    metric: 'cpu',
    comparison: 'above',
    threshold: 85,
    for_seconds: 300,
    severity: 'warning',
    channel_ids: [],
    cooldown_seconds: 1800,
    auto_resolve_seconds: 120,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

const server = { id: 7, tags: ['prod', 'db'] };

describe('ruleMatchesServer', () => {
  it.each([
    ['all servers', { all: true, server_ids: [], tags: [] }, true],
    ['its id', { all: false, server_ids: [3, 7], tags: [] }, true],
    ['one of its tags', { all: false, server_ids: [], tags: ['edge', 'db'] }, true],
    ['a tag in another case', { all: false, server_ids: [], tags: ['PROD'] }, true],
    ['another server and tag', { all: false, server_ids: [3], tags: ['edge'] }, false],
    ['an empty scope', { all: false, server_ids: [], tags: [] }, false],
  ])('matches by %s: %s', (_label, scope, expected) => {
    expect(ruleMatchesServer(scope, server)).toBe(expected);
  });
});

describe('rulesForServer', () => {
  it('keeps matching rules, enabled first, then API order', () => {
    const rules = [
      rule({ id: 1, scope: { all: true, server_ids: [], tags: [] }, enabled: false }),
      rule({ id: 2, scope: { all: false, server_ids: [9], tags: [] } }),
      rule({ id: 3, scope: { all: false, server_ids: [], tags: ['db'] } }),
      rule({ id: 4, scope: { all: false, server_ids: [7], tags: [] } }),
    ];
    expect(rulesForServer(rules, server).map((item) => item.id)).toEqual([3, 4, 1]);
  });
});

describe('describeRule', () => {
  it('reads like the design', () => {
    expect(describeRule(rule({ id: 1, metric: 'disk', threshold: 90, for_seconds: 60, severity: 'critical' }))).toBe('Disk / above 90% for 1 min → critical');
    expect(describeRule(rule({ id: 2, metric: 'cpu', threshold: 85, for_seconds: 300 }))).toBe('CPU above 85% for 5 min → warning');
    expect(describeRule(rule({ id: 3, metric: 'heartbeat', threshold: 0, for_seconds: 120, severity: 'critical' }))).toBe('Unreachable for 2 min → critical');
    expect(describeRule(rule({ id: 4, metric: 'memory', comparison: 'below', threshold: 10, for_seconds: 0 }))).toBe('Memory below 10% → warning');
  });

  it('formats rate thresholds', () => {
    expect(describeRule(rule({ id: 5, metric: 'net_in', threshold: 100 * 1024 * 1024, for_seconds: 30 }))).toBe('Network in above 100 MB/s for 30 s → warning');
  });

  it.each([
    [30, '30 s'],
    [60, '1 min'],
    [300, '5 min'],
    [3600, '1 h'],
    [5400, '1 h 30 min'],
  ])('formats a %d s window as %s', (seconds, expected) => {
    expect(formatForDuration(seconds)).toBe(expected);
  });
});

describe('scope and channel text', () => {
  it('says why the rule applies', () => {
    expect(scopeReason({ all: true, server_ids: [], tags: [] }, server)).toBe('all servers');
    expect(scopeReason({ all: false, server_ids: [7], tags: ['db'] }, server)).toBe('this server');
    expect(scopeReason({ all: false, server_ids: [], tags: ['db', 'edge'] }, server)).toBe('tag db');
    expect(scopeReason({ all: false, server_ids: [], tags: ['db', 'prod'] }, server)).toBe('tags db, prod');
  });

  it('names channels, tolerating unknown ids and an unloaded list', () => {
    const channels = [
      { id: 1, name: 'email' },
      { id: 2, name: 'Slack' },
    ];
    expect(channelNames({ channel_ids: [1, 2] }, channels)).toBe('email, Slack');
    expect(channelNames({ channel_ids: [9] }, channels)).toBe('no channels');
    expect(channelNames({ channel_ids: [] }, channels)).toBe('no channels');
    expect(channelNames({ channel_ids: [1, 2] }, undefined)).toBe('2 channels');
  });

  it('links to the rules page', () => {
    expect(ruleEditPath(4)).toBe('/rules?edit=4');
    expect(newRulePath(7)).toBe('/rules?new=1&server=7');
  });
});
