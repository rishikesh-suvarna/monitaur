import type { ReactNode } from 'react';

import { ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageBody, PageHeader, type PageHeaderProps } from '../../components/layout/PageHeader';

export interface ComingSoonProps {
  title: ReactNode;
  /** What the finished page will do, in one line. */
  description: string;
  header?: Partial<PageHeaderProps>;
}

/**
 * Placeholder for routes whose screens are not built yet. Uses the shell and
 * the page header so navigation works; replace the whole page when building it.
 */
export function ComingSoon({ title, description, header }: ComingSoonProps) {
  return (
    <>
      <PageHeader title={title} {...header} />
      <PageBody>
        <EmptyState
          mood="waiting"
          beatTone="muted"
          dinoSize={160}
          headingLevel="h2"
          title="This page is coming soon"
          description={description}
          action={
            <ButtonLink size="sm" to="/">
              Back to overview
            </ButtonLink>
          }
        />
      </PageBody>
    </>
  );
}
