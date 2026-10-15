import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { preload } from 'react-dom';
import { Button, Collapsible, Dialog, Tabs } from '@cloudflare/kumo';
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, XIcon } from '@phosphor-icons/react';
import type { Change, CommandEvidence, ScreenshotEvidence } from '../../../shared/types';
import { changes } from '../../lib/api';
import { SOURCE_LABEL, VIEWPORT_LABEL, commandState, earlierRevisions, proofLabel, proofOf, type ProofPage, type RevisionProof } from '../../lib/evidence';
import { pushLabel } from './pushes';
import { CheckStateIcon } from './Bits';
import { DisclosureTrigger } from '../ui/Disclosure';
import '../../styles/proof.css';

/*
 * What the pull request was shown doing, under its description: each page at desktop and phone
 * size, then the commands that ran with how they ended and where. A person can judge the
 * result here without reading the diff. Nothing renders when the current version carries no
 * evidence.
 */

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const ratio = (shot: ScreenshotEvidence) => ({ '--ar': `${shot.width} / ${shot.height}` }) as CSSProperties;

/** A screenshot as a plain image, read by the browser with the session cookie; one that cannot be read says so in its frame. */
function Picture({ change, shot, className, alt, lazy, priority }: { change: Change; shot: ScreenshotEvidence; className: string; alt: string; lazy?: boolean; priority?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === shot.image) return <span className="shot__missing">Not available</span>;
  // The first shot is already preloaded. Keep its image lazy so React can commit the
  // page and its reserved frame immediately instead of suspending on image decoding.
  return <img className={className} src={changes.evidenceImageUrl(change.id, shot.image)} width={shot.width} height={shot.height} loading={lazy ? 'lazy' : undefined} fetchPriority={priority ? 'high' : undefined} decoding="async" alt={alt} onError={() => setFailed(shot.image)} />;
}

/** One screenshot, sized by its own dimensions before it loads, so nothing shifts. */
function Shot({ change, shot, note, priority, onOpen }: { change: Change; shot: ScreenshotEvidence; note: string | null; priority?: boolean; onOpen: () => void }) {
  const label = `${VIEWPORT_LABEL[shot.viewport]} · ${shot.width}×${shot.height}${note ? ` · ${note}` : ''}`;
  return (
    <button type="button" className="shot" data-viewport={shot.viewport} onClick={onOpen} aria-label={`Enlarge ${shot.page}, ${label}`}>
      <span className="shot__frame" style={ratio(shot)}>
        <Picture change={change} shot={shot} className="shot__img" alt="" lazy priority={priority} />
      </span>
      <span className="shot__label">{label}</span>
    </button>
  );
}

/** A page with its screenshots side by side, desktop then phone, each column as wide as its picture is. */
function PageRow({ change, page, first, onOpen }: { change: Change; page: ProofPage; first?: boolean; onOpen: (shot: ScreenshotEvidence) => void }) {
  const sources = new Set(page.shots.map((shot) => shot.source));
  const shared = sources.size === 1 ? page.shots[0].source : null;
  const columns = { '--cols': page.shots.map((shot) => `${(shot.width / shot.height).toFixed(3)}fr`).join(' ') } as CSSProperties;
  return (
    <div className="proof__page">
      <div className="proof__page-head">
        <span className="mono proof__path">{page.page}</span>
        {shared ? <span className="proof__source">{SOURCE_LABEL[shared]}</span> : null}
      </div>
      <div className="proof__shots" data-single={page.shots.length === 1 ? page.shots[0].viewport : undefined} style={columns}>
        {page.shots.map((shot, index) => (
          <Shot key={shot.image} change={change} shot={shot} priority={first && index === 0} note={shared ? null : SOURCE_LABEL[shot.source]} onOpen={() => onOpen(shot)} />
        ))}
      </div>
    </div>
  );
}

