import { useRef } from 'react';
import { useDocumentTitle } from '../lib/title';
import { EXAMPLE_ADDRESS, paths } from '../lib/router';
import { LandingHeader } from '../components/shell/LandingHeader';
import { Mark } from '../components/shell/Mark';
import { RouterLink } from '../components/ui/Link';
import { AppShot } from '../components/landing/AppShot';
import { Close } from '../components/landing/Close';
import { LandingArt } from '../components/landing/LandingArt';
import { Overlap } from '../components/landing/Overlap';
import { Prompt } from '../components/landing/Prompt';
import { Proof } from '../components/landing/Proof';
import { QueueScene } from '../components/landing/Queue';
import { Scale } from '../components/landing/Scale';
import { Terminal } from '../components/landing/Terminal';
import { Ways } from '../components/landing/Ways';
import { EASE, gsap, onEnter, revealOnFocus, riseLines, useMotion } from '../components/landing/motion';
import '../styles/landing.css';

/** The agents whose commits Braid recognizes without any setup, from the attribution corpus in docs/VERIFICATION.md. */
const RECOGNIZED = ['Claude Code', 'Codex', 'Copilot', 'Cursor', 'Devin', 'Jules', 'Aider', 'Gemini CLI'];

/*
 * The landing page, for anyone not signed in: the claim and the prompt that sets Braid up, over a working copy of
 * Braid on the tour repository; then one moment per feature, a line over one large picture that plays as it comes
 * into view; the ways in; and the close, where the tour's agents braid into one main. Everything renders in its
 * final state; motion only plays it in.
 */
export function LandingScreen() {
  useDocumentTitle('Braid');
  const tour = paths.repo(EXAMPLE_ADDRESS);
  const root = useRef<HTMLDivElement>(null);
  useMotion(root, () => {
    revealOnFocus(root.current!);
    riseLines(root.current!.querySelector('.lp-hero__title')!, { delay: 0.05 });
    // The prompt fades with opacity alone, so its button stays in the Tab order while it plays in.
    gsap.from('.lp-hero__eyebrow', { opacity: 0, y: 8, duration: 0.8, ease: EASE });
    gsap.from('.lp-hero .lp-prompt-slot', { opacity: 0, y: 12, duration: 0.8, ease: EASE, delay: 0.35 });
    gsap.from('.lp-agents__label, .lp-agents__list li', { autoAlpha: 0, y: 10, duration: 0.6, ease: EASE, stagger: 0.04, scrollTrigger: onEnter('.lp-agents', 'top 92%') });
    for (const say of gsap.utils.toArray<HTMLElement>('.lp-sec .lp-say, .lp-ways .lp-say')) riseLines(say, { delay: 0.05, scrollTrigger: onEnter(say, 'top 85%') });
  });
  return (
    <div ref={root} className="landing">
      <LandingArt />
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <LandingHeader />
      <main id="main" className="lp" tabIndex={-1}>
        <section className="lp-hero" data-breath="hero" aria-labelledby="lp-title">
          <p className="lp-hero__eyebrow">The Git platform for agent fleets</p>
          <h1 id="lp-title" className="lp-hero__title">
            Give your agents room to breathe.
          </h1>
          <Prompt />
        </section>

        <section className="lp-demo" data-breath="demo">
          <div className="lp-hero__shot">
            <AppShot />
          </div>
          <div className="lp-agents">
            <p className="lp-agents__label">Recognizes commits from</p>
            <ul className="lp-agents__list">
              {RECOGNIZED.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="lp-sec" data-breath="features" aria-labelledby="lp-who">
          <h2 id="lp-who" className="lp-say">
            Your repository has more authors than your team.
          </h2>
          <Terminal />
        </section>

        <section className="lp-sec lp-sec--wide" data-breath="queue" aria-labelledby="lp-main">
          <QueueScene>
            <h2 id="lp-main" className="lp-say">
              A hundred agents can share one main.
            </h2>
          </QueueScene>
          <Scale />
        </section>

        <section className="lp-sec lp-sec--wide" data-breath="proof" aria-labelledby="lp-proof">
          <h2 id="lp-proof" className="lp-say">
            Agents show their work. Braid checks it again.
          </h2>
          <Proof />
        </section>

        <section className="lp-sec lp-sec--wide" data-breath="choice" aria-labelledby="lp-choice">
          <h2 id="lp-choice" className="lp-say">
            Two agents, one file, one choice.
          </h2>
          <Overlap />
        </section>

        <section className="lp-ways" data-breath="ways" aria-labelledby="lp-ways">
          <h2 id="lp-ways" className="lp-say">
            Bring the agents you already run.
          </h2>
          <Ways />
        </section>

        <Close />

        <footer className="lp-foot">
          <RouterLink href={paths.site()} className="brand" aria-label="Braid">
            <Mark />
            <span className="brand__name">Braid</span>
          </RouterLink>
          <nav className="lp-foot__links" aria-label="Footer">
            <RouterLink href={tour}>Tour</RouterLink>
            <RouterLink href={paths.explore()}>Explore</RouterLink>
            <a href="/setup.md">Docs</a>
            <a href="/llms.txt">llms.txt</a>
            <a href="/source/braid-source.zip">Source (MIT)</a>
          </nav>
          <p className="lp-foot__note">Built on Cloudflare</p>
        </footer>
      </main>
    </div>
  );
}
