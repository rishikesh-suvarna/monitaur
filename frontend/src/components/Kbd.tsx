import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/** Keyboard key, styled by the base `kbd` rule (mono 11, line-strong border). Pair with modKeyLabel() from lib/names. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex items-center', className)}>{children}</kbd>;
}
