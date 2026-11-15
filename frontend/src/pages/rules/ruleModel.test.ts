import { describe, expect, it } from 'vitest';

import type { Channel, Rule } from '../../api/types';
import { makeServer } from '../../test/fixtures';

import {
  BYTES_PER_MB,
  channelsSummary,
  countMatched,
  displayUnit,
  draftFromRule,
  draftToInput,
  durationOptions,
  fieldForApiError,
  formatRuleDuration,
  formatRuleValue,
  fromApiThreshold,
  isPercentMetric,
  newDraft,
  previewCoverage,
  previewKey,
  previewSummary,
  previewTimeline,
  RULE_METRICS,
  ruleSentence,
  ruleTitle,
  scopeSummary,
  toApiThreshold,
  updateDraft,
  validateDraft,
} from './ruleModel';

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: 1,
  name: 'cpu-warn',
  enabled: true,
  scope: { all: true, server_ids: [], tags: [] },
  metric: 'cpu',
  comparison: 'above',
  threshold: 85,
  for_seconds: 300,
  severity: 'warning',
  channel_ids: [],
  cooldown_seconds: 1800,
  auto_resolve_seconds: 120,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-12T00:00:00Z',
  ...overrides,
});

const channel = (overrides: Partial<Channel> & Pick<Channel, 'id' | 'type' | 'name'>): Channel => ({
  enabled: true,
  summary: {},
  last_delivery_at: null,
  last_delivery_ok: null,
  last_error: null,
  created_at: '2026-11-01T00:00:00Z',
  ...overrides,
});

describe('unit conversion', () => {
  it('shows % for cpu, memory and disk, MB/s for network and nothing for heartbeat', () => {
    expect(displayUnit('cpu')).toBe('%');
    expect(displayUnit('disk')).toBe('%');
    expect(displayUnit('net_in')).toBe('MB/s');
    expect(displayUnit('heartbeat')).toBe('');
  });

  it('sends network thresholds as bytes per second and reads them back without float noise', () => {
    expect(toApiThreshold('net_in', 100)).toBe(100 * BYTES_PER_MB);
    expect(toApiThreshold('net_out', 0.5)).toBe(524288);
    expect(fromApiThreshold('net_in', 104857600)).toBe(100);
    expect(fromApiThreshold('net_out', 1234567)).toBe(1.18);
  });

  it('passes percentages through and zeroes heartbeat thresholds', () => {
    expect(toApiThreshold('memory', 80)).toBe(80);
    expect(toApiThreshold('heartbeat', 42)).toBe(0);
  });

  it('offers load and swap beside the metrics they explain', () => {
    expect(RULE_METRICS).toEqual(['cpu', 'load1', 'memory', 'swap', 'disk', 'net_in', 'net_out', 'heartbeat']);
  });

  it('treats swap as a percentage and load as a bare number', () => {
    expect(displayUnit('swap')).toBe('%');
    expect(isPercentMetric('swap')).toBe(true);
    expect(displayUnit('load1')).toBe('');
    expect(isPercentMetric('load1')).toBe(false);
    expect(toApiThreshold('load1', 4.5)).toBe(4.5);
    expect(formatRuleValue('load1', 4.5)).toBe('4.5');
    expect(formatRuleValue('swap', 50)).toBe('50%');
    expect(ruleTitle({ metric: 'load1', comparison: 'above', threshold: 8, for_seconds: 300, severity: 'warning' })).toBe(
      'Load average > 8 for 5 min → warning',
    );
  });

  it('accepts any load from 0 up, but keeps swap within 0 to 100%', () => {
    const load = updateDraft(newDraft(), { metric: 'load1' });
    expect(load.threshold).toBe('4');
    expect(validateDraft({ ...load, threshold: '250' })).toEqual({});
    expect(validateDraft({ ...load, threshold: '0' })).toEqual({});
    expect(validateDraft({ ...load, threshold: '-1' }).threshold).toBe('Zero or more.');
    const swap = updateDraft(newDraft(), { metric: 'swap' });
    expect(validateDraft({ ...swap, threshold: '101' }).threshold).toBe('Between 0 and 100%.');
  });
});

