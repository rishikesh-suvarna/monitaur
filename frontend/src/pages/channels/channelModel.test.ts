import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/errors';
import type { Channel } from '../../api/types';

import {
  buildCreateBody,
  buildUpdateBody,
  channelStatus,
  deliveryText,
  emptyChannelForm,
  fieldForChannelError,
  parseRecipients,
  summaryLines,
  testOutcome,
  validateChannelForm,
  type ChannelForm,
} from './channelModel';

const channel = (overrides: Partial<Channel> & Pick<Channel, 'type'>): Channel => ({
  id: 1,
  name: 'ops',
  enabled: true,
  summary: {},
  last_delivery_at: null,
  last_delivery_ok: null,
  last_error: null,
  created_at: '2026-11-01T00:00:00Z',
  ...overrides,
});

const form = (overrides: Partial<ChannelForm>): ChannelForm => ({ ...emptyChannelForm('slack'), ...overrides });
const CREATE = { kind: 'create' } as const;
const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc';

describe('channel form validation', () => {
  it('starts with the type as the name and no secrets', () => {
    expect(emptyChannelForm('telegram')).toEqual({ name: 'Telegram', recipients: [], webhookUrl: '', webhookSecret: '', telegramToken: '', telegramChatId: '' });
    expect(emptyChannelForm('slack', channel({ type: 'slack', name: 'ops-alerts' })).name).toBe('ops-alerts');
  });

  it('requires a name of at most 60 characters', () => {
    expect(validateChannelForm('slack', form({ name: ' ', webhookUrl: 'https://hooks.slack.com/services/T/B/x' }), CREATE).name).toBe('Give the channel a name.');
    expect(validateChannelForm('slack', form({ name: 'x'.repeat(61), webhookUrl: 'https://hooks.slack.com/services/T/B/x' }), CREATE).name).toMatch(/60/);
  });

  it('checks email recipients: 1 to 10 valid addresses', () => {
    expect(validateChannelForm('email', form({ recipients: [] }), CREATE).recipients).toBe('Add at least one recipient.');
    expect(validateChannelForm('email', form({ recipients: ['ops@team.dev', 'nope'] }), CREATE).recipients).toBe('nope is not a valid email address.');
    expect(validateChannelForm('email', form({ recipients: Array.from({ length: 11 }, (_, i) => `u${i}@team.dev`) }), CREATE).recipients).toMatch(/10/);
    expect(validateChannelForm('email', form({ recipients: ['ops@team.dev'] }), CREATE)).toEqual({});
  });

  it('accepts only Slack and Discord webhook hosts over https', () => {
    expect(validateChannelForm('slack', form({ webhookUrl: 'https://hooks.slack.com/services/T0/B0/xyz' }), CREATE)).toEqual({});
    expect(validateChannelForm('slack', form({ webhookUrl: 'http://hooks.slack.com/services/x' }), CREATE).webhookUrl).toBe('Use the https:// URL.');
    expect(validateChannelForm('slack', form({ webhookUrl: 'https://hooks.slack.com@evil.test/x' }), CREATE).webhookUrl).toMatch(/hooks\.slack\.com|credentials/);
    expect(validateChannelForm('discord', form({ webhookUrl: 'https://discord.com/api/webhooks/1/abc' }), CREATE)).toEqual({});
    expect(validateChannelForm('discord', form({ webhookUrl: 'https://discord.com/channels/1' }), CREATE).webhookUrl).toMatch(/api\/webhooks/);
    expect(validateChannelForm('discord', form({ webhookUrl: 'not a url' }), CREATE).webhookUrl).toBe('That is not a valid URL.');
  });

  it('allows http or https for generic webhooks and caps the secret', () => {
    expect(validateChannelForm('webhook', form({ webhookUrl: 'http://10.0.0.5:8080/hook' }), CREATE)).toEqual({});
    expect(validateChannelForm('webhook', form({ webhookUrl: 'ftp://x.test' }), CREATE).webhookUrl).toBe('Use an http:// or https:// URL.');
    expect(validateChannelForm('webhook', form({ webhookUrl: 'https://x.test', webhookSecret: 's'.repeat(257) }), CREATE).webhookSecret).toMatch(/256/);
  });

  it('checks the Telegram bot token and chat id formats', () => {
    expect(validateChannelForm('telegram', form({ telegramToken: TOKEN, telegramChatId: '-1001234567' }), CREATE)).toEqual({});
    expect(validateChannelForm('telegram', form({ telegramToken: TOKEN, telegramChatId: '@ops_alerts' }), CREATE)).toEqual({});
    expect(validateChannelForm('telegram', form({ telegramToken: 'abc', telegramChatId: 'ops' }), CREATE)).toEqual({
      telegramToken: 'That bot token looks malformed.',
      telegramChatId: 'Use a numeric chat id or an @username.',
    });
  });
});

