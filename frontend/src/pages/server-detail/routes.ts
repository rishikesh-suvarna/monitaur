/** Paths, route params and small labels shared by the server detail and settings pages. */
import type { SeriesRange } from '../../api/types';
import { EMPTY_VALUE } from '../../lib/format';
import { TIME_RANGES } from '../../lib/ranges';

export type ServerTab = 'metrics' | 'processes' | 'alerts' | 'settings';

export const VIEWER_EDIT_REASON = 'Viewers can’t edit servers. Ask an admin for the member role.';

/** ServerDetail.dc.html opens on 6 h. */
export const DEFAULT_RANGE: SeriesRange = '6h';
export const RANGE_PARAM = 'range';
export const TAB_PARAM = 'tab';

const POSITIVE_INT = /^[1-9]\d*$/;

export const serverDetailPath = (serverId: number): string => `/servers/${serverId}`;
export const serverAlertsTabPath = (serverId: number): string => `/servers/${serverId}?${TAB_PARAM}=alerts`;
export const serverProcessesTabPath = (serverId: number): string => `/servers/${serverId}?${TAB_PARAM}=processes`;
export const serverSettingsPath = (serverId: number): string => `/servers/${serverId}/settings`;
/** The Alerts page with this server preselected, every state. */
export const alertsForServer = (serverId: number): string => `/alerts?server=${serverId}&state=all`;

/** The :id route param as a server id, or null when it cannot be one. */
export function parseServerId(raw: string | undefined): number | null {
  if (raw === undefined || !POSITIVE_INT.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export function parseTab(raw: string | null): Exclude<ServerTab, 'settings'> {
  if (raw === 'alerts' || raw === 'processes') return raw;
  return 'metrics';
}

export function parseRange(raw: string | null): SeriesRange {
  return TIME_RANGES.find((range) => range === raw) ?? DEFAULT_RANGE;
}

/** "v0.9.4", tolerating versions that already carry the v. */
export function agentVersionLabel(version: string): string {
  const trimmed = version.trim();
  if (trimmed === '') return EMPTY_VALUE;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}
