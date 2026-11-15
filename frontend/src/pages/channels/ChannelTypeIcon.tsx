import { ChatBubbleOvalLeftEllipsisIcon, EnvelopeIcon, LinkIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import type { ComponentType, SVGProps } from 'react';

import type { ChannelType } from '../../api/types';
import { cn } from '../../lib/cn';

// Channels.dc.html icons: mail, chat (Slack and Discord), send, hook.
const ICONS: Record<ChannelType, ComponentType<SVGProps<SVGSVGElement>>> = {
  email: EnvelopeIcon,
  slack: ChatBubbleOvalLeftEllipsisIcon,
  discord: ChatBubbleOvalLeftEllipsisIcon,
  telegram: PaperAirplaneIcon,
  webhook: LinkIcon,
};

/** The 40 px surface-3 tile with the channel type's icon. Decorative. */
export function ChannelTypeTile({ type, className }: { type: ChannelType; className?: string }) {
  const Icon = ICONS[type];
  return (
    <span aria-hidden="true" className={cn('inline-flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-surface-3 text-ink', className)}>
      <Icon className="h-5 w-5" strokeWidth={1.6} />
    </span>
  );
}
