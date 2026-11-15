/**
 * Which alert rules apply to a server, and how to describe them on the
 * settings page. Matching mirrors the backend (alerting.Rule.Matches): all
 * servers, the server's id, or any of its tags (case-insensitive).
 */
import type { Channel, MetricKey, Rule, RuleScope, ServerSummary } from '../../api/types';
import { formatRate } from '../../lib/format';
import { formatThreshold } from '../../lib/status';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

export function ruleMatchesServer(scope: RuleScope, server: Pick<ServerSummary, 'id' | 'tags'>): boolean {
  if (scope.all || scope.server_ids.includes(server.id)) return true;
  const tags = new Set(server.tags.map((tag) => tag.toLowerCase()));
  return scope.tags.some((tag) => tags.has(tag.toLowerCase()));
}

/** Rules whose scope covers the server, enabled ones first, otherwise in API order. */
export function rulesForServer(rules: readonly Rule[], server: Pick<ServerSummary, 'id' | 'tags'>): Rule[] {
  return rules
    .filter((rule) => ruleMatchesServer(rule.scope, server))
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => Number(b.rule.enabled) - Number(a.rule.enabled) || a.index - b.index)
    .map(({ rule }) => rule);
}

const RULE_METRIC_LABELS: Record<MetricKey, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  disk: 'Disk /',
  net_in: 'Network in',
  net_out: 'Network out',
  heartbeat: 'Unreachable',
  load1: 'Load average',
  swap: 'Swap',
};

/** "30 s", "1 min", "5 min", "1 h", "1 h 30 min". */
export function formatForDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < SECONDS_PER_MINUTE) return `${whole} s`;
  if (whole < SECONDS_PER_HOUR) return `${Math.round(whole / SECONDS_PER_MINUTE)} min`;
  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = Math.round((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

function ruleThreshold(rule: Pick<Rule, 'metric' | 'threshold'>): string {
  if (rule.metric === 'net_in' || rule.metric === 'net_out') return formatRate(rule.threshold);
  // Load average is unitless, not a percentage.
  if (rule.metric === 'load1') return String(rule.threshold);
  return formatThreshold(rule.threshold, '%');
}

/**
 * ServerSettings.dc.html rule line: "Disk / above 90% for 1 min → critical",
 * "Unreachable for 2 min → critical".
 */
export function describeRule(rule: Pick<Rule, 'metric' | 'comparison' | 'threshold' | 'for_seconds' | 'severity'>): string {
  const lasting = rule.for_seconds > 0 ? ` for ${formatForDuration(rule.for_seconds)}` : '';
  if (rule.metric === 'heartbeat') return `Unreachable${lasting} → ${rule.severity}`;
  return `${RULE_METRIC_LABELS[rule.metric]} ${rule.comparison} ${ruleThreshold(rule)}${lasting} → ${rule.severity}`;
}

/** Why the rule applies here: "all servers", "this server", "tag prod", "tags prod, db". */
export function scopeReason(scope: RuleScope, server: Pick<ServerSummary, 'id' | 'tags'>): string {
  if (scope.all) return 'all servers';
  if (scope.server_ids.includes(server.id)) return 'this server';
  const own = new Set(server.tags.map((tag) => tag.toLowerCase()));
  const matched = scope.tags.filter((tag) => own.has(tag.toLowerCase()));
  return matched.length === 1 ? `tag ${matched[0] ?? ''}` : `tags ${matched.join(', ')}`;
}

/** "email, Slack": the rule's channel names, or a note when it notifies nobody. */
export function channelNames(rule: Pick<Rule, 'channel_ids'>, channels: readonly Pick<Channel, 'id' | 'name'>[] | undefined): string {
  if (rule.channel_ids.length === 0) return 'no channels';
  if (!channels) return rule.channel_ids.length === 1 ? '1 channel' : `${rule.channel_ids.length} channels`;
  const byId = new Map(channels.map((channel) => [channel.id, channel.name]));
  const names = rule.channel_ids.map((id) => byId.get(id)).filter((name): name is string => name !== undefined);
  return names.length > 0 ? names.join(', ') : 'no channels';
}

export const ruleEditPath = (ruleId: number): string => `/rules?edit=${ruleId}`;
export const newRulePath = (serverId: number): string => `/rules?new=1&server=${serverId}`;