/** A command's output. A failure's opens scrolled to its end, where the reason usually is. */
function Output({ text, tail }: { text: string; tail: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (tail && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [tail]);
  return (
    <pre ref={ref} className="proof__out">
      {text}
    </pre>
  );
}

/** One command: its state, the command, how long it took and where it ran. Output folds unless it failed. */
function CommandRow({ command }: { command: CommandEvidence }) {
  const state = commandState(command);
  const output = command.output.trim();
  const line = (
    <>
      <CheckStateIcon state={state} label="" size={15} />
      <span className="mono proof__command">{command.command}</span>
      <span className="proof__facts">
        {command.durationMs !== undefined ? <span>{duration(command.durationMs)}</span> : null}
        <span>{SOURCE_LABEL[command.source]}</span>
        {state === 'failed' ? <span className="proof__exit">exit {command.exitCode}</span> : null}
      </span>
    </>
  );
  if (!output) {
    return (
      <li className="proof__cmd" data-state={state}>
        {line}
      </li>
    );
  }
  return (
    <li className="proof__cmd proof__cmd--fold" data-state={state}>
      <details className="proof__fold" open={state === 'failed' || undefined}>
        <summary className="proof__cmd-line">
          {line}
          <CaretDownIcon size={12} weight="bold" className="proof__caret" aria-hidden="true" />
        </summary>
        <Output text={output} tail={state === 'failed'} />
      </details>
    </li>
  );
}

/** An earlier revision's commands, folded under what they added up to. Its screenshots open from the current ones. */
function Earlier({ proof }: { proof: RevisionProof }) {
  const { label } = proofLabel({ ...proof, pages: [] });
  return (
    <Collapsible.Root className="proof__earlier">
      <DisclosureTrigger small>{pushLabel(proof.revision)} · {label}</DisclosureTrigger>
      <Collapsible.Panel className="disclosure__panel">
        <ul className="proof__commands proof__commands--earlier">
          {proof.commands.map((command, index) => (
            <CommandRow key={index} command={command} />
          ))}
        </ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * One screenshot enlarged. Arrow keys and the buttons move through the current version's
 * screenshots; where an earlier revision has the same page at the same size, it is offered beside it.
 */
function Lightbox({ change, shots, index, onClose }: { change: Change; shots: ScreenshotEvidence[]; index: number; onClose: () => void }) {
  const [at, setAt] = useState(index);
  const shot = shots[at];
  const versions = (change.evidence ?? [])
    .filter((item): item is ScreenshotEvidence => item.kind === 'screenshot' && item.page === shot.page && item.viewport === shot.viewport)
    .sort((a, b) => a.revision - b.revision);
  const [revision, setRevision] = useState(shot.revision);
  const shown = versions.find((item) => item.revision === revision) ?? shot;
  const move = (step: number) => {
    const next = (at + step + shots.length) % shots.length;
    setAt(next);
    setRevision(shots[next].revision);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    };
    // Captured: the dialog's focus management stops the keys that reach its popup.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog size="xl" className="dialog lightbox">
        <div className="dialog__head">
          <Dialog.Title className="dialog__title lightbox__title">
            <span className="mono">{shot.page}</span>
            <span className="lightbox__facts">
              {VIEWPORT_LABEL[shown.viewport]} · {shown.width}×{shown.height} · {SOURCE_LABEL[shown.source]}
            </span>
          </Dialog.Title>
          <span className="lightbox__nav">
            {shots.length > 1 ? (
              <>
                <Button size="sm" variant="ghost" shape="square" icon={CaretLeftIcon} aria-label="Previous screenshot" onClick={() => move(-1)} />
                <span className="lightbox__count">
                  {at + 1} / {shots.length}
                </span>
                <Button size="sm" variant="ghost" shape="square" icon={CaretRightIcon} aria-label="Next screenshot" onClick={() => move(1)} />
              </>
            ) : null}
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="Close" />} />
          </span>
        </div>
        {versions.length > 1 ? (
          <Tabs
            size="sm"
            variant="segmented"
            className="lightbox__revisions"
            aria-label="Push"
            value={String(revision)}
            onValueChange={(value) => setRevision(Number(value))}
            tabs={versions.map((item) => ({ value: String(item.revision), label: pushLabel(item.revision) }))}
          />
        ) : null}
        <div className="lightbox__frame" style={ratio(shown)}>
          <Picture key={shown.image} change={change} shot={shown} className="lightbox__img" alt={`${shot.page} at ${VIEWPORT_LABEL[shown.viewport].toLowerCase()} size`} />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

export function Proof({ change }: { change: Change }) {
  const proof = proofOf(change.evidence, change.revision);
  const earlier = earlierRevisions(change.evidence, change.revision)
    .map((revision) => proofOf(change.evidence, revision)!)
    .filter((item) => item.commands.length);
  const [open, setOpen] = useState<number | null>(null);
  if (!proof && !earlier.length) return null;
  const shots = proof?.pages.flatMap((page) => page.shots) ?? [];
  // Start the first visible screenshot during render, before lazy-image layout would discover it.
  if (shots[0]) preload(changes.evidenceImageUrl(change.id, shots[0].image), { as: 'image', fetchPriority: 'high' });
  return (
    <section className="proof" aria-label="Proof">
      <h2 className="proof__title">Proof</h2>
      {proof?.pages.map((page, index) => (
        <PageRow key={page.page} change={change} page={page} first={index === 0} onOpen={(shot) => setOpen(shots.indexOf(shot))} />
      ))}
      {proof?.commands.length ? (
        <ul className="proof__commands">
          {proof.commands.map((command, index) => (
            <CommandRow key={index} command={command} />
          ))}
        </ul>
      ) : null}
      {earlier.map((item) => (
        <Earlier key={item.revision} proof={item} />
      ))}
      {open !== null ? <Lightbox key={open} change={change} shots={shots} index={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}
