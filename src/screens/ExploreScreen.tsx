import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRightIcon, GithubLogoIcon, MagnifyingGlassIcon, StarIcon } from '@phosphor-icons/react';
import type { RepositoryListing } from '../../shared/account';
import type { RepositorySort } from '../../shared/repositories';
import { githubRepository } from '../lib/github-repository';
import { plural } from '../lib/format';
import { useDocumentTitle } from '../lib/title';
import { EXAMPLE_ADDRESS, navigate, paths, useRoute } from '../lib/router';
import { Avatar, compact, usePublicRepositories, type PublicRepositories } from '../dashboard/Feed';
import { Label } from '../components/pulls/Bits';
import { RouterLink } from '../components/ui/Link';
import { LoadMore } from '../components/ui/Scroll';
import { LoadingRegion } from '../components/ui/Skeleton';
import { ErrorNotice, ErrorPanel } from '../components/ui/States';
import '../styles/site.css';
import '../styles/explore.css';

const SORTS: { value: RepositorySort; label: string }[] = [{ value: 'updated', label: 'Recently updated' }, { value: 'name', label: 'Name' }];

/**
 * Explore, as a wall of public repositories: one field that searches Braid and opens any GitHub repository pasted into
 * it, then a mosaic where each repository is its picture. One its maintainers uploaded takes a wide tile; the rest
 * show their owner's GitHub face. The recorded example comes first, and more load as the reader scrolls.
 */
export function ExploreScreen() {
  const route = useRoute();
  const q = route.query.get('q')?.trim() ?? '';
  const sort: RepositorySort = route.query.get('sort') === 'name' ? 'name' : 'updated';
  const [query, setQuery] = useState(q);
  const id = useId();
  const github = githubRepository(query);

  useDocumentTitle('Explore · Braid');
  useEffect(() => setQuery(q), [q]);
  useEffect(() => {
    if (query.trim() === q || github) return;
    const timer = window.setTimeout(() => navigate(searchPath(query.trim(), sort), { replace: true }), 200);
    return () => window.clearTimeout(timer);
  }, [query, q, sort, github]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (github) navigate(paths.repo(github));
    else navigate(searchPath(query.trim(), sort), { replace: true });
  };

  return (
    <div className="page explore">
      <h1 className="explore__title">Explore</h1>
      <form className="explore__find" role="search" onSubmit={submit}>
        <label htmlFor={id} className="sr-only">Search Braid or open a GitHub repository</label>
        <span className="explore__field">
          <MagnifyingGlassIcon size={18} aria-hidden="true" />
          <input id={id} type="search" name="q" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search, or paste a GitHub repository" maxLength={2048} autoComplete="off" spellCheck={false} data-1p-ignore />
        </span>
        {github ? (
          <button type="submit" className="explore__open">
            <GithubLogoIcon size={18} aria-hidden="true" />
            <span>Open <strong>{github.owner}/{github.repo}</strong></span>
            <ArrowRightIcon size={16} aria-hidden="true" />
          </button>
        ) : null}
      </form>
      <Mosaic key={JSON.stringify([q, sort])} q={q} sort={sort} />
    </div>
  );
}

function searchPath(q: string, sort: RepositorySort): string {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (sort !== 'updated') query.set('sort', sort);
  return `${paths.explore()}${query.size ? `?${query}` : ''}`;
}

/** The recorded example leads the wall, under its one Recorded label. */
const EXAMPLE: RepositoryListing = {
  owner: { slug: EXAMPLE_ADDRESS.owner, name: EXAMPLE_ADDRESS.owner }, repo: { slug: EXAMPLE_ADDRESS.repo, name: EXAMPLE_ADDRESS.repo }, updatedAt: '',
  description: 'A webhook delivery service on Workers, with six agents’ pull requests and their proof',
};

function Mosaic({ q, sort }: { q: string; sort: RepositorySort }) {
  const repos = usePublicRepositories(q, sort);
  const { live, items, cursor, more, busy, error, total } = repos;
  if (live.error && !live.data) return <ErrorPanel title="Couldn’t load repositories" message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} />;
  if (!live.data) return <MosaicSkeleton />;
  return (
    <>
      <div className="explore__bar">
        <p className="explore__count" role="status">{q && total !== undefined ? plural(total, 'repository', 'repositories') : null}</p>
        <nav className="explore__sort" aria-label="Sort repositories">
          {SORTS.map(option => (
            <RouterLink key={option.value} href={searchPath(q, option.value)} aria-current={sort === option.value ? 'page' : undefined}>{option.label}</RouterLink>
          ))}
        </nav>
      </div>
      {live.error ? <ErrorNotice message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} /> : null}
      {items.length || !q ? (
        <ul className="mosaic" aria-label="Public repositories">
          {q ? null : <Tile item={EXAMPLE} label={<Label tone="simulated">Recorded</Label>} />}
          {items.map(item => <Tile key={`${item.owner.slug}/${item.repo.slug}`} item={item} />)}
        </ul>
      ) : null}
      {!items.length ? <p className="explore__empty">{q ? 'No repositories match your search.' : 'No other public repositories yet.'}</p> : null}
      {error ? <p className="explore__empty" role="alert">{error}</p> : null}
      {cursor ? <LoadMore more={more} busy={busy} failed={!!error} label="Load more repositories" /> : null}
    </>
  );
}

/** One repository as its picture, with its name and stars over it; one with no face is its name and description. */
function Tile({ item, label }: { item: RepositoryListing; label?: ReactNode }) {
  const { owner, repo, description, showcase } = item;
  const [broken, setBroken] = useState(false);
  const [shown, setShown] = useState(false);
  const cover = showcase?.cover && !broken ? showcase.cover : null;
  return (
    <li className="tile" data-wide={cover ? '' : undefined}>
      <RouterLink href={paths.repo({ owner: owner.slug, repo: repo.slug })} className="tile__link" title={description}>
        {/* The face or the name holds the tile, so one waiting for its picture is never blank. */}
        {showcase?.avatar || owner.avatar ? (
          <span className="tile__face"><Avatar item={item} size={88} /></span>
        ) : (
          <span className="tile__text">
            <span className="tile__text-name">{repo.slug}</span>
            {description ? <span className="tile__text-about">{description}</span> : null}
          </span>
        )}
        {cover ? <img className="tile__picture" data-shown={shown || undefined} src={`/api/media?${new URLSearchParams({ url: cover })}`} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setShown(true)} onError={() => setBroken(true)} /> : null}
        <span className="tile__caption">
          <span className="tile__name"><span className="tile__owner">{owner.slug}/</span>{repo.slug}</span>
          {showcase?.stars !== undefined ? <span className="tile__stars"><StarIcon size={13} weight="fill" aria-hidden="true" />{compact.format(showcase.stars)}<span className="sr-only"> stars</span></span> : null}
        </span>
        {label ? <span className="tile__label">{label}</span> : null}
      </RouterLink>
    </li>
  );
}

function MosaicSkeleton() {
  return (
    <LoadingRegion label="Loading repositories">
      <div className="mosaic" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => <div key={index} className="tile tile--loading" data-wide={[1, 6, 9].includes(index) ? '' : undefined} />)}
      </div>
    </LoadingRegion>
  );
}

export type { PublicRepositories };
