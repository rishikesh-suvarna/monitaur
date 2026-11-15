/** Settings logic: status page address, member permissions, plan copy. Pure, unit tested. */
import type { Member, Org, Plan, Role } from '../../api/types';
import { formatAge, plural } from '../../lib/format';
import { roleAtLeast } from '../../providers/OrgProvider';

// ---------------------------------------------------------------- status page

/** backend api/org.go slugPattern: 3 to 40 chars, starting with a letter or digit. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/;
export const MAX_SLUG_LENGTH = 40;
export const MAX_STATUS_TITLE_LENGTH = 80;
export const MAX_ORG_NAME_LENGTH = 60;
export const MAX_DISPLAY_NAME_LENGTH = 80;
export const STATUS_PATH_PREFIX = '/status/';

/** Lowercases while typing and turns spaces or underscores into dashes. */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

export function slugError(slug: string): string | undefined {
  if (slug === '') return 'Pick an address.';
  if (slug.length < 3) return 'At least 3 characters.';
  if (!SLUG_PATTERN.test(slug)) return 'Lowercase letters, numbers and dashes, starting with a letter or number.';
  return undefined;
}

export function statusPageUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, '')}${STATUS_PATH_PREFIX}${encodeURIComponent(slug)}`;
}

export interface StatusPageForm {
  enabled: boolean;
  title: string;
  slug: string;
  serverIds: number[];
  /** Uptime checks on the page (F7). */
  checkIds: number[];
}

export function statusPageForm(org: Pick<Org, 'slug' | 'status_page'>): StatusPageForm {
  return {
    enabled: org.status_page.enabled,
    title: org.status_page.title,
    slug: org.slug,
    serverIds: [...org.status_page.server_ids],
    checkIds: [...(org.status_page.check_ids ?? [])],
  };
}

const sameIds = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && [...a].sort((x, y) => x - y).every((id, index) => id === [...b].sort((x, y) => x - y)[index]);

export function statusPageDirty(saved: StatusPageForm, form: StatusPageForm): boolean {
  return (
    saved.enabled !== form.enabled ||
    saved.title.trim() !== form.title.trim() ||
    saved.slug !== form.slug ||
    !sameIds(saved.serverIds, form.serverIds) ||
    !sameIds(saved.checkIds, form.checkIds)
  );
}

export interface StatusPagePatch {
  slug?: string;
  status_page: { enabled: boolean; title: string; server_ids: number[]; check_ids: number[] };
}

/**
 * PATCH /org body: status_page replaces the whole config (so check_ids always
 * goes, or a save would drop them); slug only when it changed.
 */
export function statusPagePatch(saved: StatusPageForm, form: StatusPageForm): StatusPagePatch {
  const patch: StatusPagePatch = {
    status_page: { enabled: form.enabled, title: form.title.trim(), server_ids: [...form.serverIds], check_ids: [...form.checkIds] },
  };
  if (form.slug !== saved.slug) patch.slug = form.slug;
  return patch;
}

// ---------------------------------------------------------------- members

export interface MemberPermissions {
  /** PATCH /org/members/:userId is owner only. */
  canChangeRole: boolean;
  /** Admins remove others; nobody but an owner removes an owner. */
  canRemove: boolean;
  /** Anyone may leave, except the personal org they own. */
  canLeave: boolean;
}

export function memberPermissions(viewer: { userId: number; role: Role; personalOrg: boolean }, member: Pick<Member, 'user_id' | 'role'>): MemberPermissions {
  const self = member.user_id === viewer.userId;
  return {
    canChangeRole: viewer.role === 'owner',
    canRemove: !self && roleAtLeast(viewer.role, 'admin') && (member.role !== 'owner' || viewer.role === 'owner'),
    canLeave: self && !viewer.personalOrg,
  };
}

const MS_PER_SECOND = 1000;

/** "expires in 6 d", "expires in 3 h", "expired". */
export function inviteExpiry(expiresAt: string, now: number): string {
  const left = (Date.parse(expiresAt) - now) / MS_PER_SECOND;
  if (!Number.isFinite(left) || left <= 0) return 'expired';
  return `expires in ${formatAge(left)}`;
}

// ---------------------------------------------------------------- profile + plan

/** Firebase provider ids from GET /me. */
export function providerName(provider: string): string {
  switch (provider) {
    case 'google.com':
      return 'Google';
    case 'github.com':
      return 'GitHub';
    case 'password':
      return 'email and password';
    default:
      return provider === '' ? 'email' : provider;
  }
}

export function emailHint(provider: string): string {
  if (provider === 'password' || provider === '') return 'Your sign-in email. It can’t be changed here.';
  return `Managed by your ${providerName(provider)} account.`;
}

const days = (count: number): string => plural(count, 'day');

/** "Metrics are kept 7 days at 1-minute and 30 days at hourly resolution. Agents report at most every 10 s." */
export function retentionText(plan: Pick<Plan, 'retention_1m_days' | 'retention_1h_days' | 'min_interval_seconds'>): string {
  const minute = plan.retention_1m_days > 0 ? days(plan.retention_1m_days) : 'indefinitely';
  const hour = plan.retention_1h_days > 0 ? days(plan.retention_1h_days) : 'indefinitely';
  const interval = plan.min_interval_seconds > 0 ? ` Agents report at most every ${plan.min_interval_seconds} s.` : '';
  return `Metrics are kept ${minute} at 1-minute and ${hour} at hourly resolution.${interval}`;
}
