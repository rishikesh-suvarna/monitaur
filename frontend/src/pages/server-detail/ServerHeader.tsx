import { Menu, MenuButton, MenuItem, MenuItems, Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { BellIcon, CheckIcon, ChevronLeftIcon, Cog6ToothIcon, EllipsisHorizontalIcon, StarIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { errorMessage } from '../../api/errors';
import type { ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { buttonClasses } from '../../components/buttonClasses';
import { Chip } from '../../components/Chip';
import { IconLink } from '../../components/IconButton';
import { MaintenanceBadge } from '../../components/MaintenanceBadge';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusBadge } from '../../components/StatusBadge';
import { TabLinks } from '../../components/Tabs';
import { TagInput } from '../../components/TagInput';
import { useToast } from '../../components/toastContext';
import { useServers, useSetServerPinned, useUpdateServer } from '../../hooks/api/servers';
import { cn } from '../../lib/cn';
import { collectTags } from '../../lib/fleet';
import { EMPTY_VALUE, formatBytes, formatDuration } from '../../lib/format';
import { useOrg } from '../../providers/OrgProvider';

import {
  agentVersionLabel,
  alertsForServer,
  serverAlertsTabPath,
  serverDetailPath,
  serverProcessesTabPath,
  serverSettingsPath,
  VIEWER_EDIT_REASON,
  type ServerTab,
} from './routes';

const MENU_ITEM =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink-muted no-underline data-[focus]:bg-surface-3 data-[focus]:text-ink';

function TagsEditor({ server, canEdit }: { server: ServerSummary; canEdit: boolean }) {
  return (
    <Popover className="relative">
      <PopoverButton
        disabled={!canEdit}
        title={canEdit ? 'Edit tags' : VIEWER_EDIT_REASON}
        aria-label="Edit tags"
        className="inline-flex h-[22px] items-center whitespace-nowrap rounded-sm border border-line bg-surface-2 px-1.5 text-[12px] font-medium text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-[0.45]"
      >
        + tag
      </PopoverButton>
      <PopoverPanel
        anchor={{ to: 'bottom start', gap: 6 }}
        className="z-50 w-[320px] max-w-[calc(100vw-32px)] rounded-lg border border-line-strong bg-surface-1 p-3 shadow-float focus:outline-none"
      >
        {({ close }) => (
          <TagsForm
            server={server}
            onDone={() => {
              close();
            }}
          />
        )}
      </PopoverPanel>
    </Popover>
  );
}

function TagsForm({ server, onDone }: { server: ServerSummary; onDone: () => void }) {
  const [tags, setTags] = useState<string[]>(server.tags);
  const update = useUpdateServer();
  const servers = useServers();
  const { toast } = useToast();
  const suggestions = collectTags(servers.data?.servers ?? []);
  const dirty = tags.join(',') !== server.tags.join(',');
  const form = useRef<HTMLFormElement>(null);

  // Land in the text field (not on the first chip's remove button) when the popover opens.
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>('input:not([type="hidden"])')?.focus();
  }, []);

  return (
    <form
      ref={form}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty) {
          onDone();
          return;
        }
        update.mutate(
          { serverId: server.id, body: { tags } },
          {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Tags saved' });
              onDone();
            },
          },
        );
      }}
    >
      <TagInput label="Tags" value={tags} onChange={setTags} suggestions={suggestions} hint="Enter or comma adds a tag. Rules can target tags." />
      {update.error && (
        <p role="alert" className="m-0 text-[12px] text-crit">
          {errorMessage(update.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={update.isPending}>
          Save tags
        </Button>
      </div>
    </form>
  );
}

function usePinToggle(server: ServerSummary) {
  const setPinned = useSetServerPinned();
  const { toast } = useToast();
  return {
    pending: setPinned.isPending,
    toggle: () => {
      setPinned.mutate(
        { serverId: server.id, pinned: !server.pinned },
        {
          onError: (caught) => {
            toast({ tone: 'error', title: server.pinned ? 'Couldn’t unpin the server' : 'Couldn’t pin the server', description: errorMessage(caught) });
          },
        },
      );
    },
  };
}

function MoreMenu({ server, touch, onTogglePin }: { server: ServerSummary; touch: boolean; onTogglePin?: () => void }) {
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuButton
        aria-label="More actions"
        title="More actions"
        className={cn(buttonClasses({ variant: touch ? 'ghost' : 'secondary' }), touch ? '-mr-3 h-11 w-11 !px-0' : 'w-9 !px-0')}
      >
        <EllipsisHorizontalIcon className={touch ? 'h-5 w-5' : 'h-[18px] w-[18px]'} strokeWidth={1.8} aria-hidden="true" />
      </MenuButton>
      <MenuItems
        anchor={{ to: 'bottom end', gap: 6 }}
        className="z-50 w-[220px] rounded-lg border border-line-strong bg-surface-1 p-1 shadow-float focus:outline-none"
      >
        {onTogglePin && (
          <MenuItem>
            <button type="button" className={MENU_ITEM} onClick={onTogglePin}>
              <StarIcon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
              {server.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
            </button>
          </MenuItem>
        )}
        <MenuItem>
          <button
            type="button"
            className={MENU_ITEM}
            onClick={() => {
              void navigate(alertsForServer(server.id));
            }}
          >
            <BellIcon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
            Open in Alerts
          </button>
        </MenuItem>
        <MenuItem>
          <button
            type="button"
            className={MENU_ITEM}
            onClick={() => {
              void navigate(serverSettingsPath(server.id));
            }}
          >
            <Cog6ToothIcon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
            Server settings
          </button>
        </MenuItem>
      </MenuItems>
    </Menu>
  );
}

function ServerTabs({ server, tab, touch }: { server: ServerSummary; tab: ServerTab; touch: boolean }) {
  const open = server.open_incidents;
  return (
    <TabLinks
      aria-label="Server sections"
      // Four tabs at 390 px: a little less air between them so "12 open" still fits on one line.
      // Important: cn is clsx, and .gap-6 (TabLinks' default) comes later in the CSS than .gap-5.
      // The detail board drops the tabs 4 px; the settings board does not.
      className={touch ? '!gap-5' : tab === 'settings' ? undefined : 'mt-1'}
      itemClassName={touch ? 'h-11 whitespace-nowrap' : undefined}
      items={[
        { to: serverDetailPath(server.id), label: 'Metrics', active: tab === 'metrics' },
        { to: serverProcessesTabPath(server.id), label: 'Processes', active: tab === 'processes' },
        {
          to: serverAlertsTabPath(server.id),
          label: (
            <>
              Alerts
              {open > 0 && <span className="num ml-1.5 text-[12px] text-crit">{open} open</span>}
            </>
          ),
          active: tab === 'alerts',
        },
        { to: serverSettingsPath(server.id), label: 'Settings', active: tab === 'settings' },
      ]}
    />
  );
}

interface MetaItem {
  key: string;
  label: string;
  value: ReactNode;
}

function metaItems(server: ServerSummary): MetaItem[] {
  const latest = server.latest;
  const offline = server.status === 'offline';
  return [
    { key: 'uptime', label: 'Uptime', value: offline || !latest ? EMPTY_VALUE : formatDuration(latest.uptime_s) },
    { key: 'agent', label: 'Agent', value: agentVersionLabel(server.agent_version) },
    {
      key: 'seen',
      label: 'Last seen',
      value: <RelativeTime value={server.last_seen} className={offline ? 'text-warn' : undefined} />,
    },
    { key: 'cores', label: 'Cores', value: latest && latest.cpu_cores > 0 ? `${latest.cpu_cores} vCPU` : EMPTY_VALUE },
    { key: 'memory', label: 'Memory', value: latest && latest.mem_total > 0 ? formatBytes(latest.mem_total) : EMPTY_VALUE },
  ];
}

export interface ServerHeaderProps {
  server: ServerSummary;
  tab: ServerTab;
  desktop: boolean;
}

/**
 * ServerDetail.dc.html header: breadcrumb, mono name (wraps, never
 * truncates), status, maintenance, tags with "+ tag", Pin, more actions, meta
 * and the Metrics / Processes / Alerts / Settings tabs. The settings variant
 * (ServerSettings.dc.html) keeps only the name, status and tabs.
 */
export function ServerHeader({ server, tab, desktop }: ServerHeaderProps) {
  const { can } = useOrg();
  const canEdit = can('member');
  const pin = usePinToggle(server);
  const settings = tab === 'settings';
  const meta = metaItems(server);

  if (!desktop) {
    const back = settings ? { to: serverDetailPath(server.id), label: 'Back to server' } : { to: '/', label: 'Back to overview' };
    return (
      <header className="flex flex-col gap-2.5 border-b border-line bg-surface-1 px-4 pt-2">
        {/* ServerSettings.dc.html (compact): the badge follows the name 12 px later instead of sitting at the far edge. */}
        <div className={cn('-ml-3 flex items-center', settings ? 'gap-3' : 'gap-1')}>
          <IconLink to={back.to} aria-label={back.label} size="touch" icon={<ChevronLeftIcon className="h-5 w-5" strokeWidth={1.8} />} />
          <h1 className={cn('num m-0 min-w-0 text-[18px] font-semibold leading-6 [overflow-wrap:anywhere]', !settings && 'flex-1')}>{server.name}</h1>
          {settings ? <StatusBadge status={server.status} /> : <MoreMenu server={server} touch onTogglePin={pin.toggle} />}
        </div>
        {!settings && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={server.status} />
              {server.maintenance && <MaintenanceBadge size="md" interactive />}
              {server.tags.map((tag) => (
                <Chip key={tag}>{tag}</Chip>
              ))}
              {server.pinned && <Chip>Pinned</Chip>}
            </div>
            <dl className="num m-0 grid grid-cols-3 gap-2 text-[12px]">
              {meta.slice(0, 3).map((item) => (
                <div key={item.key}>
                  <dt className="font-sans text-ink-faint">{item.label}</dt>
                  <dd className="m-0">{item.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <ServerTabs server={server} tab={tab} touch />
      </header>
    );
  }

  return (
    <header className={cn('flex flex-col border-b border-line px-8 pt-5', settings ? 'gap-3' : 'gap-3.5')}>
      <nav aria-label="Breadcrumb" className="text-[13px] text-ink-faint">
        <Link to="/" className="text-ink-muted">
          Overview
        </Link>{' '}
        <span aria-hidden="true">/</span>{' '}
        {settings ? (
          <>
            <Link to={serverDetailPath(server.id)} className="text-ink-muted">
              {server.name}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span aria-current="page">Settings</span>
          </>
        ) : (
          <span aria-current="page">{server.name}</span>
        )}
      </nav>
      <div className={cn('flex flex-wrap items-center gap-y-3', settings ? 'gap-x-3' : 'gap-x-4')}>
        <h1 className="num m-0 min-w-0 text-h1 font-semibold [overflow-wrap:anywhere]">{server.name}</h1>
        <StatusBadge status={server.status} />
        {server.maintenance && <MaintenanceBadge size="md" interactive />}
        {!settings && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {server.tags.map((tag) => (
                <Chip key={tag}>{tag}</Chip>
              ))}
              <TagsEditor server={server} canEdit={canEdit} />
            </div>
            <span className="flex-1" />
            <Button
              aria-pressed={server.pinned}
              onClick={pin.toggle}
              title={server.pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
              leadingIcon={server.pinned ? <CheckIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" /> : undefined}
            >
              {server.pinned ? 'Pinned' : 'Pin'}
            </Button>
            <MoreMenu server={server} touch={false} />
          </>
        )}
      </div>
      {!settings && (
        <dl className="m-0 flex flex-wrap gap-x-7 gap-y-2 text-[13px]">
          {meta.map((item) => (
            <div key={item.key} className="flex gap-2">
              <dt className="text-ink-faint">{item.label}</dt>
              <dd className="num m-0 text-ink">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <ServerTabs server={server} tab={tab} touch={false} />
    </header>
  );
}
