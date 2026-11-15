/**
 * Builders for test data. They only fill required fields with neutral values;
 * tests state the fields they care about explicitly.
 */
import type { Incident, ServerSummary } from '../api/types';

export function makeServer(overrides: Partial<ServerSummary> & Pick<ServerSummary, 'id' | 'name'>): ServerSummary {
  return {
    tags: [],
    pinned: false,
    status: 'healthy',
    connected: true,
    last_seen: '2026-11-15T14:00:00Z',
    agent_version: '',
    latest: null,
    spark: { cpu: [], mem: [], disk: [] },
    open_incidents: 0,
    created_at: '2026-11-01T00:00:00Z',
    thresholds: {},
    ...overrides,
  };
}

export function makeIncident(overrides: Partial<Incident> & Pick<Incident, 'id' | 'server_id'>): Incident {
  return {
    server_name: `server-${overrides.server_id}`,
    rule_id: 1,
    rule_name: 'rule',
    metric: 'cpu',
    severity: 'warning',
    state: 'open',
    comparison: 'above',
    threshold: 80,
    peak: 90,
    last_value: 90,
    unit: '%',
    samples_over: 1,
    started_at: '2026-11-15T14:00:00Z',
    resolved_at: null,
    resolved_how: null,
    acked_at: null,
    acked_by: null,
    last_notified_at: null,
    notified_channels: [],
    next_notify_at: null,
    ...overrides,
  };
}
