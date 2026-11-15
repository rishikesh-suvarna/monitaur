import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/outline';
import { useMemo, useState } from 'react';

import type { Channel, ChannelType } from '../../api/types';
import { buttonClasses } from '../../components/buttonClasses';
import { ErrorState } from '../../components/ErrorState';
import { PageBody, PageHeader } from '../../components/layout/PageHeader';
import { CardSkeleton } from '../../components/Skeletons';
import { useChannels } from '../../hooks/api/channels';
import { CHANNEL_TYPE_LABELS, CHANNEL_TYPES } from '../../lib/channels';
import { cn } from '../../lib/cn';
import { useOrg } from '../../providers/OrgProvider';

import { ADMIN_ONLY, ChannelCard, ConnectCard } from './ChannelCard';
import { ChannelDialog } from './ChannelDialog';
import { ChannelTypeTile } from './ChannelTypeIcon';

interface DialogState {
  type: ChannelType;
  channel: Channel | null;
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 md:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]';
const SKELETON_CARDS = 5;

/** /channels (Channels.dc.html, ChannelsMobile.dc.html). */
export default function ChannelsPage() {
  const channels = useChannels();
  const { can } = useOrg();
  const canManage = can('admin');
  const canTest = can('member');
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const sorted = useMemo(
    () =>
      [...(channels.data?.channels ?? [])].sort(
        (a, b) => CHANNEL_TYPES.indexOf(a.type) - CHANNEL_TYPES.indexOf(b.type) || a.name.localeCompare(b.name) || a.id - b.id,
      ),
    [channels.data],
  );
  const unconnected = CHANNEL_TYPES.filter((type) => !sorted.some((channel) => channel.type === type));

  const connect = (type: ChannelType): void => {
    setDialog({ type, channel: null });
  };

  const addMenu = (mobile: boolean) => (
    <Menu>
      <MenuButton
        disabled={!canManage}
        title={canManage ? undefined : ADMIN_ONLY}
        className={cn(buttonClasses({ variant: 'secondary' }), mobile && '!h-10')}
      >
        <PlusIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        Add channel
      </MenuButton>
      <MenuItems
        anchor={{ to: 'bottom end', gap: 6 }}
        className="z-50 w-[220px] rounded-lg border border-line-strong bg-surface-1 p-1 shadow-float focus:outline-none"
      >
        {CHANNEL_TYPES.map((type) => (
          <MenuItem key={type}>
            <button
              type="button"
              onClick={() => {
                connect(type);
              }}
              className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 text-left text-[13px] text-ink-muted data-[focus]:bg-surface-3 data-[focus]:text-ink"
            >
              <ChannelTypeTile type={type} className="h-6 w-6 rounded-sm [&>svg]:h-3.5 [&>svg]:w-3.5" />
              Connect {CHANNEL_TYPE_LABELS[type]}
            </button>
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );

  return (
    <>
      <PageHeader
        title="Notification channels"
        description="Where alerts go. Rules pick channels; a disabled channel is skipped everywhere."
        actions={channels.data && sorted.length > 0 ? addMenu(false) : undefined}
        mobileActions={channels.data && sorted.length > 0 ? addMenu(true) : undefined}
      />
      <PageBody>
        {channels.isPending && (
          <div aria-busy="true" aria-label="Loading channels" className={GRID}>
            {Array.from({ length: SKELETON_CARDS }, (_, index) => (
              <CardSkeleton key={index} lines={4} className="min-h-[180px]" />
            ))}
          </div>
        )}
        {channels.isError && (
          <ErrorState error={channels.error} onRetry={() => void channels.refetch()} retrying={channels.isFetching} autoRetryMs={15_000} />
        )}
        {channels.data && (
          <div className={GRID}>
            {sorted.map((channel) => (
              <ChannelCard
                key={channel.id}
                channel={channel}
                canManage={canManage}
                canTest={canTest}
                onEdit={() => {
                  setDialog({ type: channel.type, channel });
                }}
              />
            ))}
            {unconnected.map((type) => (
              <ConnectCard
                key={type}
                type={type}
                canManage={canManage}
                onConnect={() => {
                  connect(type);
                }}
              />
            ))}
          </div>
        )}
      </PageBody>
      {dialog && (
        <ChannelDialog
          key={`${dialog.type}:${dialog.channel?.id ?? 'new'}`}
          type={dialog.type}
          channel={dialog.channel}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
