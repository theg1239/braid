import { useEffect, useState } from 'react';
import { Badge, Input } from '@cloudflare/kumo';
import { FileIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import type { GlobalSearch } from '../../shared/search';
import { useAccount } from '../account/AccountProvider';
import { request } from '../lib/api';
import { useLive } from '../lib/live';
import { plural } from '../lib/format';
import { useDocumentTitle } from '../lib/title';
import { encodePath } from '../lib/address';
import { navigate, paths, useRoute } from '../lib/router';
import { RouterLink } from '../components/ui/Link';
import { EmptyPanel, ErrorPanel } from '../components/ui/States';
import { SkeletonBox, SkeletonRows } from '../components/ui/Skeleton';
import { Highlight, SearchQualifiers } from './SearchScreen';
import '../styles/search.css';

export function GlobalSearchScreen() {
  const route = useRoute(), { account } = useAccount();
  const query = route.query.get('q') ?? '';
  const [input, setInput] = useState(query);
  useDocumentTitle('Code search · Braid');
  useEffect(() => { setInput(query); }, [query]);
  useEffect(() => {
    if (input === query) return;
    const timer = window.setTimeout(() => navigate(paths.globalSearch(input), { replace: true }), 200);
    return () => window.clearTimeout(timer);
  }, [input, query]);
  const search = useLive(query.trim() ? `search:all:${JSON.stringify([account?.user?.id ?? null, query])}` : null,
    () => request<GlobalSearch>(`/api/search?${new URLSearchParams({ q: query })}`), 60_000);
  const pending = input !== query || search.loading, result = search.data;
  return <div className="page search-page global-search-page">
    <header className="search-header"><h1>Code search</h1></header>
    <form className="search-form" role="search" onSubmit={event => { event.preventDefault(); navigate(paths.globalSearch(input), { replace: true }); }}>
      <Input type="search" aria-label="Search code" placeholder='Search code or use repo:owner/name' value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); if (input) setInput(''); else event.currentTarget.blur();
      }} maxLength={256} autoFocus autoComplete="off" passwordManagerIgnore />
    </form>
    <SearchQualifiers query={query} href={paths.globalSearch} />
    {!input.trim() ? <EmptyPanel icon={<MagnifyingGlassIcon size={28} />} title="Search code across repositories" description={account?.user ? 'Use repo:, org:, user:, path:, language: or "exact phrases".' : 'Use repo:, org: or user: to search public repositories.'} action={<RouterLink href={paths.globalSearch('repo:example/relay delivery')}>Search the recorded example</RouterLink>} />
      : pending ? <SkeletonBox><SkeletonRows rows={4} detail height={90} label="Searching repositories" /></SkeletonBox>
      : search.error ? <ErrorPanel title="Couldn’t search code" message={search.error} onRetry={() => void search.refresh()} retrying={search.refreshing} />
      : result ? <>
        <div className="search-summary" role="status">
          <span>{plural(result.matchCount, 'code match', 'code matches')}</span>
          <details className="search-scope"><summary>{plural(result.searched.length, 'repository', 'repositories')} searched</summary><ul>{result.searched.map(repo => <li key={`${repo.owner}/${repo.name}`}><RouterLink href={paths.repo({ owner: repo.owner, repo: repo.name })}>{repo.owner}/{repo.name}</RouterLink>{repo.recorded ? ' · Recorded example' : ''}</li>)}</ul></details>
          {result.truncated ? <span className="search-truncated">Results limited · Narrow your search</span> : null}
          {result.unavailable.length ? <span>{plural(result.unavailable.length, 'repository', 'repositories')} unavailable</span> : null}
        </div>
        {result.repositories.map(repo => <RepositoryResults key={`${repo.owner}/${repo.name}`} repo={repo} />)}
        {!result.repositories.length ? <EmptyPanel icon={<MagnifyingGlassIcon size={28} />} title="No results found" description={!account?.user && !result.searched.length ? 'Name a public repository with repo:, org: or user:.' : 'Try another query or remove a qualifier.'} /> : null}
      </> : null}
  </div>;
}

function RepositoryResults({ repo }: { repo: GlobalSearch['repositories'][number] }) {
  const base = paths.repo({ owner: repo.owner, repo: repo.name });
  const matches = new Map(repo.results.map(file => [file.path, file.matches]));
  const files = new Map(repo.files.map(file => [file.path, file.highlights]));
  const pathsFound = [...new Set([...files.keys(), ...matches.keys()])];
  return <section className="search-repository" aria-label={`${repo.owner}/${repo.name}`}>
    <h2><RouterLink href={base}>{repo.owner} / {repo.name}</RouterLink><Badge variant="outline">{repo.recorded ? 'Recorded example' : repo.visibility === 'private' ? 'Private' : 'Public'}</Badge><span>{plural(pathsFound.length, 'file')}</span></h2>
    {pathsFound.map(path => {
      const href = `${base}/blob/${encodeURIComponent(repo.ref)}/${encodePath(path)}`;
      return <article className="search-result" key={path}>
        <h3><FileIcon size={16} aria-hidden="true" /><RouterLink href={href}><Highlight text={path} ranges={files.get(path) ?? []} /></RouterLink></h3>
        {matches.has(path) ? <div className="search-result__lines" tabIndex={0} role="region" aria-label={`Matches in ${repo.owner}/${repo.name}/${path}`}>
          {matches.get(path)!.map((line, i) => <RouterLink className="search-result__line" key={i} href={`${href}#L${line.line}`} aria-label={`${path}, line ${line.line}`}><span className="search-result__number" aria-hidden="true">{line.line}</span><code><Highlight text={line.content} ranges={line.highlights} /></code></RouterLink>)}
        </div> : null}
      </article>;
    })}
  </section>;
}
