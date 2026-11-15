import { firebaseTokenProvider, handleUnauthorized } from '../auth/session';
import { getEnv } from '../config/env';
import { appCheckEnabled, getAppCheckToken } from '../config/firebase';

import { createApiClient } from './client';
import { createEndpoints } from './endpoints';

/** The app's API, authenticated with the signed-in Firebase user. */
export const api = createEndpoints(
  createApiClient({
    baseUrl: getEnv().apiBaseUrl,
    getToken: firebaseTokenProvider,
    onUnauthorized: handleUnauthorized,
    ...(appCheckEnabled() ? { getAppCheckToken } : {}),
  }),
);

export type { ApiClient, ApiClientOptions, RequestOptions } from './client';
export { APP_CHECK_HEADER, createApiClient, ORG_HEADER } from './client';
export { createEndpoints, type Endpoints } from './endpoints';
export * from './errors';
export { queryKeys } from './queryKeys';
export type * from './types';
