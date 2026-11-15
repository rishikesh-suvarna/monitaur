import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { errorMessage, hasErrorCode } from '../api/errors';
import { Button, ButtonLink } from '../components/Button';
import { Loader } from '../components/Loader';
import { StatusIcon } from '../components/StatusBadge';
import { useAcceptInvite } from '../hooks/api/me';
import { STORAGE_KEYS, writeStored } from '../lib/storage';
import { useAuth } from '../providers/AuthProvider';
import { useOrg } from '../providers/OrgProvider';

import { AuthAlert, AuthHeading, AuthLayout } from './auth/AuthLayout';

/** /invite/:token: accepts an org invite once signed in, then opens that org. */
export default function InviteAcceptPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { switchOrg } = useOrg();
  const accept = useAcceptInvite();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || token === '') return;
    started.current = true;
    accept.mutate(token, {
      onSuccess: ({ org }) => {
        writeStored(STORAGE_KEYS.currentOrg, org.id);
        switchOrg(org.id);
        void navigate('/', { replace: true });
      },
    });
  }, [accept, navigate, switchOrg, token]);

  const expired = hasErrorCode(accept.error, 'not_found') || hasErrorCode(accept.error, 'invalid');

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
      {accept.isError ? (
        <>
          <AuthAlert>
            <StatusIcon status="critical" size={16} className="mt-px" />
            <span>
              {expired
                ? 'This invite has expired or was already used. Ask for a new one.'
                : hasErrorCode(accept.error, 'forbidden')
                  ? 'This invite was sent to a different email address. Sign in with that account to accept it.'
                  : errorMessage(accept.error)}
            </span>
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
