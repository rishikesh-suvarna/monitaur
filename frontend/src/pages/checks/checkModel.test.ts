import { describe, expect, it } from 'vitest';

import type { Channel } from '../../api/types';
import { makeCheck } from '../../test/fixtures';

import {
  buildCreateBody,
  buildUpdateBody,
  checkLimits,
  checkQuota,
  checksSummary,
  defaultInterval,
  emptyCheckForm,
  failingStepsLabel,
  formFromCheck,
  intervalOptions,
  latencyAxisMax,
  parseHostPort,
  resultRows,
  stepRows,
  summarizeResults,
  targetError,
  validateCheckForm,
  type CheckForm,
} from './checkModel';

const FREE = { minIntervalSeconds: 60, planName: 'Free' };
const NO_LIMIT = { minIntervalSeconds: 0 };

const form = (patch: Partial<CheckForm> = {}): CheckForm => ({
  ...emptyCheckForm(FREE),
  name: 'API health',
  targets: { http: 'https://api.example.com/health', tcp: 'db.example.com:5432', tls: 'example.com' },
  ...patch,
});

describe('check targets per type', () => {
  it.each([
    ['https://api.example.com/health', undefined],
    ['http://example.com:8080/', undefined],
    ['', 'Enter a URL.'],
    ['api.example.com', 'Start the URL with http:// or https://.'],
    ['ftp://example.com', 'Start the URL with http:// or https://.'],
    ['https://exa mple.com', 'URLs can’t contain spaces.'],
    ['https://', 'That isn’t a valid URL.'],
  ])('http %j', (target, error) => {
    expect(targetError('http', target)).toBe(error);
  });

  it.each([
    ['db.example.com:5432', undefined],
    ['10.0.0.5:22', undefined],
    ['[2001:db8::1]:5432', undefined],
    ['db.example.com', 'Add the port, for example :5432.'],
    ['db.example.com:0', 'The port must be 1 to 65535.'],
    ['db.example.com:70000', 'The port must be 1 to 65535.'],
    ['db.example.com:ssh', 'The port must be 1 to 65535.'],
    ['tcp://db.example.com:5432', 'Leave out the scheme and path: host:port only.'],
    ['2001:db8::1:5432', 'Wrap IPv6 addresses in brackets: [2001:db8::1]:5432.'],
    ['-bad-.example.com:22', 'Enter a host name or IP address before the port.'],
    ['', 'Enter host:port, for example db.example.com:5432.'],
  ])('tcp %j', (target, error) => {
    expect(targetError('tcp', target)).toBe(error);
  });

  it.each([
    ['example.com', undefined],
    ['example.com:8443', undefined],
    ['https://example.com', 'Leave out https:// and the path: host or host:port only.'],
    ['example.com/path', 'Leave out https:// and the path: host or host:port only.'],
    ['example.com:99999', 'The port must be 1 to 65535.'],
  ])('tls %j (port optional, 443 by default)', (target, error) => {
    expect(targetError('tls', target)).toBe(error);
  });

  it('parses host and port', () => {
    expect(parseHostPort(' example.com:443 ')).toEqual({ host: 'example.com', port: 443 });
    expect(parseHostPort('example.com')).toEqual({ host: 'example.com', port: null });
    expect(parseHostPort('[::1]')).toEqual({ host: '::1', port: null });
  });
});

