import { useQuery } from '@tanstack/react-query';

import { api } from '../../api';
import { queryKeys } from '../../api/queryKeys';

const PUBLIC_STATUS_REFRESH_MS = 60_000;

/** GET /public/status/:slug. No auth; usable outside the org providers. */
export function usePublicStatus(slug: string | undefined) {
  return useQuery({
    queryKey: queryKeys.publicStatus(slug ?? ''),
    queryFn: ({ signal }) => api.publicStatus(slug ?? '', signal),
    enabled: slug !== undefined && slug !== '',
    refetchInterval: PUBLIC_STATUS_REFRESH_MS,
  });
}
