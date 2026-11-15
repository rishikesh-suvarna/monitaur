import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

import { cn } from '../lib/cn';

import { buttonClasses, type ButtonStyleProps } from './buttonClasses';
import { Loader } from './Loader';

export type { ButtonSize, ButtonStyleProps, ButtonVariant } from './buttonClasses';

export interface ButtonProps extends ButtonStyleProps, ButtonHTMLAttributes<HTMLButtonElement> {
  /** Shows the inline eye loader and disables the button. */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** Primary is the only accent-filled control on a screen. */
export function Button({
  variant,
  size,
  block,
  loading = false,
  leadingIcon,
  trailingIcon,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses({ variant, size, block }), className)}
      {...rest}
    >
      {loading ? <Loader size={size === 'sm' ? 14 : 16} label={null} /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}

export interface ButtonLinkProps extends ButtonStyleProps, LinkProps {
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

/** A router link styled as a button, for navigation actions like "Add server". */
export function ButtonLink({ variant, size, block, leadingIcon, trailingIcon, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={cn(buttonClasses({ variant, size, block }), className)} {...rest}>
      {leadingIcon}
      {children}
      {trailingIcon}
    </Link>
  );
}
