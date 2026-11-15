import { describe, expect, it, vi } from 'vitest';

import { APP_CHECK_HEADER, createApiClient, ORG_HEADER, type ApiClientOptions } from './client';
import { ApiError, codeFromStatus, errorFromResponse, isApiError } from './errors';

const BASE_URL = 'https://api.example.test/api/v1';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Harness {
  client: ReturnType<typeof createApiClient>;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  getToken: ReturnType<typeof vi.fn<ApiClientOptions['getToken']>>;
  onUnauthorized: ReturnType<typeof vi.fn<() => void>>;
}

function setup(responses: (() => Response | Promise<Response>)[], options: Partial<ApiClientOptions> = {}): Harness {
  const queue = [...responses];
  const fetchMock = vi.fn<typeof fetch>(() => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    return Promise.resolve(next());
  });
  const getToken = vi.fn<ApiClientOptions['getToken']>((force) => Promise.resolve(force ? 'fresh-token' : 'cached-token'));
  const onUnauthorized = vi.fn<() => void>();
  const client = createApiClient({ baseUrl: BASE_URL, fetch: fetchMock, getToken, onUnauthorized, ...options });
  return { client, fetch: fetchMock, getToken, onUnauthorized };
}

const headerOf = (harness: Harness, call: number, name: string): string | null => {
  const init = harness.fetch.mock.calls[call]?.[1];
  return new Headers(init?.headers).get(name);
};

describe('ApiError parsing', () => {
  it('uses the backend code and message when present', async () => {
    const error = await errorFromResponse(json(403, { error: 'Plan allows 3 servers', code: 'limit_reached' }), 'POST', '/servers');
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'limit_reached', message: 'Plan allows 3 servers', method: 'POST', path: '/servers' });
    expect(error.summary).toBe('POST /servers · Plan allows 3 servers');
  });

  it('falls back to the status when the body has no known code', async () => {
    const error = await errorFromResponse(new Response('<html>Bad gateway</html>', { status: 502 }), 'GET', '/servers');
    expect(error.code).toBe('server_error');
    expect(error.message).toBe('The server had a problem handling the request.');
  });

  it.each([
    [400, 'invalid'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [503, 'server_error'],
  ] as const)('maps HTTP %d to %s', (status, code) => {
    expect(codeFromStatus(status)).toBe(code);
  });
});

