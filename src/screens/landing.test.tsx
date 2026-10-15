import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import { LandingScreen } from './LandingScreen';

vi.mock('../lib/router', () => ({ EXAMPLE_ADDRESS: { owner: 'example', repo: 'relay' }, paths: { repo: (a: { owner: string; repo: string }) => `/${a.owner}/${a.repo}`, signin: () => '/signin', site: () => '/', explore: () => '/explore' } }));
vi.mock('../components/shell/LandingHeader', () => ({ LandingHeader: () => <header>Braid</header> }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => <a href={href} className={className}>{children}</a> }));
// Figures measured in the browser render at a desktop width.
vi.mock('../lib/hooks', async (original) => ({ ...(await original<typeof import('../lib/hooks')>()), useElementWidth: () => [() => {}, 1120] }));

const html = () => renderToStaticMarkup(<LandingScreen />);
const text = () => textOf(html());
const section = (id: string) => html().match(new RegExp(`<section[^>]*aria-labelledby="${id}"[\\s\\S]*?</section>`))![0];
const part = (breath: string) => html().match(new RegExp(`<section[^>]*data-breath="${breath}"[\\s\\S]*?</section>`))![0];
/** The demo, from its window to the end of its own markup. */
const demo = () => part('demo');

describe('The landing page', () => {
  it('starts with the claim and the Copy prompt pill, and leaves Get started to the header', () => {
    const hero = part('hero');
    expect(textOf(hero).trim()).toBe('The Git platform for agent fleets Give your agents room to breathe. Copy prompt Prompt copied!');
    expect(hero).toContain('<button type="button" class="lp-prompt"');
    // The pill shows four agents' marks, each decorative, and keeps one width for both of its labels.
    expect(hero.match(/<img [^>]*alt=""/g)).toHaveLength(4);
    expect(hero).toContain('<span class="lp-prompt__logos" aria-hidden="true">');
    for (const gone of ['Get started', 'Take the tour', 'See which agent wrote every line', 'Start at /llms.txt']) expect(text()).not.toContain(gone);
  });

  it('keeps each section to one line and its picture, with no numbers or captions', () => {
    const lines = [...html().matchAll(/<h2 id="[^"]+" class="lp-say">([^<]*)<\/h2>/g)].map((match) => match[1]);
    expect(lines).toEqual(['Your repository has more authors than your team.', 'A hundred agents can share one main.', 'Agents show their work. Braid checks it again.', 'Two agents, one file, one choice.', 'Bring the agents you already run.']);
    for (const line of lines) expect(line.split(' ').length).toBeLessThanOrEqual(9);
    expect(text()).not.toMatch(/\bfig\.|\b[1-4]\.0\b|Pull requests #36, #51 and #73/);
    expect(html()).not.toContain('lp-pillar');
  });

  it('keeps every part the background art keys to', () => {
    expect([...html().matchAll(/data-breath="([a-z]+)"/g)].map((match) => match[1])).toEqual(['hero', 'demo', 'features', 'queue', 'proof', 'choice', 'ways', 'close']);
  });

  it('links to the tour, the agents guide and the source from the footer', () => {
    const footer = html().match(/<footer[\s\S]*?<\/footer>/)![0];
    for (const href of ['/example/relay', '/explore', '/setup.md', '/llms.txt', '/source/braid-source.zip']) expect(footer).toContain(`href="${href}"`);
  });

  it('says only what is true, plainly', () => {
    const words = text();
    expect(words).not.toMatch(/\bland(?:s|ed|ing)?\b/);
    expect(words).not.toMatch(/[—–]|npx braid-git|supercharge|revolutioni|unleash|seamless|✨|10x|trusted by|AI agents/i);
    // The recorded repository is the tour; the page never calls it an example.
    expect(words).not.toMatch(/\bexample\b/i);
    // The pill's marks are decorative; the proof's screenshots say what they show; every image keeps its size.
    for (const image of html().match(/<img [^>]*>/g)!) {
      expect(image).toMatch(/ alt="[^"]*"/);
      expect(image).toMatch(/ width="\d+" height="\d+"/);
    }
  });

  it('labels each figure of the tour repository as recorded, once, and nothing as scripted or simulated', () => {
    const queue = section('lp-main');
    const recorded = { demo: demo(), queue: queue.slice(0, queue.indexOf('<figure class="lp-scale"')), proof: section('lp-proof'), choice: section('lp-choice') };
    for (const [name, markup] of Object.entries(recorded)) {
      expect(markup.match(/<span class="lp-rec">/g), name).toHaveLength(1);
      expect(markup, name).toMatch(/aria-label="Recorded run of the tour repository/);
    }
    expect(html().match(/<span class="lp-rec">/g)).toHaveLength(4);
    // The terminal is a real clone, not the recording, and the ways in are instructions.
    expect(section('lp-who')).not.toContain('lp-rec');
    expect(section('lp-ways')).not.toContain('lp-rec');
    expect(text()).not.toMatch(/\bScripted\b|\bSimulated\b/);
    // The hundred-agent comparison links to how it was made instead.
    expect(queue).toContain('<a class="lp-rec" href="/scale-evidence.txt">Method</a>');
  });

  it('opens the demo on Code, with blame on src/delivery.ts and the first run’s card', () => {
    const out = demo();
    expect(out).toContain('Sign webhook payloads with HMAC-SHA256');
    expect(out).toMatch(/aria-pressed="true"[^>]*><span class="lp-run__name">GPT-6.1 Sol/);
    expect(out).toMatch(/<button type="button" aria-pressed="true" data-on="true">Blame<\/button>/);
    expect(out).toContain('aria-current="page"');
    expect(textOf(out.match(/<button[^>]*aria-current="page"[^>]*>[\s\S]*?<\/button>/)![0]).trim()).toBe('delivery.ts');
  });

  it('makes the demo’s tabs a tablist, with one tab selected and one panel', () => {
    const out = demo();
    const tabs = [...out.matchAll(/<button id="lp-tab-(\w+)" type="button" role="tab" aria-selected="(true|false)"([^>]*)>([\s\S]*?)<\/button>/g)];
    expect(tabs.map((tab) => [tab[1], tab[2]])).toEqual([['code', 'true'], ['pulls', 'false'], ['agents', 'false'], ['settings', 'false']]);
    expect(tabs.map((tab) => textOf(tab[4]).trim())).toEqual(['Code', 'Pull requests 6', 'Agents 1', 'Settings']);
    // Only the selected tab names its panel, and only that tab is in the Tab order.
    expect(tabs.filter((tab) => tab[3].includes('aria-controls'))).toHaveLength(1);
    expect(tabs.filter((tab) => tab[3].includes('tabindex="0"'))).toHaveLength(1);
    expect(out).toContain('role="tablist" aria-label="Repository"');
    expect(out.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(out).toContain('id="lp-panel-code" class="lp-shot__panel" data-flush="true" role="tabpanel" aria-labelledby="lp-tab-code"');
  });

  it('lists main’s files in the tree, folders first, one stop in the Tab order', () => {
    const tree = demo().match(/<ul class="lp-shot__tree"[\s\S]*?<\/ul>/)![0];
    const rows = [...tree.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)];
    expect(rows.map(([, row]) => textOf(row).trim())).toEqual(['.braid', 'docs', 'public', 'src', 'billing', 'delivery.ts', 'endpoints.ts', 'index.ts', 'log.ts', 'signature.ts', 'test', 'AGENTS.md', 'CHANGELOG.md', 'package.json', 'README.md', 'tsconfig.json']);
    expect(rows.filter(([row]) => row.includes('tabindex="0"'))).toHaveLength(1);
    // The simulator's folder stays out of the tree, as its load stays out of the fleet.
    expect(tree).not.toContain('swarm');
  });

  it('makes the demo’s authors one stop in the Tab order, each named as it reads', () => {
    const buttons = [...demo().matchAll(/<button type="button" class="lp-run__who"[^>]*>([\s\S]*?)<\/button>/g)];
    expect(buttons).toHaveLength(10);
    expect(buttons.filter(([button]) => button.includes('tabindex="0"'))).toHaveLength(1);
    expect(buttons.filter(([button]) => button.includes('tabindex="-1"'))).toHaveLength(9);
    expect(textOf(buttons[0][1]).trim()).toBe('GPT-6.1 Sol for @devokafor');
    expect(demo()).toMatch(/class="lp-shot__body" role="toolbar" aria-orientation="vertical"/);
  });

  it('shows braid blame on a clone as the README prints it', () => {
    const words = textOf(section('lp-who'));
    expect(words).toContain('braid blame app/layout.tsx');
    expect(words).toMatch(/PostHog AI\s+2mo\s+import HydrationRecovery/);
  });

  it('assembles #23’s evidence: its screenshots in their frames, then each command on the pull request’s strand into main', () => {
    const proof = section('lp-proof');
    const words = textOf(proof);
    for (const part of ['/status.html', 'Add a delivery status page #23', 'Claude Fable 5.1 for @lena-park', 'main 687e5cc']) expect(words).toContain(part);
    // The screenshots are the agent's own, cropped to what they show, in a browser frame and a phone frame.
    expect(proof.match(/<div class="lp-device lp-device--(desktop|phone)"/g)).toHaveLength(2);
    expect(proof.match(/<img [^>]*width="\d+" height="\d+"/g)).toHaveLength(2);
    const runs = [...proof.matchAll(/<p class="lp-proof__run" data-where="(agent|braid)"[^>]*>([\s\S]*?)<\/p>/g)].map(([, where, row]) => [where, textOf(row).trim().replace(/&#x27;/g, "'")]);
    expect(runs).toEqual([
      ['agent', "npm test 10.0s agent's machine"],
      ['braid', 'npm ci 14.2s Braid'],
      ['braid', 'npm run typecheck 4.1s Braid'],
      ['braid', 'npm test 9.8s Braid'],
    ]);
    // One check on the strand per command, and the strand ends on main's commit.
    expect(proof.match(/class="lp-check"/g)).toHaveLength(4);
    expect(proof).toContain('data-strand="proof"');
    expect(proof).toContain('class="lp-stage__commit"');
  });

  it('tells two agents’ versions of one file as strands, and the owner’s choice by handle', () => {
    const overlap = section('lp-choice');
    const words = textOf(overlap);
    for (const part of ['Claude Opus 5.5 for @maya-chen', 'GPT-6.1 Sol for @maya-chen', 'src/limits.ts', 'line 17', 'line 19', '@maya-chen chooses this version', 'main']) expect(words).toContain(part);
    expect(words).toMatch(/setTimeout/);
    expect(words).toMatch(/throw new RateLimited/);
    // Each version is one line in an editor pane; the one not chosen is dimmed, never hidden.
    expect(overlap.match(/<div class="lp-pane"/g)).toHaveLength(2);
    expect(overlap).toMatch(/<div class="lp-pane" style="[^"]*" data-lane="other" data-dim="1"/);
    for (const strand of ['a1', 'b1', 'a2', 'b2', 'a3']) expect(overlap).toContain(`data-strand="${strand}"`);
    expect(overlap).not.toMatch(/<img\b|avatar/i);
  });

  it('braids the queue’s pull requests into main: six strands, six commits, one sent back and revised', () => {
    const queue = section('lp-main');
    for (const model of ['Claude Opus 5.5', 'Claude Fable 5.1', 'GPT-6.1 Sol']) expect(queue).toContain(`>${model}</text>`);
    expect(queue.match(/data-strand="#\d+"/g)).toEqual(['data-strand="#1"', 'data-strand="#2"', 'data-strand="#5"', 'data-strand="#69"', 'data-strand="#22"', 'data-strand="#23"']);
    expect(queue.match(/data-commit="\d"/g)).toHaveLength(6);
    expect(queue).toContain('>npm test failed</text>');
    expect(queue).toContain('>merge queue</text>');
    expect(queue).toContain('aria-label="6 pull requests from 3 agents braiding into main through the merge queue. #69 failed npm test, came back as a revision and merged."');
  });

  it('closes on every pull request the tour merged, braided into one main, and the pill again', () => {
    const close = section('lp-close');
    for (const author of ['Claude Opus 5.5', 'Claude Fable 5.1', 'Claude Sonnet 5.5', '@maya-chen', 'GPT-6.1 Sol', 'GPT-6 Astra']) expect(close).toContain(`>${author}</text>`);
    // Gemini 3 Pro's one pull request went back and never merged, so it has no strand; the background fleet is one unnamed bundle.
    expect(close).not.toContain('Gemini');
    expect(close).not.toMatch(/>Simulated</);
    expect(close.match(/data-merge="\d+"/g)).toHaveLength(47);
    expect(close.match(/data-simulated=""/g)).toHaveLength(37);
    expect(textOf(close)).toContain('One main.');
    expect(close).toContain('<button type="button" class="lp-prompt"');
  });

  it('names the three ways an agent connects with the commands that start each, then the rest in a line each', () => {
    const ways = section('lp-ways');
    const words = textOf(ways);
    for (const part of ['git push braid HEAD:refs/for/main', 'braid agent run -- claude', 'braid submit', 'create_pull_request']) expect(words).toContain(part);
    const more = [...ways.match(/<ul class="lp-ways__more">([\s\S]*?)<\/ul>/)![1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => textOf(match[1]).trim());
    expect(more).toEqual([
      'Mirror any GitHub repository at the same address.',
      'braid blame reads who wrote each line in any clone.',
      'Hosted agents run in Cloudflare Containers.',
      'Provenance travels with each commit in refs/notes/braid .',
    ]);
    expect(ways).toContain('<a href="/openai/codex">Mirror any GitHub repository</a>');
  });
});
