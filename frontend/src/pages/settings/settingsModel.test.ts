import { describe, expect, it } from 'vitest';

import {
  emailHint,
  inviteExpiry,
  memberPermissions,
  normalizeSlug,
  providerName,
  retentionText,
  slugError,
  statusPageDirty,
  statusPageForm,
  statusPagePatch,
  statusPageUrl,
  type StatusPageForm,
} from './settingsModel';

describe('status page address', () => {
  it('normalises typed slugs', () => {
    expect(normalizeSlug('Your Team_Status!')).toBe('your-team-status');
    expect(normalizeSlug('x'.repeat(50))).toHaveLength(40);
  });

  it('validates 3 to 40 lowercase letters, digits and dashes', () => {
    expect(slugError('acme')).toBeUndefined();
    expect(slugError('a1-b2')).toBeUndefined();
    expect(slugError('')).toBe('Pick an address.');
    expect(slugError('ab')).toBe('At least 3 characters.');
    expect(slugError('-acme')).toMatch(/starting with a letter or number/);
  });

  it('builds the public URL from the origin', () => {
    expect(statusPageUrl('https://app.example.test/', 'acme')).toBe('https://app.example.test/status/acme');
  });

  it('sends the whole status page config and the slug only when changed', () => {
    const saved: StatusPageForm = { enabled: false, title: 'Acme', slug: 'acme', serverIds: [2, 1], checkIds: [7] };
    expect(statusPageDirty(saved, { ...saved, serverIds: [1, 2] })).toBe(false);
    expect(statusPageDirty(saved, { ...saved, title: ' Acme ' })).toBe(false);
    expect(statusPageDirty(saved, { ...saved, checkIds: [7, 8] })).toBe(true);
    expect(statusPagePatch(saved, { ...saved, enabled: true, title: ' Acme status ' })).toEqual({
      status_page: { enabled: true, title: 'Acme status', server_ids: [2, 1], check_ids: [7] },
    });
    expect(statusPagePatch(saved, { ...saved, slug: 'acme-status' }).slug).toBe('acme-status');
  });

  it('reads check ids, and none from a backend that predates uptime checks', () => {
    const page = { enabled: true, slug: 'acme', title: 'Acme', server_ids: [1] };
    expect(statusPageForm({ slug: 'acme', status_page: { ...page, check_ids: [4, 5] } }).checkIds).toEqual([4, 5]);
    expect(statusPageForm({ slug: 'acme', status_page: page }).checkIds).toEqual([]);
  });
});

describe('member permissions', () => {
  const member = { user_id: 2, role: 'member' as const };

  it('lets only owners change roles', () => {
    expect(memberPermissions({ userId: 1, role: 'owner', personalOrg: false }, member).canChangeRole).toBe(true);
    expect(memberPermissions({ userId: 1, role: 'admin', personalOrg: false }, member).canChangeRole).toBe(false);
  });

  it('lets admins remove others but not owners, and anyone leave', () => {
    expect(memberPermissions({ userId: 1, role: 'admin', personalOrg: false }, member).canRemove).toBe(true);
    expect(memberPermissions({ userId: 1, role: 'admin', personalOrg: false }, { user_id: 3, role: 'owner' }).canRemove).toBe(false);
    expect(memberPermissions({ userId: 1, role: 'owner', personalOrg: false }, { user_id: 3, role: 'owner' }).canRemove).toBe(true);
    expect(memberPermissions({ userId: 2, role: 'viewer', personalOrg: false }, { user_id: 2, role: 'viewer' })).toEqual({
      canChangeRole: false,
      canRemove: false,
      canLeave: true,
    });
    expect(memberPermissions({ userId: 2, role: 'owner', personalOrg: true }, { user_id: 2, role: 'owner' }).canLeave).toBe(false);
  });

  it('describes invite expiry', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(inviteExpiry('2026-11-21T12:00:00Z', now)).toBe('expires in 6 d');
    expect(inviteExpiry('2026-11-15T09:00:00Z', now)).toBe('expired');
  });
});

describe('profile and plan copy', () => {
  it('names the sign-in provider', () => {
    expect(providerName('google.com')).toBe('Google');
    expect(providerName('password')).toBe('email and password');
    expect(emailHint('google.com')).toBe('Managed by your Google account.');
    expect(emailHint('password')).toMatch(/sign-in email/);
  });

  it('describes retention, treating 0 as unlimited', () => {
    expect(retentionText({ retention_1m_days: 7, retention_1h_days: 30, min_interval_seconds: 10 })).toBe(
      'Metrics are kept 7 days at 1-minute and 30 days at hourly resolution. Agents report at most every 10 s.',
    );
    expect(retentionText({ retention_1m_days: 0, retention_1h_days: 1, min_interval_seconds: 0 })).toBe(
      'Metrics are kept indefinitely at 1-minute and 1 day at hourly resolution.',
    );
  });
});
