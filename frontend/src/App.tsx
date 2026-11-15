import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { RouterProvider } from 'react-router-dom';

import { FullScreenLoader } from './components/Loader';
import { ToastProvider } from './components/Toasts';
import { queryClient } from './lib/queryClient';
import { AuthProvider } from './providers/AuthProvider';
import { MotionProvider } from './providers/MotionProvider';
import { ThemeProvider } from './providers/ThemeProvider';
import { router } from './routes/router';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MotionProvider>
          <ToastProvider>
            <AuthProvider>
              <Suspense fallback={<FullScreenLoader />}>
                <RouterProvider router={router} />
              </Suspense>
            </AuthProvider>
          </ToastProvider>
        </MotionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
