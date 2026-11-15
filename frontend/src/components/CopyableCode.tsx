import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';

import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { cn } from '../lib/cn';

import { Button } from './Button';

export interface CopyableCodeProps {
  /** Exactly what is copied. */
  code: string;
  /** What is shown, when it differs from `code` (e.g. a masked token). Defaults to `code`. */
  children?: ReactNode;
  /** Prefix a non-selectable "$ " prompt (shell commands). */
  prompt?: boolean;
  /** Multi-line block (config files) instead of a single command. */
  block?: boolean;
  /** Accessible name for the copy button, e.g. "Copy install command". */
  copyLabel?: string;
  className?: string;
}

/**
 * Components.dc.html CopyableCode: click copies; the label flips to "Copied"
 * for 2 s. Never truncates; long lines wrap.
 */
export function CopyableCode({ code, children, prompt = false, block = false, copyLabel = 'Copy', className }: CopyableCodeProps) {
  const { copied, error, copy } = useCopyToClipboard();
  const content = (
    <>
      {prompt && <span className="select-none text-ink-faint">$ </span>}
      {children ?? code}
    </>
  );
  return (
    <div className={cn('flex items-start gap-2 rounded-lg border border-line bg-bg py-3 pl-4 pr-3', className)}>
      {block ? (
        <pre className="num m-0 flex-1 whitespace-pre-wrap break-all text-[13px] leading-[21px] text-ink">{content}</pre>
      ) : (
        <code className="num flex-1 break-all text-[13px] leading-5 text-ink">{content}</code>
      )}
      <Button
        size="sm"
        onClick={() => {
          void copy(code);
        }}
        aria-label={copied ? 'Copied' : copyLabel}
        leadingIcon={
          copied ? <CheckIcon className="h-3.5 w-3.5" strokeWidth={1.8} /> : <ClipboardDocumentIcon className="h-3.5 w-3.5" strokeWidth={1.8} />
        }
      >
        <span aria-live="polite">{error ? 'Copy failed' : copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  );
}

/** A non-copyable code line in the same well (e.g. "sudo systemctl ..."). */
export function CodeLine({ children, prompt = true, className }: { children: ReactNode; prompt?: boolean; className?: string }) {
  return (
    <code className={cn('num block rounded-lg border border-line bg-bg px-4 py-3 text-[13px] leading-5 text-ink', className)}>
      {prompt && <span className="select-none text-ink-faint">$ </span>}
      {children}
    </code>
  );
}