describe('rule sentences', () => {
  it('titles list rows with a symbol, unit and severity', () => {
    expect(ruleTitle(rule())).toBe('CPU > 85% for 5 min → warning');
    expect(ruleTitle(rule({ metric: 'net_in', threshold: 100 * BYTES_PER_MB, for_seconds: 600 }))).toBe('Network in > 100 MB/s for 10 min → warning');
    expect(ruleTitle(rule({ metric: 'disk', comparison: 'below', threshold: 5, severity: 'critical', for_seconds: 60 }))).toBe(
      'Disk / < 5% for 1 min → critical',
    );
  });

  it('reads heartbeat rules as unreachable, without comparison or threshold', () => {
    expect(ruleTitle(rule({ metric: 'heartbeat', threshold: 0, for_seconds: 120, severity: 'critical' }))).toBe('Unreachable for 2 min → critical');
    expect(ruleSentence(rule({ metric: 'heartbeat', for_seconds: 120, severity: 'critical' }), ['Email'])).toBe(
      'When the heartbeat is missing for 2 min, raise critical, notify Email.',
    );
  });

  it('builds the editor sentence with every channel', () => {
    expect(ruleSentence(rule(), ['Slack · ops', 'Email'])).toBe('When CPU is above 85% for 5 min, raise warning, notify Slack · ops and Email.');
    expect(ruleSentence(rule(), [])).toBe('When CPU is above 85% for 5 min, raise warning, notify nobody.');
  });

  it('formats durations for the selects', () => {
    expect(formatRuleDuration(30)).toBe('30 s');
    expect(formatRuleDuration(300)).toBe('5 min');
    expect(formatRuleDuration(3600)).toBe('1 h');
    expect(formatRuleDuration(5400)).toBe('1 h 30 min');
    expect(durationOptions([60, 300], 90)).toEqual([60, 90, 300]);
    expect(durationOptions([60, 300], 0)).toEqual([60, 300]);
  });
});

describe('drafts', () => {
  it('round-trips a stored rule into the same API body', () => {
    const stored = rule({ metric: 'net_out', threshold: 50 * BYTES_PER_MB, channel_ids: [3], scope: { all: false, server_ids: [7], tags: ['prod'] } });
    const { id: _id, created_at: _c, updated_at: _u, ...input } = stored;
    expect(draftToInput(draftFromRule(stored))).toEqual(input);
  });

  it('maps cooldown and auto-resolve switches to 0 when off', () => {
    const draft = { ...draftFromRule(rule()), cooldownOn: false, autoResolveOn: false };
    expect(draftToInput(draft)).toMatchObject({ cooldown_seconds: 0, auto_resolve_seconds: 0 });
    const reopened = draftFromRule(rule({ cooldown_seconds: 0 }));
    expect(reopened).toMatchObject({ cooldownOn: false, cooldownSeconds: 1800 });
  });

  it('pre-scopes a new rule to a server from the deep link and preselects enabled channels', () => {
    const draft = newDraft({
      serverId: 12,
      channels: [channel({ id: 1, type: 'email', name: 'Email' }), channel({ id: 2, type: 'slack', name: 'ops', enabled: false })],
    });
    expect(draftToInput(draft)).toMatchObject({ scope: { all: false, server_ids: [12], tags: [] }, channel_ids: [1], name: 'cpu-warn' });
  });

  it('resets the threshold to the metric default and keeps a generated name in step', () => {
    const draft = updateDraft(newDraft(), { metric: 'disk', severity: 'critical' });
    expect(draft).toMatchObject({ threshold: '90', name: 'disk-critical' });
    const named = updateDraft({ ...draft, name: 'root-disk', nameEdited: true }, { metric: 'memory' });
    expect(named.name).toBe('root-disk');
  });

  it('sends heartbeat rules with comparison above and threshold 0', () => {
    const draft = updateDraft(newDraft(), { metric: 'heartbeat', forSeconds: 120, severity: 'critical' });
    expect(draftToInput(draft)).toMatchObject({ metric: 'heartbeat', comparison: 'above', threshold: 0, for_seconds: 120, name: 'host-unreachable' });
  });

  it('ignores name, channel and timer changes in the preview key', () => {
    const base = draftToInput(newDraft());
    expect(previewKey({ ...base, name: 'x', channel_ids: [9], cooldown_seconds: 60 })).toBe(previewKey(base));
    expect(previewKey({ ...base, threshold: 90 })).not.toBe(previewKey(base));
  });
});

