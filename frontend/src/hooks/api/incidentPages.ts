import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { api } from '../../api';
import { queryKeys } from '../../api/queryKeys';
import type { Incident, IncidentCounts, IncidentFilters, IncidentsResponse } from '../../api/types';
import { useOrgId } from '../../providers/OrgProvider';

/** The backend's default page size for GET /incidents (store.defaultIncidentLimit). */
export const INCIDENT_PAGE_SIZE = 50;

export type IncidentPageFilters = Omit<IncidentFilters, 'before' | 'limit'>;

export interface IncidentPagesOptions {
  pageSize?: number;
  enabled?: boolean;
}

export interface IncidentPages {
  /** Every loaded page, in order, without duplicates. */
  incidents: Incident[];
  /** Org-wide counts from the first page. */
  counts: IncidentCounts | undefined;
  isPending: boolean;
  error: unknown;
  isFetching: boolean;
  /** The last page came back full: there may be older incidents. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

interface CombinedPages {
  incidents: Incident[];
  counts: IncidentCounts | undefined;
  firstPending: boolean;
  lastPending: boolean;
  error: unknown;
  isFetching: boolean;
  lastPage: IncidentsResponse | undefined;
  pageCount: number;
  refetchers: (() => unknown)[];
}

function combinePages(results: UseQueryResult<IncidentsResponse>[]): CombinedPages {
  const seen = new Set<number>();
  const incidents: Incident[] = [];
  for (const result of results) {
    for (const incident of result.data?.incidents ?? []) {
      if (seen.has(incident.id)) continue;
      seen.add(incident.id);
      incidents.push(incident);
    }
  }
  const last = results[results.length - 1];
  return {
    incidents,
    counts: results[0]?.data?.counts,
    firstPending: results[0]?.isPending ?? true,
    lastPending: last?.isPending ?? false,
    error: results.find((result) => result.error)?.error ?? null,
    isFetching: results.some((result) => result.isFetching),
    lastPage: last?.data,
    pageCount: results.length,
    refetchers: results.map((result) => result.refetch),
  };
}

/**
 * GET /incidents with cursor pagination (`before` = the last id of the
 * previous page). Each page is an ordinary incidents query, so the live
 * stream and the optimistic ack/resolve patches reach every page; only the
 * first page receives new incidents. With the default page size the first
 * page shares its cache entry with the sidebar and overview (no `limit` key).
 */
export function useIncidentPages(filters: IncidentPageFilters, options: IncidentPagesOptions = {}): IncidentPages {
  const orgId = useOrgId();
  const pageSize = options.pageSize ?? INCIDENT_PAGE_SIZE;
  const enabled = options.enabled ?? true;
  const filtersKey = JSON.stringify([filters, pageSize]);
  const [cursors, setCursors] = useState<{ key: string; before: number[] }>({ key: filtersKey, before: [] });
  // New filters start again from the first page.
  const before = useMemo(() => (cursors.key === filtersKey ? cursors.before : []), [cursors, filtersKey]);

  const pageFilters = useMemo(() => {
    const base = JSON.parse(filtersKey) as [IncidentPageFilters, number];
    return [undefined, ...before].map<IncidentFilters>((cursor) => ({
      ...base[0],
      ...(pageSize === INCIDENT_PAGE_SIZE ? {} : { limit: pageSize }),
      ...(cursor === undefined ? {} : { before: cursor }),
    }));
  }, [filtersKey, before, pageSize]);

  const combined = useQueries({
    queries: pageFilters.map((pageFilter) => ({
      queryKey: queryKeys.incidents(orgId, pageFilter),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.incidents.list(orgId, pageFilter, signal),
      enabled,
    })),
    combine: combinePages,
  });

  const lastIncident = combined.lastPage?.incidents[combined.lastPage.incidents.length - 1];

  const loadMore = useCallback(() => {
    if (lastIncident === undefined) return;
    setCursors((current) => {
      const base = current.key === filtersKey ? current.before : [];
      return base.includes(lastIncident.id) ? current : { key: filtersKey, before: [...base, lastIncident.id] };
    });
  }, [filtersKey, lastIncident]);

  const { refetchers } = combined;
  const refetch = useCallback(() => {
    for (const run of refetchers) void run();
  }, [refetchers]);

  return {
    incidents: combined.incidents,
    counts: combined.counts,
    isPending: enabled && combined.firstPending,
    error: combined.error,
    isFetching: combined.isFetching,
    hasMore: combined.lastPage !== undefined && combined.lastPage.incidents.length >= pageSize,
    loadingMore: combined.pageCount > 1 && combined.lastPending,
    loadMore,
    refetch,
  };
}
