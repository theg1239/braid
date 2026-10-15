import { useRef, type ReactNode } from 'react';
import { useElementWidth } from '../../lib/hooks';
import { PULLS, STRANDS, type Pull } from './data';
import { gsap, ScrollTrigger, useMotion } from './motion';
import { Recorded } from './Recorded';

/*
 * The merge queue as a braid. The tour's agents send their pull requests in as strands that cross on the way, and
 * every strand meets the others at one knot, where it is combined with main and checked. One that passes becomes
 * main's next commit. #69 failed its tests there, peeled off red, and came back as a revision that passed. On tall
 * desktops scrolling plays it with the scene held in place; elsewhere it plays once. What renders is the final state.
 */

/** The pull requests drawn, in the order they entered the queue. */
const ORDER = ['#1', '#2', '#5', '#69', '#22', '#23'];
const PICKED: Pull[] = ORDER.map((label) => PULLS.find((pull) => pull.label === label)!);
/** The agents behind them, top to bottom in the order they first sent one. */
const AGENTS = [...new Set(PICKED.map((pull) => pull.strand))];
/** Every answer the queue gave, in order. */
const EVENTS = PICKED.flatMap((pull) => pull.attempts.map((attempt, index) => ({ pull, attempt, index }))).sort(
  (a, b) => a.attempt.at - b.attempt.at || ORDER.indexOf(a.pull.label) - ORDER.indexOf(b.pull.label),
);
const MERGES = EVENTS.filter((event) => event.attempt.outcome === 'merged');
/** The one that went back: its strand peels off at the knot and returns as a revision. */
const FAILED = EVENTS.find((event) => event.attempt.failed)!;

const RING = 15;

interface Point {
  x: number;
  y: number;
}

const r = (n: number) => Math.round(n * 10) / 10;
const pt = (p: Point) => `${r(p.x)},${r(p.y)}`;
const curve = (a: Point, b: Point, c: Point, d: Point) => `M${pt(a)} C${pt(b)} ${pt(c)} ${pt(d)}`;

/**
 * The scene's layout, worked out along the flow (toward main) and across it. A wide scene flows left to right; on a
 * phone it stands upright, the agents along the top and main running down, so nothing has to shrink.
 */
function geometry(width: number) {
  const upright = width < 560;
  const height = upright ? 470 : 340;
  const [length, across] = upright ? [height, width] : [width, height];
  const at = (along: number, side: number): Point => (upright ? { x: side, y: along } : { x: along, y: side });
  const start = upright ? 44 : 156;
  const knotAt = start + (length - start) * (upright ? 0.42 : 0.4);
  const mid = across / 2;
  const lanes = AGENTS.map((_, index) => across * (upright ? 0.2 + index * 0.3 : 0.16 + index * 0.34));
  const step = (length - knotAt - RING - (upright ? 44 : 64)) / Math.max(1, MERGES.length - 1);
  const commit = (index: number) => at(knotAt + RING + 30 + index * step, mid);
  /** A strand from its agent to the knot, swinging across the middle on the way so the strands cross. */
  const strand = (pull: Pull) => {
    const row = AGENTS.indexOf(pull.strand);
    const lane = lanes[row];
    const second = PICKED.filter((other) => other.strand === pull.strand).indexOf(pull);
    const span = knotAt - RING - start;
    const swing = (row === (AGENTS.length - 1) / 2 ? (second ? -1 : 1) * across * 0.3 : (mid - lane) * 1.8) * (second ? 0.78 : 1);
    return curve(at(start, lane), at(start + span * 0.38, lane + swing), at(start + span * 0.74, mid - swing * 0.32), at(knotAt - RING, mid));
  };
  // The failed pull request leaves the knot up and back, and its revision swoops back in behind it.
  const lift = upright ? 0.8 : 1;
  const [awayAt, awaySide] = [knotAt - 118 * lift, mid - 96 * lift];
  const away = at(awayAt, awaySide);
  const peel = curve(at(knotAt - RING * 0.7, mid - RING * 0.7), at(knotAt - 12, mid - 74 * lift), at(knotAt - 70 * lift, mid - 108 * lift), away);
  const revision = curve(away, at(awayAt - 52 * lift, awaySide + 18 * lift), at(knotAt - 96 * lift, mid), at(knotAt - RING, mid));
  return { upright, height, knot: at(knotAt, mid), mainFrom: at(knotAt + RING, mid), labels: lanes.map((lane) => at(start - 16, lane)), starts: lanes.map((lane) => at(start, lane)), commit, strand, peel, revision, away };
}

/** A circle drawn clockwise from the top, so a check can sweep around the knot. */
const arc = ({ x, y }: Point) => `M${r(x)},${r(y - RING)} A${RING},${RING} 0 1 1 ${r(x - 0.01)},${r(y - RING)}`;

