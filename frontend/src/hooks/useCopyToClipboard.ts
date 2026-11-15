import { useCallback, useEffect, useRef, useState } from 'react';

/** Components.dc.html: the label flips to "Copied" for 2 s. */
export const COPIED_RESET_MS = 2000;

async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && 'clipboard' in navigator) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for insecure contexts (plain http on a LAN box).
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    // Deprecated, but the only option without the async Clipboard API.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (!document.execCommand('copy')) throw new Error('Copy command was rejected');
  } finally {
    area.remove();
  }
}

export interface CopyState {
  copied: boolean;
  error: boolean;
  copy: (text: string) => Promise<void>;
}

export function useCopyToClipboard(): CopyState {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (text: string) => {
    if (timer.current !== null) clearTimeout(timer.current);
    try {
      await writeClipboard(text);
      setError(false);
      setCopied(true);
    } catch {
      setError(true);
      setCopied(false);
    }
    timer.current = setTimeout(() => {
      setCopied(false);
      setError(false);
    }, COPIED_RESET_MS);
  }, []);

  return { copied, error, copy };
}
