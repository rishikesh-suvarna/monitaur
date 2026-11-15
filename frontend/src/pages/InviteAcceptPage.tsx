import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { errorMessage, hasErrorCode } from '../api/errors';
import { Button, ButtonLink } from '../components/Button';
import { Loader } from '../components/Loader';
import { StatusIcon } from '../components/StatusBadge';
import { useAcceptInvite } from '../hooks/api/me';
import { useAuth } from '../providers/AuthProvider';
import { useOrg } from '../providers/OrgProvider';

import { AuthAlert, AuthHeading, AuthLayout } from './auth/AuthLayout';

function failureText(error: unknown): string {
  if (hasErrorCode(error, 'invalid') || hasErrorCode(error, 'not_found')) {
    return 'This invite is invalid, has expired, was already used, or was sent to a different email address. Ask for a new one, or sign in with the invited address.';
  }
  if (hasErrorCode(error, 'limit_reached')) return 'That organisation has no free seats on its plan. Ask an admin to free one, then open the link again.';
  return errorMessage(error);
}

/**
 * /invite/:token, behind RequireAuth (signed-out visitors go to /sign-in and
 * come back here). Accepts the invite once, then switches to that org, which
 * also lands on the overview.
 */
export default function InviteAcceptPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { switchOrg } = useOrg();
  const { mutateAsync } = useAcceptInvite();
  const started = useRef(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    if (started.current || token === '') return;
    started.current = true;
    // mutateAsync rather than mutate callbacks: StrictMode re-subscribes the
    // mutation observer right after this effect, which drops per-call
    // callbacks and would leave the page spinning in development.
    mutateAsync(token)
      .then(({ org }) => {
        // Replace first so Back never returns to a spent invite link; then
        // switch (useAcceptInvite has already refetched /me, so the org is known).
        void navigate('/', { replace: true });
        switchOrg(org.id);
      })
      .catch((error: unknown) => {
        setFailure(error);
      });
  }, [mutateAsync, navigate, switchOrg, token]);

  const failed = failure !== null || token === '';

  return (
    <AuthLayout>
      <AuthHeading
        title="Join an organisation"
        subtitle={
          <>
            Signed in as <span className="font-medium text-ink">{user?.email}</span>.
          </>
        }
      />
      {failed ? (
        <>
          <AuthAlert>
            <StatusIcon status="critical" size={16} className="mt-px" />
            <span>{token === '' ? 'This invite link is incomplete.' : failureText(failure)}</span>
          </AuthAlert>
          <div className="flex flex-col gap-2.5">
            <ButtonLink to="/" variant="primary" size="lg" block>
              Go to your dashboard
            </ButtonLink>
            <Button size="lg" block onClick={() => void signOut()}>
              Sign in with another account
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3 text-ink-muted">
          <Loader size={24} label={null} className="text-accent" />
          <span role="status">Accepting the invite…</span>
        </div>
      )}
    </AuthLayout>
  );
}
