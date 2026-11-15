import type { Channel, ChannelType } from '../api/types';

/** Display order on the channels page (Channels.dc.html). */
export const CHANNEL_TYPES: readonly ChannelType[] = ['email', 'slack', 'discord', 'telegram', 'webhook'];

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  email: 'Email',
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
  webhook: 'Webhook',
};

/** "Slack · ops-alerts", or just "Email" when the name only repeats the type. */
export function channelLabel(channel: Pick<Channel, 'type' | 'name'>): string {
  const type = CHANNEL_TYPE_LABELS[channel.type];
  const name = channel.name.trim();
  if (name === '' || name.toLowerCase() === type.toLowerCase()) return type;
  return `${type} · ${name}`;
}