function Scene({ width }: { width: number }) {
  const { upright, height, knot, mainFrom, labels, starts, commit, strand, peel, revision, away } = geometry(width);
  const head = commit(MERGES.length - 1);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${PICKED.length} pull requests from ${AGENTS.length} agents braiding into main through the merge queue. ${FAILED.pull.label} failed ${FAILED.attempt.failed}, came back as a revision and merged.`}
    >
      {AGENTS.map((strandIndex, index) => (
        <text key={strandIndex} className="lp-weave__who" x={r(labels[index].x)} y={r(labels[index].y + (upright ? 0 : 4))} textAnchor={upright ? 'middle' : 'end'}>
          {STRANDS[strandIndex].model}
        </text>
      ))}
      {PICKED.map((pull) => (
        <g key={pull.label} data-strand={pull.label}>
          <path className="lp-weave__gap" d={strand(pull)} />
          <path className="lp-weave__strand" d={strand(pull)} />
        </g>
      ))}
      {starts.map((point, index) => (
        <circle key={AGENTS[index]} className="lp-weave__agent" cx={r(point.x)} cy={r(point.y)} r={3.5} />
      ))}
      <path className="lp-weave__gap" data-peel="" d={peel} />
      <path className="lp-weave__peel" data-peel="" d={peel} />
      <path className="lp-weave__gap" data-revision="" d={revision} />
      <path className="lp-weave__strand" data-revision="" d={revision} />
      <text className="lp-weave__failed" data-failed="" x={r(away.x)} y={r(away.y - 10)} textAnchor="middle">
        {FAILED.attempt.failed} failed
      </text>
      <path className="lp-weave__main" d={`M${pt(mainFrom)} L${pt(head)}`} />
      {MERGES.map((event, index) => (
        <circle key={`${event.pull.label}-${event.index}`} className="lp-weave__commit" data-commit={index} cx={r(commit(index).x)} cy={r(commit(index).y)} r={4.5} />
      ))}
      <text className="lp-weave__head" data-head="" x={r(head.x + 12)} y={r(head.y + 4)}>
        main
      </text>
      <circle className="lp-weave__knot" cx={r(knot.x)} cy={r(knot.y)} r={RING} />
      {EVENTS.map((event, index) => (
        <path key={index} className="lp-weave__check" data-check={index} data-failed={event.attempt.failed ? '' : undefined} d={arc(knot)} />
      ))}
      <text className="lp-weave__queue" x={r(upright ? knot.x + RING + 10 : knot.x)} y={r(upright ? knot.y + 4 : knot.y + RING + 20)} textAnchor={upright ? 'start' : 'middle'}>
        merge queue
      </text>
    </svg>
  );
}

/** How far the reader scrolls while the scene is held. */
const HELD = 1100;

/** The merge queue as a braid, with the section's line (`children`) held in view above it. */
export function QueueScene({ children }: { children: ReactNode }) {
  const scope = useRef<HTMLDivElement>(null);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  useMotion(
    scope,
    ({ wide }) => {
      if (!width) return;
      const { upright, commit, mainFrom } = geometry(width);
      const axis = upright ? 'y' : 'x';
      const root = scope.current!;
      // Held in the middle of what the 64px header leaves of the window.
      const holdAt = () => Math.max(88, (window.innerHeight - root.offsetHeight) / 2 + 32);
      const tl = gsap.timeline({
        defaults: { ease: 'power2.inOut' },
        scrollTrigger: wide
          ? { trigger: root, start: 'top 70%', end: () => `+=${window.innerHeight * 0.7 - holdAt() + HELD}`, scrub: 0.6 }
          : { trigger: root.querySelector('.lp-weave'), start: 'top 75%', once: true },
      });
      if (wide) ScrollTrigger.create({ trigger: root, start: () => `top top+=${holdAt()}`, end: `+=${HELD}`, pin: true, refreshPriority: 1 });
      else tl.timeScale(1.7);

      // Main starts at the knot and grows a commit at a time, its name riding the newest one.
      const last = commit(MERGES.length - 1)[axis];
      const share = (index: number) => ((commit(index)[axis] - mainFrom[axis]) / (last - mainFrom[axis])) * 100;
      gsap.set('.lp-weave__main', { drawSVG: '0% 0%' });
      gsap.set('[data-head]', { autoAlpha: 0, [axis]: commit(0)[axis] - last });
      let time = 0.15;
      let merged = 0;
      for (const [index, { pull, attempt }] of EVENTS.entries()) {
        const back = index > 0 && EVENTS.slice(0, index).some((event) => event.pull === pull);
        const travel = back ? 0.7 : 0.95;
        tl.from(back ? '[data-revision]' : `[data-strand="${pull.label}"] path`, { drawSVG: '0%', duration: travel }, time);
        const at = time + travel;
        const check = `[data-check="${index}"]`;
        tl.fromTo(check, { drawSVG: '0%', autoAlpha: 1 }, { drawSVG: '100%', duration: 0.45, ease: 'none' }, at).to(check, { autoAlpha: 0, duration: 0.3 }, at + 0.7);
        if (attempt.outcome === 'merged') {
          tl.to('.lp-weave__main', { drawSVG: `0% ${share(merged)}%`, duration: 0.35 }, at + 0.45)
            .to('[data-head]', { autoAlpha: 1, [axis]: commit(merged)[axis] - last, duration: 0.35 }, at + 0.45)
            .from(`[data-commit="${merged}"]`, { autoAlpha: 0, scale: 0, transformOrigin: '50% 50%', duration: 0.3, ease: 'expo.out' }, at + 0.75);
          merged++;
          time = at + 0.5;
        } else {
          tl.from('[data-peel]', { drawSVG: '0%', duration: 0.65 }, at + 0.45).from('[data-failed]', { autoAlpha: 0, duration: 0.3 }, at + 0.95);
          time = at + 1.25;
        }
      }
      // The scene is built once its width is known, after the triggers further down: they must make room for the hold.
      if (wide) ScrollTrigger.refresh();
    },
    [width],
  );
  return (
    <div ref={scope} className="lp-queue__pin">
      {children}
      <figure className="lp-figure lp-weave-figure" aria-label="Recorded run of the tour repository's merge queue">
        <Recorded />
        <div ref={measure} className="lp-weave" style={{ height: geometry(width).height }}>
          {width > 0 ? <Scene width={width} /> : null}
        </div>
      </figure>
    </div>
  );
}
