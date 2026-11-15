/**
 * localStorage / sessionStorage access that never throws (private mode,
 * blocked storage, corrupted JSON all fall back to the default).
 */

export const STORAGE_KEYS = {
  theme: 'monitaur:theme',
  reduceMotion: 'monitaur:reduce-motion',
  currentOrg: 'monitaur:org',
  sidebarCollapsed: 'monitaur:sidebar-collapsed',
  overviewView: 'monitaur:overview-view',
  overviewSort: 'monitaur:overview-sort',
  serverChartLayout: 'monitaur:server-chart-layout',
} as const;

export const SESSION_KEYS = {
  signOutReason: 'monitaur:signout-reason',
  onboardingDismissed: 'monitaur:onboarding-dismissed',
} as const;

type StorageKind = 'local' | 'session';

function getStorage(kind: StorageKind): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStored<T>(key: string, fallback: T, isValid: (value: unknown) => value is T, kind: StorageKind = 'local'): T {
  try {
    const raw = getStorage(kind)?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown, kind: StorageKind = 'local'): void {
  try {
    getStorage(kind)?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the preference just will not persist.
  }
}

export function removeStored(key: string, kind: StorageKind = 'local'): void {
  try {
    getStorage(kind)?.removeItem(key);
  } catch {
    // Ignore: nothing to clean up if storage is unavailable.
  }
}

export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isString = (value: unknown): value is string => typeof value === 'string';
export const isNullableBoolean = (value: unknown): value is boolean | null => value === null || typeof value === 'boolean';

export function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);
}
