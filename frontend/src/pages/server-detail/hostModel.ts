/**
 * The Filesystems and Interfaces cards on the Metrics tab: rows from
 * ServerSummary.latest (section 6.1 `mounts` and `interfaces`), which the SSE
 * stream refreshes every 3 s. Mount usage is coloured by the server's disk
 * thresholds; everything else is plain data.
 */
import type { ServerInterface, ServerMount, Severity, ThresholdPair } from '../../api/types';
import { EMPTY_VALUE, formatBytes, formatPercent, formatRate } from '../../lib/format';
import { thresholdSeverity } from '../../lib/thresholds';

import { PERCENT_MAX } from './chartData';

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Used share of a filesystem, 0 to 100, or null when unknown. The agent's
 * `pct` comes first: it is gopsutil's used / (used + free), which leaves out
 * the root-reserved blocks the way `df` does, so it can be above used / total.
 * Without it, used / total is the fallback.
 */
export function mountUsagePercent(mount: Pick<ServerMount, 'pct' | 'used' | 'total'>): number | null {
  if (finite(mount.pct) && mount.pct >= 0) return mount.pct;
  if (finite(mount.total) && mount.total > 0 && finite(mount.used) && mount.used >= 0) return (mount.used / mount.total) * PERCENT_MAX;
  return null;
}

/**
 * Whether a section 6.1 list has anything to show. Typed as always present,
 * but a backend from before section 6.1 leaves it out, so this tolerates that.
 */
export const hasEntries = (list: readonly unknown[] | null | undefined): boolean => Array.isArray(list) && list.length > 0;

/** Width of the usage bar, 0 to 100. */
export const usageFill = (pct: number | null): number => (pct === null ? 0 : Math.min(PERCENT_MAX, Math.max(0, pct)));

export interface MountRow {
  path: string;
  /** "ext4", or a dash when the agent sent none. */
  fstype: string;
  /** "312 GB" */
  used: string;
  /** "480 GB" */
  total: string;
  pct: number | null;
  /** "65.0%" */
  pctText: string;
  /** Bar width, 0 to 100. */
  fill: number;
  /** Over the disk warning or critical line. */
  severity: Severity | null;
}

/**
 * One row per mount, `/` first and the rest by path. `diskThresholds` is
 * ServerSummary.thresholds.disk: the disk rules measure the root filesystem,
 * and their lines are the server's idea of "too full" for any mount.
 */
export function mountRows(mounts: readonly ServerMount[] | null | undefined, diskThresholds: ThresholdPair | undefined): MountRow[] {
  if (!mounts) return [];
  return [...mounts]
    .sort((a, b) => naturalOrder.compare(a.path, b.path))
    .map((mount) => {
      const pct = mountUsagePercent(mount);
      return {
        path: mount.path,
        fstype: mount.fstype.trim() === '' ? EMPTY_VALUE : mount.fstype,
        used: formatBytes(mount.used),
        total: formatBytes(mount.total),
        pct,
        pctText: formatPercent(pct),
        fill: usageFill(pct),
        severity: thresholdSeverity(pct, diskThresholds),
      };
    });
}

export interface InterfaceRow {
  name: string;
  /** "38.2 MB/s" */
  in: string;
  out: string;
}

/** One row per interface, in natural name order (eth2 before eth10) so rows do not jump as rates change. */
export function interfaceRows(interfaces: readonly ServerInterface[] | null | undefined): InterfaceRow[] {
  if (!interfaces) return [];
  return [...interfaces]
    .sort((a, b) => naturalOrder.compare(a.name, b.name))
    .map((item) => ({ name: item.name, in: formatRate(item.in), out: formatRate(item.out) }));
}
