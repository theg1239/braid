import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Select } from '@cloudflare/kumo';
import { BookOpenIcon, CaretDownIcon, CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import type { Change, ChangeGuide } from '../../../shared/types';
import { modelName } from '../../../shared/models';
import { basename, dirname } from '../../lib/format';
import { prefetchDiff } from '../../lib/resources';
import { EmptyPanel, ErrorNotice } from '../ui/States';
import { LoadingRegion, SkeletonLine, SkeletonRow } from '../ui/Skeleton';
import { GuideCode } from './GuideCode';
import { navigationKey } from './fileNavigation';
import { useMoves } from './useMoves';
import { arrangeChapters, currentChapter, filesNote, kindNote, lineRanges, retryGuide, useGuide, type NumberedChapter } from './guide';
import { CodeSkeletonRows } from '../code/CodeSkeleton';
import './guide.css';

/*
 * The guided review of a pull request: what the system was before and what it is after, then the
 * diff in chapters, each a few hunks with one reason. The chapter list is on the left and the
 * chapter's code on the right, so understanding the change never means switching tabs. Tests
 * and generated files fold at the end of the list.
 */

/* ---------- The list ---------- */

function ChapterRow({ chapter, current, onSelect }: { chapter: NumberedChapter; current: boolean; onSelect: (id: string) => void }) {
  const note = kindNote(chapter.kind);
  const files = filesNote(chapter);
  return (
    <li>
      <button type="button" className="guide__chapter" aria-current={current ? 'true' : undefined} onClick={() => onSelect(chapter.id)}>
        <span className="guide__num">{chapter.number}</span>
        <span className="guide__chapter-text">
          <span className="guide__chapter-title">{chapter.title}</span>
          <span className="guide__chapter-note">{note ? `${note} · ${files}` : files}</span>
        </span>
      </button>
    </li>
  );
}

function Fold({ label, chapters, open, onToggle, currentId, onSelect }: { label: string; chapters: NumberedChapter[]; open: boolean; onToggle: (open: boolean) => void; currentId: string | null; onSelect: (id: string) => void }) {
  if (!chapters.length) return null;
  return (
    <details className="guide__fold" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary className="guide__fold-summary">
        <CaretDownIcon size={12} weight="bold" className="guide__fold-caret" aria-hidden="true" />
        {label}
        <span className="tab-count">{chapters.length}</span>
      </summary>
      <ol className="guide__list">
        {chapters.map((chapter) => <ChapterRow key={chapter.id} chapter={chapter} current={chapter.id === currentId} onSelect={onSelect} />)}
      </ol>
    </details>
  );
}

/* ---------- Before the guide is written ---------- */

/** The guide's layout with nothing in it yet: the same columns, so the chapters land where the reader is already looking. */
function GuidePending() {
  return (
    <LoadingRegion label="Loading guide" className="guide guide--pending">
      <div className="guide__intro">
        <section className="guide__side"><h2>Before</h2><SkeletonLine width="92%" /><SkeletonLine width="70%" /></section>
        <section className="guide__side"><h2>After</h2><SkeletonLine width="88%" /><SkeletonLine width="76%" /></section>
      </div>
      <div className="guide__layout">
        <div className="guide__chapters">{Array.from({ length: 5 }, (_, index) => <SkeletonRow key={index} index={index} icon={false} detail height={48} />)}</div>
        <div className="guide__code">
          <div className="guide__current"><SkeletonLine width="40%" height={18} /></div>
          <SkeletonLine width="70%" />
          <div className="guide__file">
            <div className="guide__file-head"><SkeletonLine width={160} /></div>
            <div className="guide__diff-room" style={{ height: 336 }}><CodeSkeletonRows count={16} /></div>
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}

/* ---------- The tab ---------- */

function Chapters({ change, guide }: { change: Change; guide: ChangeGuide }) {
  const arranged = useMemo(() => arrangeChapters(guide.chapters), [guide.chapters]);
  const [wanted, setWanted] = useState<string | null>(null);
  const [open, setOpen] = useState({ tests: false, generated: false });
  const current = currentChapter(arranged.all, wanted);
  const root = useRef<HTMLDivElement>(null);
  // Blocks moved between files read as chips, as on Files changed.
  const { moves, onReady } = useMoves(change, change.files);
  const index = current ? arranged.all.indexOf(current) : -1;
  const previous = index > 0 ? arranged.all[index - 1] : null;
  const next = index >= 0 && index < arranged.all.length - 1 ? arranged.all[index + 1] : null;

  const select = useCallback((id: string) => {
    setWanted(id);
    const chapter = arranged.all.find((item) => item.id === id);
    if (chapter?.kind === 'tests') setOpen((state) => ({ ...state, tests: true }));
    if (chapter?.kind === 'generated') setOpen((state) => ({ ...state, generated: true }));
    // The chapter's heading comes back into view when the reader was deep in the last one.
    const heading = root.current?.querySelector<HTMLElement>('.guide__current');
    if (heading && heading.getBoundingClientRect().top < 0) heading.scrollIntoView({ block: 'start' });
  }, [arranged]);

  // j and k move between chapters, as they move between files on Files changed.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!navigationKey(event)) return;
      if (event.key !== 'j' && event.key !== 'k') return;
      const target = event.key === 'j' ? next : previous;
      if (!target) return;
      event.preventDefault();
      select(target.id);
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [next, previous, select]);

  // The next chapter's files are read while this one is open.
  useEffect(() => {
    for (const file of next?.files ?? []) prefetchDiff(change.id, change.revision, file.path);
  }, [change.id, change.revision, next]);

  if (!current) return <EmptyPanel icon={<BookOpenIcon size={24} />} title="No chapters" />;
  const note = kindNote(current.kind);
  const items = arranged.all.map((chapter) => ({ value: chapter.id, label: `${chapter.number}. ${chapter.title}` }));
  return (
    <div ref={root} className="guide__layout">
      <nav className="guide__chapters" aria-label="Chapters">
        <ol className="guide__list">
          {arranged.main.map((chapter) => <ChapterRow key={chapter.id} chapter={chapter} current={chapter.id === current.id} onSelect={select} />)}
        </ol>
        <Fold label="Tests" chapters={arranged.tests} open={open.tests} onToggle={(tests) => setOpen((state) => ({ ...state, tests }))} currentId={current.id} onSelect={select} />
        <Fold label="Generated" chapters={arranged.generated} open={open.generated} onToggle={(generated) => setOpen((state) => ({ ...state, generated }))} currentId={current.id} onSelect={select} />
        <p className="guide__by quiet">
          {guide.generatedBy ? <span className="guide__model" title={guide.generatedBy}>Written by {modelName(guide.generatedBy)}</span> : null}
          <span className="guide__keys" title="Next and previous chapter"><kbd>j</kbd><kbd>k</kbd><span className="sr-only">move between chapters</span></span>
        </p>
      </nav>
      <div className="guide__code">
        <header className="guide__current">
          <div className="guide__picker">
            <Select size="sm" aria-label="Chapter" value={current.id} items={items} onValueChange={(value) => value && select(value)} />
          </div>
          <h2 className="guide__title"><span className="guide__num">{current.number}</span>{current.title}</h2>
          {note ? <span className="guide__kind">{note}</span> : null}
          <span className="guide__nav">
            <Button size="sm" variant="ghost" shape="square" icon={CaretLeftIcon} aria-label="Previous chapter" disabled={!previous} onClick={() => previous && select(previous.id)} />
            <Button size="sm" variant="ghost" shape="square" icon={CaretRightIcon} aria-label="Next chapter" disabled={!next} onClick={() => next && select(next.id)} />
          </span>
        </header>
        {current.summary ? <p className="guide__summary">{current.summary}</p> : null}
        {current.files.map((file) => (
          <section key={file.path} className="guide__file" aria-label={file.path}>
            <header className="guide__file-head">
              <span className="guide__path mono" title={file.path}><span className="guide__dir">{dirname(file.path)}</span>{basename(file.path)}</span>
              <span className="guide__lines quiet">{lineRanges(file.hunks)}</span>
            </header>
            <GuideCode change={change} path={file.path} hunks={file.hunks} moves={moves} onReady={onReady} />
          </section>
        ))}
      </div>
    </div>
  );
}

/** The Guide tab: before and after, then the chapters; its layout from the first paint, filled in as the model finishes. */
export function Guide({ change }: { change: Change }) {
  const { guide, error, refreshing } = useGuide(change);
  if (!guide) {
    if (error) return <div className="guide"><ErrorNotice message={error} onRetry={() => retryGuide(change)} retrying={refreshing} /></div>;
    return <GuidePending />;
  }
  if (guide.status === 'failed') return <div className="guide"><ErrorNotice message={guide.error ?? 'The guide could not be written.'} onRetry={() => retryGuide(change)} retrying={refreshing} /></div>;
  if (guide.status === 'pending') return <GuidePending />;
  return (
    <div className="guide">
      {guide.before || guide.after ? (
        <div className="guide__intro">
          <section className="guide__side"><h2>Before</h2><p>{guide.before}</p></section>
          <section className="guide__side"><h2>After</h2><p>{guide.after}</p></section>
        </div>
      ) : null}
      <Chapters key={`${change.id}:${change.revision}`} change={change} guide={guide} />
    </div>
  );
}
