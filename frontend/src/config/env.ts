/**
 * Build-time environment, validated once at startup. A missing or malformed
 * value stops the app with a readable message instead of producing requests to
 * `undefined/api/v1`.
 */

export const API_PATH_PREFIX = '/api/v1';
export const AGENT_CONNECT_PATH = '/agent/connect';

export const REQUIRED_KEYS = [
  'VITE_APP_SERVER_URL',
  'VITE_APP_SERVER_WS_URL',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

// Not needed for Firebase Auth, so a missing value is not fatal.
export const OPTIONAL_KEYS = ['VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MESSAGING_SENDER_ID'] as const;

type EnvKey = (typeof REQUIRED_KEYS)[number] | (typeof OPTIONAL_KEYS)[number];
export type EnvSource = Partial<Record<EnvKey, string | undefined>>;

export interface FirebaseEnv {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export interface AppEnv {
  /** Backend origin, no trailing slash, e.g. https://api.example.com */
  serverUrl: string;
  /** `${serverUrl}/api/v1` */
  apiBaseUrl: string;
  /** WebSocket origin agents dial, e.g. wss://api.example.com */
  serverWsUrl: string;
  /** Full agent endpoint written into the agent config. */
  agentEndpoint: string;
  firebase: FirebaseEnv;
}

export class EnvError extends Error {
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(missing: readonly string[], invalid: readonly string[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (invalid.length > 0) parts.push(`invalid ${invalid.join(', ')}`);
    super(`Monitaur is not configured: ${parts.join('; ')}. Set them in .env.development.local or the build environment.`);
    this.name = 'EnvError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

function isUrlWithProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function parseEnv(source: EnvSource): AppEnv {
  const read = (key: EnvKey): string => (source[key] ?? '').trim();
  const missing = REQUIRED_KEYS.filter((key) => read(key) === '');
  const invalid: string[] = [];

  const serverUrl = stripTrailingSlash(read('VITE_APP_SERVER_URL'));
  const serverWsUrl = stripTrailingSlash(read('VITE_APP_SERVER_WS_URL'));
  if (serverUrl !== '' && !isUrlWithProtocol(serverUrl, ['http:', 'https:'])) invalid.push('VITE_APP_SERVER_URL');
  if (serverWsUrl !== '' && !isUrlWithProtocol(serverWsUrl, ['ws:', 'wss:'])) invalid.push('VITE_APP_SERVER_WS_URL');

  if (missing.length > 0 || invalid.length > 0) throw new EnvError(missing, invalid);

  const optional = (key: EnvKey): string | undefined => (read(key) === '' ? undefined : read(key));
  const storageBucket = optional('VITE_FIREBASE_STORAGE_BUCKET');
  const messagingSenderId = optional('VITE_FIREBASE_MESSAGING_SENDER_ID');

  return {
    serverUrl,
    apiBaseUrl: `${serverUrl}${API_PATH_PREFIX}`,
    serverWsUrl,
    agentEndpoint: `${serverWsUrl}${AGENT_CONNECT_PATH}`,
    firebase: {
      apiKey: read('VITE_FIREBASE_API_KEY'),
      authDomain: read('VITE_FIREBASE_AUTH_DOMAIN'),
      projectId: read('VITE_FIREBASE_PROJECT_ID'),
      appId: read('VITE_FIREBASE_APP_ID'),
      ...(storageBucket ? { storageBucket } : {}),
      ...(messagingSenderId ? { messagingSenderId } : {}),
    },
  };
}

let cached: AppEnv | null = null;

/** The validated environment. Throws EnvError on first call if misconfigured. */
export function getEnv(): AppEnv {
  cached ??= parseEnv(import.meta.env);
  return cached;
}
