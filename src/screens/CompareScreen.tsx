import { useEffect, useRef, useState } from 'react';
import { Button, Tabs } from '@cloudflare/kumo';
import { ArrowLeftIcon, ArrowsLeftRightIcon, CaretRightIcon, GitCommitIcon, GitPullRequestIcon } from '@phosphor-icons/react';
import type { ComparedFile, RepositoryComparison } from '../../shared/compare';
import { api } from '../lib/api';
import { plural, shortHash } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { navigate, paths, useRoute } from '../lib/router';
import { useSnapshot } from '../store/workspace';
import { prefetchCode } from '../components/code/viewer';
import { CodeLoading, DiffView, setDiffStyle, useDiffStyle, type DiffStyle } from '../components/code';
import { BranchMenu } from '../components/code/BranchMenu';
import { AuthorChip } from '../components/pulls/Bits';
import { RouterLink } from '../components/ui/Link';
import { EmptyPanel } from '../components/ui/States';
import { Stats } from '../components/ui/Status';
import { ChangesSkeleton } from '../components/ui/ScreenSkeleton';
import { RepositoryReadError } from './RepositoryReadError';
import { useBranchPullRequests } from './BranchesScreen';
import { RelativeTime } from '../components/ui/Time';
import '../styles/branches.css';

function ComparisonDiff({ base, head, file }: { base: string; head: string; file: ComparedFile }) {
  const key = `repository:diff:${base}:${head}:${file.path}`;
  const diff = useLive(key, () => api.compareDiff(base, head, file.path), 300_000);
  const style = useDiffStyle();
  if (diff.error) return <RepositoryReadError state={diff} title="Couldn’t load changes" notFound="Changes not found" />;
  if (!diff.data) return <CodeLoading label="Loading changes" lines={file.additions + file.deletions} />;
  if (diff.data.binary) return <div className="code code--empty">Binary file</div>;
  if (diff.data.tooLarge) return <div className="code code--empty">Diff too large <RouterLink href={paths.code(file.path, { ref: file.deleted ? base : head })}>View file</RouterLink></div>;
  return <DiffView path={file.path} before={diff.data.before} after={diff.data.after} id={key} style={style} />;
}

/** The first files draw their diffs at once rather than when they near the viewport; public/boot.js reads as many diffs with the comparison. */
const EAGER_FILES = 3;

function ComparisonFile({ base, head, file, eager }: { base: string; head: string; file: ComparedFile; eager: boolean }) {
  const ref = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null), measured = useRef(0);
  const [near, setNear] = useState(eager), [open, setOpen] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting && body.current?.offsetHeight) measured.current = body.current.offsetHeight;
      setNear(entry.isIntersecting);
    }, { rootMargin: '1000px 0px' });
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  const note = file.added ? 'Added' : file.deleted ? 'Deleted' : file.beforeMode !== file.afterMode ? `${file.beforeMode} → ${file.afterMode}` : null;
  return <section className="compare__file" ref={ref} aria-label={file.path}>
    <header className="compare__file-head">
      <button className="compare__file-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <CaretRightIcon size={12} weight="bold" aria-hidden="true" />
        <span className="mono">{file.path}</span>
      </button>
      {note ? <span className="quiet compare__file-note">{note}</span> : null}
      {file.binary || file.tooLarge ? <span className="quiet">{file.binary ? 'Binary' : 'Large file'}</span> : <Stats additions={file.additions} deletions={file.deletions} />}
    </header>
    {open ? <div className="compare__file-body" ref={body} style={near ? undefined : { minHeight: measured.current || Math.min(600, 60 + (file.additions + file.deletions) * 20) }}>
      {near ? <ComparisonDiff base={base} head={head} file={file} /> : <CodeLoading label="Loading changes" lines={file.additions + file.deletions} />}
    </div> : null}
  </section>;
}

