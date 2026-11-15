import { PlusIcon } from '@heroicons/react/24/outline';
import { Link } from 'react-router-dom';

import { errorMessage } from '../../api/errors';
import type { Rule, ServerSummary } from '../../api/types';
import { Button, ButtonLink } from '../../components/Button';
import { Card } from '../../components/Card';
import { ErrorState } from '../../components/ErrorState';
import { TableRowsSkeleton } from '../../components/Skeletons';
import { StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/toastContext';
import { Toggle } from '../../components/Toggle';
import { useChannels } from '../../hooks/api/channels';
import { useRules, useUpdateRule } from '../../hooks/api/rules';

import { channelNames, describeRule, newRulePath, ruleEditPath, rulesForServer, scopeReason } from './ruleScope';

const VIEWER_RULES_REASON = 'Viewers can’t change alert rules. Ask an admin for the member role.';

/**
 * ServerSettings.dc.html "Alert rules on this server": the rules whose scope
 * covers it (all servers, its id or one of its tags), each linking to the
 * rule editor, with the enable switch inline.
 */
export function RulesCard({ server, canEdit }: { server: ServerSummary; canEdit: boolean }) {
  const rules = useRules();
  const channels = useChannels();
  const update = useUpdateRule();
  const { toast } = useToast();
  const matching = rules.data ? rulesForServer(rules.data.rules, server) : [];

  const setEnabled = (rule: Rule, enabled: boolean): void => {
    update.mutate(
      { ruleId: rule.id, patch: { enabled } },
      {
        onError: (caught) => {
          toast({ tone: 'error', title: enabled ? 'Couldn’t enable the rule' : 'Couldn’t disable the rule', description: errorMessage(caught) });
        },
      },
    );
  };

  return (
    <Card as="section" aria-labelledby="rules-heading" className="overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4">
        <h2 id="rules-heading" className="m-0 flex-1 text-h3 font-semibold">
          Alert rules on this server
        </h2>
        {canEdit ? (
          <ButtonLink size="sm" to={newRulePath(server.id)} leadingIcon={<PlusIcon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}>
            Add rule
          </ButtonLink>
        ) : (
          <Button size="sm" disabled title={VIEWER_RULES_REASON} leadingIcon={<PlusIcon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}>
            Add rule
          </Button>
        )}
      </div>

      {rules.isPending && <TableRowsSkeleton rows={3} />}
      {rules.isError && !rules.data && (
        <div className="border-t border-line p-4">
          <ErrorState variant="widget" error={rules.error} title="Couldn’t load alert rules." onRetry={() => void rules.refetch()} retrying={rules.isFetching} />
        </div>
      )}
      {rules.data && matching.length === 0 && (
        <p className="m-0 border-t border-line px-5 py-4 text-[13px] text-ink-muted">
          No rule covers this server yet, so nothing will alert on it. Add one, or tag the server so an existing rule matches.
        </p>
      )}

      {matching.length > 0 && (
        <ul className="m-0 list-none p-0">
          {matching.map((rule) => {
            const pending = update.isPending && update.variables.ruleId === rule.id;
            const enabled = pending && update.variables.patch.enabled !== undefined ? update.variables.patch.enabled : rule.enabled;
            const title = describeRule(rule);
            return (
              <li key={rule.id} className="flex items-center gap-3 border-t border-line px-5 py-3 transition-colors duration-150 ease-out hover:bg-surface-2">
                <StatusBadge status={rule.severity === 'critical' ? 'critical' : 'warning'} variant="icon" />
                {/* ServerSettings.dc.html keeps a disabled rule at full ink; its switch shows the state. */}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link to={ruleEditPath(rule.id)} className="text-[13px] font-medium text-ink no-underline hover:underline">
                    {title}
                  </Link>
                  <span className="num text-[12px] text-ink-faint">
                    {scopeReason(rule.scope, server)} · {channelNames(rule, channels.data?.channels)}
                  </span>
                </div>
                <span title={canEdit ? undefined : VIEWER_RULES_REASON}>
                  <Toggle
                    checked={enabled}
                    disabled={!canEdit || pending}
                    hideLabel
                    label={`Enable rule: ${title}`}
                    onChange={(next) => {
                      setEnabled(rule, next);
                    }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
