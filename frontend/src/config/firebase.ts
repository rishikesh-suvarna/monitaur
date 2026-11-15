import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

import { getEnv } from './env';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

/** Lazily initialised so a misconfigured env fails in main.tsx, not at import time. */
export function getFirebaseAuth(): Auth {
  if (auth) return auth;
  app ??= initializeApp(getEnv().firebase);
  auth = getAuth(app);
  return auth;
}
