import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { InlineCopyText, LinkButton, Tabs } from '@cloudflare/kumo';
import { CaretRightIcon, GitCommitIcon } from '@phosphor-icons/react';
import type { CommitDetail, CommitFile } from '../../shared/history';
import { api } from '../lib/api';
import { plural, shortHash } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { paths, useRoute } from '../lib/router';
import { useSnapshot } from '../store/workspace';
import { CodeLoading, DiffView, isProse, setDiffStyle, useDiffStyle, type DiffStyle } from '../components/code';
import { diffEstimate, retainedDiffHeight } from '../components/code/diff-estimate';
import { AuthorChip } from '../components/pulls/Bits';
import { RouterLink } from '../components/ui/Link';
import { EmptyPanel } from '../components/ui/States';
import { Stats } from '../components/ui/Status';
import { RepositoryReadError } from './RepositoryReadError';
import '../styles/pulls.css';
import '../styles/commits.css';
import { CommitDetailSkeleton } from '../components/ui/ScreenSkeleton';
import { RelativeTime } from '../components/ui/Time';

function FileStats({ file }: { file: CommitFile }) {
  return file.additions !== null && file.deletions !== null ? <Stats additions={file.additions} deletions={file.deletions} /> : <span className="quiet">{file.binary ? 'Binary' : file.tooLarge ? 'Large file' : '—'}</span>;
}

/** Only mounted while its section is near the viewport; the shared read cache survives folding. */
export function CommitFileDiff({ sha, file, parent }: { sha: string; file: CommitFile; parent?: string }) {
  const key = `commit-diff:${JSON.stringify([sha, file.path])}`;
  const diff = useLive(key, () => api.commitDiff(sha, file.path), 300_000);
  const style = useDiffStyle();
  if (diff.error) return <RepositoryReadError state={diff} title="Couldn’t load changes" notFound="Changes not found" />;
  if (!diff.data) return <CodeLoading label="Loading changes" lines={(file.additions ?? 0) + (file.deletions ?? 0)} />;
  if (diff.data.binary) return <div className="code code--empty">Binary file</div>;
  if (diff.data.tooLarge) return <div className="code code--empty">Diff too large <RouterLink href={paths.code(file.path, { ref: file.status === 'deleted' ? parent : sha })}>View file</RouterLink></div>;
  return <DiffView path={file.path} before={diff.data.before} after={diff.data.after} id={key} style={style} virtualized={false} />;
}

function FileSection({ commit, file, index, width }: { commit: CommitDetail; file: CommitFile; index: number; width: number }) {
  const ref = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const style = useDiffStyle();
  const [measured, setMeasured] = useState<{ width: number; style: DiffStyle; height: number } | null>(null);
  const [near, setNear] = useState(false), [open, setOpen] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '600px 0px' });
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  const modeChanged = file.beforeMode && file.afterMode && file.beforeMode !== file.afterMode;
  // Eight pixels per column allows for the local 12.5 px mono face; the two
  // gutters, indicators and padding are outside the available wrapping width.
  const wrapped = style === 'unified' && isProse(file.path) && file.textColumns !== undefined ? { textColumns: file.textColumns, columns: Math.floor((width - 112) / 8) } : undefined;
  const estimate = file.binary || file.tooLarge ? 80 : diffEstimate({ additions: file.additions ?? 0, deletions: file.deletions ?? 0, added: file.status === 'added', deleted: file.status === 'deleted' }, 20, wrapped);
  useEffect(() => {
    const node = content.current;
    if (!near || !open || !node) return;
    let rendered = 0;
    const reserve = () => {
      if (!rendered || !body.current) return;
      const top = body.current.getBoundingClientRect().top;
      setMeasured(previous => {
        const reserved = previous?.width === width && previous.style === style ? previous.height : estimate;
        const height = retainedDiffHeight(reserved, rendered, top, window.innerHeight);
        return previous?.width === width && previous.style === style && previous.height === height ? previous : { width, style, height };
      });
    };
    const observer = new ResizeObserver(() => {
      if (node.querySelector('[aria-busy="true"], .code--pending')) return;
      rendered = Math.ceil(node.getBoundingClientRect().height) + 1;
      reserve();
    });
    observer.observe(node);
    window.addEventListener('scroll', reserve, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener('scroll', reserve); };
  }, [near, open, width, style, estimate]);
  return <section className="commit-file" id={`commit-file-${index}`} ref={ref} aria-label={file.path}>
    <header className="commit-file__header">
      <button type="button" className="commit-file__toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${file.path}`} onClick={() => setOpen(!open)}>
        <CaretRightIcon size={12} weight="bold" aria-hidden="true" />
        <span className="mono">{file.path}</span>
      </button>
      <span className="quiet commit-file__status">{file.status === 'added' ? 'Added' : file.status === 'deleted' ? 'Deleted' : modeChanged ? `${file.beforeMode} → ${file.afterMode}` : null}</span>
      <FileStats file={file} />
    </header>
    {open ? <div ref={body} className="commit-file__body" style={{ minHeight: measured?.width === width && measured.style === style ? measured.height : estimate }}>
      {near ? <div ref={content}><CommitFileDiff sha={commit.hash} parent={commit.parents[0]} file={file} /></div> : null}
    </div> : null}
  </section>;
}

