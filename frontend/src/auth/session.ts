/**
 * Session plumbing shared by the API client and the AuthProvider. Kept out of
 * React so the client can sign the user out on a dead session without a
 * component tree, and without ever reloading the page.
 */
import { signOut as firebaseSignOut } from 'firebase/auth';

import { ApiError, defaultMessage } from '../api/errors';
import { getFirebaseAuth } from '../config/firebase';
import { queryClient } from '../lib/queryClient';
import { SESSION_KEYS, STORAGE_KEYS, removeStored, writeStored } from '../lib/storage';

export type SignOutReason = 'user' | 'expired';

const NETWORK_ERROR_CODE = 'auth/network-request-failed';

const isNetworkAuthError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === NETWORK_ERROR_CODE;

/** Token provider for the API client, backed by Firebase. */
export async function firebaseTokenProvider(forceRefresh: boolean): Promise<string | null> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch (error) {
    // Offline is not a dead session; do not sign the user out for it.
    if (isNetworkAuthError(error)) {
      throw new ApiError({ status: 0, code: 'network', message: defaultMessage('network'), method: 'AUTH', path: 'token', cause: error });
    }
    throw error;
  }
}

let signingOut: Promise<void> | null = null;

/** Signs out, drops every cached query and forgets the current org. Idempotent. */
export function signOutAndReset(reason: SignOutReason): Promise<void> {
  signingOut ??= (async () => {
    try {
      if (reason === 'expired') writeStored(SESSION_KEYS.signOutReason, reason, 'session');
      await queryClient.cancelQueries();
      queryClient.clear();
      removeStored(STORAGE_KEYS.currentOrg);
      await firebaseSignOut(getFirebaseAuth());
    } finally {
      signingOut = null;
    }
  })();
  return signingOut;
}

/** Called by the API client when a request is still 401 after a forced refresh. */
export function handleUnauthorized(): void {
  void signOutAndReset('expired');
}
