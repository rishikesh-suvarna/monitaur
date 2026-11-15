/**
 * Notification channel forms and card text (Channels.dc.html). Validation
 * mirrors backend notify.Channel.Validate so most mistakes are caught before
 * the request. Secrets are write-only: editing starts with empty secret
 * fields, and `config` is sent only when the user typed new values.
 */
import { isApiError } from '../../api/errors';
import type { Channel, ChannelConfig, ChannelTestResponse, ChannelType, CreateChannelBody, ServerStatus, UpdateChannelBody } from '../../api/types';
import { CHANNEL_TYPE_LABELS } from '../../lib/channels';
import { isEmail } from '../../lib/email';
import { formatRelativeTime } from '../../lib/format';

export const MAX_CHANNEL_NAME_LENGTH = 60;
export const MIN_EMAIL_RECIPIENTS = 1;
export const MAX_EMAIL_RECIPIENTS = 10;
export const MAX_WEBHOOK_SECRET_LENGTH = 256;
export const MAX_URL_LENGTH = 2048;

const SLACK_HOST = 'hooks.slack.com';
const DISCORD_HOSTS = ['discord.com', 'discordapp.com'];
const DISCORD_HOOK_PATH = '/api/webhooks/';
const HTTPS = 'https:';
const HTTP = 'http:';
const HTTPS_PORT = '443';

const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_CHAT_PATTERN = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
const TELEGRAM_CHAT_MAX = 64;
const RECIPIENT_SEPARATORS = /[\s,;]+/;

/** One line per type for "Not connected" cards and the connect dialog. */
export const CHANNEL_PITCH: Record<ChannelType, string> = {
  email: 'Send alerts to up to 10 addresses.',
  slack: 'Post alerts to a Slack channel through an incoming webhook.',
  discord: 'Post alerts to a Discord channel through a channel webhook.',
  telegram: 'Message a chat or group from your own Telegram bot.',
  webhook: 'POST each alert as JSON to your own endpoint, optionally signed.',
};

export interface ChannelForm {
  name: string;
  recipients: string[];
  webhookUrl: string;
  webhookSecret: string;
  telegramToken: string;
  telegramChatId: string;
}

export type ChannelFormField = keyof ChannelForm;
export type ChannelFormErrors = Partial<Record<ChannelFormField, string>>;

/** Editing never pre-fills secrets: only the name comes back from the API. */
export function emptyChannelForm(type: ChannelType, channel?: Channel): ChannelForm {
  return {
    name: channel?.name ?? CHANNEL_TYPE_LABELS[type],
    recipients: [],
    webhookUrl: '',
    webhookSecret: '',
    telegramToken: '',
    telegramChatId: '',
  };
}

