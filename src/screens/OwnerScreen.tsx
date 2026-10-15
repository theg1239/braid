import { useEffect, useState } from 'react';
import { Badge, Input, LinkButton, Select } from '@cloudflare/kumo';
import { BuildingsIcon, CompassIcon, UserIcon } from '@phosphor-icons/react';
import type { OwnerRepositories } from '../../shared/owners';
import { useOwner } from '../account/owners';
import { ClaimOwner } from '../account/ClaimOwner';
import { useAccount } from '../account/AccountProvider';
import { OrganizationPeople } from '../account/OrganizationPeople';
import { OrganizationSettings } from '../account/OrganizationSettings';
import { RouterLink } from '../components/ui/Link';
import { Avatar } from '../components/ui/Avatar';
import { EmptyPanel, ErrorPanel } from '../components/ui/States';
import { LoadingRegion, SkeletonLine, SkeletonRow } from '../components/ui/Skeleton';
import { absoluteTime, plural, relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { navigate, paths, useRoute } from '../lib/router';
import { OrganizationTeams } from './OrganizationTeams';
import '../styles/owner.css';
import '../styles/settings.css';

export function OwnerScreen() {
  const route = useRoute();
  const slug = route.id!;
  const { account } = useAccount();
  const page = useOwner(slug);
  const organization = account?.organizations.find(org => org.slug === page.data?.owner.slug);
  const personal = page.data?.owner.kind === 'user';
  const section = route.screen === 'organization' ? route.sub : route.query.get('tab') === 'repositories' ? 'repositories' : 'overview';
  const restricted = personal && route.screen === 'organization' || (section === 'teams' || section === 'people') && !organization || section === 'settings' && organization?.role !== 'owner';
  const missing = page.errorStatus === 404 || !!page.data && restricted;
  const title = missing ? 'Page not found' : (page.data?.owner.name || slug);
  useDocumentTitle(`${title} · Braid`);
  useEffect(() => {
    if (page.data && !page.error && page.data.owner.slug !== slug) {
      const canonical = page.data.owner.slug;
      navigate(page.data.owner.kind === 'user' ? `${paths.owner(canonical)}${section === 'repositories' ? '?tab=repositories' : ''}` : section === 'overview' ? paths.owner(canonical) : route.path ? paths.organizationTeam(canonical, route.path, route.query.get('tab') === 'repositories' ? 'repositories' : undefined) : paths.organization(canonical, section as 'repositories'), { replace: true });
    }
  }, [page.data, page.error, slug, section, route.path, route.query]);
  if (missing) return <div className="page"><EmptyPanel size="base" heading="h1" icon={<CompassIcon size={36} />} title="Page not found" action={<LinkButton variant="secondary" href={paths.explore()}>Explore repositories</LinkButton>} /></div>;
  if (page.error) return <div className="page owner"><ErrorPanel heading="h1" title="Couldn’t load profile" message={page.error} onRetry={() => void page.refresh()} retrying={page.refreshing} /></div>;
  if (!page.data) return <LoadingRegion className="page owner" label="Loading profile"><div className="owner__head"><span className="owner__icon"><SkeletonLine width={38} height={38} /></span><SkeletonLine width={180} height={28} /></div><div className="owner__skeleton-tabs"><SkeletonLine width={80} /><SkeletonLine width={110} /><SkeletonLine width={70} /></div>{[0, 1, 2, 3].map(index => <SkeletonRow key={index} index={index} detail icon={false} height={100} />)}</LoadingRegion>;
  const { owner, repositories, memberCount } = page.data;
  const mirror = page.data.mirror || owner.mirror;
  const canCreate = !mirror && (personal ? account?.user?.username === owner.slug : organization?.role === 'owner');
  const repositoriesHref = personal ? `${paths.owner(owner.slug)}?tab=repositories` : paths.organization(owner.slug, 'repositories');
  const tabs = [{ id: 'overview', label: 'Overview', href: paths.owner(owner.slug) }, { id: 'repositories', label: 'Repositories', href: repositoriesHref },
    ...(!personal && organization ? [{ id: 'teams', label: 'Teams', href: paths.organization(owner.slug, 'teams') }, { id: 'people', label: 'People', href: paths.organization(owner.slug, 'people') }] : []),
    ...(!personal && canCreate ? [{ id: 'settings', label: 'Settings', href: paths.organization(owner.slug, 'settings') }] : [])];
  return <div className="page owner">
    <header className="owner__head"><span className="owner__icon"><Avatar src={owner.avatarUrl} size={72} className="owner__avatar" fallback={personal ? <UserIcon size={38} aria-hidden="true" /> : <BuildingsIcon size={38} aria-hidden="true" />} /></span><div className="owner__identity"><h1 className="owner__title">{owner.name || owner.slug}</h1>{mirror ? <a className="owner__address" href={`https://github.com/${encodeURIComponent(owner.slug)}`}>Mirrored from github.com/{owner.slug}</a> : personal || owner.name !== owner.slug ? <RouterLink className="owner__address" href={paths.owner(owner.slug)}>{personal ? `@${owner.slug}` : owner.slug}</RouterLink> : null}</div>{mirror ? <span className="owner__claim"><ClaimOwner slug={owner.slug} claimable={page.data.claimable ?? owner.claimable} onClaimed={page.refresh} /></span> : null}</header>
    <nav className="org-tabs" aria-label={personal ? 'Profile' : 'Organization'}>{tabs.map(tab => <RouterLink key={tab.id} href={tab.href} aria-current={section === tab.id ? 'page' : undefined}>{tab.label}{tab.id === 'repositories' ? <span className="owner__count">{repositories.length}</span> : null}</RouterLink>)}</nav>
    {section === 'overview' ? <>
      {organization && memberCount !== undefined ? <div className="org-counts"><RouterLink href={paths.organization(owner.slug, 'people')}>{plural(memberCount, 'person', 'people')}</RouterLink><RouterLink href={repositoriesHref}>{plural(repositories.length, 'repository', 'repositories')}</RouterLink></div> : null}
      <div className="org-section-head"><h2>Recent repositories</h2>{canCreate && repositories.length ? <LinkButton variant="primary" href={paths.newRepository(owner.slug)}>New repository</LinkButton> : null}</div>
      <RepositoryList owner={owner} repositories={repositories.slice(0, 6)} canCreate={canCreate} />
      {repositories.length > 6 ? <RouterLink className="org-more" href={repositoriesHref}>View all repositories</RouterLink> : null}
    </> : null}
    {section === 'repositories' ? <RepositorySearch key={slug} page={page.data} canCreate={canCreate} /> : null}
    {section === 'people' && organization ? <OrganizationPeople key={organization.id} team={organization} /> : null}
    {section === 'settings' && organization ? <OrganizationSettings organization={organization} onChange={() => void page.refresh()} /> : null}
    {section === 'teams' && organization ? <OrganizationTeams organization={organization} /> : null}
  </div>;
}

function RepositorySearch({ page, canCreate }: { page: OwnerRepositories; canCreate: boolean }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState('updated');
  const items = page.repositories.filter(repo => (type === 'all' || repo.visibility === type) && `${repo.name} ${repo.slug} ${repo.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
  return <>
    <div className="org-filters"><Input aria-label="Find a repository" placeholder="Find a repository…" value={query} onChange={event => setQuery(event.target.value)} type="search" passwordManagerIgnore /><Select aria-label="Repository type" value={type} onValueChange={value => setType(String(value))} items={[{ value: 'all', label: 'All' }, { value: 'public', label: 'Public' }, { value: 'private', label: 'Private' }]} /><Select aria-label="Sort repositories" value={sort} onValueChange={value => setSort(String(value))} items={[{ value: 'updated', label: 'Last updated' }, { value: 'name', label: 'Name' }]} />{canCreate && page.repositories.length ? <LinkButton variant="primary" href={paths.newRepository(page.owner.slug)}>New repository</LinkButton> : null}</div>
    <RouterLink className="org-more" href={paths.globalSearch(`${page.owner.kind === 'user' ? 'user' : 'org'}:${page.owner.slug}${query.trim() ? ` ${query.trim()}` : ''}`)}>Search code in {page.owner.slug}</RouterLink>
    {page.repositories.length && !items.length ? <p className="owner__empty">No repositories match your search.</p> : <RepositoryList owner={page.owner} repositories={items} canCreate={canCreate} />}
  </>;
}

function RepositoryList({ owner, repositories, canCreate }: Pick<OwnerRepositories, 'owner' | 'repositories'> & { canCreate: boolean }) {
  const now = useNow();
  if (!repositories.length) return <div className="org-empty"><h2>No repositories yet.</h2>{canCreate ? <div className="org-actions"><LinkButton variant="primary" href={paths.newRepository(owner.slug)}>New repository</LinkButton><LinkButton variant="secondary" href={paths.newRepository(owner.slug, true)}>Import</LinkButton></div> : null}</div>;
  return <ul aria-label="Repositories">{repositories.map(repo => <li key={repo.slug} className="owner__repo"><div className="owner__repo-title"><RouterLink href={paths.repo({ owner: owner.slug, repo: repo.slug })} className="owner__repo-name">{repo.name}</RouterLink><Badge variant="outline">{repo.visibility === 'public' ? 'Public' : 'Private'}</Badge></div>{repo.description ? <p className="owner__description">{repo.description}</p> : null}<time className="owner__updated" dateTime={repo.updatedAt} title={absoluteTime(repo.updatedAt)}>Updated {relativeTime(repo.updatedAt, now)}</time></li>)}</ul>;
}
