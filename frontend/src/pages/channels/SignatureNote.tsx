import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';

import { Button } from '../../components/Button';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

import { SIGNATURE_SNIPPET } from './channelModel';

/**
 * How a receiver verifies X-Monitaur-Signature. The snippet scrolls
 * sideways instead of wrapping, so the code stays readable in a dialog.
 */
export function SignatureNote() {
  const { copied, error, copy } = useCopyToClipboard();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3">
      <p className="m-0 text-[12px] leading-[18px] text-ink-muted">
        Signed requests carry <code className="num text-ink">X-Monitaur-Signature: sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of the raw request
        body keyed with your secret. Recompute it and compare in constant time:
      </p>
      <div className="overflow-hidden rounded border border-line bg-bg">
        <div className="flex items-center gap-2 border-b border-line py-1 pl-3 pr-1">
          <span className="flex-1 text-[12px] text-ink-faint">Node.js</span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={copied ? 'Copied' : 'Copy verification snippet'}
            onClick={() => {
              void copy(SIGNATURE_SNIPPET);
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
        </div>
        {/* Focusable so keyboard users can scroll the code sideways. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <pre tabIndex={0} aria-label="Signature verification code" className="num m-0 overflow-x-auto whitespace-pre px-3 py-2.5 text-[12px] leading-[18px] text-ink">
          {SIGNATURE_SNIPPET}
        </pre>
      </div>
    </div>
  );
}
