import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { authErrorMessage } from '../../auth/authErrors';
import { Button } from '../../components/Button';
import { FullScreenLoader } from '../../components/Loader';
import { Input } from '../../components/Input';
import { StatusIcon } from '../../components/StatusBadge';
import { SESSION_KEYS, isString, readStored, removeStored } from '../../lib/storage';
import { MIN_PASSWORD_LENGTH, useAuth } from '../../providers/AuthProvider';

import { AuthAlert, AuthHeading, AuthLayout } from './AuthLayout';

type Mode = 'in' | 'up' | 'reset';

interface FromState {
  from?: { pathname?: string; search?: string };
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z" />
    </svg>
  );
}

const COPY: Record<Mode, { title: string; subtitle: string; cta: string }> = {
  in: { title: 'Sign in', subtitle: 'Watch your servers. Get paged when they need you.', cta: 'Sign in' },
  up: { title: 'Create your account', subtitle: 'Free for your own servers. No card.', cta: 'Create account' },
  reset: { title: 'Reset your password', subtitle: 'We’ll email you a link to choose a new one.', cta: 'Send reset link' },
};

/** SignIn.dc.html and SignInMobile.dc.html: Google first, then email. */
export default function SignInPage() {
  const { user, initializing, signInWithGoogle, signInWithEmail, signUpWithEmail, sendPasswordReset } = useAuth();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    readStored<string | null>(SESSION_KEYS.signOutReason, null, isString, 'session') === 'expired'
      ? 'Your session expired. Sign in again to continue.'
      : null,
  );
  const [pending, setPending] = useState<'google' | 'email' | null>(null);

  useEffect(() => {
    removeStored(SESSION_KEYS.signOutReason, 'session');
  }, []);

  if (initializing) return <FullScreenLoader />;
  if (user) {
    const from = (location.state as FromState | null)?.from;
    return <Navigate to={from?.pathname ? `${from.pathname}${from.search ?? ''}` : '/'} replace />;
  }

  const copy = COPY[mode];
  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const run = async (kind: 'google' | 'email', action: () => Promise<void>): Promise<void> => {
    setPending(kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setPending(null);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // The form is noValidate so errors use the design's alert, not browser bubbles.
    if (email.trim() === '') {
      setError('Enter your email address.');
      return;
    }
    if (mode !== 'reset' && password === '') {
      setError('Enter your password.');
      return;
    }
    if (mode === 'reset') {
      void run('email', async () => {
        await sendPasswordReset(email);
        setNotice(`If an account exists for ${email.trim()}, a reset link is on its way.`);
      });
      return;
    }
    if (mode === 'up' && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`);
      return;
    }
    void run('email', () => (mode === 'up' ? signUpWithEmail(email, password) : signInWithEmail(email, password)));
  };

  return (
    <AuthLayout>
      <AuthHeading title={copy.title} subtitle={copy.subtitle} />

      {mode !== 'reset' && (
        <>
          <Button
            size="lg"
            block
            leadingIcon={<GoogleIcon />}
            loading={pending === 'google'}
            disabled={pending !== null}
            onClick={() => {
              void run('google', signInWithGoogle);
            }}
          >
            Continue with Google
          </Button>
          <div className="flex items-center gap-3 text-[12px] text-ink-faint">
            <span className="h-px flex-1 bg-line" />
            or with email
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      <form className="flex flex-col gap-3.5" onSubmit={onSubmit} noValidate>
        {error && (
          <AuthAlert>
            <StatusIcon status="critical" size={16} className="mt-px" />
            <span>{error}</span>
          </AuthAlert>
        )}
        {notice && (
          <AuthAlert tone="success">
            <StatusIcon status="healthy" size={16} className="mt-px" />
            <span>{notice}</span>
          </AuthAlert>
        )}
        <Input
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@company.dev"
          required
          size="xl"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        {mode !== 'reset' && (
          <Input
            label="Password"
            type={showPassword ? 'text' : 'password'}
            name="password"
            autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'up' ? MIN_PASSWORD_LENGTH : undefined}
            size="xl"
            className="pr-16"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            hint={mode === 'up' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
            labelAside={
              mode === 'in' ? (
                <button
                  type="button"
                  onClick={() => {
                    switchMode('reset');
                  }}
                  className="border-0 bg-transparent p-0 text-[12px] text-accent underline hover:text-ink"
                >
                  Forgot password?
                </button>
              ) : undefined
            }
            trailing={
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={showPassword}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => {
                  setShowPassword(!showPassword);
                }}
              >
                {showPassword ? 'Hide' : 'Show'}
              </Button>
            }
          />
        )}
        <Button type="submit" variant="primary" size="lg" block loading={pending === 'email'} disabled={pending !== null}>
          {copy.cta}
        </Button>
      </form>

      <p className="m-0 text-center text-[13px] text-ink-muted">
        {mode === 'up' ? 'Already have an account?' : mode === 'reset' ? 'Remembered it?' : 'New to Monitaur?'}{' '}
        <button
          type="button"
          onClick={() => {
            switchMode(mode === 'in' ? 'up' : 'in');
          }}
          className="cursor-pointer border-0 bg-transparent p-0 font-medium text-accent hover:text-ink"
        >
          {mode === 'in' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </AuthLayout>
  );
}