describe('createApiClient', () => {
  it('sends the bearer token, org header and JSON body', async () => {
    const harness = setup([() => json(201, { server: { id: 1 } })]);
    await harness.client.request('/servers', { method: 'POST', orgId: 42, body: { name: 'web-01' } });

    const [url, init] = harness.fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/servers`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ name: 'web-01' }));
    expect(headerOf(harness, 0, 'Authorization')).toBe('Bearer cached-token');
    expect(headerOf(harness, 0, ORG_HEADER)).toBe('42');
  });

  it('omits the org header for user-level endpoints and skips empty query values', async () => {
    const harness = setup([() => json(200, { incidents: [] })]);
    await harness.client.request('/incidents', { query: { state: 'open', severity: undefined, limit: 50 } });
    expect(harness.fetch.mock.calls[0]?.[0]).toBe(`${BASE_URL}/incidents?state=open&limit=50`);
    expect(headerOf(harness, 0, ORG_HEADER)).toBeNull();
  });

  it('sends no Authorization header for public endpoints', async () => {
    const harness = setup([() => json(200, { title: 'Status' })]);
    await harness.client.request('/public/status/acme', { auth: false });
    expect(harness.getToken).not.toHaveBeenCalled();
    expect(headerOf(harness, 0, 'Authorization')).toBeNull();
  });

  it('resolves 204 responses to undefined', async () => {
    const harness = setup([() => new Response(null, { status: 204 })]);
    await expect(harness.client.request('/servers/1', { method: 'DELETE', orgId: 1 })).resolves.toBeUndefined();
  });

  it('throws a typed ApiError for error responses', async () => {
    const harness = setup([() => json(403, { error: 'verify first', code: 'email_unverified' })]);
    const error: unknown = await harness.client.request('/me').catch((caught: unknown) => caught);
    expect(isApiError(error) && error.code).toBe('email_unverified');
    expect(harness.onUnauthorized).not.toHaveBeenCalled();
  });

  it('turns a failed fetch into a network ApiError', async () => {
    const harness = setup([() => Promise.reject(new TypeError('Failed to fetch'))]);
    await expect(harness.client.request('/servers')).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('turns a hung request into a timeout ApiError', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      );
      const client = createApiClient({ baseUrl: BASE_URL, fetch: fetchMock, getToken: () => Promise.resolve('t'), onUnauthorized: vi.fn(), timeoutMs: 10_000 });
      const pending = client.request('/servers');
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout', message: 'timed out after 10 s' });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('401 handling', () => {
  it('retries once with a forced token refresh and succeeds', async () => {
    const harness = setup([() => json(401, { code: 'unauthorized', error: 'expired' }), () => json(200, { ok: true })]);
    await expect(harness.client.request('/me')).resolves.toEqual({ ok: true });

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.getToken.mock.calls).toEqual([[false], [true]]);
    expect(headerOf(harness, 1, 'Authorization')).toBe('Bearer fresh-token');
    expect(harness.onUnauthorized).not.toHaveBeenCalled();
  });

  it('signs out after a second 401 and does not retry again', async () => {
    const harness = setup([() => json(401, { code: 'unauthorized' }), () => json(401, { code: 'unauthorized', error: 'revoked' })]);
    await expect(harness.client.request('/servers', { orgId: 1 })).rejects.toMatchObject({ status: 401, code: 'unauthorized' });

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('shares one forced refresh between concurrent 401s', async () => {
    const harness = setup([
      () => json(401, {}),
      () => json(401, {}),
      () => json(200, { a: 1 }),
      () => json(200, { b: 2 }),
    ]);
    await Promise.all([harness.client.request('/a'), harness.client.request('/b')]);
    expect(harness.getToken.mock.calls.filter(([force]) => force)).toHaveLength(1);
  });

  it('signs out when the identity provider refuses to refresh the token', async () => {
    const harness = setup([() => json(401, {})], {
      getToken: (force) => (force ? Promise.reject(new Error('auth/user-token-expired')) : Promise.resolve('stale')),
    });
    await expect(harness.client.request('/me')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(harness.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not sign out when the refresh fails because the network is down', async () => {
    const offline = new ApiError({ status: 0, code: 'network', message: 'offline', method: 'AUTH', path: 'token' });
    const harness = setup([() => json(401, {})], {
      getToken: (force) => (force ? Promise.reject(offline) : Promise.resolve('stale')),
    });
    await expect(harness.client.request('/me')).rejects.toBe(offline);
    expect(harness.onUnauthorized).not.toHaveBeenCalled();
  });

  it('never retries public endpoints', async () => {
    const harness = setup([() => json(401, {})]);
    await expect(harness.client.request('/public/status/x', { auth: false })).rejects.toMatchObject({ status: 401 });
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('Firebase App Check header', () => {
  it('is absent when no App Check provider is configured', async () => {
    const harness = setup([() => json(200, {})]);
    await harness.client.request('/me');
    expect(headerOf(harness, 0, APP_CHECK_HEADER)).toBeNull();
  });

  it('is sent on authenticated requests only when a provider is configured', async () => {
    let calls = 0;
    const harness = setup([() => json(200, {}), () => json(200, {})], {
      getAppCheckToken: () => {
        calls++;
        return Promise.resolve('ac-token');
      },
    });
    await harness.client.request('/me');
    await harness.client.request('/public/status/acme', { auth: false });
    expect(headerOf(harness, 0, APP_CHECK_HEADER)).toBe('ac-token');
    expect(headerOf(harness, 1, APP_CHECK_HEADER)).toBeNull();
    expect(calls).toBe(1);
  });

  it('still sends the request without the header when the provider fails', async () => {
    const harness = setup([() => json(200, { ok: true })], { getAppCheckToken: () => Promise.reject(new Error('recaptcha blocked')) });
    await expect(harness.client.request('/me')).resolves.toEqual({ ok: true });
    expect(headerOf(harness, 0, APP_CHECK_HEADER)).toBeNull();
    expect(headerOf(harness, 0, 'Authorization')).toBe('Bearer cached-token');
  });
});
