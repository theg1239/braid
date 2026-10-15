import { useState } from 'react';
import { Button } from '@cloudflare/kumo';
import { GitForkIcon, StarIcon } from '@phosphor-icons/react';
import type { RepositoryListing } from '../../shared/account';
import { accountApi } from '../account/api';
import { authorLine } from '../lib/changes';
import { useLive } from '../lib/live';
import { EXAMPLE_ADDRESS, paths } from '../lib/router';
import { RouterLink } from '../components/ui/Link';
import { LoadingRegion, SkeletonLine } from '../components/ui/Skeleton';
import { ErrorNotice } from '../components/ui/States';
import { RelativeTime } from '../components/ui/Time';

const DAY = 86_400_000;
const STORIES = 14;
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * What everyone else is building: the owners active lately as a row of faces, then each public repository as a post,
 * with the picture its maintainers chose or its owner's face, GitHub's numbers and topics, and its latest commit by
 * whoever made it.
 */
export function Feed({ now }: { now: number }) {
  // The same read as Explore's first page, so moving between them shares it.
  const live = useLive(`repos:${JSON.stringify(['', 'updated'])}`, () => accountApi.repositories(null, 30, { q: '', sort: 'updated' }), 60_000);
  const [extra, setExtra] = useState<{ items: RepositoryListing[]; cursor: string | null; loaded: boolean; busy: boolean }>({ items: [], cursor: null, loaded: false, busy: false });
  const items = [...live.data?.items ?? [], ...extra.items].filter(item => item.owner.slug !== EXAMPLE_ADDRESS.owner);
  const cursor = extra.loaded ? extra.cursor : live.data?.nextCursor ?? null;
  const more = async () => {
    if (!cursor || extra.busy) return;
    setExtra(current => ({ ...current, busy: true }));
    try {
      const next = await accountApi.repositories(cursor, 30, { q: '', sort: 'updated' });
      setExtra(current => ({ items: [...current.items, ...next.items], cursor: next.nextCursor, loaded: true, busy: false }));
    } catch { setExtra(current => ({ ...current, busy: false })); }
  };
  // Newest first, so each owner keeps their latest repository.
  const owners = items.filter((item, index) => items.findIndex(other => other.owner.slug === item.owner.slug) === index).slice(0, STORIES);

  return (
    <section className="feed" aria-labelledby="feed-title">
      <h2 id="feed-title" className="dash__h2">
        Explore
        <RouterLink href={paths.explore()} className="feed__all">All repositories</RouterLink>
      </h2>
      {live.error && !live.data ? <ErrorNotice message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} /> : null}
      {!live.data && !live.error ? <FeedSkeleton /> : null}
      {owners.length ? (
        <ul className="stories" aria-label="Active owners">
          {owners.map(item => (
            <li key={item.owner.slug}>
              <RouterLink href={paths.owner(item.owner.slug)} className="story" data-fresh={now - Date.parse(item.updatedAt) < DAY || undefined}>
                <span className="story__ring"><Avatar item={item} size={52} eager /></span>
                <span className="story__name">{item.owner.slug}</span>
              </RouterLink>
            </li>
          ))}
        </ul>
      ) : null}
      {items.length ? <ul className="posts" aria-label="Public repositories">{items.map(item => <Post key={`${item.owner.slug}/${item.repo.slug}`} item={item} now={now} />)}</ul> : null}
      {live.data && !items.length ? <p className="dash__calm">No other public repositories yet.</p> : null}
      {cursor ? <Button className="dash__more" variant="secondary" size="sm" disabled={extra.busy} aria-busy={extra.busy || undefined} onClick={() => void more()}>Show more</Button> : null}
    </section>
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

function Post({ item, now }: { item: RepositoryListing; now: number }) {
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
        <RelativeTime at={item.updatedAt} now={now} className="post__when" />
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

function FeedSkeleton() {
  return (
    <LoadingRegion label="Loading public repositories">
      <div className="stories" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <span key={index} className="story"><span className="story__ring"><span className="avatar" style={{ width: 52, height: 52 }} /></span><SkeletonLine width={44} height={10} /></span>)}</div>
      <div className="posts" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="post">
          <div className="post__head"><span className="avatar" style={{ width: 30, height: 30 }} /><SkeletonLine width={`${[46, 38, 54, 41][index]}%`} /></div>
          <div className="post__media"><span className="post__card" /></div>
          <div className="post__body"><SkeletonLine width="72%" /></div>
        </div>
      ))}</div>
    </LoadingRegion>
  );
}
