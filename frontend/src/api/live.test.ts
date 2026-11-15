import { describe, expect, it } from 'vitest';

import { backoffDelay, BACKOFF_MAX_MS } from '../lib/backoff';
import { makeCheck, makeIncident, makeServer } from '../test/fixtures';

import {
  bumpCheckOpenIncidents,
  CHECK_SPARK_POINTS,
  incidentMatches,
  openIncidentDelta,
  patchChecksList,
  patchIncidentsList,
  patchServerDetail,
  patchServersList,
} from './cachePatches';
import { createSseParser, type SseMessage } from './sse';
import type { IncidentsResponse, StreamCheckUpdate } from './types';

describe('SSE parser', () => {
  const collect = () => {
    const messages: SseMessage[] = [];
    const comments: string[] = [];
    const parser = createSseParser({
      onMessage: (message) => messages.push(message),
      onComment: (text) => comments.push(text),
    });
    return { parser, messages, comments };
  };

  it('parses named events with JSON data and ignores pings', () => {
    const { parser, messages, comments } = collect();
    parser.push('event: servers\ndata: {"servers":[]}\n\n: ping\n\nevent: incident\ndata: {"action":"opened"}\n\n');
    expect(messages).toEqual([
      { event: 'servers', data: '{"servers":[]}' },
      { event: 'incident', data: '{"action":"opened"}' },
    ]);
    expect(comments).toEqual(['ping']);
  });

  it('reassembles events split across chunks, including a split CRLF', () => {
    const { parser, messages } = collect();
    parser.push('event: serv');
    parser.push('ers\r');
    parser.push('\ndata: {"a"');
    parser.push(':1}\r\n\r\n');
    expect(messages).toEqual([{ event: 'servers', data: '{"a":1}' }]);
  });

  it('joins multi-line data and defaults the event name', () => {
    const { parser, messages } = collect();
    parser.push('data: line one\ndata: line two\n\n');
    expect(messages).toEqual([{ event: 'message', data: 'line one\nline two' }]);
  });
});

describe('reconnect backoff', () => {
  it('doubles from 1 s and caps at 30 s', () => {
    const noJitter = () => 0.5;
    expect([1, 2, 3, 4, 10].map((attempt) => backoffDelay(attempt, noJitter))).toEqual([1000, 2000, 4000, 8000, BACKOFF_MAX_MS]);
  });

  it('applies at most 20% jitter', () => {
    expect(backoffDelay(1, () => 0)).toBe(800);
    expect(backoffDelay(1, () => 1)).toBe(1200);
  });
});

describe('servers cache patch', () => {
  it('merges live fields and keeps untouched rows by reference', () => {
    const a = makeServer({ id: 1, name: 'a', status: 'healthy' });
    const b = makeServer({ id: 2, name: 'b' });
    const current = { servers: [a, b] };
    const { next, unknownIds } = patchServersList(current, [
      { id: 1, status: 'critical', connected: true, last_seen: '2026-11-15T14:30:00Z', latest: null },
      { id: 99, status: 'healthy', connected: true, last_seen: null, latest: null },
    ]);
    expect(next.servers[0]).toMatchObject({ id: 1, status: 'critical', last_seen: '2026-11-15T14:30:00Z' });
    expect(next.servers[1]).toBe(b);
    expect(unknownIds).toEqual([99]);
  });

  it('returns the same object when nothing changed', () => {
    const a = makeServer({ id: 1, name: 'a' });
    const current = { servers: [a] };
    const { next } = patchServersList(current, [
      { id: 1, status: a.status, connected: a.connected, last_seen: a.last_seen, latest: a.latest },
    ]);
    expect(next).toBe(current);
  });

  it('picks up an agent version reported after the list was cached', () => {
    const a = makeServer({ id: 1, name: 'a', agent_version: '' });
    const current = { servers: [a] };
    const live = { id: 1, status: a.status, connected: true, last_seen: a.last_seen, latest: a.latest };
    const { next } = patchServersList(current, [{ ...live, agent_version: 'v2.0.0' }]);
    expect(next.servers[0]?.agent_version).toBe('v2.0.0');
    // Older backends omit the field: keep what the cache had.
    const { next: kept } = patchServersList(next, [live]);
    expect(kept.servers[0]?.agent_version).toBe('v2.0.0');
  });

  it('follows a maintenance window starting and ending, in the list and the detail', () => {
    const a = makeServer({ id: 1, name: 'a', maintenance: false });
    const live = { id: 1, status: a.status, connected: a.connected, last_seen: a.last_seen, latest: a.latest };
    const started = patchServersList({ servers: [a] }, [{ ...live, maintenance: true }]).next;
    expect(started.servers[0]?.maintenance).toBe(true);
    expect(patchServersList(started, [{ ...live, maintenance: false }]).next.servers[0]?.maintenance).toBe(false);

    const detail = { server: a, token: { prefix: 'mt_live_ab', created_at: a.created_at, last_used_at: null }, counts: { incidents: 0, rules: 0, metrics_days: 0 } };
    expect(patchServerDetail(detail, { ...live, maintenance: true }).server.maintenance).toBe(true);
  });

  it('keeps the cached maintenance flag when an older backend leaves it out', () => {
    const a = makeServer({ id: 1, name: 'a', maintenance: true });
    const current = { servers: [a] };
    const { next } = patchServersList(current, [{ id: 1, status: a.status, connected: a.connected, last_seen: a.last_seen, latest: a.latest }]);
    expect(next).toBe(current);
    expect(next.servers[0]?.maintenance).toBe(true);
  });
});

