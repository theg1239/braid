import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Popover } from '@cloudflare/kumo';
import type { FileBlame, Provenance } from '../../../shared/types';
import { personHandle } from '../../../shared/people';
import { isShowableText, splitLines, textSize } from '../../lib/diff';
import { plural, shortHash } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useBlame } from '../../lib/resources';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { EmptyPanel, ErrorPanel } from '../ui/States';
import { BlameSkeleton } from './CodeSkeleton';
import { scrollToSourceLine, useLineAnchor } from './line-anchor';
import { useSourceLineHeight } from './line-height';
import { RelativeTime } from '../ui/Time';
import '../../styles/blame.css';

/*
 * Blame, as GitHub lays it out: runs of lines one commit last changed, who made it on the left and
 * the lines on the right. Who is the model and whose agent it was, or the person. Only the lines near
 * the viewport are in the document; the rest are a gap of exactly their height, so a 20,000-line
 * file scrolls like a short one. Loads with the Code screen.
 */

/** Lines within this distance of the viewport are rendered. */
const MARGIN = 600;

/** How Braid knows who made a commit, in two or three words. */
const CONFIDENCE: Record<Provenance['confidence'], string> = { braid: 'Seen by Braid', trailers: 'From the commit', inferred: 'Inferred from the commit' };

interface Hunk {
  start: number;
  text: string[];
  provenance?: Provenance;
  top: number;
  height: number;
}

/** Who a run of lines reads as: the model that wrote it, or the person. */
function writer(provenance: Provenance): string {
  return provenance.agent ? provenance.agent.name : provenance.owner ? personHandle(provenance.owner) : shortHash(provenance.commit);
}

/** The blame's ranges with their lines, each placed at its exact offset; and the widest line, for the horizontal extent. */
function hunksOf(blame: FileBlame, content: string, lineHeight: number): { hunks: Hunk[]; total: number; chars: number } {
  const lines = splitLines(content);
  const chars = lines.reduce((width, line) => Math.max(width, line.length + line.split('\t').length - 1), 0);
  const hunks: Hunk[] = [];
  const add = (start: number, count: number, provenance?: Provenance) => {
    const text = lines.slice(start - 1, start - 1 + count);
    if (text.length) hunks.push({ start, text, provenance, top: (start - 1) * lineHeight, height: text.length * lineHeight });
  };
  let next = 1;
  for (const range of blame.ranges) {
    if (range.start > next) add(next, range.start - next);
    add(range.start, range.lines, range.provenance);
    next = range.start + range.lines;
  }
  if (next <= lines.length) add(next, lines.length - next + 1);
  return { hunks, total: lines.length * lineHeight, chars };
}

/** The pixel bounds within reach of the viewport; the initial render is bounded before measurement, too. */
function useVisible(ref: RefObject<HTMLElement | null>, hunks: Hunk[]): [number, number] {
  const [range, setRange] = useState<[number, number]>([0, MARGIN]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const top = -rect.top - MARGIN;
      const bottom = window.innerHeight - rect.top + MARGIN;
      setRange((current) => (current[0] === top && current[1] === bottom ? current : [top, bottom]));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, hunks]);
  return range;
}

/** The runs touching the visible pixel bounds, found without scanning every range on each scroll. */
function visibleHunks(hunks: Hunk[], top: number, bottom: number): Hunk[] {
  let lo = 0, hi = hunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hunks[mid].top + hunks[mid].height > top) hi = mid;
    else lo = mid + 1;
  }
  const first = lo;
  hi = hunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hunks[mid].top >= bottom) hi = mid;
    else lo = mid + 1;
  }
  return hunks.slice(first, lo);
}

/** The commit behind a run: its subject, then who, the run it came from, its pull request and task, and how Braid knows. */
function Card({ provenance }: { provenance: Provenance }) {
  const { agent, owner, change, task } = provenance;
  const handle = provenance.kind !== 'bot' && owner ? personHandle(owner) : null;
  return (
    <>
      <Popover.Title className="blame-card__title">
        <span className="blame-card__subject">{provenance.subject}</span>
        <span className="mono blame-card__hash">{shortHash(provenance.commit)}</span>
      </Popover.Title>
      <dl className="facts blame-card__facts">
        {agent ? (
          <>
            <dt>{provenance.kind === 'bot' ? 'Bot' : 'Model'}</dt>
            <dd title={agent.model}>{agent.name}</dd>
          </>
        ) : null}
        {handle ? (
          <>
            <dt>{agent ? 'Owner' : 'Author'}</dt>
            <dd>{handle}</dd>
          </>
        ) : null}
        {agent?.tool ? (
          <>
            <dt>Tool</dt>
            <dd className="mono">{agent.tool}</dd>
          </>
        ) : null}
        {agent?.session ? (
          <>
            <dt>Session</dt>
            <dd className="mono">
              {agent.session}
              {agent.parentSession ? <span className="blame-card__parent"> under {agent.parentSession}</span> : null}
            </dd>
          </>
        ) : null}
        {agent?.fleet ? (
          <>
            <dt>Fleet</dt>
            <dd>{agent.fleet}</dd>
          </>
        ) : null}
        {change ? (
          <>
            <dt>Pull request</dt>
            <dd>
              <RouterLink href={paths.pull(change.number)} className="text-link">
                #{change.number}
              </RouterLink>
            </dd>
          </>
        ) : null}
        {task ? (
          <>
            <dt>Task</dt>
            <dd>
              <RouterLink href={paths.task(task.id)} className="text-link">
                {task.title ?? task.id}
              </RouterLink>
            </dd>
          </>
        ) : null}
        <dt>Confidence</dt>
        <dd>{CONFIDENCE[provenance.confidence]}</dd>
      </dl>
    </>
  );
}

