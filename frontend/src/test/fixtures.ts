/**
 * Builders for test data. They only fill required fields with neutral values;
 * tests state the fields they care about explicitly.
 */
import type { Check, Incident, MaintenanceWindow, ServerLatest, ServerSummary } from '../api/types';

/**
 * A live sample as an older agent sends it: the section 6.1 host metrics are
 * null and the mount and interface lists empty.
 */
export function makeLatest(overrides: Partial<ServerLatest> = {}): ServerLatest {
  return {
    cpu: 0,
    mem: 0,
    disk: 0,
    net_in: 0,
    net_out: 0,
    mem_total: 0,
    mem_used: 0,
    disk_total: 0,
    disk_used: 0,
    cpu_cores: 0,
    uptime_s: 0,
    at: '2026-11-15T14:00:00Z',
    load1: null,
    load5: null,
    load15: null,
    swap: null,
    swap_total: null,
    swap_used: null,
    disk_read: null,
    disk_write: null,
    mounts: [],
    interfaces: [],
    ...overrides,
  };
}

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
    maintenance: false,
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
    check_id: null,
    check_name: null,
    silenced: false,
    ...overrides,
  };
}

export function makeCheck(overrides: Partial<Check> & Pick<Check, 'id' | 'name'>): Check {
  return {
    type: 'http',
    target: 'https://example.test/health',
    interval_seconds: 60,
    timeout_seconds: 10,
    expect_status: 0,
    keyword: '',
    tls_warn_days: 14,
    enabled: true,
    channel_ids: [],
    status: 'up',
    last: null,
    uptime_24h: null,
    latency_spark: [],
    tls_days_left: null,
    open_incidents: 0,
    maintenance: false,
    created_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

export function makeWindow(
  overrides: Partial<MaintenanceWindow> & Pick<MaintenanceWindow, 'id' | 'starts_at' | 'ends_at'>,
): MaintenanceWindow {
  return {
    name: `window-${overrides.id}`,
    scope: { all: true, server_ids: [], tags: [], check_ids: [] },
    created_by: null,
    created_at: '2026-11-01T00:00:00Z',
    state: 'scheduled',
    ...overrides,
  };
}