/** Splits pasted text ("a@x.dev, b@x.dev") into addresses, dropping duplicates. */
export function parseRecipients(raw: string, existing: readonly string[] = []): string[] {
  const seen = new Set(existing.map((address) => address.toLowerCase()));
  const out: string[] = [];
  for (const part of raw.split(RECIPIENT_SEPARATORS)) {
    const address = part.trim();
    if (address === '' || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  return out;
}

export { isEmail };

/** Whether the form carries new config (in edit mode, empty means "keep what is stored"). */
export function configTouched(type: ChannelType, form: ChannelForm): boolean {
  switch (type) {
    case 'email':
      return form.recipients.length > 0;
    case 'slack':
    case 'discord':
      return form.webhookUrl.trim() !== '';
    case 'webhook':
      return form.webhookUrl.trim() !== '' || form.webhookSecret !== '';
    case 'telegram':
      return form.telegramToken.trim() !== '' || form.telegramChatId.trim() !== '';
  }
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function urlError(type: 'slack' | 'discord' | 'webhook', raw: string): string | undefined {
  const value = raw.trim();
  if (value === '') return 'Paste the webhook URL.';
  if (value.length > MAX_URL_LENGTH) return `At most ${MAX_URL_LENGTH} characters.`;
  const url = parseUrl(value);
  if (!url || url.hostname === '') return 'That is not a valid URL.';
  if (type === 'webhook') {
    return url.protocol === HTTP || url.protocol === HTTPS ? undefined : 'Use an http:// or https:// URL.';
  }
  if (url.protocol !== HTTPS) return 'Use the https:// URL.';
  if (url.username !== '' || url.password !== '') return 'The URL must not contain credentials.';
  if (url.port !== '' && url.port !== HTTPS_PORT) return 'The URL must not use a custom port.';
  const host = url.hostname.toLowerCase();
  if (type === 'slack') return host === SLACK_HOST ? undefined : `Slack webhook URLs start with https://${SLACK_HOST}/.`;
  if (!DISCORD_HOSTS.includes(host)) return 'Discord webhook URLs start with https://discord.com/api/webhooks/.';
  return url.pathname.startsWith(DISCORD_HOOK_PATH) ? undefined : 'Discord webhook URLs start with https://discord.com/api/webhooks/.';
}

export type ChannelFormMode = { kind: 'create' } | { kind: 'edit'; channel: Channel };

/** Field errors for the connect or edit form; empty when it can be sent. */
export function validateChannelForm(type: ChannelType, form: ChannelForm, mode: ChannelFormMode): ChannelFormErrors {
  const errors: ChannelFormErrors = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'Give the channel a name.';
  else if (Array.from(name).length > MAX_CHANNEL_NAME_LENGTH) errors.name = `At most ${MAX_CHANNEL_NAME_LENGTH} characters.`;

  const editing = mode.kind === 'edit';
  if (editing && !configTouched(type, form)) return errors;

  switch (type) {
    case 'email': {
      if (form.recipients.length < MIN_EMAIL_RECIPIENTS) errors.recipients = 'Add at least one recipient.';
      else if (form.recipients.length > MAX_EMAIL_RECIPIENTS) errors.recipients = `At most ${MAX_EMAIL_RECIPIENTS} recipients.`;
      else {
        const bad = form.recipients.find((address) => !isEmail(address));
        if (bad !== undefined) errors.recipients = `${bad} is not a valid email address.`;
      }
      break;
    }
    case 'slack':
    case 'discord': {
      const error = urlError(type, form.webhookUrl);
      if (error) errors.webhookUrl = error;
      break;
    }
    case 'webhook': {
      if (editing && form.webhookUrl.trim() === '') errors.webhookUrl = 'Enter the URL too: it is saved together with the secret.';
      else {
        const error = urlError('webhook', form.webhookUrl);
        if (error) errors.webhookUrl = error;
      }
      if (form.webhookSecret.length > MAX_WEBHOOK_SECRET_LENGTH) errors.webhookSecret = `At most ${MAX_WEBHOOK_SECRET_LENGTH} characters.`;
      else if (editing && mode.channel.summary.signed === 'yes' && form.webhookSecret === '') {
        errors.webhookSecret = 'Enter the signing secret again: changing the URL replaces the whole configuration.';
      }
      break;
    }
    case 'telegram': {
      const token = form.telegramToken.trim();
      const chat = form.telegramChatId.trim();
      if (!TELEGRAM_TOKEN_PATTERN.test(token)) errors.telegramToken = token === '' ? 'Paste the bot token from @BotFather.' : 'That bot token looks malformed.';
      if (chat === '') errors.telegramChatId = 'Enter the chat id.';
      else if (chat.length > TELEGRAM_CHAT_MAX || !TELEGRAM_CHAT_PATTERN.test(chat)) errors.telegramChatId = 'Use a numeric chat id or an @username.';
      break;
    }
  }
  return errors;
}

function configFor(type: ChannelType, form: ChannelForm): ChannelConfig {
  switch (type) {
    case 'email':
      return { email_to: [...form.recipients] };
    case 'slack':
    case 'discord':
      return { webhook_url: form.webhookUrl.trim() };
    case 'webhook':
      return form.webhookSecret === ''
        ? { webhook_url: form.webhookUrl.trim() }
        : { webhook_url: form.webhookUrl.trim(), webhook_secret: form.webhookSecret };
    case 'telegram':
      return { telegram_token: form.telegramToken.trim(), telegram_chat_id: form.telegramChatId.trim() };
  }
}

export function buildCreateBody(type: ChannelType, form: ChannelForm): CreateChannelBody {
  return { type, name: form.name.trim(), config: configFor(type, form) };
}

/** Only what changed: no `config` when every config field was left empty. */
export function buildUpdateBody(channel: Channel, form: ChannelForm): UpdateChannelBody {
  const body: UpdateChannelBody = {};
  const name = form.name.trim();
  if (name !== channel.name) body.name = name;
  if (configTouched(channel.type, form)) body.config = configFor(channel.type, form);
  return body;
}

/** Which field an API `invalid` message is about. */
export function fieldForChannelError(message: string): ChannelFormField | null {
  const text = message.toLowerCase();
  if (text.includes('channel name')) return 'name';
  if (text.includes('recipient') || text.includes('email channels')) return 'recipients';
  if (text.includes('webhook secret')) return 'webhookSecret';
  if (text.includes('webhook url')) return 'webhookUrl';
  if (text.includes('bot token')) return 'telegramToken';
  if (text.includes('chat id')) return 'telegramChatId';
  return null;
}

// ---------------------------------------------------------------- cards

/** The redacted summary as the card's mono lines. */
export function summaryLines(channel: Pick<Channel, 'type' | 'summary'>): string[] {
  const { summary } = channel;
  switch (channel.type) {
    case 'email':
      return [`To: ${summary.recipients ?? '…'}`];
    case 'slack':
    case 'discord':
      return [`Webhook: ${summary.destination ?? '…'}`];
    case 'telegram':
      return [`Chat: ${summary.chat ?? '…'}`];
    case 'webhook':
      return [`POST ${summary.url ?? '…'}`, summary.signed === 'yes' ? 'HMAC-SHA256 signed' : 'Unsigned'];
  }
}

export interface ChannelStatusView {
  status: ServerStatus;
  label: string;
  /** The card turns warn when delivery is failing. */
  failing: boolean;
}

export function channelStatus(channel: Pick<Channel, 'enabled' | 'last_delivery_ok'>): ChannelStatusView {
  if (!channel.enabled) return { status: 'offline', label: 'Connected · disabled', failing: false };
  if (channel.last_delivery_ok === false) return { status: 'warning', label: 'Delivery failing', failing: true };
  return { status: 'healthy', label: 'Connected · enabled', failing: false };
}

/** "delivered 3 h ago", "failed 2 h ago", "never fired". */
export function deliveryText(channel: Pick<Channel, 'last_delivery_at' | 'last_delivery_ok'>, now: number): string {
  if (channel.last_delivery_at === null) return 'never fired';
  const when = formatRelativeTime(channel.last_delivery_at, now);
  return channel.last_delivery_ok === false ? `failed ${when}` : `delivered ${when}`;
}

export interface TestOutcome {
  ok: boolean;
  message: string;
}

/** POST /channels/:id/test result or error, as the line shown on the card. */
export function testOutcome(result: ChannelTestResponse | undefined, error: unknown): TestOutcome {
  if (error !== null && error !== undefined) {
    if (isApiError(error) && error.code === 'rate_limited') return { ok: false, message: 'Wait a minute before sending another test.' };
    return { ok: false, message: error instanceof Error && error.message !== '' ? error.message : 'The test could not be sent.' };
  }
  if (result?.ok) return { ok: true, message: 'Test delivered.' };
  return { ok: false, message: result?.error ?? 'Delivery failed.' };
}

/** The receiver-side check for X-Monitaur-Signature (Node.js). */
export const SIGNATURE_SNIPPET = `const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex'));
const given = Buffer.from(req.get('X-Monitaur-Signature') ?? '');
const valid = given.length === expected.length && crypto.timingSafeEqual(given, expected);`;
