import { useRef } from 'react';
import { EASE, gsap, onEnter, typeOut, useMotion } from './motion';

/*
 * The three ways an agent reaches Braid, each with the commands that start it, typed as the cards come into view;
 * then the rest of what Braid does, one line each.
 */
const WAYS = [
  { name: 'Plain Git', code: ['git push braid HEAD:refs/for/main'] },
  { name: 'The braid CLI', code: ['braid agent run -- claude', 'braid submit'] },
  { name: 'MCP', code: ['tools/call create_pull_request', 'tools/call get_pull_request'] },
];

export function Ways() {
  const scope = useRef<HTMLDivElement>(null);
  useMotion(scope, () => {
    const tl = gsap.timeline({ scrollTrigger: onEnter(scope.current!, 'top 80%') });
    tl.from('.lp-way', { autoAlpha: 0, y: 24, duration: 0.8, ease: EASE, stagger: 0.1 }, 0);
    // Opacity alone, so the mirror's link stays in the Tab order while it plays in.
    tl.from('.lp-ways__more li', { opacity: 0, y: 10, duration: 0.6, ease: EASE, stagger: 0.06 }, 0.5);
    gsap.utils.toArray<HTMLElement>('.lp-way').forEach((way, index) => {
      let at = 0.45 + index * 0.3;
      for (const line of way.querySelectorAll('.lp-way__cmd')) {
        tl.add(typeOut(line, 0.024), at);
        at += (line.textContent ?? '').length * 0.024 + 0.25;
      }
    });
  });
  return (
    <div ref={scope}>
    <ul className="lp-ways__grid">
      {WAYS.map(({ name, code }) => (
        <li key={name} className="lp-way">
          <h3 className="lp-way__name">{name}</h3>
          <code className="lp-way__code">
            {code.map((command) => (
              <span key={command} className="lp-way__cmd">
                {command}
              </span>
            ))}
          </code>
        </li>
      ))}
    </ul>
    <ul className="lp-ways__more">
      <li>
        <a href="/openai/codex">Mirror any GitHub repository</a> at the same address.
      </li>
      <li>
        <code>braid blame</code> reads who wrote each line in any clone.
      </li>
      <li>Hosted agents run in Cloudflare Containers.</li>
      <li>
        Provenance travels with each commit in <code>refs/notes/braid</code>.
      </li>
    </ul>
    </div>
  );
}