describe('check form validation', () => {
  it('accepts a complete form', () => {
    expect(validateCheckForm(form(), FREE)).toEqual({});
  });

  it('refuses an interval under the plan minimum, naming the plan', () => {
    expect(validateCheckForm(form({ intervalSeconds: 30 }), FREE).interval).toBe('The Free plan checks at most every 1 min.');
    expect(validateCheckForm(form({ intervalSeconds: 60 }), FREE).interval).toBeUndefined();
    expect(validateCheckForm(form({ intervalSeconds: 30, timeoutSeconds: 10 }), NO_LIMIT).interval).toBeUndefined();
  });

  it('caps the timeout at what the backend accepts', () => {
    expect(validateCheckForm(form({ intervalSeconds: 300, timeoutSeconds: 60 }), NO_LIMIT).timeout).toBe('Timeouts go up to 30 s.');
    expect(validateCheckForm(form({ intervalSeconds: 300, timeoutSeconds: 30 }), NO_LIMIT).timeout).toBeUndefined();
  });

  it('wants a timeout shorter than the interval', () => {
    expect(validateCheckForm(form({ intervalSeconds: 30, timeoutSeconds: 30 }), NO_LIMIT).timeout).toBe(
      'The timeout must be shorter than the interval.',
    );
  });

  it('validates only the fields of the chosen type', () => {
    const http = form({ expectStatus: '700', tlsWarnDays: '0' });
    expect(validateCheckForm(http, FREE)).toMatchObject({ expectStatus: expect.any(String) as string, tlsWarnDays: expect.any(String) as string });
    // A tcp check ignores the http and certificate fields.
    expect(validateCheckForm({ ...http, type: 'tcp' }, FREE)).toEqual({});
    // A plain http URL reports no certificate, so warning days are not checked.
    expect(validateCheckForm(form({ targets: { http: 'http://example.com', tcp: '', tls: '' }, tlsWarnDays: '0' }), FREE)).toEqual({});
  });

  it('needs a name and a target for the current type', () => {
    const errors = validateCheckForm(form({ name: '  ', type: 'tcp', targets: { http: 'https://x.test', tcp: '', tls: '' } }), FREE);
    expect(errors.name).toBe('Give the check a name.');
    expect(errors.target).toBe('Enter host:port, for example db.example.com:5432.');
  });
});

describe('check form defaults and bodies', () => {
  const channels: Channel[] = [
    { id: 1, type: 'email', name: 'ops', enabled: true, summary: {}, last_delivery_at: null, last_delivery_ok: null, last_error: null, created_at: '' },
    { id: 2, type: 'slack', name: 'old', enabled: false, summary: {}, last_delivery_at: null, last_delivery_ok: null, last_error: null, created_at: '' },
  ];

  it('defaults to the plan minimum snapped to a preset and preselects enabled channels', () => {
    expect(defaultInterval(0)).toBe(60);
    expect(defaultInterval(90)).toBe(120);
    expect(emptyCheckForm({ minIntervalSeconds: 300 }, channels)).toMatchObject({ intervalSeconds: 300, channelIds: [1] });
  });

  it('sends type-specific fields only with their type', () => {
    expect(buildCreateBody(form({ expectStatus: '204', keyword: 'ok' }))).toEqual({
      name: 'API health',
      type: 'http',
      target: 'https://api.example.com/health',
      interval_seconds: 60,
      timeout_seconds: 10,
      enabled: true,
      channel_ids: [],
      expect_status: 204,
      keyword: 'ok',
      tls_warn_days: 14,
    });
    const tcp = buildCreateBody(form({ type: 'tcp' }));
    expect(tcp).not.toHaveProperty('expect_status');
    expect(tcp).not.toHaveProperty('tls_warn_days');
    expect(buildCreateBody(form({ type: 'tls', tlsWarnDays: '30' }))).toMatchObject({ target: 'example.com', tls_warn_days: 30 });
    // Empty expected status means any 2xx or 3xx (0 on the wire).
    expect(buildCreateBody(form()).expect_status).toBe(0);
  });

  it('patches only what changed', () => {
    const check = makeCheck({ id: 4, name: 'API', target: 'https://api.example.com/health', channel_ids: [2, 1] });
    expect(buildUpdateBody(check, formFromCheck(check))).toEqual({});
    expect(buildUpdateBody(check, { ...formFromCheck(check), channelIds: [1, 2] })).toEqual({});
    expect(buildUpdateBody(check, { ...formFromCheck(check), name: 'API v2', intervalSeconds: 300 })).toEqual({ name: 'API v2', interval_seconds: 300 });
  });

  it('lists intervals under the plan minimum as disabled', () => {
    const options = intervalOptions(60, 60);
    expect(options.find((option) => option.value === 30)).toMatchObject({ disabled: true });
    expect(options.find((option) => option.value === 60)).toMatchObject({ disabled: false, label: '1 min' });
    // A legacy interval stays selectable in the list (and is then flagged by validation).
    expect(intervalOptions(0, 45).some((option) => option.value === 45)).toBe(true);
  });
});