export function ComparisonResult({ comparison, now }: { comparison: RepositoryComparison; now: number }) {
  const style = useDiffStyle();
  const changed = comparison.status === 'ready' && comparison.files.length > 0;
  // The viewer evaluates after the commits have painted and before the first diff answers.
  useEffect(() => { if (changed) prefetchCode(); }, [changed]);
  const states = { identical: 'Identical', unrelated: 'No common history', limited: 'History exceeds the comparison limit or is incomplete', 'multiple-bases': 'Multiple merge bases' };
  if (comparison.status !== 'ready') return <EmptyPanel title={states[comparison.status]} />;
  const totals = comparison.files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
  return <>
    <section className="branches__section compare__commits" aria-label="Commits">
      <h2 className="branches__heading">{plural(comparison.commits.length, 'commit')}{comparison.commitsTruncated ? ' shown' : ''}</h2>
      {comparison.commits.length ? <ul>{comparison.commits.map(commit => <li className="compare__commit" key={commit.hash}>
        <GitCommitIcon size={18} className="quiet" aria-hidden="true" />
        <div className="branches__details">
          <RouterLink className="compare__commit-title" href={paths.commit(commit.hash)}>{commit.title}</RouterLink>
          <div className="branches__meta"><AuthorChip author={commit.author} /><RelativeTime at={commit.time} now={now} /></div>
        </div>
        <RouterLink className="mono compare__hash" href={paths.commit(commit.hash)}>{shortHash(commit.hash)}</RouterLink>
      </li>)}</ul> : <p className="compare__empty quiet">No commits ahead</p>}
      {comparison.commitsTruncated ? <p className="compare__empty quiet">More commits in <RouterLink href={paths.commits(comparison.head)}>commit history</RouterLink></p> : null}
    </section>
    <section className="compare__files" aria-label="Files changed">
      <header className="compare__files-head">
        <h2>Files changed <span className="quiet">{comparison.files.length}{comparison.filesTruncated ? '+' : ''}</span></h2>
        <Stats {...totals} />
        {comparison.files.length ? <Tabs size="sm" variant="segmented" className="compare__style" aria-label="Diff view" value={style} onValueChange={value => setDiffStyle(value as DiffStyle)} tabs={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]} /> : null}
      </header>
      {comparison.filesTruncated ? <p className="quiet">File limit reached. Showing a partial comparison.</p> : null}
      {comparison.files.some(file => file.tooLarge) ? <p className="quiet">Line counts exclude large files.</p> : null}
      {comparison.files.length ? comparison.files.map((file, index) => <ComparisonFile key={`${comparison.mergeBase}:${comparison.head}:${file.path}`} base={comparison.mergeBase!} head={comparison.head} file={file} eager={index < EAGER_FILES} />) : <EmptyPanel title="No files changed" />}
    </section>
  </>;
}

export function CompareScreen() {
  const route = useRoute(), { project } = useSnapshot();
  const [base = project.branch, head = project.branch] = route.id?.split('...') ?? [];
  const comparison = useLive(`repository:compare:${JSON.stringify([base, head])}`, () => api.compare(base, head), 60_000);
  const pulls = useBranchPullRequests();
  const pullRequest = comparison.data ? pulls.data?.get(comparison.data.head) : undefined;
  const now = useNow();
  useDocumentTitle(`Comparing ${base}...${head} · ${project.name}`);
  return <div className="page compare">
    <header className="page-head"><h1 className="page-title">Compare changes</h1></header>
    <div className="compare__refs">
      <BranchMenu allowCommit current={base} label="base" hrefForBranch={branch => paths.compare(branch, head)} />
      <ArrowLeftIcon size={16} className="quiet" aria-hidden="true" />
      <BranchMenu allowCommit current={head} label="compare" hrefForBranch={branch => paths.compare(base, branch)} />
      <Button variant="ghost" size="sm" shape="square" icon={ArrowsLeftRightIcon} aria-label="Swap base and compare" onClick={() => navigate(paths.compare(head, base))} />
    </div>
    <div className="compare__pull-request">
      {pullRequest ? <RouterLink href={paths.pull(pullRequest.number)} title={pullRequest.title}>
        <GitPullRequestIcon size={16} weight="bold" className="pr-state" data-state="open" aria-hidden="true" />Pull request #{pullRequest.number} · Open
      </RouterLink> : null}
    </div>
    <RepositoryReadError state={comparison} title="Couldn’t compare branches" notFound="Branch or commit not found" />
    {comparison.data ? <ComparisonResult comparison={comparison.data} now={now} /> : !comparison.error ? <ChangesSkeleton label="Comparing branches" /> : null}
  </div>;
}
