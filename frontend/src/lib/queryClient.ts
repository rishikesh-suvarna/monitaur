import { QueryClient } from '@tanstack/react-query';

import { isApiError } from '../api/errors';

const MAX_RETRIES = 2;
const DEFAULT_STALE_MS = 10_000;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

/** Retry network and 5xx failures; a 4xx will not fix itself (except 429). */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (!isApiError(error)) return true;
  if (error.code === 'rate_limited') return true;
  if (error.code === 'aborted') return false;
  return error.status === 0 || error.status >= HTTP_SERVER_ERROR_MIN || error.status < HTTP_CLIENT_ERROR_MIN;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      staleTime: DEFAULT_STALE_MS,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});
