import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Checkbox, Input, Select, Tabs, Tooltip } from '@cloudflare/kumo';
import { CaretRightIcon, CheckIcon, FileIcon, FolderIcon, SidebarSimpleIcon } from '@phosphor-icons/react';
import type { Change, ChangeFile } from '../../../shared/types';
import type { ChangeGuide } from '../../../shared/guide';
import { basename, dirname } from '../../lib/format';
import { prefetchDiff, useChangeComparison, useChangeDiff } from '../../lib/resources';
import { isPlainLeftClick, navigate, paths } from '../../lib/router';
import { setViewed, useViewed } from '../../lib/viewed';
import { Stats } from '../ui/Status';
import { EmptyPanel } from '../ui/States';
import { useFileNavigation } from './fileNavigation';
import { prefetchCode } from '../code/viewer';
import { CodeError, CodeLoading, DiffView, setDiffStyle, useDiffStyle, type DiffStyle } from '../code';
import { diffEstimate } from '../code/diff-estimate';
import { contextRowHeight, type DiffReview } from '../code/review-types';
import type { MoveEnd } from '../code/moves';
import { useMoves } from './useMoves';
import { useGuide } from './guide';
import { groupFiles, groupingKey } from './file-groups';
import { answerBlocker, useSnapshot } from '../../store/workspace';
import { CommentComposer, ReviewThread } from './Comments';
import { pushLabel } from './pushes';
import { CodeSkeletonRows } from '../code/CodeSkeleton';
import '../../styles/files.css';

/*
 * Files changed, as GitHub lays it out: a file tree on the left, every file's diff open on the
 * right, a Viewed box on each that folds it, and above them the comparison and the diff style.
 * Only the diffs near the viewport are rendered; the rest hold their measured height, so a
 * change with hundreds of files scrolls like a short one.
 */

/* ---------- The tree ---------- */

/** A file as the tab shows it: from the current revision, or from a comparison with an earlier one. */
type ShownFile = Pick<ChangeFile, 'path' | 'additions' | 'deletions' | 'added' | 'deleted' | 'mode'>;

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: ShownFile[];
}

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Folder chains with one child and no files read as one row, as on GitHub. */
function collapse(folder: Folder): Folder {
  const folders = folder.folders.map(collapse).sort(byName);
  if (folder.path && folders.length === 1 && !folder.files.length) {
    const [only] = folders;
    return { ...only, name: `${folder.name}/${only.name}` };
  }
  return { ...folder, folders };
}

function folderTree(files: ShownFile[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.find((folder) => folder.name === part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return collapse(root);
}

interface TreeProps {
  change: Change;
  since: number | undefined;
  viewed: ReadonlySet<string>;
  focus: string | null;
  onJump: (path: string) => void;
}

function TreeRows({ folder, depth, ...rest }: TreeProps & { folder: Folder; depth: number }) {
  return (
    <>
      {folder.folders.map((child) => (
        <li key={child.path}>
          <details className="ftree__dir" open>
            <summary className="ftree__item ftree__summary" style={{ paddingLeft: 6 + depth * 14 }}>
              <CaretRightIcon size={11} weight="bold" className="ftree__caret" aria-hidden="true" />
              <FolderIcon size={14} weight="fill" className="ftree__icon ftree__icon--dir" aria-hidden="true" />
              <span className="ftree__name">{child.name}</span>
            </summary>
            <ul className="ftree">
              <TreeRows folder={child} depth={depth + 1} {...rest} />
            </ul>
          </details>
        </li>
      ))}
      {folder.files.map((file) => (
        <li key={file.path}>
          <TreeFile file={file} depth={depth} change={rest.change} since={rest.since} viewed={rest.viewed.has(file.path)} active={rest.focus === file.path} onJump={rest.onJump} />
        </li>
      ))}
    </>
  );
}

const TreeFile = memo(function TreeFile({ file, depth, change, since, viewed, active, onJump }: Omit<TreeProps, 'viewed' | 'focus'> & { file: ShownFile; depth: number; viewed: boolean; active: boolean }) {
  const warm = () => {
    prefetchCode();
    prefetchDiff(change.id, change.revision, file.path, since);
  };
  return (
    <a
      href={paths.pull(change.number, { file: file.path, since })}
      className="ftree__item ftree__file"
      aria-current={active ? 'true' : undefined}
      aria-label={`${file.path}${viewed ? ', viewed' : ''}`}
      title={file.path}
      data-viewed={viewed || undefined}
      data-deleted={file.deleted || undefined}
      style={{ paddingLeft: 23 + depth * 14 }}
      onPointerEnter={warm}
      onFocus={warm}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onJump(file.path);
      }}
    >
      {viewed ? <CheckIcon size={14} className="ftree__icon" aria-hidden="true" /> : <FileIcon size={14} className="ftree__icon" aria-hidden="true" />}
      <span className="ftree__name">{basename(file.path)}</span>
      <Stats additions={file.additions} deletions={file.deletions} className="ftree__stats" />
    </a>
  );
});

