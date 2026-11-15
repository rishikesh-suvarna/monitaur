import { EnvelopeIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';

import { authErrorMessage } from '../../auth/authErrors';
import { Button } from '../../components/Button';
import { StatusIcon } from '../../components/StatusBadge';
import { useNow } from '../../hooks/useNow';
import { useAuth } from '../../providers/AuthProvider';

import { AuthAlert, AuthHeading, AuthLayout } from './AuthLayout';

/** Firebase rate-limits verification emails; do not let people spam the button. */
export const RESEND_COOLDOWN_MS = 60_000;
const MS_PER_SECOND = 1000;

export interface VerifyEmailScreenProps {
  /** Re-run the request that came back `email_unverified` (GET /me). */
  onVerified: () => Promise<unknown>;
}

/**
 * Shown when the API answers 403 `email_unverified`. Password sign-ups land
 * here until they click the link in their inbox.
 */
export function VerifyEmailScreen({ onVerified }: VerifyEmailScreenProps) {
  const { user, sendVerificationEmail, refreshUser, signOut } = useAuth();
  const now = useNow();
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [pending, setPending] = useState<'resend' | 'check' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cooldown = cooldownUntil === null ? 0 : Math.max(0, Math.ceil((cooldownUntil - now) / MS_PER_SECOND));

  const resend = async (): Promise<void> => {
    setPending('resend');
    setError(null);
    try {
      await sendVerificationEmail();
      setNotice('Sent. Check your inbox and spam folder.');
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setPending(null);
    }
  };

  const check = async (): Promise<void> => {
    setPending('check');
    setError(null);
    try {
      const refreshed = await refreshUser();
      if (refreshed && !refreshed.emailVerified) {
        setError('We haven’t seen the confirmation yet. Click the link in the email, then try again.');
        return;
      }
      await onVerified();
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setPending(null);
    }
  };

  return (
    <AuthLayout>
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-[10px] bg-tint-accent text-accent">
        <EnvelopeIcon className="h-6 w-6" strokeWidth={1.6} aria-hidden="true" />
      </span>
      <AuthHeading
        title="Verify your email"
        subtitle={
          <>
            We sent a link to <span className="font-medium text-ink">{user?.email ?? 'your inbox'}</span>. Click it, then come back
            here to continue.
          </>
        }
      />
      {error && (
        <AuthAlert>
          <StatusIcon status="critical" size={16} className="mt-px" />
          <span>{error}</span>
        </AuthAlert>
      )}
      {notice && !error && (
        <AuthAlert tone="success">
          <StatusIcon status="healthy" size={16} className="mt-px" />
          <span>{notice}</span>
        </AuthAlert>
      )}
      <div className="flex flex-col gap-2.5">
        <Button variant="primary" size="lg" block loading={pending === 'check'} disabled={pending !== null} onClick={() => void check()}>
          I’ve verified my email
        </Button>
        <Button size="lg" block loading={pending === 'resend'} disabled={pending !== null || cooldown > 0} onClick={() => void resend()}>
          {cooldown > 0 ? (
            <>
              Resend in <span className="num">{cooldown}s</span>
            </>
          ) : (
            'Resend email'
          )}
        </Button>
      </div>
      <p className="m-0 text-center text-[13px] text-ink-muted">
        Wrong address?{' '}
        <button
          type="button"
          onClick={() => void signOut()}
          className="cursor-pointer border-0 bg-transparent p-0 font-medium text-accent hover:text-ink"
        >
          Sign out
        </button>
      </p>
    </AuthLayout>
  );
}
