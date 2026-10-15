import { EXAMPLE_ADDRESS, addressPath, paths, type Address, type Route } from '../../lib/router';
import { RouterLink } from '../ui/Link';

const LABELS: Partial<Record<Route['screen'], string>> = { 'global-search': 'Search', home: 'Dashboard', explore: 'Explore', new: 'New repository', 'new-organization': 'New organization', signin: 'Sign in', authorize: 'Authorize', username: 'Pick a username', organizations: 'Organizations', 'not-found': 'Page not found' };

/** URL labels are always available; resolved names can replace them without changing the frame. */
export function Breadcrumbs({ route, address = route.repo, ownerName, repoName }: { route: Route; address?: Address | null; ownerName?: string; repoName?: string }) {
  const owner = address?.owner ?? (route.screen === 'owner' || route.screen === 'organization' ? route.id : null);
  return <nav className="global-head__context" aria-label="Site breadcrumb">
    {owner ? owner === EXAMPLE_ADDRESS.owner ? <span className="global-head__owner">{owner}</span> : <RouterLink className={address ? 'global-head__owner' : 'global-head__page'} href={paths.owner(owner)} title={ownerName || owner} aria-current={address ? undefined : 'page'}>{ownerName || owner}</RouterLink> : <span className="global-head__page" aria-current="page">{repoName || LABELS[route.screen] || 'Settings'}</span>}
    {address ? <>
      <span className="global-head__slash" aria-hidden="true">/</span>
      <RouterLink className="global-head__repo" href={addressPath(address)} title={repoName || address.repo} aria-current="page">{repoName || address.repo}</RouterLink>
    </> : null}
  </nav>;
}