describe('validateDraft', () => {
  it('accepts the default new rule', () => {
    expect(validateDraft(newDraft())).toEqual({});
  });

  it('flags the fields the engine would reject', () => {
    expect(validateDraft({ ...newDraft(), name: '  ', threshold: '120' })).toEqual({ name: 'Give the rule a name.', threshold: 'Between 0 and 100%.' });
    expect(validateDraft({ ...newDraft(), threshold: 'abc' }).threshold).toBe('Enter a number.');
    expect(validateDraft({ ...newDraft(), scopeAll: false }).scope).toMatch(/at least one server or tag/);
    expect(validateDraft({ ...newDraft(), metric: 'net_in', threshold: '-1' }).threshold).toBe('Zero or more.');
    expect(validateDraft({ ...newDraft(), metric: 'heartbeat', forSeconds: 10 }).for).toBe('Heartbeat rules need at least 30 s.');
  });

  it('routes API validation messages to the field they are about', () => {
    expect(fieldForApiError('cpu threshold must be between 0 and 100 percent, got 120')).toBe('threshold');
    expect(fieldForApiError('heartbeat rules need a duration (for) of at least 30s, got 10s')).toBe('for');
    expect(fieldForApiError('scope includes a server that is not in this organization')).toBe('scope');
    expect(fieldForApiError('rule routes to a channel that is not in this organization')).toBe('channels');
    expect(fieldForApiError('rule name is required')).toBe('name');
    expect(fieldForApiError('something else')).toBeNull();
  });
});

describe('scope', () => {
  const servers = [
    makeServer({ id: 1, name: 'api-01', tags: ['prod', 'api'] }),
    makeServer({ id: 2, name: 'worker-queue-01', tags: ['worker'] }),
    makeServer({ id: 3, name: 'edge-lon-01', tags: ['Edge'] }),
  ];
  const names = new Map(servers.map((server) => [server.id, server.name]));

  it('matches all, listed ids and tags case-insensitively', () => {
    expect(countMatched({ all: true, server_ids: [], tags: [] }, servers)).toBe(3);
    expect(countMatched({ all: false, server_ids: [2], tags: ['edge'] }, servers)).toBe(2);
    expect(countMatched({ all: false, server_ids: [], tags: ['db'] }, servers)).toBe(0);
  });

  it('summarises the scope for list rows', () => {
    expect(scopeSummary({ all: true, server_ids: [], tags: [] }, names)).toBe('all servers');
    expect(scopeSummary({ all: false, server_ids: [2], tags: ['prod'] }, names)).toBe('tag: prod, worker-queue-01');
    expect(scopeSummary({ all: false, server_ids: [1, 2, 99], tags: [] }, names)).toBe('api-01, worker-queue-01 +1');
  });

  it('names channels and skips deleted ones', () => {
    const channels = new Map([
      [1, channel({ id: 1, type: 'slack', name: 'ops' })],
      [2, channel({ id: 2, type: 'email', name: 'Email' })],
    ]);
    expect(channelsSummary([1, 2, 3], channels)).toBe('ops, Email');
    expect(channelsSummary([], channels)).toBe('no channels');
  });
});

describe('preview', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const names = new Map([
    [1, 'api-01'],
    [2, 'db-01'],
  ]);

  it('lays incidents out on the 7-day window, busiest server first, open ones to now', () => {
    const rows = previewTimeline(
      [
        { server_id: 1, start: '2026-11-14T12:00:00Z', end: '2026-11-14T13:00:00Z', peak: 91 },
        { server_id: 2, start: '2026-11-08T12:00:00Z', end: '2026-11-08T18:00:00Z', peak: 97 },
        { server_id: 2, start: '2026-11-15T11:00:00Z', end: null, peak: 93 },
      ],
      now,
      names,
    );
    expect(rows.map((row) => row.name)).toEqual(['db-01', 'api-01']);
    const [first, open] = rows[0]!.spans;
    expect(first!.leftPct).toBeCloseTo(0);
    expect(first!.widthPct).toBeCloseTo((6 / 168) * 100);
    expect(open!.leftPct + open!.widthPct).toBeCloseTo(100);
  });

  it('gives very short incidents a visible sliver', () => {
    const [row] = previewTimeline([{ server_id: 1, start: '2026-11-14T12:00:00Z', end: '2026-11-14T12:01:00Z', peak: 91 }], now, names);
    expect(row!.spans[0]!.widthPct).toBe(0.6);
  });

  it('summarises how often it would have fired and when the replay was capped', () => {
    expect(previewSummary({ would_fire: 0, matched_servers: 4, previewed: 4, servers: 0 })).toBe('Would not have fired. Quiet, maybe too quiet.');
    expect(previewSummary({ would_fire: 3, matched_servers: 4, previewed: 4, servers: 2 })).toBe('Would have fired 3 times on 2 servers.');
    expect(previewSummary({ would_fire: 1, matched_servers: 1, previewed: 1, servers: 1 })).toBe('Would have fired once on 1 server.');
    expect(previewSummary({ would_fire: 0, matched_servers: 0, previewed: 0, servers: 0 })).toMatch(/No servers match/);
    expect(previewCoverage({ matched_servers: 14, previewed: 10 })).toBe('Replayed 10 of 14 matching servers.');
    expect(previewCoverage({ matched_servers: 4, previewed: 4 })).toBeNull();
  });
});
