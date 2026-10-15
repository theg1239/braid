import { useEffect, useState } from 'react';
import { Input, Select } from '@cloudflare/kumo';
import type { RepositoryListing } from '../../shared/account';
import type { RepositorySort } from '../../shared/repositories';
import { GitHubRepositoryField } from '../components/repo/GitHubRepositoryField';
import { plural } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { EXAMPLE_ADDRESS, navigate, paths, useRoute } from '../lib/router';
import { Post, Posts, usePublicRepositories } from '../dashboard/Feed';
import { Label } from '../components/pulls/Bits';
import { RouterLink } from '../components/ui/Link';
import '../styles/site.css';
import '../styles/pages.css';
import '../styles/dashboard.css';

/** Public repositories as posts, newest activity first, with the recorded example first; more load as the reader scrolls. */
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

/** The recorded example leads the posts, under its one Recorded label. */
const EXAMPLE: RepositoryListing = {
  owner: { slug: EXAMPLE_ADDRESS.owner, name: EXAMPLE_ADDRESS.owner }, repo: { slug: EXAMPLE_ADDRESS.repo, name: EXAMPLE_ADDRESS.repo }, updatedAt: '',
  description: 'A webhook delivery service on Workers, with six agents’ pull requests and their proof',
};

function Repositories({ q, sort }: { q: string; sort: RepositorySort }) {
  const now = useNow();
  const repos = usePublicRepositories(q, sort);
  return (
    <>
      {q && repos.total !== undefined ? <p className="explore__count" role="status">{plural(repos.total, 'repository', 'repositories')}</p> : null}
      <Posts repos={repos} now={now} first={q ? null : <Post item={EXAMPLE} now={now} label={<Label tone="simulated">Recorded</Label>} />}
        empty={q ? 'No repositories match your search.' : 'No other public repositories yet.'} />
    </>
  );
}
