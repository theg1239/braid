import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CodeIcon,
  FileIcon,
  FolderIcon,
  GearSixIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  RobotIcon,
} from '@phosphor-icons/react';
import { Mark } from '../shell/Mark';
import { COMMITS, CONFIDENCE, DELIVERY, DELIVERY_RUNS, OPEN_PULLS, PATHS, type Commit } from './data';
import { loadViews, type DemoView } from './demo/load';
import { highlight } from './highlight';
import { EASE, gsap, useMotion } from './motion';
import { Recorded } from './Recorded';

/*
 * Under the claim: a small, working Braid over the tour repository's recording. Code opens on src/delivery.ts with blame
 * on, drawn as the app draws it: each run of lines names the model or the person and whose agent it was, and one
 * run's commit is open in a card. Pointing at, focusing or clicking another run opens that one; the tree opens
 * every file of main. Pull requests, Agents and Settings open the app's other views from the same recording, loaded
 * once the page is idle. The window keeps one size whatever it shows, so nothing on the page moves.
 */

/** Code line height in pixels, so the card can sit beside its run. */
const LINE = 21;
/** Space above and below each run, as GitHub sets off blame hunks; it keeps every author button at least 24px tall. */
const RUN_PAD = 3;
/** The card's height, rounded up: its title keeps two lines and its facts four rows, so it never changes. */
const CARD_ROOM = 228;
/** The sticky header's height and a little room, kept clear when a chosen card is shown. */
const HEADER = 76;
/** The file the window opens on. */
const HOME = 'src/delivery.ts';

type Tab = DemoView['tab'];
const TABS: {
  tab: Tab;
  icon: typeof CodeIcon;
  label: string;
  count?: number;
}[] = [
  { tab: 'code', icon: CodeIcon, label: 'Code' },
  {
    tab: 'pulls',
    icon: GitPullRequestIcon,
    label: 'Pull requests',
    count: OPEN_PULLS,
  },
  { tab: 'agents', icon: RobotIcon, label: 'Agents', count: 1 },
  { tab: 'settings', icon: GearSixIcon, label: 'Settings' },
];

/* ---------- The tree: main's files, folders first, as GitHub lists them ---------- */

interface Entry {
  name: string;
  path: string;
  depth: number;
  folder: boolean;
}

/** Every folder and file under `prefix`, folders first; a closed folder's contents stay out. */
function entries(open: Set<string>, prefix = '', depth = 0): Entry[] {
  const below = PATHS.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
  const folders = [...new Set(below.filter((rest) => rest.includes('/')).map((rest) => rest.split('/')[0]))].sort();
  const files = below.filter((rest) => !rest.includes('/')).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  return [
    ...folders.flatMap((name) => {
      const path = `${prefix}${name}`;
      return [{ name, path, depth, folder: true }, ...(open.has(path) ? entries(open, `${path}/`, depth + 1) : [])];
    }),
    ...files.map((name) => ({
      name,
      path: `${prefix}${name}`,
      depth,
      folder: false,
    })),
  ];
}

/* ---------- Blame ---------- */

interface Run {
  start: number;
  lines: string[];
  commit: Commit;
  /** Where the run starts in the file view, in pixels. */
  top: number;
}

type Ranges = [start: number, lines: number, commit: string][];

/** A file's blame as the window lays it out, each run set off by its padding. */
function runsOf(lines: string[], ranges: Ranges, commits: Record<string, Commit>): Run[] {
  let top = 0;
  return ranges.map(([start, count, id]) => {
    const run = {
      start,
      lines: lines.slice(start - 1, start - 1 + count),
      commit: commits[id],
      top,
    };
    top += count * LINE + 2 * RUN_PAD;
    return run;
  });
}

const HOME_RUNS = runsOf(DELIVERY, DELIVERY_RUNS, COMMITS);

/** Where the card sits: beside its run, and never past the end of the file. */
function cardY(runs: Run[], index: number) {
  const end = runs.at(-1)!.top + runs.at(-1)!.lines.length * LINE + 2 * RUN_PAD;
  return Math.max(0, Math.min(runs[index].top + 6, end + 6 - CARD_ROOM));
}

