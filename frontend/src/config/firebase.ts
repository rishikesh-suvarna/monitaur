import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAuth, type Auth } from 'firebase/auth';

import { getEnv } from './env';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let appCheck: AppCheck | null = null;

/**
 * Lazily initialised so a misconfigured env fails in main.tsx, not at import
 * time. App Check starts with the app when VITE_FIREBASE_APPCHECK_SITE_KEY is
 * set, so its first token is usually ready before the first API call.
 */
function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  const env = getEnv();
  app = initializeApp(env.firebase);
  if (env.appCheckSiteKey) {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(env.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (auth) return auth;
  auth = getAuth(getFirebaseApp());
  return auth;
}

/** True when the build enables Firebase App Check. */
export function appCheckEnabled(): boolean {
  return Boolean(getEnv().appCheckSiteKey);
}

/**
 * The current App Check token (cached and auto-refreshed by the SDK), or null
 * when App Check is off.
 */
export async function getAppCheckToken(): Promise<string | null> {
  getFirebaseApp();
  if (!appCheck) return null;
  const { token } = await getToken(appCheck, false);
  return token;
}