describe('plan limits and quota', () => {
  it('reads the plan, and enforces nothing without check fields', () => {
    expect(checkLimits(undefined)).toEqual({ minIntervalSeconds: 0 });
    const plan = { name: 'Free', min_check_interval_seconds: 60, max_checks: 3 };
    expect(checkLimits(plan)).toEqual({ minIntervalSeconds: 60, planName: 'Free' });
    expect(checkQuota(plan, { checks: 3 }, 1)).toMatchObject({ used: 3, limit: 3, atLimit: true });
    expect(checkQuota(plan, {}, 2)).toMatchObject({ used: 2, atLimit: false });
    expect(checkQuota({ name: 'Legacy', max_checks: 0 }, { checks: 40 }, 40)).toMatchObject({ atLimit: false });
    expect(checkQuota({ name: 'Old' }, undefined, 2)).toBeNull();
  });

  it('summarises the list', () => {
    const base = { all: 0, down: 0, degraded: 0, pending: 0, paused: 0, up: 0 };
    expect(checksSummary(base)).toBe('No checks yet');
    expect(checksSummary({ ...base, all: 3, up: 3 })).toBe('3 checks, all up');
    expect(checksSummary({ ...base, all: 8, down: 1, degraded: 1, up: 6 })).toBe('8 checks · 1 down · 1 degraded');
  });
});

describe('results chart shaping', () => {
  const points = [
    { t: '2026-11-15T13:00:00Z', up_pct: 100, latency_avg: 200, latency_max: 400 },
    { t: 'garbage', up_pct: 50, latency_avg: 1, latency_max: 1 },
    { t: '2026-11-15T12:00:00Z', up_pct: 90, latency_avg: 300, latency_max: 1300 },
    { t: '2026-11-15T14:00:00Z', up_pct: null, latency_avg: null, latency_max: null },
  ];

  it('sorts oldest first, drops bad times and keeps gaps', () => {
    const rows = resultRows(points);
    expect(rows.map((row) => row.up)).toEqual([90, 100, null]);
  });

  it('gives the last step of each run its full width', () => {
    const hour = 3600;
    const lone = resultRows([{ t: '2026-11-15T18:15:00Z', up_pct: 0, latency_avg: null, latency_max: null }]);
    const drawn = stepRows(lone, 900);
    expect(drawn).toHaveLength(2);
    expect(drawn[1]).toMatchObject({ up: 0, start: Date.parse('2026-11-15T18:15:00Z'), ts: Date.parse('2026-11-15T18:30:00Z') - 1 });

    // 12:00 and 13:00 form one run (closed once, after 13:00); 14:00 is a gap.
    const run = stepRows(resultRows(points), hour);
    expect(run.map((row) => row.up)).toEqual([90, 100, 100, null]);
    expect(run[2]?.ts).toBe(Date.parse('2026-11-15T14:00:00Z') - 1);
    expect(stepRows(lone, 0)).toEqual(lone);
  });

  it('summarises uptime and latency over the range', () => {
    expect(summarizeResults(resultRows(points))).toEqual({ upPct: 95, avgMs: 250, maxMs: 1300, failingSteps: 1, measuredSteps: 2 });
    expect(summarizeResults([])).toEqual({ upPct: null, avgMs: null, maxMs: null, failingSteps: 0, measuredSteps: 0 });
  });

  it('names failing steps by their size', () => {
    expect(failingStepsLabel({ failingSteps: 0, measuredSteps: 24 }, 3600)).toBeNull();
    expect(failingStepsLabel({ failingSteps: 1, measuredSteps: 24 }, 3600)).toBe('1 hour with failures');
    expect(failingStepsLabel({ failingSteps: 2, measuredSteps: 30 }, 86_400)).toBe('2 days with failures');
    expect(failingStepsLabel({ failingSteps: 10, measuredSteps: 140 }, 600)).toBe('failures in 10 of 140 steps of 10 min');
  });

  it('rounds the latency axis to a readable top', () => {
    expect(latencyAxisMax(resultRows(points))).toBe(1500);
    expect(latencyAxisMax([])).toBe(100);
  });
});
