import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';

import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Dino } from '../components/Dino';

/**
 * Router error boundary: an unexpected render error, or a lazy page chunk that
 * no longer exists after a deploy. Offers a reload instead of a blank page.
 */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : errorMessage(error);
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6 text-ink">
      <div role="alert" className="flex max-w-[480px] flex-col items-center gap-3 rounded-lg border border-line bg-surface-1 p-8 text-center">
        <Dino mood="lost" size={140} beatTone="muted" label="" />
        <h1 className="m-0 text-h2 font-semibold">Something broke on this page</h1>
        <p className="m-0 text-[13px] text-ink-muted">Reloading usually fixes it, especially right after an update.</p>
        <code className="num break-all text-[12px] text-ink-faint">{message}</code>
        <Button
          variant="primary"
          leadingIcon={<ArrowPathIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </Button>
      </div>
    </main>
  );
}
