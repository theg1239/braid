import { useState, type ReactNode } from 'react';
import { GitForkIcon, StarIcon } from '@phosphor-icons/react';
import type { RepositoryListing } from '../../shared/account';
import type { RepositorySort } from '../../shared/repositories';
import { accountApi } from '../account/api';
import { errorMessage } from '../lib/api';
import { authorLine } from '../lib/changes';
import { useLive } from '../lib/live';
import { EXAMPLE_ADDRESS, paths } from '../lib/router';
import { RouterLink } from '../components/ui/Link';
import { LoadMore } from '../components/ui/Scroll';
import { LoadingRegion, SkeletonLine } from '../components/ui/Skeleton';
import { ErrorNotice, ErrorPanel } from '../components/ui/States';
import { RelativeTime } from '../components/ui/Time';

const DAY = 86_400_000;
const STORIES = 16;
const PAGE = 30;
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/*
 * What everyone else is building, as the dashboard and Explore show it: the owners active lately as a row of faces,
 * then each public repository as a post, with the picture its maintainers chose or its owner's face, GitHub's numbers
 * and topics, and its latest commit by whoever made it. More posts load as the reader nears the end.
 */

/** Public repositories page by page. The first page is shared by every reader of the same search and order. */
export function usePublicRepositories(q = '', sort: RepositorySort = 'updated') {
  const live = useLive(`repos:${JSON.stringify([q, sort])}`, () => accountApi.repositories(null, PAGE, { q, sort }), 60_000);
  const [extra, setExtra] = useState<{ items: RepositoryListing[]; cursor: string | null; loaded: boolean; busy: boolean; error: string | null }>({ items: [], cursor: null, loaded: false, busy: false, error: null });
  // The example has its own place; a page that overlaps the one before never shows a repository twice.
  const items = [...new Map([...live.data?.items ?? [], ...extra.items].map(item => [`${item.owner.slug}/${item.repo.slug}`, item])).values()].filter(item => item.owner.slug !== EXAMPLE_ADDRESS.owner);
  const cursor = extra.loaded ? extra.cursor : live.data?.nextCursor ?? null;
  const more = async () => {
    if (!cursor || extra.busy) return;
    setExtra(current => ({ ...current, busy: true, error: null }));
    try {
      const next = await accountApi.repositories(cursor, PAGE, { q, sort });
      setExtra(current => ({ items: [...current.items, ...next.items], cursor: next.nextCursor, loaded: true, busy: false, error: null }));
    } catch (error) { setExtra(current => ({ ...current, busy: false, error: errorMessage(error) })); }
  };
  return { live, items, cursor, more, busy: extra.busy, error: extra.error, total: live.data?.total };
}
export type PublicRepositories = ReturnType<typeof usePublicRepositories>;

/** Owners with a public repository, most recent first, each once. A ring means they pushed in the last day. */
export function Stories({ repos, now }: { repos: PublicRepositories; now: number }) {
  const { items, live } = repos;
  const owners = items.filter((item, index) => items.findIndex(other => other.owner.slug === item.owner.slug) === index).slice(0, STORIES);
  if (!live.data && !live.error) return <LoadingRegion label="Loading owners" className="stories">{Array.from({ length: 10 }, (_, index) => <span key={index} className="story"><span className="story__ring"><span className="avatar" style={{ width: 56, height: 56 }} /></span><SkeletonLine width={44} height={10} /></span>)}</LoadingRegion>;
  if (!owners.length) return null;
  return (
    <ul className="stories" aria-label="Active owners">
      {owners.map(item => (
        <li key={item.owner.slug}>
          <RouterLink href={paths.owner(item.owner.slug)} className="story" data-fresh={now - Date.parse(item.updatedAt) < DAY || undefined}>
            <span className="story__ring"><Avatar item={item} size={56} eager /></span>
            <span className="story__name">{item.owner.slug}</span>
          </RouterLink>
        </li>
      ))}
    </ul>
  );
}

