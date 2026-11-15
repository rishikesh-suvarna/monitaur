/** Friendly copy for Firebase Auth error codes, in the SignIn design's voice. */

const MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'That email and password don’t match. Try again or reset your password.',
  'auth/wrong-password': 'That email and password don’t match. Try again or reset your password.',
  'auth/user-not-found': 'That email and password don’t match. Try again or reset your password.',
  'auth/invalid-email': 'That doesn’t look like an email address.',
  'auth/email-already-in-use': 'An account with that email already exists. Sign in instead.',
  'auth/weak-password': 'Choose a longer password.',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/network-request-failed': 'Can’t reach the sign-in service. Check your connection.',
  'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups and try again.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/account-exists-with-different-credential': 'This email is already registered with a different sign-in method.',
  'auth/missing-email': 'Enter your email address first.',
};

/** Codes that mean the user simply backed out; show nothing. */
const SILENT_CODES = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request']);

export function authErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return null;
}

/** Message to show for a failed auth action, or null when it should be silent. */
export function authErrorMessage(error: unknown): string | null {
  const code = authErrorCode(error);
  if (code !== null && SILENT_CODES.has(code)) return null;
  if (code !== null) {
    const message = MESSAGES[code];
    if (message) return message;
  }
  return 'Something went wrong signing you in. Try again.';
}
