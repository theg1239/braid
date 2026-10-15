import type { ReactNode } from 'react';
import { LinkButton } from '@cloudflare/kumo';
import { paths, useRoute } from '../../lib/router';
import { useDocumentTitle } from '../../lib/title';
import { useAccount } from '../../account/AccountProvider';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { PageState } from '../ui/States';
import { LoadingContent } from '../ui/LoadingContent';
import { GlobalHeader } from './GlobalHeader';

/** A page of the site: the global header and one column. The landing page draws its own header, in its own chunk. */
export function SitePage({ children }: { children: ReactNode }) {
  const route = useRoute();
  return (
    <div className="app app--site">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <GlobalHeader />
      <main id="main" className="main" tabIndex={-1}>
        <LoadingContent value={true}><ErrorBoundary resetKey={route.href}>{children}</ErrorBoundary></LoadingContent>
      </main>
    </div>
  );
}

/** One clean 404: a page that does not exist, or a repository that is private or unknown. */
/** `children` is a next step beside the way out, such as linking the owner to GitHub. */
export function NotFound({ kind, children }: { kind: 'page' | 'repository'; children?: ReactNode }) {
  const { accounts } = useAccount();
  const title = kind === 'repository' ? 'Repository not found' : 'Page not found';
  useDocumentTitle(`${title} · Braid`);
  return (
    <SitePage>
      <div className="page">
        <PageState title={title}>
          {children}
          <LinkButton variant="secondary" href={accounts ? paths.explore() : paths.site()}>
            {accounts ? 'Explore repositories' : 'Back to repository'}
          </LinkButton>
        </PageState>
      </div>
    </SitePage>
  );
}
