/** Name, tag and label helpers shared by forms and the shell. */

export const MAX_SERVER_NAME_LENGTH = 64;
export const MAX_TAG_LENGTH = 32;
const MAX_INITIALS = 2;

/** Onboarding.dc.html: lowercase while typing; anything else becomes a dash. */
export function normalizeServerName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, MAX_SERVER_NAME_LENGTH);
}

/** Tags follow the same alphabet as server names: lowercase letters, numbers, dashes. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

/** "Rishikesh Suvarna" -> "RS", "ops@example.com" -> "OE", "rex" -> "RE". */
export function initialsFor(name: string): string {
  const words = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words.map((word) => word.charAt(0)) : Array.from(words[0] ?? '?');
  return letters.slice(0, MAX_INITIALS).join('').toUpperCase();
}

const isApplePlatform = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export function modKeyLabel(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl ${key}`;
}
