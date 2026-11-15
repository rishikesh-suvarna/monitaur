import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

import { cn } from '../lib/cn';

import { buttonClasses, type ButtonVariant } from './buttonClasses';

export type IconButtonSize = 'sm' | 'md' | 'touch';

// sm 28, md 36, touch 44 (mobile touch targets are at least 44 px). The padding
// reset is important: buttonClasses' px-2.5/px-3.5 come later in Tailwind's CSS
// and would otherwise squeeze the icon to a few pixels.
const SQUARE: Record<IconButtonSize, string> = {
  sm: 'h-7 w-7 !px-0',
  md: 'h-9 w-9 !px-0',
  touch: 'h-11 w-11 !px-0',
};

interface IconButtonBaseProps {
  /** Required: the accessible name, also shown as a tooltip. */
  'aria-label': string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: IconButtonSize;
}

export interface IconButtonProps
  extends IconButtonBaseProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  ref?: Ref<HTMLButtonElement>;
}

/** A square icon-only button. TypeScript requires an aria-label. */
export function IconButton({ icon, variant = 'ghost', size = 'md', className, type = 'button', title, ref, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      title={title ?? rest['aria-label']}
      className={cn(buttonClasses({ variant, size: size === 'sm' ? 'sm' : 'md' }), SQUARE[size], className)}
      {...rest}
    >
      {icon}
    </button>
  );
}

export interface IconLinkProps extends IconButtonBaseProps, Omit<LinkProps, 'aria-label' | 'children'> {}

/** Icon-only router link with the same look, e.g. the mobile "Add server". */
export function IconLink({ icon, variant = 'ghost', size = 'md', className, title, ...rest }: IconLinkProps) {
  return (
    <Link
      title={title ?? rest['aria-label']}
      className={cn(buttonClasses({ variant, size: size === 'sm' ? 'sm' : 'md' }), SQUARE[size], className)}
      {...rest}
    >
      {icon}
    </Link>
  );
}
