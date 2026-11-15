import { ApiError, defaultMessage, errorFromResponse, isApiError } from './errors';

export const ORG_HEADER = 'X-Monitaur-Org';
export const DEFAULT_TIMEOUT_MS = 10_000;

const HTTP_UNAUTHORIZED = 401;
const HTTP_NO_CONTENT = 204;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;

export interface ApiClientOptions {
  /** e.g. https://api.example.com/api/v1 */
  baseUrl: string;
  /**
   * Returns a bearer token, or null when nobody is signed in. `forceRefresh`
   * asks the identity provider for a fresh token instead of a cached one.
   * Throw an ApiError (e.g. code "network") to surface a specific failure.
   */
  getToken: (forceRefresh: boolean) => Promise<string | null>;
  /** Called once a request is still 401 after a forced token refresh. */
  onUnauthorized: () => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Sent as X-Monitaur-Org. Omit for user-level endpoints such as /me. */
  orgId?: number | null;
  /** Defaults to true. Public endpoints pass false. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Overrides the client timeout; null disables it (streams). */
  timeoutMs?: number | null;
  accept?: string;
}

export interface ApiClient {
  /** JSON request. Resolves to undefined for 204 responses. */
  request: <T>(path: string, options?: RequestOptions) => Promise<T>;
  /** Resolves to a 2xx Response (body unread); throws ApiError otherwise. */
  requestRaw: (path: string, options?: RequestOptions) => Promise<Response>;
}

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

interface Deadline {
  signal: AbortSignal | undefined;
  timedOut: () => boolean;
  clear: () => void;
}

/** Combines the caller's signal with a timeout without needing AbortSignal.any. */
function withDeadline(callerSignal: AbortSignal | undefined, timeoutMs: number | null): Deadline {
  if (timeoutMs === null) return { signal: callerSignal, timedOut: () => false, clear: () => undefined };
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  const forward = (): void => {
    controller.abort();
  };
  if (callerSignal?.aborted) controller.abort();
  callerSignal?.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => expired,
    clear: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forward);
    },
  };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clientTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Concurrent 401s share one forced refresh instead of each hitting the IdP.
  let refreshing: Promise<string | null> | null = null;
  const refreshToken = (): Promise<string | null> => {
    refreshing ??= options.getToken(true).finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const unauthorized = (method: string, path: string, cause?: unknown): ApiError =>
    new ApiError({ status: HTTP_UNAUTHORIZED, code: 'unauthorized', message: defaultMessage('unauthorized'), method, path, cause });

  async function tokenOrThrow(forceRefresh: boolean, method: string, path: string): Promise<string> {
    let token: string | null;
    try {
      token = forceRefresh ? await refreshToken() : await options.getToken(false);
    } catch (error) {
      if (isApiError(error)) throw error;
      // The identity provider refused to issue a token: the session is gone.
      options.onUnauthorized();
      throw unauthorized(method, path, error);
    }
    if (token === null) throw unauthorized(method, path);
    return token;
  }

  async function send(path: string, opts: RequestOptions, forceRefresh: boolean): Promise<Response> {
    const method = opts.method ?? 'GET';
    const headers = new Headers({ Accept: opts.accept ?? 'application/json' });
    if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
    if (opts.auth ?? true) headers.set('Authorization', `Bearer ${await tokenOrThrow(forceRefresh, method, path)}`);
    if (opts.orgId !== undefined && opts.orgId !== null) headers.set(ORG_HEADER, String(opts.orgId));

    const deadline = withDeadline(opts.signal, opts.timeoutMs === undefined ? clientTimeout : opts.timeoutMs);
    try {
      return await fetchImpl(buildUrl(options.baseUrl, path, opts.query), {
        method,
        headers,
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
        signal: deadline.signal ?? null,
      });
    } catch (error) {
      if (deadline.timedOut()) {
        const seconds = Math.round((opts.timeoutMs ?? clientTimeout) / 1000);
        throw new ApiError({ status: 0, code: 'timeout', message: `timed out after ${seconds} s`, method, path, cause: error });
      }
      if (opts.signal?.aborted) {
        throw new ApiError({ status: 0, code: 'aborted', message: defaultMessage('aborted'), method, path, cause: error });
      }
      throw new ApiError({ status: 0, code: 'network', message: defaultMessage('network'), method, path, cause: error });
    } finally {
      deadline.clear();
    }
  }

  async function requestRaw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const method = opts.method ?? 'GET';
    const authenticated = opts.auth ?? true;
    let response = await send(path, opts, false);

    if (response.status === HTTP_UNAUTHORIZED && authenticated) {
      // One retry with a forced refresh covers an expired cached token.
      void response.body?.cancel().catch(() => undefined);
      response = await send(path, opts, true);
      if (response.status === HTTP_UNAUTHORIZED) {
        // Still rejected: sign out. Never reload the page, which could loop.
        options.onUnauthorized();
        throw await errorFromResponse(response, method, path);
      }
    }

    if (!response.ok) throw await errorFromResponse(response, method, path);
    return response;
  }

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const response = await requestRaw(path, opts);
    if (response.status === HTTP_NO_CONTENT) return undefined as T;
    const text = await response.text();
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ApiError({ status: response.status, code: 'bad_response', message: defaultMessage('bad_response'), method, path, cause: error });
    }
  }

  return { request, requestRaw };
}
