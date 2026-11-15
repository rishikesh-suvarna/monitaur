import type { IncidentFilters, SeriesRange } from './types';

/**
 * Query keys. Everything org-scoped starts with ['org', orgId] so a cache entry
 * can never be read under another org. Lists and details sit under different
 * third segments, so invalidating a list never refetches every detail.
 */
export const queryKeys = {
  me: (uid: string) => ['me', uid] as const,

  orgScope: (orgId: number) => ['org', orgId] as const,
  org: (orgId: number) => ['org', orgId, 'detail'] as const,
  members: (orgId: number) => ['org', orgId, 'members'] as const,

  serversList: (orgId: number) => ['org', orgId, 'servers', 'list'] as const,
  serverDetails: (orgId: number) => ['org', orgId, 'servers', 'detail'] as const,
  server: (orgId: number, serverId: number) => ['org', orgId, 'servers', 'detail', serverId] as const,
  serverSeriesAll: (orgId: number, serverId: number) => ['org', orgId, 'servers', 'series', serverId] as const,
  serverSeries: (orgId: number, serverId: number, range: SeriesRange) =>
    ['org', orgId, 'servers', 'series', serverId, range] as const,

  incidentsAll: (orgId: number) => ['org', orgId, 'incidents'] as const,
  incidents: (orgId: number, filters: IncidentFilters) => ['org', orgId, 'incidents', filters] as const,

  rules: (orgId: number) => ['org', orgId, 'rules'] as const,
  channels: (orgId: number) => ['org', orgId, 'channels'] as const,

  publicStatus: (slug: string) => ['public', 'status', slug] as const,
};
