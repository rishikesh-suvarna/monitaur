import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../api';
import { bumpOpenIncidents, openIncidentDelta, patchServerDetail, patchServersList } from '../api/cachePatches';
import { isApiError } from '../api/errors';
import { queryKeys } from '../api/queryKeys';
import { createSseParser, type SseMessage } from '../api/sse';
import { backoffDelay } from '../lib/backoff';
import type {
  IncidentStreamEvent,
  ServerDetailResponse,
  ServersResponse,
  ServersStreamEvent,
} from '../api/types';

import { findCachedIncident, writeIncidentToCaches } from './api/incidents';

/** The server pings every 15 s; three missed pings means the stream is dead. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

export type LiveConnectionState = 'connecting' | 'open' | 'reconnecting' | 'offline';

export interface LiveStreamStatus {
  state: LiveConnectionState;
  /** ms epoch of the last `servers` event: drives "updated 2s ago". */
  lastServersAt: number | null;
  /** ms epoch when the next reconnect attempt fires, while reconnecting. */
  retryAt: number | null;
  /** Consecutive failed attempts. */
  attempt: number;
}

const INITIAL_STATUS: LiveStreamStatus = { state: 'connecting', lastServersAt: null, retryAt: null, attempt: 0 };

/** Errors the stream cannot recover from by retrying (auth is handled elsewhere). */
const isTerminal = (error: unknown): boolean =>
  isApiError(error) && (error.code === 'unauthorized' || error.code === 'forbidden' || error.code === 'email_unverified');

function applyServersEvent(queryClient: QueryClient, orgId: number, payload: ServersStreamEvent): void {
  const listKey = queryKeys.serversList(orgId);
  const list = queryClient.getQueryData<ServersResponse>(listKey);
  if (list) {
    const { next, unknownIds } = patchServersList(list, payload.servers);
    if (next !== list) queryClient.setQueryData(listKey, next);
    // A server we have never seen was created elsewhere: fetch the full row.
    if (unknownIds.length > 0) void queryClient.invalidateQueries({ queryKey: listKey });
  }
  for (const update of payload.servers) {
    const detailKey = queryKeys.server(orgId, update.id);
    const detail = queryClient.getQueryData<ServerDetailResponse>(detailKey);
    if (detail) queryClient.setQueryData(detailKey, patchServerDetail(detail, update));
  }
}

function applyIncidentEvent(queryClient: QueryClient, orgId: number, payload: IncidentStreamEvent): void {
  const previous = findCachedIncident(queryClient, orgId, payload.incident.id);
  writeIncidentToCaches(queryClient, orgId, payload.incident);
  const listKey = queryKeys.serversList(orgId);
  const list = queryClient.getQueryData<ServersResponse>(listKey);
  if (list) queryClient.setQueryData(listKey, bumpOpenIncidents(list, payload.incident.server_id, openIncidentDelta(payload, previous)));
  // Patched in place; mark stale so the next mount refetches exact counts.
  void queryClient.invalidateQueries({ queryKey: queryKeys.incidentsAll(orgId), refetchType: 'none' });
}

function sleep(ms: number, signal: AbortSignal, wake: EventTarget, wakeEvent: string): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      wake.removeEventListener(wakeEvent, done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    wake.addEventListener(wakeEvent, done, { once: true });
  });
}

/**
 * Keeps one SSE connection to GET /stream for the org (fetch-based, so it can
 * send the Authorization header) and patches the servers and incidents caches
 * from `servers` and `incident` events. Reconnects with exponential backoff,
 * immediately when the browser comes back online. Mount it once: the app does
 * so in <LiveStreamProvider>; read its state with useLiveStatus().
 */
export function useLiveStream(orgId: number, enabled = true): LiveStreamStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStreamStatus>(INITIAL_STATUS);

  useEffect(() => {
    if (!enabled) return undefined;
    const lifetime = new AbortController();
    // A function, so TypeScript does not narrow `aborted` to false inside the loop.
    const stopped = (): boolean => lifetime.signal.aborted;
    setStatus(INITIAL_STATUS);

    const handleMessage = (message: SseMessage): void => {
      try {
        if (message.event === 'servers') {
          applyServersEvent(queryClient, orgId, JSON.parse(message.data) as ServersStreamEvent);
          setStatus((current) => ({ ...current, lastServersAt: Date.now() }));
        } else if (message.event === 'incident') {
          applyIncidentEvent(queryClient, orgId, JSON.parse(message.data) as IncidentStreamEvent);
        }
      } catch (error) {
        // One malformed event must not kill the stream.
        console.warn('Ignoring malformed live event', message.event, error);
      }
    };

    const connectOnce = async (onOpen: () => void): Promise<void> => {
      const attempt = new AbortController();
      const cancel = (): void => {
        attempt.abort();
      };
      lifetime.signal.addEventListener('abort', cancel, { once: true });
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(cancel, STREAM_IDLE_TIMEOUT_MS);
      };
      try {
        const response = await api.stream(orgId, attempt.signal);
        if (!response.body) throw new Error('Stream response has no body');
        onOpen();
        resetIdle();
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        const parser = createSseParser({ onMessage: handleMessage });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          resetIdle();
          parser.push(value);
        }
      } finally {
        clearTimeout(idleTimer);
        lifetime.signal.removeEventListener('abort', cancel);
      }
    };

    const run = async (): Promise<void> => {
      let failures = 0;
      let connectedBefore = false;
      while (!stopped()) {
        try {
          await connectOnce(() => {
            // After a gap, events may have been missed: resync once.
            if (connectedBefore) {
              void queryClient.invalidateQueries({ queryKey: queryKeys.serversList(orgId) });
              void queryClient.invalidateQueries({ queryKey: queryKeys.incidentsAll(orgId) });
            }
            connectedBefore = true;
            failures = 0;
            setStatus((current) => ({ ...current, state: 'open', retryAt: null, attempt: 0 }));
          });
        } catch (error) {
          if (stopped()) return;
          if (isTerminal(error)) {
            setStatus((current) => ({ ...current, state: 'offline', retryAt: null }));
            return;
          }
        }
        if (stopped()) return;
        failures += 1;
        const delay = backoffDelay(failures);
        setStatus((current) => ({ ...current, state: 'reconnecting', retryAt: Date.now() + delay, attempt: failures }));
        await sleep(delay, lifetime.signal, window, 'online');
      }
    };

    void run();
    return () => {
      lifetime.abort();
    };
  }, [enabled, orgId, queryClient]);

  return status;
}
