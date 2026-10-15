import { useRef } from 'react';
import { EASE, gsap, onEnter, typeOut, useMotion } from './motion';

/*
 * `braid blame` on a plain GitHub clone, as the README prints it: the founder's ExamCooker at 0b61f38, trimmed.
 * Nothing here went through Braid, so every agent is inferred from co-author lines and bot authors. The clone
 * and the blame are typed as the figure comes into view, and the output arrives line by line.
 */

const WIDTHS = [9, 17, 11, 14, 5];
const HEAD = ['Lines', 'Author', 'Owner', 'Pull request', 'Age', 'Code'];
const ROWS: string[][] = [
  ['1', '@theg1239', '', '', '5mo', 'import React, { Suspense } from "react";'],
  ['4', 'Copilot', '@theg1239', '', '5mo', 'import { Toaster } from "@/app/components/ui/toaster";'],
  ['8', 'PostHog AI', '', '', '2mo', 'import HydrationRecovery from "@/app/hydration-recovery";'],
  ['9', 'Cursor', '@theg1239', '', '2mo', 'import { hydrationRecoveryInitScript } from "@/app/hydration-re…'],
];
/** Rows written by people rather than agents, shown quieter. */
const PEOPLE = new Set(['@theg1239']);

const cell = (text: string, index: number) => (index < WIDTHS.length ? text.padEnd(WIDTHS[index]) : text);

export function Terminal() {
  const scope = useRef<HTMLElement>(null);
  useMotion(scope, () => {
    const [clone, blame] = gsap.utils.toArray<HTMLElement>('.lp-term__line');
    const tl = gsap.timeline({ scrollTrigger: onEnter(scope.current!, 'top 78%') });
    tl.from(clone, { autoAlpha: 0, duration: 0.01 }, 0.15)
      .add(typeOut(clone.querySelector('.lp-term__cmd')!, 0.012), 0.2)
      .from('.lp-term__out', { autoAlpha: 0, duration: 0.2 }, '>+0.1')
      .from(blame, { autoAlpha: 0, duration: 0.01 }, '>+0.15')
      .add(typeOut(blame.querySelector('.lp-term__cmd')!, 0.022), '>+0.05')
      .from('.lp-term__head, .lp-term__row', { autoAlpha: 0, duration: 0.35, ease: EASE, stagger: 0.07 }, '>+0.1');
  });
  return (
    <figure ref={scope} className="lp-figure">
      <div className="lp-term" role="group" aria-label="braid blame on a GitHub clone of ExamCooker">
        <div className="lp-term__bar">
          <span>zsh</span>
        </div>
        <pre className="lp-term__body" tabIndex={0} role="region" aria-label="Blame output for app/layout.tsx">
          <span className="lp-term__line">
            <span className="lp-term__prompt">~ $ </span>
            <span className="lp-term__cmd">git clone https://github.com/ACM-VIT/ExamCooker &amp;&amp; cd ExamCooker</span>
          </span>
          {'\n'}
          <span className="lp-term__out">Cloning into 'ExamCooker'...</span>
          {'\n'}
          <span className="lp-term__line">
            <span className="lp-term__prompt">~/ExamCooker $ </span>
            <span className="lp-term__cmd">braid blame app/layout.tsx</span>
          </span>
          {'\n'}
          <span className="lp-term__head">{HEAD.map(cell).join('')}</span>
          {ROWS.map((row) => (
            <span key={row[0]} className="lp-term__row" data-person={PEOPLE.has(row[1]) || undefined}>
              {'\n'}
              <span className="lp-term__n">{cell(row[0], 0)}</span>
              <span className="lp-term__who">{cell(row[1], 1)}</span>
              <span className="lp-term__owner">{cell(row[2], 2)}</span>
              {cell(row[3], 3)}
              <span className="lp-term__age">{cell(row[4], 4)}</span>
              <span className="lp-term__code">{row[5]}</span>
            </span>
          ))}
        </pre>
      </div>
    </figure>
  );
}