describe('incidents cache patch', () => {
  const counts = { open: 1, acked: 0, resolved_24h: 0 };

  it('moves an acknowledged incident out of the open list and fixes counts', () => {
    const open = makeIncident({ id: 5, server_id: 1, state: 'open' });
    const list: IncidentsResponse = { incidents: [open], counts };
    const next = patchIncidentsList(list, { state: 'open' }, { ...open, state: 'acked' }, open);
    expect(next.incidents).toEqual([]);
    expect(next.counts).toEqual({ open: 0, acked: 1, resolved_24h: 0 });
  });

  it('adds a newly opened incident to a matching first page only', () => {
    const fresh = makeIncident({ id: 9, server_id: 1 });
    const empty: IncidentsResponse = { incidents: [], counts: { open: 0, acked: 0, resolved_24h: 0 } };
    expect(patchIncidentsList(empty, { state: 'open' }, fresh, undefined).incidents).toEqual([fresh]);
    expect(patchIncidentsList(empty, { state: 'open', before: 5 }, fresh, undefined).incidents).toEqual([]);
    expect(patchIncidentsList(empty, { state: 'resolved' }, fresh, undefined).incidents).toEqual([]);
  });

  it('computes the open_incidents change for a server', () => {
    const open = makeIncident({ id: 1, server_id: 1 });
    expect(openIncidentDelta({ action: 'opened', incident: open }, undefined)).toBe(1);
    expect(openIncidentDelta({ action: 'resolved', incident: { ...open, state: 'resolved' } }, open)).toBe(-1);
    expect(openIncidentDelta({ action: 'updated', incident: { ...open, state: 'acked' } }, open)).toBe(0);
  });
});

describe('checks cache patch', () => {
  const result = (at: string, latency: number) => ({ at, ok: true, latency_ms: latency, status_code: 200, error: null });
  const live = (patch: Partial<StreamCheckUpdate> & Pick<StreamCheckUpdate, 'id'>): StreamCheckUpdate => ({
    status: 'up',
    last: null,
    uptime_24h: null,
    tls_days_left: null,
    maintenance: false,
    ...patch,
  });

  it('merges live fields, keeps untouched rows by reference and reports unknown ids', () => {
    const a = makeCheck({ id: 1, name: 'api' });
    const b = makeCheck({ id: 2, name: 'site' });
    const current = { checks: [a, b] };
    const { next, unknownIds } = patchChecksList(current, [
      live({ id: 1, status: 'down', uptime_24h: 98.5, maintenance: true, tls_days_left: 30 }),
      live({ id: 42 }),
    ]);
    expect(next.checks[0]).toMatchObject({ id: 1, status: 'down', uptime_24h: 98.5, maintenance: true, tls_days_left: 30 });
    expect(next.checks[1]).toBe(b);
    expect(unknownIds).toEqual([42]);
  });

  it('returns the same object when nothing changed', () => {
    const last = result('2026-11-15T14:00:00Z', 120);
    const current = { checks: [makeCheck({ id: 1, name: 'api', last, latency_spark: [120] })] };
    const { next } = patchChecksList(current, [live({ id: 1, last: { ...last } })]);
    expect(next).toBe(current);
  });

  it('appends a newer result to the latency sparkline, capped at 30 points', () => {
    const spark = Array.from({ length: CHECK_SPARK_POINTS }, (_, index) => index);
    const current = { checks: [makeCheck({ id: 1, name: 'api', last: result('2026-11-15T14:00:00Z', 29), latency_spark: spark })] };
    const { next } = patchChecksList(current, [live({ id: 1, last: result('2026-11-15T14:01:00Z', 250) })]);
    const updated = next.checks[0]!;
    expect(updated.latency_spark).toHaveLength(CHECK_SPARK_POINTS);
    expect(updated.latency_spark.at(-1)).toBe(250);
    expect(updated.latency_spark[0]).toBe(1);
    // Same result again (or an older one): no second append.
    const { next: again } = patchChecksList(next, [live({ id: 1, status: 'degraded', last: result('2026-11-15T14:01:00Z', 250) })]);
    expect(again.checks[0]!.latency_spark).toEqual(updated.latency_spark);
  });

  it('moves a check’s open incident count', () => {
    const current = { checks: [makeCheck({ id: 1, name: 'api', open_incidents: 1 })] };
    expect(bumpCheckOpenIncidents(current, 1, 1).checks[0]!.open_incidents).toBe(2);
    expect(bumpCheckOpenIncidents(current, 1, -5).checks[0]!.open_incidents).toBe(0);
    expect(bumpCheckOpenIncidents(current, 9, 1)).toBe(current);
  });

  it('matches incidents to a check filter', () => {
    const incident = makeIncident({ id: 1, server_id: null, check_id: 7, metric: 'http' });
    expect(incidentMatches(incident, { check_id: 7 })).toBe(true);
    expect(incidentMatches(incident, { check_id: 8 })).toBe(false);
    expect(incidentMatches(incident, { server_id: 1 })).toBe(false);
  });
});
