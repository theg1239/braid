import { useEffect } from 'react';
import { Button, InlineCopyText, LinkButton } from '@cloudflare/kumo';
import { CodeIcon, GitCommitIcon, XIcon } from '@phosphor-icons/react';
import type { RepositoryCommit } from '../../shared/history';
import { api } from '../lib/api';
import { shortHash } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { paths, useRoute } from '../lib/router';
import { useSnapshot } from '../store/workspace';
import { BranchMenu } from '../components/code/BranchMenu';
import { AuthorChip } from '../components/pulls/Bits';
import { RouterLink } from '../components/ui/Link';
import { EmptyPanel } from '../components/ui/States';
import { HistorySkeleton } from '../components/ui/ScreenSkeleton';
import { RepositoryReadError } from './RepositoryReadError';
import { RelativeTime } from '../components/ui/Time';
import '../styles/pulls.css';
import '../styles/commits.css';

export function CommitsScreen() {
  const { project } = useSnapshot();
  const route = useRoute();
  const ref = route.ref ?? project.branch;
  useDocumentTitle(`Commits · ${project.name}`);
  return <History branch={ref} path={route.path} cursors={route.query.getAll('cursor')} />;
}

function History({ branch, path, cursors }: { branch: string; path: string; cursors: string[] }) {
  const cursor = cursors.at(-1) ?? null;
  const history = useLive(`commits:${JSON.stringify([branch, path, cursor])}`, () => api.commits(branch, path, cursor), 60_000);
  const pageHref = (pages: string[]) => {
    const query = new URLSearchParams(pages.map(page => ['cursor', page]));
    return `${paths.commits(branch, path)}${pages.length ? `?${query}` : ''}`;
  };
  useEffect(() => { window.scrollTo(0, 0); }, [branch, path, cursor]);
  const now = useNow();
  const groups = new Map<string, RepositoryCommit[]>();
  for (const commit of history.data?.items ?? []) {
    const date = new Date(commit.at);
    const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
    const items = groups.get(day) ?? [];
    items.push(commit);
    groups.set(day, items);
  }
  return (
    <div className="page commits-page">
      <header className="commits-header">
        <h1>Commits</h1>
        <BranchMenu current={branch} hrefForBranch={name => paths.commits(name, path)} />
        {path ? (
          <span className="commits-filter">
            <span className="mono">{path}</span>
            <RouterLink href={paths.commits(branch)} aria-label="Clear path filter"><XIcon size={14} aria-hidden="true" /></RouterLink>
          </span>
        ) : null}
      </header>
      <RepositoryReadError state={history} title="Couldn’t load commits" notFound="Commit history not found" />
      {history.loading ? (
        <HistorySkeleton />
      ) : history.data?.items.length === 0 ? (
        <EmptyPanel icon={<GitCommitIcon size={28} />} title={history.data.nextCursor ? 'No matching commits on this page' : 'No commits found'} />
      ) : (
        <div>
          {[...groups].map(([day, commits]) => (
            <section className="commits-day" key={day} aria-label={`Commits on ${day}`}>
              <h2><GitCommitIcon size={18} aria-hidden="true" />Commits on {day}</h2>
              <ul className="commits-list">
                {commits.map(commit => (
                  <li className="commits-row" key={commit.hash}>
                    <div className="commits-row__body">
                      <RouterLink className="commits-row__title" href={paths.commit(commit.hash)}>{commit.title || 'Untitled commit'}</RouterLink>
                      <div className="commits-row__meta">
                        <AuthorChip author={commit.author} />
                        <RelativeTime at={commit.at} now={now} />
                        {commit.pullRequest ? <RouterLink href={paths.pull(commit.pullRequest)} className="commits-row__pull" aria-label={`Pull request #${commit.pullRequest}`}>#{commit.pullRequest}</RouterLink> : null}
                      </div>
                    </div>
                    <span className="commits-row__hash"><InlineCopyText value={commit.hash} labels={{ copyAction: `Copy commit hash ${shortHash(commit.hash)}`, copied: `Copied commit hash ${shortHash(commit.hash)}` }}>{shortHash(commit.hash)}</InlineCopyText></span>
                    <RouterLink className="commits-row__browse" href={paths.code('', { ref: commit.hash })} aria-label={`Browse the repository at ${shortHash(commit.hash)}`} title="Browse the repository at this point"><CodeIcon size={18} aria-hidden="true" /></RouterLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {history.loading ? null : <nav className="commits-pagination" aria-label="Commit history pages">
        {cursors.length ? <LinkButton variant="secondary" size="sm" href={pageHref(cursors.slice(0, -1))}>Newer</LinkButton> : <Button variant="secondary" size="sm" disabled>Newer</Button>}
        {history.data?.nextCursor && !history.loading && !history.error ? <LinkButton variant="secondary" size="sm" href={pageHref([...cursors, history.data.nextCursor])}>Older</LinkButton> : <Button variant="secondary" size="sm" disabled>Older</Button>}
      </nav>}
    </div>
  );
}