describe('editing keeps stored secrets unless new ones are typed', () => {
  const slack = channel({ type: 'slack', name: 'ops', summary: { destination: 'hooks.slack.com/…/abcd' } });
  const signedHook = channel({ type: 'webhook', name: 'hook', summary: { url: 'https://x.test/…', signed: 'yes' } });

  it('accepts an edit with empty secret fields and sends no config', () => {
    const edit = form({ name: 'ops-renamed' });
    expect(validateChannelForm('slack', edit, { kind: 'edit', channel: slack })).toEqual({});
    expect(buildUpdateBody(slack, edit)).toEqual({ name: 'ops-renamed' });
    expect(buildUpdateBody(slack, form({ name: 'ops' }))).toEqual({});
  });

  it('sends config only when new values were entered', () => {
    expect(buildUpdateBody(slack, form({ name: 'ops', webhookUrl: 'https://hooks.slack.com/services/new' }))).toEqual({
      config: { webhook_url: 'https://hooks.slack.com/services/new' },
    });
  });

  it('asks for the signing secret again when a signed webhook gets a new URL', () => {
    const errors = validateChannelForm('webhook', { ...emptyChannelForm('webhook', signedHook), webhookUrl: 'https://y.test/hook' }, { kind: 'edit', channel: signedHook });
    expect(errors.webhookSecret).toMatch(/signing secret again/);
  });

  it('needs the URL with a new secret, and both Telegram fields together', () => {
    const hook = { ...emptyChannelForm('webhook', signedHook), webhookSecret: 'new-secret' };
    expect(validateChannelForm('webhook', hook, { kind: 'edit', channel: signedHook }).webhookUrl).toMatch(/Enter the URL too/);
    const tg = channel({ type: 'telegram', summary: { chat: '-100…567' } });
    expect(validateChannelForm('telegram', { ...emptyChannelForm('telegram', tg), telegramToken: TOKEN }, { kind: 'edit', channel: tg }).telegramChatId).toBe(
      'Enter the chat id.',
    );
  });
});

describe('channel bodies', () => {
  it('builds the per-type config', () => {
    expect(buildCreateBody('email', form({ name: ' Ops email ', recipients: ['a@x.dev', 'b@x.dev'] }))).toEqual({
      type: 'email',
      name: 'Ops email',
      config: { email_to: ['a@x.dev', 'b@x.dev'] },
    });
    expect(buildCreateBody('webhook', form({ name: 'Hook', webhookUrl: ' https://x.test/h ' })).config).toEqual({ webhook_url: 'https://x.test/h' });
    expect(buildCreateBody('webhook', form({ name: 'Hook', webhookUrl: 'https://x.test/h', webhookSecret: 's3cret' })).config).toEqual({
      webhook_url: 'https://x.test/h',
      webhook_secret: 's3cret',
    });
    expect(buildCreateBody('telegram', form({ name: 'TG', telegramToken: TOKEN, telegramChatId: '@ops_alerts' })).config).toEqual({
      telegram_token: TOKEN,
      telegram_chat_id: '@ops_alerts',
    });
  });

  it('splits pasted recipient lists and drops duplicates', () => {
    expect(parseRecipients('a@x.dev, b@x.dev;\nA@x.dev c@x.dev', ['c@x.dev'])).toEqual(['a@x.dev', 'b@x.dev']);
  });

  it('routes API messages to fields', () => {
    expect(fieldForChannelError('slack: webhook url host must be hooks.slack.com')).toBe('webhookUrl');
    expect(fieldForChannelError('recipient 2 is not a valid email address')).toBe('recipients');
    expect(fieldForChannelError('telegram bot token is malformed')).toBe('telegramToken');
    expect(fieldForChannelError('telegram chat id must be a numeric id or an @username')).toBe('telegramChatId');
    expect(fieldForChannelError('boom')).toBeNull();
  });
});

describe('channel cards', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');

  it('formats the redacted summary per type', () => {
    expect(summaryLines(channel({ type: 'email', summary: { recipients: 'ops@team.dev +1' } }))).toEqual(['To: ops@team.dev +1']);
    expect(summaryLines(channel({ type: 'webhook', summary: { url: 'https://hooks.internal.example/…', signed: 'yes' } }))).toEqual([
      'POST https://hooks.internal.example/…',
      'HMAC-SHA256 signed',
    ]);
    expect(summaryLines(channel({ type: 'telegram', summary: { chat: '-100…567' } }))).toEqual(['Chat: -100…567']);
  });

  it('shows disabled, failing and healthy states', () => {
    expect(channelStatus({ enabled: false, last_delivery_ok: false })).toEqual({ status: 'offline', label: 'Connected · disabled', failing: false });
    expect(channelStatus({ enabled: true, last_delivery_ok: false })).toMatchObject({ status: 'warning', failing: true });
    expect(channelStatus({ enabled: true, last_delivery_ok: null }).status).toBe('healthy');
  });

  it('describes the last delivery', () => {
    expect(deliveryText({ last_delivery_at: null, last_delivery_ok: null }, now)).toBe('never fired');
    expect(deliveryText({ last_delivery_at: '2026-11-15T09:00:00Z', last_delivery_ok: true }, now)).toBe('delivered 3 h ago');
    expect(deliveryText({ last_delivery_at: '2026-11-15T10:00:00Z', last_delivery_ok: false }, now)).toBe('failed 2 h ago');
  });

  it('turns test results and a 429 into a message', () => {
    expect(testOutcome({ ok: true }, null)).toEqual({ ok: true, message: 'Test delivered.' });
    expect(testOutcome({ ok: false, error: 'discord: unexpected status 404' }, null)).toEqual({ ok: false, message: 'discord: unexpected status 404' });
    const limited = new ApiError({ status: 429, code: 'rate_limited', message: 'wait', method: 'POST', path: '/channels/1/test' });
    expect(testOutcome(undefined, limited)).toEqual({ ok: false, message: 'Wait a minute before sending another test.' });
  });
});
