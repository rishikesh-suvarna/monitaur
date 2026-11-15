/** Agent token display and rotation helpers for the settings page. */
import type { RotateTokenResponse, ServerSummary } from '../../api/types';
import { resolveInstall, type ResolvedInstall } from '../../lib/agentInstall';
import { formatElapsed, formatTimeOfDay, toTime } from '../../lib/format';

const MASK = '•'.repeat(12);
const MS_PER_SECOND = 1000;

/**
 * "mt_live_7f3c••••••••••••". The API keeps only the display prefix, so
 * unlike the design there is no real tail to show.
 */
export function maskedTokenPrefix(prefix: string): string {
  return `${prefix}${MASK}`;
}

export interface GraceCountdown {
  expired: boolean;
  /** "9:58" until the old token stops working. */
  remaining: string;
  /** "14:37", when it stops. */
  at: string;
}

/** Time left on the previous token after a rotation (previous_valid_until). */
export function graceCountdown(previousValidUntil: string, now: number): GraceCountdown | null {
  const until = toTime(previousValidUntil);
  if (until === null) return null;
  const seconds = Math.max(0, (until - now) / MS_PER_SECOND);
  return { expired: seconds <= 0, remaining: formatElapsed(Math.ceil(seconds)), at: formatTimeOfDay(until) };
}

/** The new config to paste, from the rotation's `install` block, else built locally. */
export function rotatedInstall(response: RotateTokenResponse, server: ServerSummary, agentEndpoint: string): ResolvedInstall {
  return resolveInstall(
    { server, token: response.token, install: response.install ?? { command: '', config_path: '', config: '' } },
    agentEndpoint,
  );
}
