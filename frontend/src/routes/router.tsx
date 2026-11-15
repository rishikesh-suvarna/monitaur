import { lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';

import { AppShell } from '../components/layout/AppShell';

import { RequireAuth } from './RequireAuth';
import { RouteError } from './RouteError';

// Every page is its own chunk.
const SignInPage = lazy(() => import('../pages/auth/SignInPage'));
const OnboardingPage = lazy(() => import('../pages/onboarding/OnboardingPage'));
const OverviewPage = lazy(() => import('../pages/overview/OverviewPage'));
const InviteAcceptPage = lazy(() => import('../pages/InviteAcceptPage'));
const NotFoundPage = lazy(() => import('../pages/NotFoundPage'));
const ServerDetailPage = lazy(() => import('../pages/server-detail/ServerDetailPage'));
const ServerSettingsPage = lazy(() => import('../pages/server-settings/ServerSettingsPage'));
const AlertsPage = lazy(() => import('../pages/alerts/AlertsPage'));
const RulesPage = lazy(() => import('../pages/rules/RulesPage'));
const ChannelsPage = lazy(() => import('../pages/channels/ChannelsPage'));
const SettingsPage = lazy(() => import('../pages/placeholders/SettingsPage'));
const StatusPage = lazy(() => import('../pages/placeholders/StatusPage'));

export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignInPage />, errorElement: <RouteError /> },
  // Public, no auth and no shell.
  { path: '/status/:slug', element: <StatusPage />, errorElement: <RouteError /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { path: '/onboarding', element: <OnboardingPage /> },
      { path: '/invite/:token', element: <InviteAcceptPage /> },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'servers/:id', element: <ServerDetailPage /> },
          { path: 'servers/:id/settings', element: <ServerSettingsPage /> },
          { path: 'alerts', element: <AlertsPage /> },
          { path: 'rules', element: <RulesPage /> },
          { path: 'channels', element: <ChannelsPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
