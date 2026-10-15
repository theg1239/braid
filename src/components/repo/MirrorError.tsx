import { Suspense } from 'react';
import { LinkButton } from '@cloudflare/kumo';
import { writeSession } from '../../account/session';
import { MIRROR_TOO_LARGE } from '../../account/mirrors';
import type { Address } from '../../lib/router';
import { lazyComponent } from '../../lib/lazy';
import { EmptyPanel } from '../ui/States';

const RepositoryField = lazyComponent(() => import('./GitHubRepositoryField'), m => m.GitHubRepositoryField).Component;

/** A GitHub repository Braid can't show. `signIn` offers sign-in to someone signed out, who may see a private one once signed in. */
export function MirrorError({ message, code, address, signIn = false }: { message: string; code?: string | null; address: Address; signIn?: boolean }) {
  return <div className="page mirror-error">
    <EmptyPanel size="base" heading="h1" title={`github.com/${address.owner}/${address.repo}`} description={code === MIRROR_TOO_LARGE ? `${message} Initial imports support up to 40 MB.` : message} action={
      signIn ? <LinkButton variant="primary" href="/api/auth/github" onClick={() => writeSession('next', window.location.pathname + window.location.search + window.location.hash)}>Sign in with GitHub</LinkButton> : <LinkButton variant="primary" href={`https://github.com/${encodeURIComponent(address.owner)}/${encodeURIComponent(address.repo)}`}>Open on GitHub</LinkButton>
    } />
    <div className="mirror-error__field"><Suspense fallback={null}><RepositoryField label="Open another repository" /></Suspense></div>
  </div>;
}
