import { Link } from 'react-router-dom';

import type { Channel, Rule } from '../../api/types';
import { cardClasses } from '../../components/Card';
import { STRETCHED_LINK } from '../../components/serverMetrics';
import { StatusBadge } from '../../components/StatusBadge';
import { Toggle } from '../../components/Toggle';
import { cn } from '../../lib/cn';

import { channelsSummary, ruleTitle, scopeSummary } from './ruleModel';

export interface RuleListProps {
  rules: readonly Rule[];
  /** GET /rules `matched`: rule id -> server count. */
  matched: Readonly<Record<string, number>>;
  serverNames: ReadonlyMap<number, string>;
  channels: ReadonlyMap<number, Channel>;
  selectedId: number | null;
  canEdit: boolean;
  onToggle: (rule: Rule, enabled: boolean) => void;
  className?: string;
}

/** Rules.dc.html "All rules": severity shape, sentence, scope line and an enable switch. */
export function RuleList({ rules, matched, serverNames, channels, selectedId, canEdit, onToggle, className }: RuleListProps) {
  const off = rules.filter((rule) => !rule.enabled).length;
  return (
    <section aria-labelledby="rule-list-heading" className={cn(cardClasses, 'min-w-0 overflow-hidden', className)}>
      <div className="flex items-center border-b border-line px-4 py-3.5">
        <h2 id="rule-list-heading" className="m-0 flex-1 text-[14px] font-semibold leading-5">
          All rules <span className="num text-ink-faint">{rules.length}</span>
        </h2>
        {off > 0 && <span className="text-[12px] leading-4 text-ink-faint">{off} off</span>}
      </div>
      {rules.length === 0 ? (
        <p className="m-0 px-4 py-6 text-center text-[13px] text-ink-muted">No rules yet. Save the one on the left to start watching.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {rules.map((rule) => {
            const title = ruleTitle(rule);
            const selected = rule.id === selectedId;
            const count = matched[String(rule.id)] ?? 0;
            return (
              <li
                key={rule.id}
                className={cn(
                  'relative flex items-center gap-3 border-b border-line px-4 py-2.5 transition-colors duration-150 ease-out last:border-b-0',
                  selected ? 'bg-tint-accent shadow-[inset_3px_0_0_rgb(var(--ac))]' : 'hover:bg-surface-2',
                )}
              >
                <StatusBadge status={rule.severity} variant="icon" />
                <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', !rule.enabled && 'opacity-[0.55]')}>
                  <Link
                    to={{ search: `?edit=${rule.id}` }}
                    aria-current={selected ? 'true' : undefined}
                    className={cn('text-[13px] font-medium leading-[18px] text-ink hover:text-ink', STRETCHED_LINK)}
                  >
                    {title}
                    {!rule.enabled && <span className="sr-only"> (disabled)</span>}
                  </Link>
                  <span className="num truncate text-[11px] leading-4 text-ink-faint">
                    {scopeSummary(rule.scope, serverNames)} · matches {count} · {channelsSummary(rule.channel_ids, channels)}
                  </span>
                </div>
                {/* Above the stretched link so the switch stays clickable. */}
                <div className="relative z-[1]" title={canEdit ? undefined : 'Viewers can’t change alert rules'}>
                  <Toggle
                    hideLabel
                    label={`${rule.enabled ? 'Disable' : 'Enable'} ${title}`}
                    checked={rule.enabled}
                    disabled={!canEdit}
                    onChange={(enabled) => {
                      onToggle(rule, enabled);
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
