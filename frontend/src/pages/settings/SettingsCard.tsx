import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import { useId, type ReactNode } from 'react';

import { Button } from '../../components/Button';
import { cardClasses } from '../../components/Card';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';

export interface SettingsCardProps {
  title: ReactNode;
  /** Right of the title (a badge or a button). */
  aside?: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** Anchor for links such as /settings#plan. */
  id?: string;
  className?: string;
  children?: ReactNode;
}

/** Settings.dc.html section: a 20 px padded card with a 16 px heading. */
export function SettingsCard({ title, aside, description, id, className, children }: SettingsCardProps) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className={cn(cardClasses, 'flex scroll-mt-4 flex-col gap-4 p-5', className)}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={headingId} className="m-0 text-[16px] font-semibold leading-6">
            {title}
          </h2>
          {description && <span className="text-[12px] leading-4 text-ink-faint">{description}</span>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export interface CopyFieldProps {
  label: ReactNode;
  value: string;
  /** Accessible name of the copy button, e.g. "Copy API URL". */
  copyLabel: string;
  /** Extra controls after Copy (e.g. an Open link). */
  extra?: ReactNode;
}

/** Settings.dc.html endpoint row: label, mono value in a bg well, ghost Copy. */
export function CopyField({ label, value, copyLabel, extra }: CopyFieldProps) {
  const labelId = useId();
  const desktop = useIsDesktop();
  const { copied, error, copy } = useCopyToClipboard();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-[13px] font-medium text-ink">
        {label}
      </span>
      <div className="flex items-center gap-2 rounded border border-line bg-bg py-2 pl-3 pr-2">
        <code aria-labelledby={labelId} className="num flex-1 break-all text-[13px] leading-5 text-ink">
          {value}
        </code>
        <Button
          size={desktop ? 'sm' : 'md'}
          variant="ghost"
          aria-label={copied ? 'Copied' : copyLabel}
          onClick={() => {
            void copy(value);
          }}
          leadingIcon={
            copied ? (
              <CheckIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <ClipboardDocumentIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
            )
          }
        >
          <span aria-live="polite">{error ? 'Copy failed' : copied ? 'Copied' : 'Copy'}</span>
        </Button>
        {extra}
      </div>
    </div>
  );
}

/** A "Save" that appears inside an input while its value differs from the stored one. */
export function InlineSave({ visible, pending, disabled }: { visible: boolean; pending: boolean; disabled?: boolean }) {
  if (!visible) return null;
  return (
    <Button type="submit" size="sm" variant="primary" loading={pending} disabled={disabled}>
      Save
    </Button>
  );
}
