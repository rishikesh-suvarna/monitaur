import { Menu, MenuButton, MenuItem, MenuItems, MenuSeparator } from '@headlessui/react';
import { Link } from 'react-router-dom';

import type { Channel } from '../../api/types';
import { cn } from '../../lib/cn';
import { channelLabel } from '../../lib/channels';

export interface ChannelPickerProps {
  channels: readonly Channel[];
  value: readonly number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}

const CHIP_32 = 'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-surface-2 px-[7px] text-[12px] font-medium leading-none text-ink-muted';
const MENU_ITEM = 'flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink-muted no-underline data-[focus]:bg-surface-3 data-[focus]:text-ink';

/** ", notify [Slack · #ops] [Email] [+ Channel]" from Rules.dc.html. */
export function ChannelPicker({ channels, value, onChange, disabled = false }: ChannelPickerProps) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const selected = value.flatMap((id) => {
    const channel = byId.get(id);
    return channel ? [channel] : [];
  });
  const available = channels.filter((channel) => !value.includes(channel.id));

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {selected.map((channel) => {
        const label = channelLabel(channel);
        return (
          <span
            key={channel.id}
            className={cn(CHIP_32, !channel.enabled && 'border-dashed text-ink-faint')}
            title={channel.enabled ? undefined : `${label} is disabled, so this rule skips it`}
          >
            {label}
            {!channel.enabled && <span className="text-ink-faint">(off)</span>}
            <button
              type="button"
              aria-label={`Stop notifying ${label}`}
              title={`Stop notifying ${label}`}
              disabled={disabled}
              onClick={() => {
                onChange(value.filter((id) => id !== channel.id));
              }}
              className="cursor-pointer border-0 bg-transparent p-0 text-[14px] leading-none text-ink-faint hover:text-ink disabled:cursor-not-allowed"
            >
              ×
            </button>
          </span>
        );
      })}
      <Menu>
        <MenuButton
          disabled={disabled}
          className={cn(
            CHIP_32,
            'cursor-pointer px-2.5 transition-colors duration-150 ease-out hover:text-ink disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          + Channel
        </MenuButton>
        <MenuItems
          anchor={{ to: 'bottom start', gap: 6 }}
          className="z-50 w-[240px] rounded-lg border border-line-strong bg-surface-1 p-1 shadow-float focus:outline-none"
        >
          {available.map((channel) => (
            <MenuItem key={channel.id}>
              <button
                type="button"
                className={MENU_ITEM}
                onClick={() => {
                  onChange([...value, channel.id]);
                }}
              >
                <span className="flex-1 truncate">{channelLabel(channel)}</span>
                {!channel.enabled && <span className="text-[12px] text-ink-faint">off</span>}
              </button>
            </MenuItem>
          ))}
          {available.length === 0 && (
            <div className="px-2 py-1.5 text-[13px] text-ink-faint">
              {channels.length === 0 ? 'No channels connected yet.' : 'Every channel is already notified.'}
            </div>
          )}
          <MenuSeparator className="my-1 h-px bg-line" />
          <MenuItem>
            <Link to="/channels" className={MENU_ITEM}>
              Manage channels
            </Link>
          </MenuItem>
        </MenuItems>
      </Menu>
    </span>
  );
}
