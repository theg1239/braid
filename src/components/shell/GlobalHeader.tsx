import { Suspense, type ReactNode } from 'react';
import { Button, LinkButton } from '@cloudflare/kumo';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useAccount } from '../../account/AccountProvider';
import { AccountRetry } from '../../account/AccountRetry';
import { PALETTE_KEYS } from '../../lib/format';
import { openPalette } from '../../lib/palette';
import { lazyComponent } from '../../lib/lazy';
import { EXAMPLE_ADDRESS, paths, useRoute, type Address } from '../../lib/router';
import { Kbd } from '../ui/Kbd';
import { RouterLink } from '../ui/Link';
import { SkeletonLine } from '../ui/Skeleton';
import { Breadcrumbs } from './Breadcrumbs';
import { Mark } from './Mark';

const AccountControls = lazyComponent(() => import('../../account/Masthead'), m => m.AccountControls).Component;
const ResolvedHeaderContext = lazyComponent(() => import('./ResolvedHeaderContext'), m => m.ResolvedHeaderContext).Component;

/** One masthead for every app page, with repository navigation supplied below it. */
export function GlobalHeader({ address, repoName, details, contextDetail, children, onSearch, onSearchIntent }: { address?: Address | null; repoName?: string; details?: ReactNode; contextDetail?: ReactNode; children?: ReactNode; onSearch?: () => void; onSearchIntent?: () => unknown }) {
  const route = useRoute();
  const { account, accounts, loading, error } = useAccount();
  const repository = address ?? route.repo;
  const signedIn = !!account?.user;
  const breadcrumb = <Breadcrumbs route={route} address={repository} repoName={repoName} />;
  const showSearch = signedIn || !!repository || !accounts;
  return <header className="global-head">
    <div className="global-head__bar">
      <RouterLink href={paths.site()} className="brand" aria-label="Braid"><Mark size={24} /></RouterLink>
      <div className="global-head__identity">{contextDetail ? breadcrumb : repository || route.screen === 'owner' || route.screen === 'organization' ? <Suspense fallback={breadcrumb}>
        <ResolvedHeaderContext route={route} address={repository} repoName={repoName} />
      </Suspense> : breadcrumb}{contextDetail}</div>
      {details ? <div className="global-head__details">{details}</div> : null}
      <div className="global-head__actions">
        {!signedIn && accounts && !loading ? <nav className="global-head__links" aria-label="Site">
          <RouterLink href={paths.explore()} aria-current={route.screen === 'explore' ? 'page' : undefined}>Explore</RouterLink>
          <RouterLink href={paths.repo(EXAMPLE_ADDRESS)}>Tour</RouterLink>
        </nav> : null}
        {showSearch ? <Button variant="secondary" icon={MagnifyingGlassIcon} onClick={onSearch ?? (() => openPalette())} onPointerEnter={onSearchIntent} onFocus={onSearchIntent} className="global-head__search" aria-label={`Search ${PALETTE_KEYS.label}`} aria-keyshortcuts={PALETTE_KEYS.aria}>
          <span className="global-head__search-label">Search</span><Kbd>{PALETTE_KEYS.label}</Kbd>
        </Button> : null}
        {loading ? <SkeletonLine width={32} height={32} /> : error ? <AccountRetry /> : signedIn ? <Suspense fallback={<span className="global-head__account-placeholder"><SkeletonLine width={34} height={34} /></span>}><AccountControls /></Suspense> : accounts ? <LinkButton variant="secondary" size="sm" href={paths.signin(route.screen === 'signin' ? undefined : route.href)}>Sign in</LinkButton> : null}
      </div>
    </div>
    {children}
  </header>;
}