/** The keys that move along a list, and where each one goes. */
const MOVES: Record<string, (index: number, count: number) => number> = {
  ArrowDown: (index, count) => Math.min(count - 1, index + 1),
  ArrowUp: (index) => Math.max(0, index - 1),
  Home: () => 0,
  End: (_, count) => count - 1,
};

/** Tabs run across, so the left and right arrows move along them. */
const TAB_KEYS: Record<string, (index: number, count: number) => number> = {
  ArrowRight: MOVES.ArrowDown,
  ArrowLeft: MOVES.ArrowUp,
  Home: MOVES.Home,
  End: MOVES.End,
};

/** The arrow keys, Home and End move focus along `buttons`, which are one stop in the Tab order. */
function roving(event: KeyboardEvent<HTMLElement>, index: number, buttons: (HTMLElement | null)[], keys = MOVES) {
  const to = keys[event.key]?.(index, buttons.length);
  if (to === undefined) return;
  event.preventDefault();
  buttons[to]?.focus();
}

const writer = (commit: Commit) => commit.model ?? commit.owner;

function Card({ commit }: { commit: Commit }) {
  return (
    <>
      <p className="lp-card__kicker">
        {commit.pull ? <GitMergeIcon size={14} weight="bold" className="lp-card__merged" aria-hidden="true" /> : <GitCommitIcon size={14} weight="bold" aria-hidden="true" />}
        {commit.pull ? `Pull request #${commit.pull}` : 'Commit'} <span className="mono">{commit.hash}</span>
      </p>
      <p className="lp-card__title">{commit.subject}</p>
      <dl className="lp-card__facts" data-person={commit.model ? undefined : ''}>
        {commit.model ? (
          <div>
            <dt>Model</dt>
            <dd>{commit.model}</dd>
          </div>
        ) : null}
        <div className="lp-card__owner">
          <dt>{commit.model ? 'Owner' : 'Author'}</dt>
          <dd>{commit.owner}</dd>
        </div>
        {commit.tool ? (
          <div className="lp-card__tool">
            <dt>Tool</dt>
            <dd className="mono">{commit.tool}</dd>
          </div>
        ) : null}
        <div className="lp-card__confidence">
          <dt>Confidence</dt>
          <dd>
            <CheckCircleIcon
              size={14}
              weight={commit.confidence === 'braid' ? 'fill' : 'regular'}
              className="lp-card__ok"
              data-weak={commit.confidence === 'inferred' || undefined}
              aria-hidden="true"
            />
            {CONFIDENCE[commit.confidence]}
          </dd>
        </div>
      </dl>
    </>
  );
}

/** Code is highlighted as TypeScript; prose and markup stay plain. */
const highlighted = (path: string) => /\.(ts|json)$/.test(path);

function Line({ text, number, path }: { text: string; number: number; path: string }) {
  return (
    <li>
      <span className="lp-run__n" aria-hidden="true">
        {number}
      </span>
      <code>
        {highlighted(path)
          ? highlight(text).map(([kind, part], i) =>
              kind === 'plain' ? (
                part
              ) : (
                <span key={i} className={`tk-${kind}`}>
                  {part}
                </span>
              ),
            )
          : text}
      </code>
    </li>
  );
}

/** Who opened the card: scrolling past, which is not announced; pointing, which is; or choosing, which also scrolls the page just enough to show it. */
type By = 'scroll' | 'point' | 'choose';

/**
 * One file with blame on: each run's author is a button, and the card beside the runs shows the open run's commit.
 * `open` and `by` belong to the window, so scrolling past can step through the first file's runs.
 */
