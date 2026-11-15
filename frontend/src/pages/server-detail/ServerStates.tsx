import { ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageBody } from '../../components/layout/PageHeader';
import { CardSkeleton, Skeleton } from '../../components/Skeletons';
import { cn } from '../../lib/cn';

/** Header placeholder with the real header's padding, so nothing jumps when the server lands. */
export function ServerHeaderSkeleton({ desktop }: { desktop: boolean }) {
  return (
    <header
      aria-busy="true"
      aria-label="Loading server"
      className={cn('flex flex-col border-b border-line', desktop ? 'gap-3.5 px-8 pb-4 pt-5' : 'gap-2.5 bg-surface-1 px-4 py-3')}
    >
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-6 w-64 max-w-full" />
      <Skeleton className="h-3 w-80 max-w-full" />
    </header>
  );
}

export function ServerBodySkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <PageBody>
      {cards > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: cards }, (_, index) => (
            <CardSkeleton key={index} lines={3} />
          ))}
        </div>
      )}
      <CardSkeleton lines={6} />
    </PageBody>
  );
}

/** A bad id, a deleted server, or one in another org (the API answers 404 for all three). */
export function ServerNotFound() {
  return (
    <PageBody>
      <EmptyState
        mood="lost"
        dinoSize={160}
        headingLevel="h1"
        title="This server isn’t here"
        description="It may have been deleted, or it belongs to another organisation."
        action={
          <ButtonLink size="sm" to="/" variant="primary">
            Back to overview
          </ButtonLink>
        }
      />
    </PageBody>
  );
}
