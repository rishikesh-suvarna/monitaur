import { useParams } from 'react-router-dom';

import { EmptyState } from '../../components/EmptyState';
import { Logo } from '../../components/Logo';

/**
 * Placeholder for the public /status/:slug page (no auth, no shell). Build
 * from StatusPage.dc.html with usePublicStatus(slug).
 */
export default function StatusPage() {
  const { slug } = useParams();
  return (
    <div className="flex min-h-screen flex-col items-center gap-8 bg-bg px-4 py-12 text-ink">
      <Logo size={32} />
      <EmptyState
        className="w-full max-w-[560px]"
        mood="waiting"
        headingLevel="h1"
        title="Status page coming soon"
        description={slug ? `The public status page for “${slug}” is being rebuilt.` : 'Public status pages are being rebuilt.'}
      />
    </div>
  );
}