function Blame({ path, runs, mode, open, by, setOpen }: { path: string; runs: Run[]; mode: 'blame' | 'code'; open: number; by: By; setOpen: (open: number, by: By) => void }) {
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const y = cardY(runs, open);
  // A chosen card shows below the sticky header: inside the file, which scrolls to it, and on the page, which scrolls
  // just enough. On a phone the card has its own row under the file.
  useEffect(() => {
    if (by !== 'choose') return;
    const box = card.current!;
    const glides = !window.matchMedia('(max-width: 760px)').matches;
    const file = body.current!;
    if (glides && (y < file.scrollTop || y + CARD_ROOM > file.scrollTop + file.clientHeight)) file.scrollTop = Math.max(0, y - 12);
    const rect = box.getBoundingClientRect();
    const shift = rect.top < HEADER ? rect.top - HEADER : rect.bottom > window.innerHeight - 8 ? rect.bottom - window.innerHeight + 16 : 0;
    if (shift)
      window.scrollBy({
        top: shift,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
  }, [open, by, y]);
  const choose = (index: number) => setOpen(index, 'choose');
  return (
    <div className="lp-shot__view" data-mode={mode}>
      <div
        ref={body}
        className="lp-shot__body"
        role="toolbar"
        aria-orientation="vertical"
        aria-label={`Who wrote each run of lines in ${path}`}
        onScroll={(event) => card.current?.style.setProperty('--scroll', `${event.currentTarget.scrollTop}px`)}
      >
        {runs.map((item, index) => (
          <div key={item.start} className="lp-run" data-on={(mode === 'blame' && index === open) || undefined} onPointerEnter={() => mode === 'blame' && setOpen(index, 'point')}>
            <button
              ref={(node) => {
                buttons.current[index] = node;
              }}
              type="button"
              className="lp-run__who"
              aria-pressed={index === open}
              tabIndex={mode === 'blame' && index === open ? 0 : -1}
              onFocus={() => choose(index)}
              onClick={() => choose(index)}
              onKeyDown={(event) => roving(event, index, buttons.current)}
            >
              <span className="lp-run__name" data-person={item.commit.model ? undefined : ''}>
                {writer(item.commit)}
              </span>{' '}
              {item.commit.model ? <span className="lp-run__owner">for {item.commit.owner}</span> : null}
            </button>
            <ol className="lp-run__code" start={item.start}>
              {item.lines.map((line, offset) => (
                <Line key={offset} text={line} number={item.start + offset} path={path} />
              ))}
            </ol>
          </div>
        ))}
      </div>
      <div ref={card} className="lp-card" style={{ '--card-y': `${y}px` } as CSSProperties}>
        <div className="lp-card__box" aria-live={by === 'scroll' ? 'off' : 'polite'}>
          <div key={`${path}:${runs[open].start}`} className="lp-card__content">
            <Card commit={runs[open].commit} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Space for a file, a view or rows that are still on their way: the layout they will take, without words. */
export function Skeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div className="lp-skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} style={{ width: `${38 + ((index * 37) % 52)}%` }} />
      ))}
    </div>
  );
}

/** The other views and every file's rows, once they have loaded. */
function useViews() {
  const [module, setModule] = useState<Awaited<ReturnType<typeof loadViews>> | null>(null);
  useEffect(() => {
    let live = true;
    // Fetched on the first idle moment, so a tab or a file opens at once and the hero never waits for them.
    const fetch = () => void loadViews().then((loaded) => live && setModule(() => loaded));
    const handle = 'requestIdleCallback' in window ? requestIdleCallback(fetch, { timeout: 2500 }) : setTimeout(fetch, 1200);
    return () => {
      live = false;
      if ('requestIdleCallback' in window) cancelIdleCallback(handle as number);
      else clearTimeout(handle);
    };
  }, []);
  return module;
}

const Pulls = lazy(() => loadViews().then((module) => ({ default: module.PullsView })));
const Agents = lazy(() => loadViews().then((module) => ({ default: module.AgentsView })));
const Settings = lazy(() => loadViews().then((module) => ({ default: module.SettingsView })));

function Panel({ tab, children, flush }: { tab: Tab; children: ReactNode; flush?: boolean }) {
  return (
    <div id={`lp-panel-${tab}`} className="lp-shot__panel" data-flush={flush || undefined} role="tabpanel" aria-labelledby={`lp-tab-${tab}`} tabIndex={flush ? undefined : 0}>
      {children}
    </div>
  );
}

