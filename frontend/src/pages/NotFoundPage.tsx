import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';

import { Button, ButtonLink } from '../components/Button';
import { Dino } from '../components/Dino';
import { Kbd } from '../components/Kbd';
import { PageBody } from '../components/layout/PageHeader';
import { useOptionalShell } from '../components/layout/ShellContext';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { modKeyLabel } from '../lib/names';

/** States.dc.html 404: "This page went extinct." */
export default function NotFoundPage() {
  const shell = useOptionalShell();
  const desktop = useIsDesktop();
  return (
    <PageBody>
      <section
        aria-labelledby="not-found-title"
        className="flex flex-wrap items-center justify-center gap-12 rounded-lg border border-line bg-surface-1 px-8 py-14"
      >
        <Dino mood="lost" size={desktop ? 280 : 180} beatTone="muted" label="" />
        <div className="flex max-w-[420px] flex-col gap-3">
          <span className="num text-[13px] text-ink-faint">404 · no heartbeat at this URL</span>
          <h1 id="not-found-title" className="m-0 text-display font-semibold tracking-[-0.01em]">
            This page went extinct.
          </h1>
          <p className="m-0 text-ink-muted">Rex checked every rack. Maybe the server was deleted or the link is old.</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink to="/" variant="primary">
              Back to overview
            </ButtonLink>
            {shell && (
              <Button onClick={shell.openPalette} leadingIcon={<MagnifyingGlassIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}>
                Find a server <Kbd>{modKeyLabel('K')}</Kbd>
              </Button>
            )}
          </div>
        </div>
      </section>
    </PageBody>
  );
}
