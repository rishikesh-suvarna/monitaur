import { PlusIcon } from '@heroicons/react/24/outline';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { errorMessage } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import type { Rule, RulesResponse } from '../../api/types';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { PageBody, PageHeader } from '../../components/layout/PageHeader';
import { CardSkeleton, TableRowsSkeleton } from '../../components/Skeletons';
import { useToast } from '../../components/toastContext';
import { useChannels } from '../../hooks/api/channels';
import { useRules, useUpdateRule } from '../../hooks/api/rules';
import { useServers } from '../../hooks/api/servers';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { useReducedMotion } from '../../providers/MotionProvider';
import { useOrg } from '../../providers/OrgProvider';

import { RuleEditor } from './RuleEditor';
import { RuleList } from './RuleList';

const RULES_PATH = '/rules';
const LIST_CLASSES = 'flex-[1_1_340px] md:max-w-[420px]';

const parseId = (raw: string | null): number | null => {
  if (raw === null) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * /rules (Rules.dc.html, RulesMobile.dc.html). Deep links: ?edit=<id> opens a
 * rule, ?new=1&server=<id> starts a rule scoped to that server.
 */
export default function RulesPage() {
  const desktop = useIsDesktop();
  const reduced = useReducedMotion();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can, orgId } = useOrg();
  const canEdit = can('member');
  const [params] = useSearchParams();
  const editorRef = useRef<HTMLElement>(null);

  const rules = useRules();
  const servers = useServers();
  const channels = useChannels();
  const toggleRule = useUpdateRule();

  const editParam = parseId(params.get('edit'));
  const isNew = params.get('new') === '1';
  const serverParam = parseId(params.get('server'));

  const list = useMemo(() => rules.data?.rules ?? [], [rules.data]);
  const serverList = useMemo(() => servers.data?.servers ?? [], [servers.data]);
  const channelList = useMemo(() => channels.data?.channels ?? [], [channels.data]);
  const serverNames = useMemo(() => new Map(serverList.map((server) => [server.id, server.name])), [serverList]);
  const channelsById = useMemo(() => new Map(channelList.map((channel) => [channel.id, channel])), [channelList]);

  const requested = editParam === null ? null : (list.find((rule) => rule.id === editParam) ?? null);
  const missing = editParam !== null && rules.data !== undefined && requested === null;
  // Desktop always shows a rule in the editor (the design never leaves it blank).
  const editing = isNew ? null : (requested ?? (desktop && editParam === null ? (list[0] ?? null) : null));
  const showEditor = isNew || editing !== null;
  // A new rule waits for servers and channels so the deep-link scope and the
  // preselected channels are right from the first render.
  const newReady = !isNew || ((servers.data !== undefined || servers.isError) && (channels.data !== undefined || channels.isError));
  const initialServerId = serverParam !== null && serverNames.has(serverParam) ? serverParam : null;
  const editorKey = isNew ? `new:${initialServerId ?? ''}` : `edit:${editing?.id ?? ''}`;

  useEffect(() => {
    if (desktop || !showEditor) return;
    editorRef.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [desktop, editorKey, reduced, showEditor]);

  const startNew = (): void => {
    void navigate({ pathname: RULES_PATH, search: '?new=1' });
  };
  const close = (): void => {
    void navigate(RULES_PATH);
  };

  const onToggle = (rule: Rule, enabled: boolean): void => {
    const key = queryKeys.rules(orgId);
    queryClient.setQueryData<RulesResponse>(key, (current) =>
      current ? { ...current, rules: current.rules.map((item) => (item.id === rule.id ? { ...item, enabled } : item)) } : current,
    );
    toggleRule.mutateAsync({ ruleId: rule.id, patch: { enabled } }).catch((error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: key });
      toast({ title: `Couldn’t ${enabled ? 'enable' : 'disable'} ${rule.name}`, description: errorMessage(error), tone: 'error' });
    });
  };

  const newButton = (mobile: boolean) => (
    <Button
      variant="primary"
      className={cn(mobile && '!h-10')}
      leadingIcon={<PlusIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
      onClick={startNew}
      disabled={!canEdit}
      title={canEdit ? undefined : 'Viewers can’t create alert rules'}
    >
      New rule
    </Button>
  );

  const header = <PageHeader title="Alert rules" actions={newButton(false)} mobileActions={newButton(true)} />;

  if (rules.isPending) {
    return (
      <>
        {header}
        <PageBody>
          <div aria-busy="true" aria-label="Loading alert rules" className="flex flex-wrap items-start gap-6">
            <CardSkeleton lines={8} className="min-h-[420px] flex-[999_1_520px]" />
            <div className={cn('overflow-hidden rounded-lg border border-line bg-surface-1', LIST_CLASSES)}>
              <TableRowsSkeleton rows={6} />
            </div>
          </div>
        </PageBody>
      </>
    );
  }

  if (rules.isError) {
    return (
      <>
        {header}
        <PageBody>
          <ErrorState error={rules.error} onRetry={() => void rules.refetch()} retrying={rules.isFetching} autoRetryMs={15_000} />
        </PageBody>
      </>
    );
  }

  if (list.length === 0 && !isNew) {
    return (
      <>
        {header}
        <PageBody>
          {missing && <ErrorState variant="widget" error={null} title="That rule no longer exists. It may have been deleted." />}
          <EmptyState
            mood="sleep"
            headingLevel="h2"
            title="No alert rules yet"
            description="Rules decide when a server raises an incident, and which channels hear about it."
            action={newButton(false)}
          />
        </PageBody>
      </>
    );
  }

  return (
    <>
      {header}
      <PageBody>
        {missing && <ErrorState variant="widget" error={null} title="That rule no longer exists. It may have been deleted." />}
        <div className="flex flex-wrap items-start gap-6">
          {showEditor &&
            (newReady ? (
              <RuleEditor
                key={editorKey}
                ref={editorRef}
                rule={editing}
                initialServerId={initialServerId}
                servers={serverList}
                channels={channelList}
                canEdit={canEdit}
                onClose={close}
                onCancelEdit={() => {
                  if (!desktop) close();
                }}
                onCreated={(created) => {
                  void navigate({ pathname: RULES_PATH, search: `?edit=${created.id}` }, { replace: true });
                }}
              />
            ) : (
              <CardSkeleton lines={8} className="min-h-[420px] flex-[999_1_520px]" />
            ))}
          <RuleList
            className={LIST_CLASSES}
            rules={list}
            matched={rules.data.matched}
            serverNames={serverNames}
            channels={channelsById}
            selectedId={editing?.id ?? null}
            canEdit={canEdit}
            onToggle={onToggle}
          />
        </div>
      </PageBody>
    </>
  );
}