export function AppShot() {
  const [view, setView] = useState<DemoView>({ tab: 'code', file: HOME });
  const [mode, setMode] = useState<'blame' | 'code'>('blame');
  const [{ open, by }, setRun] = useState<{ open: number; by: By }>({
    open: 0,
    by: 'scroll',
  });
  const [folders, setFolders] = useState(() => new Set(['src']));
  const scope = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const files = useRef<(HTMLButtonElement | null)[]>([]);
  const views = useViews();
  const file = view.tab === 'code' ? (view.file ?? HOME) : HOME;
  const runs = useMemo(() => (file === HOME ? HOME_RUNS : views ? runsOf(views.FILES[file], views.BLAME[file], views.COMMITS) : null), [file, views]);
  const tree = useMemo(() => entries(folders), [folders]);
  const [focusedFile, setFocusedFile] = useState(0);
  useMotion(scope, () => {
    gsap
      .timeline({ delay: 0.45, defaults: { ease: EASE } })
      .from(scope.current, { autoAlpha: 0, y: 56, duration: 1.2 }, 0)
      .from('.lp-shot__repo > *, .lp-shot__tabs [role="tab"], .lp-shot__branch, .lp-shot__tree li', { autoAlpha: 0, x: -8, duration: 0.6, stagger: 0.022 }, 0.3)
      .from('.lp-shot__bar > *', { autoAlpha: 0, duration: 0.5, stagger: 0.06 }, 0.45)
      .from('.lp-run__code li', { autoAlpha: 0, x: -6, duration: 0.5, stagger: 0.014 }, 0.5)
      .from('.lp-run__who > *', { autoAlpha: 0, x: -10, duration: 0.6, stagger: 0.07 }, 0.75)
      .from(
        '.lp-card__box',
        {
          autoAlpha: 0,
          y: 16,
          scale: 0.97,
          transformOrigin: '50% 0%',
          duration: 0.9,
        },
        1.25,
      )
      .from('.lp-card__facts > div', { autoAlpha: 0, y: 6, duration: 0.5, stagger: 0.07 }, 1.45);
  });

  function show(next: DemoView) {
    setView(next);
    if (next.tab === 'code') {
      setRun({ open: 0, by: 'point' });
      setMode('blame');
      const path = next.file ?? HOME;
      setFolders((current) => {
        const parents = path
          .split('/')
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join('/'));
        return parents.every((parent) => current.has(parent)) ? current : new Set([...current, ...parents]);
      });
    }
  }

  // A view opened inside a tab, such as one pull request from the list, starts at its top.
  useLayoutEffect(() => {
    const panel = scope.current!.querySelector('.lp-shot__panel:not([data-flush])');
    if (panel) panel.scrollTop = 0;
  }, [view]);

  // The tree keeps one stop in the Tab order on the row last focused, which stays in the list as folders close.
  useLayoutEffect(() => setFocusedFile((index) => Math.min(index, tree.length - 1)), [tree.length]);

  function pick(entry: Entry, index: number) {
    setFocusedFile(index);
    if (!entry.folder) return show({ tab: 'code', file: entry.path });
    setFolders((current) => {
      const next = new Set(current);
      if (!next.delete(entry.path)) next.add(entry.path);
      return next;
    });
  }

  const crumbs = file.split('/');
  return (
    <div ref={scope} className="lp-shot" data-tab={view.tab} role="group" aria-label="Recorded run of the tour repository: a working copy of Braid" onPointerEnter={() => void loadViews()}>
      <div className="lp-shot__head">
        <div className="lp-shot__repo" aria-hidden="true">
          <Mark size={16} />
          <span className="lp-shot__slash">/</span>
          <span>acme</span>
          <span className="lp-shot__slash">/</span>
          <b>relay</b>
          <span className="lp-shot__public">Public</span>
          <Recorded />
        </div>
        <div className="lp-shot__tabs" role="tablist" aria-label="Repository">
          {TABS.map(({ tab, icon: Icon, label, count }, index) => (
            <button
              key={tab}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              id={`lp-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={view.tab === tab}
              aria-controls={view.tab === tab ? `lp-panel-${tab}` : undefined}
              tabIndex={view.tab === tab ? 0 : -1}
              onClick={() => show(tab === 'code' ? { tab, file } : { tab })}
              onKeyDown={(event) => {
                const to = TAB_KEYS[event.key]?.(index, TABS.length);
                if (to === undefined) return;
                event.preventDefault();
                tabs.current[to]?.focus();
                const next = TABS[to].tab;
                show(next === 'code' ? { tab: next, file } : { tab: next });
              }}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{label}</span>
              {count ? <span className="lp-shot__count">{count}</span> : null}
            </button>
          ))}
        </div>
      </div>
      {view.tab === 'code' ? (
        <Panel tab="code" flush>
          <aside className="lp-shot__side">
            <span className="lp-shot__branch" aria-hidden="true">
              <GitBranchIcon size={13} />
              main
              <CaretDownIcon size={11} />
            </span>
            <div role="toolbar" aria-orientation="vertical" aria-label="Files on main">
              <ul className="lp-shot__tree">
                {tree.map((entry, index) => (
                  <li key={entry.path} data-on={entry.path === file || undefined}>
                    <button
                      ref={(node) => {
                        files.current[index] = node;
                      }}
                      type="button"
                      style={{ paddingLeft: 10 + entry.depth * 16 }}
                      tabIndex={index === focusedFile ? 0 : -1}
                      aria-expanded={entry.folder ? folders.has(entry.path) : undefined}
                      aria-current={entry.path === file ? 'page' : undefined}
                      onClick={() => pick(entry, index)}
                      onFocus={() => setFocusedFile(index)}
                      onKeyDown={(event) => roving(event, index, files.current.slice(0, tree.length))}
                    >
                      {entry.folder ? folders.has(entry.path) ? <CaretDownIcon size={11} aria-hidden="true" /> : <CaretRightIcon size={11} aria-hidden="true" /> : <span className="lp-shot__caret" />}
                      {entry.folder ? <FolderIcon size={15} weight="fill" className="lp-shot__folder" aria-hidden="true" /> : <FileIcon size={15} aria-hidden="true" />}
                      <span>{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
          <div className="lp-shot__main">
            <div className="lp-shot__bar">
              <span className="lp-shot__crumb">
                {crumbs.slice(0, -1).map((part) => (
                  <span key={part}>
                    {part} <span aria-hidden="true">/</span>{' '}
                  </span>
                ))}
                <b>{crumbs.at(-1)}</b>
              </span>
              <select className="lp-shot__pick" aria-label="File" value={file} onChange={(event) => show({ tab: 'code', file: event.target.value })}>
                {PATHS.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
              <span className="lp-shot__seg" role="group" aria-label="View">
                {(['code', 'blame'] as const).map((each) => (
                  <button key={each} type="button" aria-pressed={mode === each} data-on={mode === each || undefined} onClick={() => setMode(each)}>
                    {each === 'code' ? 'Code' : 'Blame'}
                  </button>
                ))}
              </span>
              <span className="lp-shot__lines">{runs ? `${runs.reduce((sum, run) => sum + run.lines.length, 0)} lines` : null}</span>
            </div>
            {runs ? <Blame key={file} path={file} runs={runs} mode={mode} open={Math.min(open, runs.length - 1)} by={by} setOpen={(index, how) => setRun({ open: index, by: how })} /> : <Skeleton />}
          </div>
        </Panel>
      ) : (
        <Panel key={view.tab} tab={view.tab}>
          <Suspense fallback={<Skeleton />}>
            {view.tab === 'pulls' ? (
              <Pulls key={view.queue ? 'queue' : (view.pull ?? 'list')} pull={view.pull} checks={view.checks} queue={view.queue} show={show} />
            ) : view.tab === 'agents' ? (
              <Agents key={String(view.task)} task={view.task} show={show} />
            ) : (
              <Settings />
            )}
          </Suspense>
        </Panel>
      )}
    </div>
  );
}