/** One run: who on the left, opening the commit's card on hover or click, and its lines on the right. */
function HunkRow({ hunk, top, bottom, now, selected, lineHeight }: { hunk: Hunk; top: number; bottom: number; now: number; selected: number | null; lineHeight: number }) {
  const { provenance } = hunk;
  const owner = provenance?.kind === 'agent' && provenance.owner ? personHandle(provenance.owner) : null;
  const first = Math.max(0, Math.min(hunk.text.length, Math.floor((top - hunk.top) / lineHeight)));
  const last = Math.max(first, Math.min(hunk.text.length, Math.ceil((bottom - hunk.top) / lineHeight)));
  return (
    <div className="blame__hunk" data-first={hunk.top === 0 || undefined} data-confidence={provenance?.confidence} style={{ top: hunk.top, height: hunk.height }}>
      {provenance ? <Popover>
        <Popover.Trigger openOnHover delay={350} render={<button type="button" className="blame__who" />}>
          <span className="blame__name">{writer(provenance)}</span>
          {owner ? <span className="blame__owner">for {owner}</span> : null}
          {provenance.confidence === 'inferred' ? <span className="blame__weak">inferred</span> : null}
          <RelativeTime at={provenance.at} now={now} className="blame__age" />
        </Popover.Trigger>
        <Popover.Content align="start" sideOffset={4} className="blame-card">
          <Card provenance={provenance} />
        </Popover.Content>
      </Popover> : <span className="blame__who" aria-hidden="true" />}
      <ol className="blame__lines" start={hunk.start + first} style={{ height: hunk.height, paddingTop: first * lineHeight }}>
        {hunk.text.slice(first, last).map((line, index) => (
          <li key={hunk.start + first + index} className="blame__line" id={`L${hunk.start + first + index}`} data-selected={selected === hunk.start + first + index || undefined}>
            <a className="blame__num" href={`#L${hunk.start + first + index}`} aria-label={`Line ${hunk.start + first + index}`}>{hunk.start + first + index}</a>
            <span className="blame__text">{line}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Who wrote the file, in one quiet line: each writer with its lines, most first; and why the attribution is coarse, when it is. */
function Shares({ hunks, note }: { hunks: Hunk[]; note: string | undefined }) {
  const totals = new Map<string, { name: string; owner: string | null; lines: number }>();
  for (const hunk of hunks) {
    const { provenance } = hunk;
    if (!provenance) continue;
    const name = writer(provenance);
    const owner = provenance.kind === 'agent' && provenance.owner ? personHandle(provenance.owner) : null;
    const key = `${name}\0${owner ?? ''}`;
    const known = totals.get(key) ?? { name, owner, lines: 0 };
    known.lines += hunk.text.length;
    totals.set(key, known);
  }
  const shares = [...totals.values()].sort((a, b) => b.lines - a.lines);
  return (
    <p className="blame__sum" role="group" aria-label="File authors">
      {shares.map((share) => (
        <span key={`${share.name}${share.owner ?? ''}`} className="blame__share">
          <span className="blame__share-name">{share.name}</span>
          {share.owner ? <span className="blame__share-owner">for {share.owner}</span> : null}
          <span className="blame__share-lines">{plural(share.lines, 'line')}</span>
        </span>
      ))}
      {note ? <span className="blame__note">{note} Line history: <a className="text-link" href="/setup.md"><code>braid blame</code></a>.</span> : null}
    </p>
  );
}

function Hunks({ blame, content, path }: { blame: FileBlame; content: string; path: string }) {
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const lineHeight = useSourceLineHeight();
  const { hunks, total, chars } = useMemo(() => hunksOf(blame, content, lineHeight), [blame, content, lineHeight]);
  const [top, bottom] = useVisible(ref, hunks);
  const selected = useLineAnchor();
  useEffect(() => {
    if (selected === null || !ref.current) return;
    if (selected <= splitLines(content).length) scrollToSourceLine(ref.current, (selected - 1) * lineHeight);
  }, [selected, content, lineHeight]);
  return (
    <>
      <Shares hunks={hunks} note={blame.pending ? undefined : blame.note} />
      <div ref={ref} className="code blame" tabIndex={0} role="region" aria-label={`Who changed ${path}`} style={{ '--chars': chars, '--source-line-height': `${lineHeight}px` } as CSSProperties}>
        <div className="blame__body" style={{ height: total }}>
          {visibleHunks(hunks, top, bottom).map((hunk) => (
            <HunkRow key={hunk.start} hunk={hunk} top={top} bottom={bottom} now={now} selected={selected} lineHeight={lineHeight} />
          ))}
        </div>
      </div>
    </>
  );
}

/** Who last changed each line of a file on main, beside the lines. */
export function BlameView({ path, content, head }: { path: string; content: string; head: string }) {
  const { blame, error, retry } = useBlame(path, head);
  if (!isShowableText(textSize(content))) return <EmptyPanel title="Too large to show" description="Open Code to download it." />;
  if (error) return <ErrorPanel title="Couldn’t read who changed this file" message={error} onRetry={retry} />;
  if (!blame) return <BlameSkeleton lines={textSize(content).lines} />;
  if (!content) return <div className="code code--empty">Empty file</div>;
  return <Hunks blame={blame} content={content} path={path} />;
}
