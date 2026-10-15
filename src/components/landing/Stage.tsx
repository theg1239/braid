import type { CSSProperties, ReactNode } from 'react';
import { highlight } from './highlight';

/*
 * The parts both drawn scenes are made of: a bounded stage centred on the page, so its main sits on the line the
 * background draws down the page's centre; agents as small rings in their own tint; strands that leave and enter
 * their nodes tangentially; the file as a pill; code in a small editor pane. Positions come from each scene's own
 * geometry, one for a wide stage and one for a phone's.
 */

/** Each agent's tint, used for its ring, its strand and its accents; main keeps the page's purple. */
export const TINT: Record<string, string> = {
  'Claude Opus 5.5': '#efe6d8',
  'GPT-6.1 Sol': '#93a5c1',
  'Claude Fable 5.1': '#b9abe9',
  main: '#a78bfa',
};

/** The widest a stage gets, centred on the page; narrower windows draw the phone's stage. */
export const WIDE = 880;
export const wideEnough = (width: number) => width >= WIDE;

export type Point = [x: number, y: number];

/** Leaves `a` straight down and arrives at `b` straight down. */
export const fall = ([ax, ay]: Point, [bx, by]: Point) => `M${ax},${ay} C${ax},${(ay + by) / 2} ${bx},${(ay + by) / 2} ${bx},${by}`;
/** Leaves `a` straight down and arrives at `b` level, from whichever side `b` is on. */
export const sweep = ([ax, ay]: Point, [bx, by]: Point) => `M${ax},${ay} C${ax},${ay + (by - ay) * 0.8} ${bx - (bx - ax) * 0.45},${by} ${bx},${by}`;

/** Where an HTML part of the stage sits: its box's left and top, or right, in stage pixels. */
export const at = (left: number | null, top: number, width?: number, right?: number): CSSProperties => ({
  ...(left === null ? { right } : { left }),
  top,
  ...(width ? { width } : {}),
});

/** A ring for an agent or a pull request, and a dot for main's commit. */
export function Ring({ at: [x, y], tint, label }: { at: Point; tint: string; label?: string }) {
  return <circle className="lp-stage__ring" data-node={label} cx={x} cy={y} r={3.5} style={{ stroke: tint }} />;
}

export function Commit({ at: [x, y] }: { at: Point }) {
  return <circle className="lp-stage__commit" cx={x} cy={y} r={5} style={{ fill: TINT.main }} />;
}

export function Strand({ d, tint, name }: { d: string; tint: string; name: string }) {
  return <path className="lp-stage__strand" data-strand={name} d={d} style={{ stroke: tint }} />;
}

/** An agent's name beside its ring: the model in white, whose agent it was muted. */
export function Agent({ model, owner, style, align = 'left' }: { model: string; owner: string; style: CSSProperties; align?: 'left' | 'right' }) {
  return (
    <p className="lp-stage__agent" data-align={align} style={style}>
      <b>{model}</b> for {owner}
    </p>
  );
}

/** One line of code in a small editor pane: the agent's tint, the model and the line number, then the line. */
export function Pane({ model, number, line, style, children, ...rest }: { model: string; number: number; line: string; style: CSSProperties; children?: ReactNode; 'data-lane'?: string; 'data-dim'?: string }) {
  return (
    <div className="lp-pane" style={style} {...rest}>
      <p className="lp-pane__head">
        <span className="lp-pane__dot" style={{ background: TINT[model] }} aria-hidden="true" />
        <b>{model}</b>
        <span>line {number}</span>
      </p>
      <p className="lp-pane__body">
        <span className="lp-pane__gutter" aria-hidden="true">
          +
        </span>
        <code>
          {highlight(line).map(([kind, text], index) =>
            kind === 'plain' ? (
              text
            ) : (
              <span key={index} className={`tk-${kind}`}>
                {text}
              </span>
            ),
          )}
        </code>
      </p>
      {children}
    </div>
  );
}
