import { createContext, use, type ReactNode } from 'react';

import { useLiveStream, type LiveStreamStatus } from '../hooks/useLiveStream';

import { useOrgId } from './OrgProvider';

const LiveStreamContext = createContext<LiveStreamStatus | null>(null);

/** Runs the single live stream for the current org (reconnects on org switch). */
export function LiveStreamProvider({ children }: { children: ReactNode }) {
  const orgId = useOrgId();
  const status = useLiveStream(orgId);
  return <LiveStreamContext value={status}>{children}</LiveStreamContext>;
}

/** Connection state of the live stream, for the "Live · updated 2s ago" line. */
export function useLiveStatus(): LiveStreamStatus {
  const context = use(LiveStreamContext);
  if (!context) throw new Error('useLiveStatus must be used inside <LiveStreamProvider>');
  return context;
}