/** The posts, then the next page as the reader nears the end. `first` goes before them, as Explore's example does. */
export function Posts({ repos, now, first, empty }: { repos: PublicRepositories; now: number; first?: ReactNode; empty: string }) {
  const { live, items, cursor, more, busy, error } = repos;
  if (live.error && !live.data) return <ErrorPanel title="Couldn’t load repositories" message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} />;
  if (!live.data) return <PostsSkeleton />;
  return (
    <>
      {live.error ? <ErrorNotice message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} /> : null}
      {items.length || first ? <ul className="posts" aria-label="Public repositories">{first}{items.map(item => <Post key={`${item.owner.slug}/${item.repo.slug}`} item={item} now={now} />)}</ul> : null}
      {!items.length ? <p className="feed__empty">{empty}</p> : null}
      {error ? <p className="feed__error" role="alert">{error}</p> : null}
      {cursor ? <LoadMore more={more} busy={busy} failed={!!error} label="Load more repositories" /> : null}
    </>
  );
}

/** The owner's GitHub picture, from GitHub's page for a mirror or the account Braid knows, or an empty circle: Braid never draws a stand-in face. */
function Avatar({ item, size, eager = false }: { item: RepositoryListing; size: number; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  const remote = item.showcase?.avatar;
  const src = remote ? `/api/media?${new URLSearchParams({ url: remote })}` : item.owner.avatar ? `/api/owners/${encodeURIComponent(item.owner.slug)}/avatar` : null;
  return src && !failed
    ? <img className="avatar" src={src} alt="" width={size} height={size} loading={eager ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : <span className="avatar" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Post({ item, now, label }: { item: RepositoryListing; now: number; label?: ReactNode }) {
  const { owner, repo, description } = item;
  const { latest, cover, stars, forks, topics, language } = item.showcase ?? {};
  const [broken, setBroken] = useState(false);
  const href = paths.repo({ owner: owner.slug, repo: repo.slug });
  const picture = cover && !broken;
  return (
    <li className="post">
      <header className="post__head">
        <RouterLink href={paths.owner(owner.slug)} className="post__face" tabIndex={-1} aria-hidden="true"><Avatar item={item} size={32} /></RouterLink>
        <span className="post__name">
          <RouterLink href={paths.owner(owner.slug)} className="post__owner">{owner.slug}</RouterLink>
          <span className="post__owner">/</span>
          <RouterLink href={href}>{repo.slug}</RouterLink>
        </span>
        {label ?? <RelativeTime at={item.updatedAt} now={now} className="post__when" />}
      </header>
      <RouterLink href={href} className="post__media" data-picture={picture || undefined} tabIndex={-1} aria-hidden="true">
        {picture ? (
          <img src={`/api/media?${new URLSearchParams({ url: cover })}`} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        ) : (
          <span className="post__card">
            <Avatar item={item} size={56} />
            <span className="post__card-name">{repo.slug}</span>
            {description ? <span className="post__card-text">{description}</span> : null}
          </span>
        )}
      </RouterLink>
      <div className="post__body">
        {stars !== undefined || forks !== undefined || language ? (
          <p className="post__facts">
            {stars !== undefined ? <span><StarIcon size={15} weight="fill" aria-hidden="true" />{compact.format(stars)}<span className="sr-only"> stars</span></span> : null}
            {forks !== undefined ? <span><GitForkIcon size={15} aria-hidden="true" />{compact.format(forks)}<span className="sr-only"> forks</span></span> : null}
            {language ? <span className="post__language">{language}</span> : null}
          </p>
        ) : null}
        {picture && description ? <p className="post__desc">{description}</p> : null}
        {latest ? (
          <p className="post__caption">
            <span className="post__by">{authorLine(latest.author)}</span> {latest.title}
          </p>
        ) : null}
        {topics?.length ? <p className="post__topics">{topics.map(topic => <span key={topic}>#{topic}</span>)}</p> : null}
      </div>
    </li>
  );
}

function PostsSkeleton() {
  return (
    <LoadingRegion label="Loading public repositories">
      <div className="posts" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="post">
          <div className="post__head"><span className="avatar" style={{ width: 30, height: 30 }} /><SkeletonLine width={`${[46, 38, 54, 41, 50, 35][index]}%`} /></div>
          <div className="post__media"><span className="post__card" /></div>
          <div className="post__body"><SkeletonLine width="72%" /></div>
        </div>
      ))}</div>
    </LoadingRegion>
  );
}