function CommitContent({ commit }: { commit: CommitDetail }) {
  const now = useNow(), style = useDiffStyle();
  const { project } = useSnapshot();
  const files = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    if (!files.current) return;
    const measure = () => setWidth(files.current!.clientWidth - 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(files.current);
    return () => observer.disconnect();
  }, []);
  const body = commit.message.slice(commit.message.indexOf('\n') + 1).trim();
  const hasBody = commit.message.includes('\n') && body.length > 0;
  const totals = commit.files.reduce((sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }), { additions: 0, deletions: 0 });
  const uncounted = commit.files.filter(file => file.additions === null).length;
  return <>
    <header className="commit-header">
      <div className="commit-heading">
        <div className="commit-heading__message">
          <h1>{commit.title || 'Untitled commit'}</h1>
          {hasBody ? body.length > 300 || body.split('\n').length > 4 ? <details className="commit-message"><summary>Show commit message</summary><pre>{body}</pre></details> : <pre className="commit-message">{body}</pre> : null}
        </div>
        <div className="commit-heading__actions">
          {commit.parents.length && !commit.parentUnavailable
            ? <LinkButton href={paths.compare(commit.parents[0], commit.hash)} variant="secondary" size="sm">Compare with previous commit</LinkButton>
            : <LinkButton href={paths.compare(commit.hash, project.branch)} variant="secondary" size="sm">Compare with…</LinkButton>}
          <LinkButton href={paths.code('', { ref: commit.hash })} variant="secondary" size="sm">Browse files</LinkButton>
        </div>
      </div>
      <div className="commit-meta">
        <AuthorChip author={commit.author} />
        <span className="quiet">committed <RelativeTime at={commit.at} now={now} /></span>
        {commit.pullRequest ? <RouterLink href={paths.pull(commit.pullRequest)} className="commit-meta__pull" aria-label={`Pull request #${commit.pullRequest}`}>#{commit.pullRequest}</RouterLink> : null}
      </div>
      <div className="commit-refs">
        <span className="commit-refs__hash"><GitCommitIcon size={16} aria-hidden="true" /><InlineCopyText value={commit.hash} labels={{ copyAction: `Copy commit hash ${shortHash(commit.hash)}`, copied: `Copied commit hash ${shortHash(commit.hash)}` }}>{shortHash(commit.hash)}</InlineCopyText></span>
        <span className="commit-refs__parents"><span className="quiet">{commit.parents.length ? plural(commit.parents.length, 'parent') : 'Initial commit'}</span>{commit.parents.map((parent, index) => index === 0 && commit.parentUnavailable ? <span key={parent}><span className="mono">{shortHash(parent)}</span> <span className="quiet">(not imported)</span></span> : <RouterLink key={parent} className="mono" href={paths.commit(parent)}>{shortHash(parent)}</RouterLink>)}</span>
      </div>
    </header>
    {commit.parentUnavailable ? <EmptyPanel title="Parent commit unavailable" description="Browse files to view this commit." /> : <section ref={files} className="commit-changes" aria-label="Files changed">
      <header className="commit-changes__header">
        <h2>{plural(commit.files.length, 'file')} changed{commit.filesTruncated ? ' shown' : ''}</h2>
        <Stats {...totals} />
        {commit.files.length ? <Tabs size="sm" variant="segmented" className="commit-changes__style" aria-label="Diff view" value={style} onValueChange={value => setDiffStyle(value as DiffStyle)} tabs={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]} /> : null}
      </header>
      {commit.filesTruncated ? <p className="quiet">File limit reached. Showing a partial diff.</p> : null}
      {uncounted ? <p className="quiet">Line counts exclude {plural(uncounted, 'file')}.</p> : null}
      {commit.files.length ? <>
        {commit.files.length > 1 ? <nav className="commit-file-list" aria-label="Changed files"><ul>{commit.files.map((file, index) => <li key={file.path}>
          <a className="mono" href={`#commit-file-${index}`}>{file.path}</a><span className="quiet commit-file-list__status">{file.status}</span><FileStats file={file} />
        </li>)}</ul></nav> : null}
        {commit.files.map((file, index) => <FileSection key={`${commit.hash}:${file.path}`} commit={commit} file={file} index={index} width={width} />)}
      </> : <EmptyPanel title="No files changed" />}
    </section>}
  </>;
}

export function CommitScreen() {
  const { project } = useSnapshot(), route = useRoute();
  const sha = route.id!;
  const commit = useLive(`commit:${sha}`, () => api.commit(sha), 300_000);
  useDocumentTitle(`${commit.data?.title || `Commit ${shortHash(sha)}`} · ${project.name}`);
  return <div className="page commit-page">
    <RepositoryReadError state={commit} title="Couldn’t load commit" notFound="Commit not found" />
    {commit.data ? <CommitContent key={commit.data.hash} commit={commit.data} /> : !commit.error ? <CommitDetailSkeleton /> : null}
  </div>;
}
