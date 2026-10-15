import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@cloudflare/kumo';
import { ArrowClockwiseIcon, DownloadSimpleIcon } from '@phosphor-icons/react';
import type { DiffFileInput, FileContents } from '@pierre/diffs';
import type { ChangeConflictRegion } from '../../../shared/types';
import { isLargeText, isShowableText, splitLines, textSize, type TextSize } from '../../lib/diff';
import { basename, formatBytes, taggedFilename } from '../../lib/format';
import { downloadText } from '../../lib/hooks';
import type { ChangeResult } from '../../lib/resources';
import { Conflict, Diff, Markdown, Source } from './viewer';
import { useLineAnchor } from './line-anchor';
import { CodeSkeleton } from './CodeSkeleton';
import type { DiffComments } from './annotations';
import type { DiffReview } from './review-types';
import { readStored, writeStored } from '../../lib/storage';
import '../../styles/code.css';

/*
 * Code on screen. The viewer itself (pierre.tsx, with its highlighter and worker pool) is a
 * separate chunk that loads the first time a diff or a code file is shown (viewer.ts); everything
 * a page needs before that, and prose that needs no grammar, lives here.
 */

/* ---------- Unified or split, as on GitHub's Files changed ---------- */

export type DiffStyle = 'unified' | 'split';
const STYLE_KEY = 'braid.diff';
const styleListeners = new Set<() => void>();
let diffStyle: DiffStyle = readStored('localStorage', STYLE_KEY) === 'split' ? 'split' : 'unified';

export function setDiffStyle(next: DiffStyle) {
  diffStyle = next;
  writeStored('localStorage', STYLE_KEY, next);
  for (const listener of styleListeners) listener();
}

export function useDiffStyle(): DiffStyle {
  return useSyncExternalStore(
    (listener) => {
      styleListeners.add(listener);
      return () => styleListeners.delete(listener);
    },
    () => diffStyle,
  );
}

/* ---------- States ---------- */

/** Shown in place of code while a version loads. Never the empty placeholder text. */
export function CodeLoading({ label = 'Code', lines }: { label?: string; lines?: number }) {
  return <CodeSkeleton label={label} lines={lines} />;
}

