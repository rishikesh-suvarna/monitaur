import type { IncidentFilters } from '../api/types';

import { useIncidents } from './api/incidents';

/** Shared filter objects so the sidebar, tab bar and overview hit one cache entry each. */
export const OPEN_INCIDENTS: IncidentFilters = { state: 'open' };
export const ACKED_INCIDENTS: IncidentFilters = { state: 'acked' };

/** Unacknowledged open incidents, for the Alerts nav badge. Null while loading. */
export function useOpenIncidentCount(): number | null {
  const open = useIncidents(OPEN_INCIDENTS);
  return open.data ? open.data.counts.open : null;
}
