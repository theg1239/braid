import { Fragment, useEffect, useState } from 'react';
import { Input } from '@cloudflare/kumo';
import { FileIcon, GitBranchIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import type { SearchHighlight } from '../../shared/search';
import { parseSearch } from '../../shared/search-query';
import { api } from '../lib/api';
import { plural, shortHash } from '../lib/format';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { navigate, paths, useRoute } from '../lib/router';
import { useSnapshot } from '../store/workspace';
import { RouterLink } from '../components/ui/Link';
import { EmptyPanel } from '../components/ui/States';
import { SkeletonBox, SkeletonRows } from '../components/ui/Skeleton';
import { RepositoryReadError } from './RepositoryReadError';
import '../styles/search.css';

export function Highlight({ text, ranges }: { text: string; ranges: SearchHighlight[] }) {
  let end = 0;
  return <>{ranges.map((range, index) => {
    const before = text.slice(end, range.start);
    end = range.end;
    return <Fragment key={index}>{before}<mark>{text.slice(range.start, range.end)}</mark></Fragment>;
  })}{text.slice(end)}</>;
}

export function SearchQualifiers({ query, href }: { query: string; href: (query: string) => string }) {
  const { qualifiers } = parseSearch(query);
  return <nav className="search-qualifiers" aria-label="Search qualifiers">
    {qualifiers.map(item => <RouterLink className="search-qualifier" key={item.start} href={href(`${query.slice(0, item.start)}${query.slice(item.end)}`.trim())} aria-label={`Remove ${item.kind}:${item.value}`}>
      <code>{item.kind}:{item.value}</code><XIcon size={12} aria-hidden="true" />
    </RouterLink>)}
    {!qualifiers.some(item => item.kind === 'path') ? <RouterLink className="search-qualifier" href={href(`${query} path:src/`.trim())}>path:src/</RouterLink> : null}
    {!qualifiers.some(item => item.kind === 'language') ? <RouterLink className="search-qualifier" href={href(`${query} language:typescript`.trim())}>language:typescript</RouterLink> : null}
  </nav>;
}

export function SearchScreen() {
  const { project } = useSnapshot();
  const route = useRoute();
  const query = route.query.get('q') ?? '';
  const selectedRef = route.query.get('ref');
  const ref = selectedRef ?? project.branch;
  const [input, setInput] = useState(query);
  useDocumentTitle(`Search · ${project.name}`);
  useEffect(() => { setInput(query); }, [query]);
  const href = (value: string) => {
    const params = new URLSearchParams();
    if (value) params.set('q', value);
    if (selectedRef !== null) params.set('ref', selectedRef);
    return `${paths.search()}${params.size ? `?${params}` : ''}`;
  };
  useEffect(() => {
    if (input === query) return;
    const timer = window.setTimeout(() => navigate(href(input), { replace: true }), 200);
    return () => window.clearTimeout(timer);
  }, [input, query, selectedRef]);

  const searching = query.trim().length > 0;
  const search = useLive(searching ? `search:${JSON.stringify([project.head, ref, query])}` : null, () => api.search(query, ref), 60_000);
  const pending = input !== query || search.loading;
  const result = search.data;
  const fileHref = (path: string) => paths.code(path, { kind: 'file', ref: result!.ref });

  return (
    <div className="page search-page">
      <header className="search-header">
        <h1>Search</h1>
        <span className="search-branch"><GitBranchIcon size={15} aria-hidden="true" />{/^[a-f0-9]{40}$/.test(ref) ? shortHash(ref) : ref}</span>
      </header>
      <form className="search-form" role="search" onSubmit={event => { event.preventDefault(); navigate(href(input), { replace: true }); }}>
        <Input type="search" aria-label="Search this repository" placeholder="Search this repository" value={input} onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          if (input) setInput('');
          else event.currentTarget.blur();
        }} onChange={event => setInput(event.target.value)} maxLength={256} autoFocus autoComplete="off" passwordManagerIgnore />
      </form>
      <SearchQualifiers query={query} href={href} />
      {!input.trim() ? (
        <EmptyPanel icon={<MagnifyingGlassIcon size={28} />} title="Search code" description="Find files and code in this repository." />
      ) : search.error && !pending ? (
        <RepositoryReadError state={search} title="Couldn’t search this repository" notFound="Branch or commit not found" />
      ) : pending ? (
        <SkeletonBox><SkeletonRows rows={4} detail height={90} label="Searching repository" /></SkeletonBox>
      ) : result ? (
        <>
          {result.matchCount || result.files.length || result.truncated ? <div className="search-summary" role="status">
            {result.matchCount || result.files.length ? <span>{plural(result.matchCount, 'code match', 'code matches')} in {plural(result.results.length, 'file')}{result.files.length ? ` · ${plural(result.files.length, 'filename match', 'filename matches')}` : ''}</span> : null}
            {result.truncated ? <span className="search-truncated">Results limited</span> : null}
          </div> : null}
          {result.files.length ? (
            <section className="search-files" aria-labelledby="search-files-heading">
              <h2 id="search-files-heading">Files <span>{result.files.length}</span></h2>
              <ul>{result.files.map(file => <li key={file.path}><RouterLink href={fileHref(file.path)}><FileIcon size={16} aria-hidden="true" /><span><Highlight text={file.path} ranges={file.highlights} /></span></RouterLink></li>)}</ul>
            </section>
          ) : null}
          {result.results.length ? (
            <section className="search-code" aria-labelledby="search-code-heading">
              <h2 id="search-code-heading">Code <span>{result.matchCount}</span></h2>
              {result.results.map(file => (
                <article className="search-result" key={file.path}>
                  <h3><FileIcon size={16} aria-hidden="true" /><RouterLink href={fileHref(file.path)}>{file.path}</RouterLink></h3>
                  <div className="search-result__lines" tabIndex={0} role="region" aria-label={`Matches in ${file.path}`}>
                    {file.matches.map((match, index) => <RouterLink key={index} className="search-result__line" href={`${fileHref(file.path)}#L${match.line}`} aria-label={`${file.path}, line ${match.line}`}>
                      <span className="search-result__number" aria-hidden="true">{match.line}</span>
                      <code><Highlight text={match.content} ranges={match.highlights} /></code>
                    </RouterLink>)}
                  </div>
                </article>
              ))}
            </section>
          ) : null}
          {!result.files.length && !result.results.length ? <EmptyPanel icon={<MagnifyingGlassIcon size={28} />} title="No results found" description="Try another word or filename." /> : null}
        </>
      ) : null}
    </div>
  );
}