/** A version that could not be read, with the server's reason and a retry. */
export function CodeError({ result, onRetry }: { result: Extract<ChangeResult, { status: 'error' }>; onRetry: () => void }) {
  return (
    <div className="code code--empty code--error" role="alert">
      <span>{result.changed ? 'This proposal changed. The page updates on its own.' : result.message}</span>
      {result.changed ? null : (
        <Button size="sm" variant="secondary" icon={ArrowClockwiseIcon} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** A proposal that removes the file has no contents to show. */
export function DeletedFile({ path }: { path: string }) {
  return <div className="code code--empty">{path} is deleted in this version</div>;
}

interface Side {
  name: string;
  text: string;
  size: TextSize;
  filename: string;
  /** What to say when this side has no text. */
  empty: string;
}

/**
 * A text past the inline limit. Nothing is cut: the stored version, its fingerprint and the
 * merge carry the whole file, and each side downloads exactly as stored. Texts under the hard
 * cap can still be shown on request, as plain text.
 */
function LargeText({ label, sides, onShow }: { label: string; sides: Side[]; onShow?: () => void }) {
  return (
    <div className="code code--empty code--large" role="region" aria-label={label}>
      <p className="code__large-title">Too large to show inline</p>
      <ul className="code__sides">
        {sides.map((side, index) => (
          <li key={index} className="code__side">
            <span className="code__side-name">{side.name}</span>
            <span className="code__side-size">{side.text ? `${side.size.lines.toLocaleString()} lines · ${formatBytes(side.size.bytes)}` : side.empty}</span>
            {side.text ? (
              <Button size="sm" variant="secondary" icon={DownloadSimpleIcon} aria-label={`Download ${side.name}`} onClick={() => downloadText(side.filename, side.text, 'text/plain')}>
                Download
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {onShow ? (
        <Button size="sm" variant="ghost" title="Renders every line, without syntax highlighting" onClick={onShow}>
          Show anyway
        </Button>
      ) : null}
    </div>
  );
}

/* ---------- Prose ---------- */

const PROSE = new Set(['md', 'markdown', 'txt', 'text', 'rst', 'adoc']);
const CODE_WITHOUT_EXTENSION = new Set(['dockerfile', 'containerfile', 'makefile', 'justfile', 'gemfile', 'rakefile', 'procfile']);

/** Files GitHub renders as prose: Markdown, which Preview shows rendered and Code shows as written. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(basename(path));
}

/** README files, notes and plain text read better wrapped and need no grammar, so they render at once, without the viewer. */
export function isProse(path: string): boolean {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return !CODE_WITHOUT_EXTENSION.has(name.toLowerCase());
  return PROSE.has(name.slice(dot + 1).toLowerCase());
}

function PlainText({ content, path }: { content: string; path: string }) {
  const lines = useMemo(() => splitLines(content), [content]);
  const selected = useLineAnchor(), region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected !== null) region.current?.querySelector(`#L${selected}`)?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [selected, content, path]);
  return (
    <div className="code" role="region" aria-label={`Contents of ${path}`} tabIndex={0} ref={region}>
      <table className="code__table" data-wrap="">
        <tbody>
          {lines.map((line, index) => (
            <tr key={index} id={`L${index + 1}`} className="code__row" data-selected={selected === index + 1 || undefined}>
              <td className="code__num"><a href={`#L${index + 1}`} aria-label={`Line ${index + 1}`}>{index + 1}</a></td>
              <td className="code__line">{line || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Files and diffs ---------- */

export type FileRender = 'preview' | 'code';

/** `id` names this exact text, so highlighting is cached across renders and views. A Markdown file previews as prose when `render` asks. */
export function FileView({ path, content, id, render = 'code' }: { path: string; content: string; id: string; render?: FileRender }) {
  const size = useMemo(() => textSize(content), [content]);
  const [shown, setShown] = useState<string | null>(null);
  const large = isLargeText(size);
  const plain = large && shown === id;
  const file = useMemo<FileContents>(() => ({ name: path, contents: content, cacheKey: plain ? `${id}:plain` : id, ...(plain ? { lang: 'text' as const } : {}) }), [path, content, id, plain]);
  const label = `Contents of ${path}`;
  if (large && !plain) {
    return <LargeText label={label} sides={[{ name: 'File', text: content, size, filename: basename(path), empty: 'Empty' }]} onShow={isShowableText(size) ? () => setShown(id) : undefined} />;
  }
  if (!content) return <div className="code code--empty">Empty file</div>;
  if (render === 'preview' && isMarkdown(path)) {
    return (
      <Suspense fallback={<CodeLoading />}>
        <Markdown source={content} path={path} />
      </Suspense>
    );
  }
  if (isProse(path)) return <PlainText content={content} path={path} />;
  return (
    <Suspense fallback={<CodeSkeleton lines={size.lines} />}>
      <Source file={file} label={label} />
    </Suspense>
  );
}

interface DiffViewProps extends DiffComments, DiffReview {
  path: string;
  /** Null when the file is added. */
  before: string | null;
  /** Null when the file is deleted. */
  after: string | null;
  /** Names this exact pair of texts, for highlight caching. */
  id: string;
  label?: string;
  /** Labels the sides when they are two agents' versions rather than before and after. */
  names?: { before: string; after: string };
  style?: DiffStyle;
  /** A caller that already windows whole files can keep the visible file's rows stable. */
  virtualized?: boolean;
}

/** Line diff of two texts, unified or split, with unchanged runs folded as on GitHub. */
export function DiffView({ path, before, after, id, label, names, style = 'unified', virtualized = true, annotations, onAddComment, ...review }: DiffViewProps) {
  const sizes = useMemo(() => ({ before: textSize(before ?? ''), after: textSize(after ?? '') }), [before, after]);
  const [shown, setShown] = useState<string | null>(null);
  const large = isLargeText(sizes.before) || isLargeText(sizes.after);
  const plain = large && shown === id;
  const files = useMemo<DiffFileInput | null>(() => {
    const make = (contents: string, side: string): FileContents => ({ name: path, contents, cacheKey: `${id}:${side}${plain ? ':plain' : ''}`, ...(plain ? { lang: 'text' as const } : {}) });
    if (before !== null && after !== null) return { oldFile: make(before, 'old'), newFile: make(after, 'new') };
    if (after !== null) return { oldFile: null, newFile: make(after, 'new') };
    if (before !== null) return { oldFile: make(before, 'old'), newFile: null };
    return null;
  }, [path, before, after, id, plain]);
  const region = label ?? `Changes to ${path}`;

  if (!files) return <DeletedFile path={path} />;
  if (large && !plain) {
    const left = names?.before ?? 'Before';
    const right = names?.after ?? 'After';
    return (
      <LargeText
        label={region}
        sides={[
          { name: left, text: before ?? '', size: sizes.before, filename: taggedFilename(path, left), empty: 'Empty' },
          { name: right, text: after ?? '', size: sizes.after, filename: taggedFilename(path, right), empty: after === null ? 'Deleted' : 'Empty' },
        ]}
        onShow={isShowableText(sizes.before) && isShowableText(sizes.after) ? () => setShown(id) : undefined}
      />
    );
  }
  if (before === after) return <div className="code code--empty">{before ? 'No differences' : 'Empty file'}</div>;
  return (
    <Suspense fallback={<CodeSkeleton label="Changes" lines={sizes.before.lines + sizes.after.lines} />}>
      <Diff files={files} label={region} split={style === 'split'} wrap={isProse(path)} virtualized={virtualized} annotations={annotations} onAddComment={onAddComment} {...review} />
    </Suspense>
  );
}

/** Guide can render original zero-based `hunks` from a file with the same grammar context, move links and comments as Files changed. */
export function AnchoredHunks(props: DiffViewProps & { hunks: readonly number[] }) {
  return <DiffView {...props} />;
}

/* ---------- Conflicts ---------- */

/** The region as Git would leave it in the file: main's lines, the common base, then this change's lines. */
function conflictText(region: ChangeConflictRegion, branch: string): string {
  const block = (lines: string[]) => lines.map((line) => (line.endsWith('\n') ? line : `${line}\n`)).join('');
  return `<<<<<<< ${branch}\n${block(region.ours)}||||||| base\n${block(region.base)}=======\n${block(region.theirs)}>>>>>>> this change\n`;
}

export function ConflictView({ path, region, branch, index }: { path: string; region: ChangeConflictRegion; branch: string; index: number }) {
  const file = useMemo<FileContents>(
    () => ({ name: path, contents: conflictText(region, branch), cacheKey: `${path}:conflict:${index}:${region.baseStart}:${region.oursStart}:${region.theirsStart}` }),
    [path, region, branch, index],
  );
  return (
    <Suspense fallback={<CodeLoading />}>
      <Conflict file={file} label={`Conflict region ${index + 1}`} />
    </Suspense>
  );
}
