import { Suspense } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { hasErrorCode } from '../api/errors';
import { ErrorState } from '../components/ErrorState';
import { FullScreenLoader } from '../components/Loader';
import { useMe } from '../hooks/api/me';
import { VerifyEmailScreen } from '../pages/auth/VerifyEmailScreen';
import { useAuth } from '../providers/AuthProvider';
import { LiveStreamProvider } from '../providers/LiveStreamProvider';
import { OrgProvider } from '../providers/OrgProvider';

/**
 * Gate for every signed-in route: Firebase session, then GET /me (which also
 * enforces email verification), then the org and live-stream providers.
 */
export function RequireAuth() {
  const { user, initializing } = useAuth();
  const location = useLocation();

  if (initializing) return <FullScreenLoader />;
  if (!user) return <Navigate to="/sign-in" replace state={{ from: location }} />;
  return <SignedIn uid={user.uid} />;
}

function SignedIn({ uid }: { uid: string }) {
  const me = useMe();

  if (me.isPending) return <FullScreenLoader label="Loading your workspace" />;
  if (me.isError) {
    if (hasErrorCode(me.error, 'email_unverified')) return <VerifyEmailScreen onVerified={() => me.refetch()} />;
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-4">
        <ErrorState
          className="w-full max-w-[560px]"
          error={me.error}
          onRetry={() => void me.refetch()}
          retrying={me.isFetching}
          autoRetryMs={15_000}
        />
      </div>
    );
  }

  return (
    <OrgProvider me={me.data} uid={uid}>
      <LiveStreamProvider>
        <Suspense fallback={<FullScreenLoader />}>
          <Outlet />
        </Suspense>
      </LiveStreamProvider>
    </OrgProvider>
  );
}
