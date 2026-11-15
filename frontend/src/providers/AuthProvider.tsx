import { useQueryClient } from '@tanstack/react-query';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  type User,
} from 'firebase/auth';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { authErrorCode } from '../auth/authErrors';
import { signOutAndReset } from '../auth/session';
import { getFirebaseAuth } from '../config/firebase';

/** SignIn.dc.html sign-up hint: "At least 10 characters." */
export const MIN_PASSWORD_LENGTH = 10;

export interface AuthContextValue {
  user: User | null;
  /** True until Firebase has restored (or ruled out) a session. */
  initializing: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  /** Creates the account and sends the verification email. */
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  sendVerificationEmail: () => Promise<void>;
  /** Reloads the user and forces a new ID token so `email_verified` is current. */
  refreshUser: () => Promise<User | null>;
  /** Signs out and clears every cached query. */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = getFirebaseAuth();
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [initializing, setInitializing] = useState(true);
  const previousUid = useRef<string | null>(null);

  useEffect(
    () =>
      onAuthStateChanged(auth, (next) => {
        // A different (or no) user must never see the previous user's cache.
        if (previousUid.current !== null && previousUid.current !== next?.uid) queryClient.clear();
        previousUid.current = next?.uid ?? null;
        setUser(next);
        setInitializing(false);
      }),
    [auth, queryClient],
  );

  const signInWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      // Mobile browsers often block popups; a full-page redirect still works.
      if (authErrorCode(error) === 'auth/popup-blocked') {
        await signInWithRedirect(auth, provider);
        return;
      }
      throw error;
    }
  }, [auth]);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    },
    [auth],
  );

  const signUpWithEmail = useCallback(
    async (email: string, password: string) => {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw Object.assign(new Error('Password too short'), { code: 'auth/weak-password' });
      }
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      await sendEmailVerification(credential.user);
    },
    [auth],
  );

  const sendPasswordReset = useCallback(
    async (email: string) => {
      await sendPasswordResetEmail(auth, email.trim());
    },
    [auth],
  );

  const sendVerificationEmail = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) throw Object.assign(new Error('Not signed in'), { code: 'auth/no-current-user' });
    await sendEmailVerification(current);
  }, [auth]);

  const refreshUser = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return null;
    await current.reload();
    await current.getIdToken(true);
    const refreshed = auth.currentUser;
    setUser(refreshed);
    return refreshed;
  }, [auth]);

  const signOut = useCallback(() => signOutAndReset('user'), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      initializing,
      signInWithGoogle,
      signInWithEmail,
      signUpWithEmail,
      sendPasswordReset,
      sendVerificationEmail,
      refreshUser,
      signOut,
    }),
    [user, initializing, signInWithGoogle, signInWithEmail, signUpWithEmail, sendPasswordReset, sendVerificationEmail, refreshUser, signOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const context = use(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
