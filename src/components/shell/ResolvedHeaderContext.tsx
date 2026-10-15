import { accountOwners, type OwnerKind } from '../../../shared/account';
import { useAccount } from '../../account/AccountProvider';
import { useRepositoryAddress } from '../../account/addresses';
import { useOwner } from '../../account/owners';
import { isExample, type Address, type Route } from '../../lib/router';
import { Breadcrumbs } from './Breadcrumbs';

/** As on GitHub, a person reads as their username, which the address already shows, and an organization by its name. */
const ownerName = (owner?: { name: string; kind?: OwnerKind }) => (owner?.kind === 'user' ? undefined : owner?.name);

/** Read the same cached answers as the page; the URL breadcrumb remains visible throughout. */
export function ResolvedHeaderContext({ route, address, repoName }: { route: Route; address: Address | null; repoName?: string }) {
  const { account } = useAccount();
  const owner = address?.owner ?? route.id;
  const organization = accountOwners(account).find(org => org.slug === owner);
  if (address) {
    if (organization || isExample(address)) return <Breadcrumbs route={route} address={address} ownerName={ownerName(organization)} repoName={repoName || organization?.workspaces.find(repo => repo.slug === address.repo)?.name} />;
    return <RepositoryContext route={route} address={address} repoName={repoName} />;
  }
  return <OwnerContext route={route} />;
}

function OwnerContext({ route }: { route: Route }) {
  const page = useOwner(route.id!);
  return <Breadcrumbs route={route} ownerName={ownerName(page.data?.owner)} />;
}

function RepositoryContext({ route, address, repoName }: { route: Route; address: Address; repoName?: string }) {
  const result = useRepositoryAddress(address);
  const found = result.status === 'ready' ? result.address : null;
  return <Breadcrumbs route={route} address={address} ownerName={ownerName(found?.owner)} repoName={repoName || found?.repo.name} />;
}
