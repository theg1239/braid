import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FileBlame } from '../../../shared/types';
import { BlameView } from './blame';

const result = vi.hoisted(() => ({ blame: null as FileBlame | null, error: null as string | null, lineHeight: 20 }));
vi.mock('./line-height', () => ({ useSourceLineHeight: () => result.lineHeight }));
vi.mock('../../lib/resources', () => ({ useBlame: () => ({ blame: result.blame, error: result.error, retry: () => {} }) }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-10T12:00:00Z') }));
vi.mock('../../lib/router', () => ({ useRoute: () => ({ hash: '#L24' }), paths: { pull: (number: number) => `/pull/${number}`, task: (id: string) => `/agents/${id}` } }));
vi.mock('./index', () => ({ CodeLoading: () => <div>Loading</div> }));
vi.mock('../ui/Link', () => ({ RouterLink: () => <a /> }));

describe('Blame rendering', () => {
  it('groups reconciled human runs once and renders an inferred agent for @owner', () => {
    result.error = null; result.lineHeight = 20;
    const person = { name: '@theg1239' };
    result.blame = { path: 'README.md', ref: 'a'.repeat(40), lines: 5, ranges: [
      { start: 1, lines: 2, provenance: { commit: 'a'.repeat(40), at: '2026-10-09T12:00:00Z', subject: 'Start', kind: 'human', owner: person, confidence: 'inferred' } },
      { start: 3, lines: 1, provenance: { commit: 'b'.repeat(40), at: '2026-10-09T12:00:00Z', subject: 'Docs', kind: 'human', owner: person, confidence: 'inferred' } },
      { start: 4, lines: 2, provenance: { commit: 'c'.repeat(40), at: '2026-10-09T12:00:00Z', subject: 'Agent docs', kind: 'agent', agent: { name: 'Codex' }, owner: person, confidence: 'inferred' } },
    ] };
    const html = renderToStaticMarkup(<BlameView path="README.md" head={result.blame.ref} content={'one\ntwo\nthree\nfour\nfive\n'} />);
    expect(html).toContain('for @theg1239');
    expect(html.match(/class="blame__share"/g)).toHaveLength(2);
    expect(html).toContain('3 lines'); expect(html).toContain('2 lines');
  });
  it.each([20, 32])('bounds a large attribution range at a %i px line height', (lineHeight) => {
    result.lineHeight = lineHeight;
    result.blame = { path: 'big.txt', ref: 'a'.repeat(40), lines: 20_000, ranges: [{ start: 1, lines: 20_000,
      provenance: { commit: 'a'.repeat(40), at: '2026-10-09T12:00:00Z', subject: 'Start', kind: 'agent', agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' }, owner: { name: 'Ishaan', github: 'theg1239' }, confidence: 'inferred' } }] };
    const html = renderToStaticMarkup(<BlameView path="big.txt" head={result.blame.ref} content={Array.from({ length: 20_000 }, (_, i) => `line ${i + 1}\n`).join('')} />);
    expect((html.match(/class="blame__line"/g) ?? []).length).toBeLessThan(100);
    expect(html).toContain(`height:${20_000 * lineHeight}px`);
    expect(html).toContain('for @theg1239');
    if (lineHeight === 20) {
      expect(html).toContain('id="L24" data-selected="true"');
      expect(html).toContain('href="#L24" aria-label="Line 24"');
    }
  });
  it('shows loading and retry for cold public blame instead of not found', () => {
    result.blame = null;
    expect(renderToStaticMarkup(<BlameView path="README.md" head={'a'.repeat(40)} content="# Relay" />)).toContain('Loading');
    result.error = 'This repository is preparing public content. Retry shortly.';
    const html = renderToStaticMarkup(<BlameView path="README.md" head={'a'.repeat(40)} content="# Relay" />);
    expect(html).toContain(result.error);
    expect(html).toContain('Try again');
    expect(html.toLowerCase()).not.toContain('not found');
    result.error = null;
  });
  it.each([20, 32])('keeps every source line and its geometry when empty or coarse attribution resolves at %i px', lineHeight => {
    result.lineHeight = lineHeight; result.error = null;
    const provenance = { commit: 'a'.repeat(40), at: '2026-10-09T12:00:00Z', subject: 'Import', kind: 'human' as const, owner: { name: 'Alice' }, confidence: 'inferred' as const };
    const base = { path: 'README.md', ref: 'a'.repeat(40), lines: 5 };
    const render = (blame: FileBlame) => {
      result.blame = blame;
      return renderToStaticMarkup(<BlameView path={base.path} head={base.ref} content={'one\ntwo\nthree\nfour\nfive\n'} />);
    };
    const empty = render({ ...base, lines: 0, ranges: [], pending: true });
    const coarse = render({ ...base, ranges: [{ start: 1, lines: 5, provenance }], pending: true, note: 'Earlier lines while history loads.' });
    const complete = render({ ...base, ranges: Array.from({ length: 5 }, (_, index) => ({ start: index + 1, lines: 1, provenance })) });
    for (const html of [empty, coarse, complete]) {
      expect(html.match(/class="blame__line"/g)).toHaveLength(5);
      expect(html).toContain(`class="blame__body" style="height:${5 * lineHeight}px"`);
      expect(html).toContain('--chars:5;');
      expect(html).toContain('class="blame__sum" role="group" aria-label="File authors"');
      expect(html).not.toMatch(/Loading|history loads|spinner/);
    }
    expect(complete).toContain(`top:${4 * lineHeight}px`);
  });
});
