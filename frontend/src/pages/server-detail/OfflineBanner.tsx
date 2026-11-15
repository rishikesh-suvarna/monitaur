import { useId, useState } from 'react';

import type { ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { CopyableCode } from '../../components/CopyableCode';
import { StatusBadge } from '../../components/StatusBadge';
import { useNow } from '../../hooks/useNow';
import { AGENT_LOGS_COMMAND, AGENT_STATUS_COMMAND } from '../../lib/agentInstall';
import { formatAge, formatDayTime, formatTimeOfDay, secondsSince, toTime } from '../../lib/format';

const MS_PER_DAY = 86_400_000;

/** "at 14:15" today, "on Sat 03:12" before that. */
function stoppedAt(lastSeen: number, now: number): string {
  const sameDay = new Date(lastSeen).toDateString() === new Date(now).toDateString();
  if (sameDay && now - lastSeen < MS_PER_DAY) return `at ${formatTimeOfDay(lastSeen)}`;
  return `on ${formatDayTime(lastSeen, now)}`;
}

/**
 * States.dc.html "Agent offline": a warn-tinted banner over the frozen data,
 * "Last seen 12 min ago", and the commands to check the agent.
 */
export function OfflineBanner({ server }: { server: ServerSummary }) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const lastSeen = toTime(server.last_seen);
  const age = secondsSince(lastSeen, now);

  return (
    <div className="overflow-hidden rounded-lg border border-warn bg-surface-1">
      <div role="status" className="flex flex-wrap items-center gap-x-2.5 gap-y-2 bg-tint-warn px-4 py-2.5 text-[13px]">
        <StatusBadge status="offline" variant="icon" />
        <span className="min-w-0 flex-1">
          {lastSeen === null || age === null ? (
            <>
              <strong className="font-semibold">No data yet.</strong> <span className="num">{server.name}</span> hasn’t reported since it was
              added.
            </>
          ) : (
            <>
              <strong className="font-semibold">Last seen {formatAge(age)} ago.</strong> <span className="num">{server.name}</span> stopped
              reporting <span className="num">{stoppedAt(lastSeen, now)}</span>. Values below are frozen.
            </>
          )}
        </span>
        <Button
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          Troubleshoot
        </Button>
      </div>
      {open && (
        <div id={panelId} className="flex flex-col gap-2 border-t border-warn px-4 py-3">
          <p className="m-0 text-[13px] text-ink-muted">On the server, check that the agent is running, then read its last log lines:</p>
          <CopyableCode code={AGENT_STATUS_COMMAND} prompt copyLabel="Copy status command" />
          <CopyableCode code={AGENT_LOGS_COMMAND} prompt copyLabel="Copy logs command" />
        </div>
      )}
    </div>
  );
}