/* ---------- One file ---------- */

function fileNote(file: ShownFile): string | null {
  if (file.added) return 'Added';
  if (file.deleted) return 'Deleted';
  if (file.mode === '100755') return 'Executable';
  return null;
}

/**
 * Renders its children only while they are within a screen of the viewport. Off screen it
 * keeps the height they last had, so the scrollbar stays put as diffs come and go.
 */
function Windowed({ estimate, initial, children }: { estimate: number; initial: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const measured = useRef(0);
  const [near, setNear] = useState(initial);
  useEffect(() => {
    const node = ref.current!;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setNear(true);
        else {
          if (node.offsetHeight) measured.current = node.offsetHeight;
          setNear(false);
        }
      },
      { rootMargin: '1000px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="fsec__body" style={near ? undefined : { minHeight: measured.current || estimate }}>
      {near ? children : null}
    </div>
  );
}

function FileDiff({ change, file, since, onUpdated, review }: { change: Change; file: ShownFile; since: number | undefined; onUpdated: (change: Change) => void; review: DiffReview }) {
  const { key, diff, error, retry } = useChangeDiff(change.id, change.revision, file.path, since);
  const style = useDiffStyle();
  const snapshot = useSnapshot();
  const [comment, setComment] = useState<{ line: number; side: 'LEFT' | 'RIGHT'; restoreFocus: () => void } | null>(null);
  const canComment = !since && !answerBlocker(snapshot);
  const lineHeight = canComment ? 24 : 20;
  const estimate = diffEstimate(file, lineHeight) + contextRowHeight(file.path);
  const sizing = useRef<HTMLDivElement>(null);
  const [threadHeights, setThreadHeights] = useState<Record<string, number>>({});
  const threads = (change.comments ?? []).filter(comment => !comment.inReplyTo && comment.anchor?.path === file.path);
  const current = threads.filter(comment => !comment.anchor!.outdated && !since);
  const earlier = threads.filter(comment => comment.anchor!.outdated || since);
  const locations = [...new Set(current.map(comment => `${comment.anchor!.side}:${comment.anchor!.position}`))];
  useLayoutEffect(() => {
    const node = sizing.current;
    if (!node) return;
    const measure = () => {
      const heights = Object.fromEntries([...node.querySelectorAll<HTMLElement>('[data-thread-location]')].map(thread => [thread.dataset.threadLocation!, thread.getBoundingClientRect().height]));
      setThreadHeights(previous => JSON.stringify(previous) === JSON.stringify(heights) ? previous : heights);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [change.comments, file.path, since, error, diff?.binary, diff?.withheld]);
  if (error) return <CodeError result={{ status: 'error', message: error, changed: false }} onRetry={retry} />;
  if (diff?.withheld) return <div className="code code--empty">Content withheld because these changes contain a secret.</div>;
  if (diff?.binary) return <div className="code code--empty">Binary file</div>;
  if (since && diff && diff.before === diff.after) return <div className="code code--empty">Unchanged since {pushLabel(since).toLowerCase()}</div>;
  const annotations = locations.map(location => {
    const roots = current.filter(comment => `${comment.anchor!.side}:${comment.anchor!.position}` === location), anchor = roots[0].anchor!;
    return { side: anchor.side === 'LEFT' ? 'deletions' as const : 'additions' as const, lineNumber: anchor.position!, metadata: <div className="line-conversations" style={{ minHeight: threadHeights[location], lineHeight: `${lineHeight}px` }}>{roots.map(root => <ReviewThread key={root.id} change={change} root={root} onUpdated={onUpdated} inline />)}</div> };
  });
  if (comment) annotations.push({ side: comment.side === 'LEFT' ? 'deletions' : 'additions', lineNumber: comment.line, metadata: <div className="line-conversations"><CommentComposer key={`${comment.side}:${comment.line}`} change={change} anchor={{ path: file.path, line: comment.line, side: comment.side }} onUpdated={onUpdated} onCancel={() => { setComment(null); comment.restoreFocus(); }} /></div> });
  return <>
    <div className="fsec__diff" style={{ '--diff-line-height': `${lineHeight}px` } as CSSProperties}>
      <div ref={sizing} className="fsec__sizing" aria-hidden="true" inert>
        <div className="fsec__code-placeholder" style={{ height: estimate }}>
          <CodeSkeletonRows count={Math.min(30, (estimate - 16) / lineHeight)} />
        </div>
        {locations.map(location => <div className="line-conversations" data-thread-location={location} key={location}>{current.filter(root => `${root.anchor!.side}:${root.anchor!.position}` === location).map(root => <ReviewThread key={`${root.id}:${!!root.resolved}`} change={change} root={root} onUpdated={onUpdated} />)}</div>)}
      </div>
      <div className="fsec__render" aria-busy={!diff || undefined} aria-label={!diff ? 'Changes' : undefined}>
        {diff ? <DiffView path={file.path} before={diff.before} after={diff.after} id={key} style={style} annotations={annotations} {...review}
          onAddComment={canComment ? (line, side, restoreFocus) => setComment({ line, side: side === 'deletions' ? 'LEFT' : 'RIGHT', restoreFocus }) : undefined} /> : null}
      </div>
    </div>
    {earlier.length ? <div className="file-conversations">{earlier.map(root => <ReviewThread key={root.id} change={change} root={root} onUpdated={onUpdated} inline />)}</div> : null}
  </>;
}

const Section = memo(function Section({ change, file, index, initial, since, viewed, viewedKey, folded, onFold, onUpdated, review }: { change: Change; file: ShownFile; index: number; initial: boolean; since: number | undefined; viewed: boolean; viewedKey: string; folded: boolean; onFold: (path: string, folded: boolean) => void; onUpdated: (change: Change) => void; review: DiffReview }) {
  const open = !folded;
  const note = fileNote(file);
  const mark = (next: boolean) => {
    setViewed(viewedKey, change.revision, file.path, next);
    onFold(file.path, next);
  };
  return (
    <section id={`file-${index}`} className="fsec" tabIndex={-1} data-path={file.path} data-open={open || undefined} data-deleted={file.deleted || undefined} aria-label={file.path}>
      <header className="fsec__head">
        <button type="button" className="fsec__toggle" title={file.path} aria-label={`${open ? 'Collapse' : 'Expand'} ${file.path}`} aria-expanded={open} onClick={() => onFold(file.path, !folded)}>
          <CaretRightIcon size={12} weight="bold" className="fsec__caret" aria-hidden="true" />
          <span className="fsec__path mono">
            <span className="fsec__dir">{dirname(file.path)}</span>
            {basename(file.path)}
          </span>
        </button>
        {note ? <span className="fsec__note">{note}</span> : null}
        <Stats additions={file.additions} deletions={file.deletions} className="fsec__stats" />
        <Checkbox label="Viewed" aria-label={`Viewed ${file.path}`} checked={viewed} onCheckedChange={(checked) => mark(checked)} className="fsec__viewed" />
      </header>
      {open ? (
        <Windowed initial={initial} estimate={diffEstimate(file, 24) + contextRowHeight(file.path)}>
          <FileDiff change={change} file={file} since={since} onUpdated={onUpdated} review={review} />
        </Windowed>
      ) : null}
    </section>
  );
});

/* ---------- The tab ---------- */

const byPath = (a: ShownFile, b: ShownFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Earlier revisions of the change to compare against, as the picker offers them. */
function compareItems(revision: number): { value: string; label: string }[] {
  return [{ value: 'all', label: 'All changes' }, ...Array.from({ length: revision - 1 }, (_, i) => ({ value: String(i + 1), label: `Since ${pushLabel(i + 1).toLowerCase()}` }))];
}

/**
 * Every file of the current revision with its diff against main, or, since an earlier revision,
 * every file that differs from it, counted against it. `focus` is a path from the address bar to
 * scroll to; `notice` sits between the bar and the files.
 */
export function FilesChanged({ change, since, focus, notice, onUpdated = () => {} }: { change: Change; since: number | null; focus: string | null; notice?: ReactNode; onUpdated?: (change: Change) => void }) {
  const compared = useChangeComparison(change.id, change.revision, since ?? undefined);
  const shown = since ? compared.comparison?.files : change.files;
  const originalFiles = useMemo(() => (shown ? [...shown].sort(byPath) : []), [shown]);
  const { guide } = useGuide(change);
  const groupKey = `${change.id}:${change.revision}:${since ?? ''}`;
  const availableGuide = guide?.revision === change.revision && !since ? guide : null;
  // Cached data groups on entry. A late model answer needs an explicit click; it must not move a reader's diff.
  const [grouping, setGrouping] = useState<{ key: string; guide: ChangeGuide | null }>(() => ({ key: groupKey, guide: availableGuide }));
  const groups = useMemo(() => groupFiles(originalFiles, grouping.key === groupKey ? grouping.guide : null), [originalFiles, grouping, groupKey]);
  const availableGroups = useMemo(() => groupFiles(originalFiles, availableGuide), [originalFiles, availableGuide]);
  const canGroup = groupingKey(groups) !== groupingKey(availableGroups);
  const files = useMemo(() => [...groups.main, ...groups.tests, ...groups.generated], [groups]);
  const [openGroups, setOpenGroups] = useState<Set<'tests' | 'generated'>>(() => new Set());
  const [filter, setFilter] = useState('');
  const treeFiles = useMemo(() => files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase())), [files, filter]);
  const tree = useMemo(() => folderTree(treeFiles), [treeFiles]);
  const viewedKey = since ? `${change.id}:since:${since}` : change.id;
  const viewed = useViewed(viewedKey, change.revision);
  const [folded, setFolded] = useState(() => new Set(viewed));
  const style = useDiffStyle();
  const root = useRef<HTMLDivElement>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [jump, setJump] = useState(0);
  const compare = since ?? undefined;
  const { moves, onReady } = useMoves(change, originalFiles, compare);
  const [moveTarget, setMoveTarget] = useState<MoveEnd | null>(() => {
    const match = typeof window === 'undefined' ? null : /^#diff-([LR])(\d+)$/.exec(window.location.hash);
    return focus && match && Number(match[2]) > 0 ? { path: focus, side: match[1] === 'L' ? 'deletions' : 'additions', line: Number(match[2]) } : null;
  });

  useEffect(() => {
    const group = (['tests', 'generated'] as const).find(kind => groups[kind].some(file => file.path === focus));
    if (group) setOpenGroups(current => current.has(group) ? current : new Set([...current, group]));
  }, [focus, groups, jump]);
  useEffect(() => {
    const index = files.findIndex((file) => file.path === focus);
    if (index >= 0) {
      const section = document.getElementById(`file-${index}`);
      section?.scrollIntoView({ block: 'start' });
      section?.focus({ preventScroll: true });
    }
  }, [files, focus, jump, openGroups]);

  const onFold = useCallback((path: string, next: boolean) => setFolded((current) => {
    const updated = new Set(current);
    if (next) updated.add(path);
    else updated.delete(path);
    return updated;
  }), []);
  const onJump = useCallback((path: string) => {
    onFold(path, false);
    setMoveTarget(null);
    navigate(paths.pull(change.number, { file: path, since: compare }), { replace: true });
    setJump((n) => n + 1);
    setTreeOpen(false);
  }, [change.number, compare, onFold]);
  const onMove = useCallback((target: MoveEnd) => { onJump(target.path); setMoveTarget({ ...target }); }, [onJump]);
  const review = useMemo(() => ({ moves, onReady, onMove, moveTarget }), [moves, onReady, onMove, moveTarget]);
  useFileNavigation(root, onJump);

  if (!since && !files.length) {
    return (
      <>
        {notice}
        <EmptyPanel icon={<FileIcon size={24} />} title="No files changed" />
      </>
    );
  }

  // Since an earlier revision, the list itself loads first; the bar stays so the comparison can change.
  const body = since && compared.error ? <CodeError result={{ status: 'error', message: compared.error, changed: false }} onRetry={compared.retry} />
    : since && !compared.comparison ? <CodeLoading label="Comparing changes" />
    : !files.length ? <EmptyPanel icon={<FileIcon size={24} />} title={`No changes since ${pushLabel(since!).toLowerCase()}`} />
    : null;
  const renderFile = (file: ShownFile) => {
    const index = files.indexOf(file);
    return <Section key={file.path} change={change} file={file} index={index} initial={file.path === focus || index === 0} since={compare} viewed={viewed.has(file.path)} viewedKey={viewedKey} folded={folded.has(file.path)} onFold={onFold} onUpdated={onUpdated} review={review} />;
  };
  const layout = (
    <div className="files-layout" data-tree-open={treeOpen || undefined}>
      <nav id="changed-files" className="ftree-pane" aria-label="Changed files">
        <Input aria-label="Filter changed files" placeholder="Filter files" value={filter} onChange={(event) => setFilter(event.target.value)} passwordManagerIgnore className="ftree__filter" />
        {!treeFiles.length ? <p className="ftree__empty quiet">No matching files</p> : null}
        <ul className="ftree">
          <TreeRows folder={tree} depth={0} change={change} since={compare} viewed={viewed} focus={focus} onJump={onJump} />
        </ul>
      </nav>
      <div className="fsecs">
        {groups.main.map(renderFile)}
        {(['tests', 'generated'] as const).map(kind => groups[kind].length ? <details className="fgroup" key={kind} open={openGroups.has(kind)} onToggle={event => {
          const open = event.currentTarget.open;
          setOpenGroups(current => { if (current.has(kind) === open) return current; const next = new Set(current); if (open) next.add(kind); else next.delete(kind); return next; });
        }}>
          <summary className="fgroup__summary"><CaretRightIcon size={12} className="fgroup__caret" aria-hidden="true" />{kind === 'tests' ? 'Tests' : 'Generated'} <span className="count">{groups[kind].length}</span></summary>
          {openGroups.has(kind) ? <div className="fsecs">{groups[kind].map(renderFile)}</div> : null}
        </details> : null)}
        {(change.comments ?? []).filter(comment => !comment.inReplyTo && comment.anchor && !files.some(file => file.path === comment.anchor!.path)).map(root => <ReviewThread key={root.id} change={change} root={root} onUpdated={onUpdated} inline />)}
      </div>
    </div>
  );
  const seen = files.reduce((count, file) => count + (viewed.has(file.path) ? 1 : 0), 0);
  return (
    <div ref={root} className="files">
      <div className="files-bar">
        <Button size="sm" variant="outline" icon={SidebarSimpleIcon} className="files-bar__tree" aria-expanded={treeOpen} aria-controls="changed-files" onClick={() => setTreeOpen((open) => !open)}>
          Files
        </Button>
        {change.revision > 1 ? (
          <Select
            size="sm"
            aria-label="Compare"
            value={since ? String(since) : 'all'}
            items={compareItems(change.revision)}
            onValueChange={(value) => value && navigate(paths.pull(change.number, value === 'all' ? { tab: 'files' } : { since: Number(value) }))}
          />
        ) : null}
        <span className="files-bar__count quiet">
          {seen} of {files.length} viewed
        </span>
        {files.length ? <Button size="sm" variant="ghost" onClick={() => {
          const expand = folded.size === files.length;
          setFolded(expand ? new Set() : new Set(files.map((file) => file.path)));
          setOpenGroups(expand ? new Set(['tests', 'generated']) : new Set());
        }}>{folded.size === files.length ? 'Expand all' : 'Collapse all'}</Button> : null}
        {files.length > 1 ? <Button className="files-bar__group" size="sm" variant="ghost" disabled={!canGroup} style={{ visibility: canGroup ? undefined : 'hidden' }} onClick={() => {
          setGrouping({ key: groupKey, guide: availableGuide }); setOpenGroups(new Set());
        }}>Group files</Button> : null}
        <Tooltip className="files-bar__keys" content="j / k: next / previous file. n / p: next / previous change." render={<button type="button" aria-label="Keyboard shortcuts" />}>
          <kbd>j</kbd><kbd>k</kbd> files <kbd>n</kbd><kbd>p</kbd> changes
        </Tooltip>
        <Tabs
          size="sm"
          variant="segmented"
          className="files-bar__style"
          aria-label="Diff view"
          value={style}
          onValueChange={(value) => setDiffStyle(value as DiffStyle)}
          tabs={[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Split' },
          ]}
        />
      </div>
      {notice}
      {body ?? layout}
    </div>
  );
}
