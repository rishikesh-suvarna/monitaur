# Monitaur dashboard

React 19, TypeScript (strict, `noUncheckedIndexedAccess`), Vite 7, Tailwind 3, TanStack Query 5, React Router 7, Headless UI 2, Heroicons, Recharts 3 and Firebase Auth. Package manager: Yarn 1.

The visual source of truth is the "Monitaur dashboard redesign" canvas (one `.dc.html` per artboard). The API contract is `docs/platform-v2.md` section 4.

## Commands

```bash
yarn install --frozen-lockfile
yarn dev          # http://localhost:5173
yarn typecheck    # tsc --noEmit for app and config files
yarn lint         # ESLint with typescript-eslint (strict, type-checked) and jsx-a11y
yarn test         # Vitest unit tests
yarn build        # typecheck, then vite build
```

## Environment

Set these in `.env.development.local` (gitignored) or the build environment. The app checks them at startup and shows a configuration error instead of booting if a required one is missing or malformed.

| Variable | Required | Notes |
|---|---|---|
| `VITE_APP_SERVER_URL` | yes | Backend origin, `http(s)://`. The API is `${VITE_APP_SERVER_URL}/api/v1`. |
| `VITE_APP_SERVER_WS_URL` | yes | Agent WebSocket origin, `ws(s)://`. Written into the agent config as `${VITE_APP_SERVER_WS_URL}/agent/connect`. |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | yes | Firebase web config. |
| `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID` | no | Not used by Auth. |
| `VITE_FIREBASE_APPCHECK_SITE_KEY` | no | reCAPTCHA Enterprise site key. When set, Firebase App Check starts with the app and every signed-in API request sends `X-Firebase-AppCheck` (pair with the backend's `require_app_check`). |
| `VITE_FIREBASE_AUTH_EMULATOR_HOST` | no | `host:port` of the Firebase Auth emulator for local end-to-end runs. Ignored in production builds. |

## Layout

```
src/
  main.tsx, App.tsx      entry (env check first), providers
  styles/                tokens.css (design tokens as RGB channels), index.css
  config/                env.ts (validated env), firebase.ts (lazy init)
  api/                   typed client, endpoints, errors, query keys, SSE parser, cache patches, types
  auth/                  session.ts (token provider, sign-out), authErrors.ts
  providers/             Theme, Motion, Auth, Org, LiveStream
  hooks/                 hooks/api/* (TanStack Query per endpoint), useLiveStream and UI hooks
  components/            design system; components/layout/ is the app shell
  lib/                   formatters, status mapping, fleet logic, sparkline geometry, storage
  routes/                router, RequireAuth gate, route error boundary
  pages/                 one folder per screen (see Screens), plus 404 and invite acceptance
```

Page folders keep their pure logic in a `*Model.ts` beside the components (`rules/ruleModel.ts`, `channels/channelModel.ts`, `settings/settingsModel.ts`, `status/statusModel.ts`), unit tested next to it.

Import shared pieces from the barrels: `src/components/index.ts`, `src/hooks/index.ts`, `src/api/index.ts`.

## Conventions

- Tokens: use the Tailwind theme (`bg-surface-1`, `border-line`, `text-ink-muted`, `text-crit`, `bg-tint-warn`, `text-h2`, `rounded-lg`, `shadow-float`). Never hard-code colours. Numbers go in `.num` (Geist Mono, tabular figures).
- Status is colour + shape + word: use `StatusBadge` / `StatusIcon` and `presentIncident()`. Data series use `series` colours; warn/crit only for threshold breaches.
- Data: org-scoped hooks read the org from `useOrgId()`; keys come from `queryKeys` and always start with `['org', orgId]`. Mutations invalidate targeted keys (v5 object syntax).
- Live data: `LiveStreamProvider` runs one fetch-based SSE connection and patches the servers and incidents caches; read its state with `useLiveStatus()`. Do not open a second stream.
- Errors are `ApiError` with `code` and `status`. A 401 retries once with a forced token refresh, then signs out; the app never reloads itself.
- Role-restricted actions stay visible but disabled (`useOrg().can('member')`) with a `title` explaining why.
- Motion respects `prefers-reduced-motion` and the user override (`useMotion()`); JS animations check `useReducedMotion()`.

## Screens

| Route | Page module | Artboards |
|---|---|---|
| `/sign-in` | `pages/auth/` | SignIn, SignInMobile |
| `/onboarding` | `pages/onboarding/` | Onboarding, OnboardingMobile |
| `/` | `pages/overview/` | Main, OverviewLight, OverviewMobile, States |
| `/servers/:id` | `pages/server-detail/` | ServerDetail, ServerDetailLight, ServerDetailMobile |
| `/servers/:id/settings` | `pages/server-settings/` | ServerSettings, ServerSettingsMobile |
| `/alerts` | `pages/alerts/` | Alerts, AlertsMobile |
| `/rules` | `pages/rules/` | Rules, RulesMobile |
| `/channels` | `pages/channels/` | Channels, ChannelsMobile |
| `/settings` | `pages/settings/` | Settings, SettingsMobile (plus organization, plan and status page sections) |
| `/status/:slug` | `pages/status/` | StatusPage (public, no shell) |
| `/invite/:token` | `pages/InviteAcceptPage.tsx` | |

