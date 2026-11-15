import type { Role } from '../api/types';
import { cn } from '../lib/cn';
import { ROLE_LABELS } from '../lib/roles';

const ROLE_TONE: Record<Role, string> = {
  owner: 'border-accent bg-tint-accent text-accent',
  admin: 'border-line-strong bg-surface-2 text-ink',
  member: 'border-line bg-surface-2 text-ink-muted',
  viewer: 'border-line bg-transparent text-ink-faint',
};

/** A 22 px chip naming an org role. Owner is the only accented one. */
export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center whitespace-nowrap rounded-sm border px-[7px] text-[12px] font-medium',
        ROLE_TONE[role],
        className,
      )}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}
