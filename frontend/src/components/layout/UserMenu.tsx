import { Menu, MenuButton, MenuHeading, MenuItem, MenuItems, MenuSection, MenuSeparator } from '@headlessui/react';
import { ArrowLeftStartOnRectangleIcon, CheckIcon, ChevronUpDownIcon, UserCircleIcon } from '@heroicons/react/24/outline';
import { useNavigate } from 'react-router-dom';

import { useServers } from '../../hooks/api/servers';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { initialsFor } from '../../lib/names';
import { useAuth } from '../../providers/AuthProvider';
import { useOrg } from '../../providers/OrgProvider';

const ITEM = 'flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink-muted data-[focus]:bg-surface-3 data-[focus]:text-ink';

/**
 * Sidebar.dc.html user block: avatar, name and "N servers · org". It opens a
 * menu with Settings and Sign out; the org switcher section appears only when
 * the user belongs to more than one org.
 */
export function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { signOut } = useAuth();
  const { user, org, orgs, switchOrg } = useOrg();
  const navigate = useNavigate();
  const servers = useServers();
  const name = user.display_name || user.email;
  const serverCount = servers.data?.servers.length;
  const subtitle = serverCount === undefined ? org.name : `${plural(serverCount, 'server')} · ${org.name}`;

  return (
    <Menu>
      <MenuButton
        aria-label={collapsed ? `Account: ${name}` : undefined}
        className="flex w-full items-center gap-2.5 rounded px-1.5 py-1 text-left hover:bg-surface-2"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full bg-tint-accent text-[12px] font-semibold text-accent"
        >
          {initialsFor(name)}
        </span>
        {!collapsed && (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-ink">{name}</span>
              <span className="truncate text-[12px] text-ink-faint">{subtitle}</span>
            </span>
            <ChevronUpDownIcon className="h-4 w-4 flex-none text-ink-faint" strokeWidth={1.8} aria-hidden="true" />
          </>
        )}
      </MenuButton>
      <MenuItems
        anchor={{ to: 'top start', gap: 8 }}
        className="z-50 w-[232px] rounded-lg border border-line-strong bg-surface-1 p-1 shadow-float focus:outline-none"
      >
        {orgs.length > 1 && (
          <>
            <MenuSection>
              <MenuHeading className="cap px-2 pb-1 pt-1.5">Organisations</MenuHeading>
              {orgs.map((item) => (
                <MenuItem key={item.id}>
                  <button
                    type="button"
                    className={cn(ITEM, item.id === org.id && 'text-ink')}
                    onClick={() => {
                      switchOrg(item.id);
                    }}
                  >
                    <CheckIcon
                      className={cn('h-3.5 w-3.5 flex-none text-accent', item.id !== org.id && 'invisible')}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    <span className="flex-1 truncate">{item.name}</span>
                    <span className="text-[11px] text-ink-faint">{item.role}</span>
                  </button>
                </MenuItem>
              ))}
            </MenuSection>
            <MenuSeparator className="my-1 h-px bg-line" />
          </>
        )}
        <MenuItem>
          <button
            type="button"
            className={ITEM}
            onClick={() => {
              void navigate('/settings');
            }}
          >
            <UserCircleIcon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
            Settings
          </button>
        </MenuItem>
        <MenuItem>
          <button
            type="button"
            className={ITEM}
            onClick={() => {
              void signOut();
            }}
          >
            <ArrowLeftStartOnRectangleIcon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
            Sign out
          </button>
        </MenuItem>
      </MenuItems>
    </Menu>
  );
}
