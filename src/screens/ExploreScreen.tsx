import { useEffect, useState } from 'react';
import { Button, Input, Select } from '@cloudflare/kumo';
import type { RepositoryListing } from '../../shared/account';
import type { RepositorySort } from '../../shared/repositories';
import { errorMessage } from '../lib/api';
import { GitHubRepositoryField } from '../components/repo/GitHubRepositoryField';
import { absoluteTime, plural, relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { EXAMPLE_ADDRESS, navigate, paths, useRoute } from '../lib/router';
import { accountApi } from '../account/api';
import { Label } from '../components/pulls/Bits';
import { RouterLink } from '../components/ui/Link';
import { SkeletonRows } from '../components/ui/Skeleton';
import { ErrorPanel, ErrorNotice } from '../components/ui/States';
import '../styles/site.css';
import '../styles/pages.css';

/** Public repositories, newest activity first, with the recorded example pinned on top. */
export function ExploreScreen() {
  const route = useRoute();
  const q = route.query.get('q')?.trim() ?? '';
  const sort = route.query.get('sort') === 'name' ? 'name' : 'updated';
  const [query, setQuery] = useState(q);

  useDocumentTitle('Explore · Braid');
  useEffect(() => setQuery(q), [q]);
  useEffect(() => {
    if (query.trim() === q) return;
    const timer = window.setTimeout(() => navigate(searchPath(query.trim(), sort), { replace: true }), 200);
    return () => window.clearTimeout(timer);
  }, [query, q, sort]);

  return (
    <div className="page explore">
      <header className="explore__head">
        <h1 className="explore__title">Explore</h1>
      </header>
      <section className="explore__open" aria-label="Open a GitHub repository">
        <GitHubRepositoryField />
        <div className="explore__try" aria-label="Try a repository">{['openai/codex', 'anthropics/claude-code', 'cloudflare/workers-sdk'].map(repository => {
          const [owner, repo] = repository.split('/');
          return <RouterLink key={repository} href={paths.repo({ owner, repo })}><span>{owner}/</span>{repo}</RouterLink>;
        })}</div>
        <p className="explore__swap">Or swap github.com for this site in any repository URL.</p>
      </section>
      <div className="explore__filters">
        <Input type="search" aria-label="Search repositories" placeholder="Search repositories" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} className="explore__search" passwordManagerIgnore />
        <Select<RepositorySort> aria-label="Sort repositories" value={sort} onValueChange={value => { if (value !== null) navigate(searchPath(query.trim(), value)); }} items={[{ value: 'updated', label: 'Recently updated' }, { value: 'name', label: 'Name' }]} />
      </div>
      <Repositories key={JSON.stringify([q, sort])} q={q} sort={sort} />
    </div>
  );
}

function searchPath(q: string, sort: RepositorySort): string {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (sort !== 'updated') query.set('sort', sort);
  return `${paths.explore()}${query.size ? `?${query}` : ''}`;
}

function Repositories({ q, sort }: { q: string; sort: RepositorySort }) {
  const now = useNow();
  const first = useLive(`repos:${JSON.stringify([q, sort])}`, () => accountApi.repositories(null, 30, { q, sort }), 60_000);
  const [extra, setExtra] = useState<{ items: RepositoryListing[]; cursor: string | null; loaded: boolean; busy: boolean; error: string | null }>({ items: [], cursor: null, loaded: false, busy: false, error: null });

  // The example has its own row; the listing never shows it twice.
  const items = [...new Map([...(first.data?.items ?? []), ...extra.items].map(item => [`${item.owner.slug}/${item.repo.slug}`, item])).values()].filter((item) => item.owner.slug !== EXAMPLE_ADDRESS.owner);
  const cursor = extra.loaded ? extra.cursor : (first.data?.nextCursor ?? null);
  const more = async () => {
    if (!cursor || extra.busy) return;
    setExtra((current) => ({ ...current, busy: true, error: null }));
    try {
      const next = await accountApi.repositories(cursor, 30, { q, sort });
      setExtra((current) => ({ ...current, items: [...current.items, ...next.items], cursor: next.nextCursor, loaded: true, busy: false }));
    } catch (err) {
      setExtra((current) => ({ ...current, busy: false, error: errorMessage(err) }));
    }
  };

  return (
    <>
      {first.error && first.data ? <ErrorNotice message={first.error} onRetry={() => void first.refresh()} retrying={first.refreshing} /> : null}
      {q && first.data?.total !== undefined ? <p className="explore__count" role="status">{plural(first.data.total, 'repository', 'repositories')}</p> : null}
      <ul className="list list__rows" aria-label="Public repositories">
        {!q ? <li className="repo-row" data-pinned="">
          <div className="repo-row__main">
            <div className="repo-row__title">
              <RouterLink href={paths.repo(EXAMPLE_ADDRESS)} className="repo-row__name">
                <span className="repo-row__owner">{EXAMPLE_ADDRESS.owner}/</span>
                {EXAMPLE_ADDRESS.repo}
              </RouterLink>
              <Label tone="simulated">recorded example</Label>
            </div>
            <p className="repo-row__desc">A webhook delivery service on Workers, with six agents’ pull requests and their proof</p>
          </div>
        </li> : null}
        {items.map((item) => (
          <li key={`${item.owner.slug}/${item.repo.slug}`} className="repo-row">
            <div className="repo-row__main">
              <span className="repo-row__name">
                <RouterLink href={paths.owner(item.owner.slug)} className="repo-row__owner">{item.owner.slug}</RouterLink>
                <span className="repo-row__owner">/</span>
                <RouterLink href={paths.repo({ owner: item.owner.slug, repo: item.repo.slug })}>{item.repo.slug}</RouterLink>
              </span>
              {item.description ? <p className="repo-row__desc">{item.description}</p> : null}
            </div>
            <time className="repo-row__time" dateTime={item.updatedAt} title={absoluteTime(item.updatedAt)}>
              Updated {relativeTime(item.updatedAt, now)}
            </time>
          </li>
        ))}
        {first.loading && !first.data ? (
          <li><SkeletonRows rows={5} detail height={84} label="Loading repositories" /></li>
        ) : null}
        {first.error && !first.data ? (
          <li>
            <ErrorPanel title="Couldn’t load repositories" message={first.error} onRetry={() => void first.refresh()} retrying={first.refreshing} />
          </li>
        ) : null}
        {first.data && !items.length ? <li className="repo-row repo-row--empty">{q ? 'No repositories match your search.' : 'No other public repositories yet.'}</li> : null}
      </ul>
      {cursor ? (
        <div className="list__more">
          <Button size="sm" variant="secondary" disabled={extra.busy} aria-busy={extra.busy || undefined} onClick={() => void more()}>
            Load more
          </Button>
        </div>
      ) : null}
      {extra.error ? (
        <p className="quiet" role="alert">
          {extra.error}
        </p>
      ) : null}
    </>
  );
}
