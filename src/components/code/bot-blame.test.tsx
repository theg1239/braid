import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { FileBlame } from '../../../shared/types';
import { BlameView } from './blame';

const fixture = vi.hoisted(() => ({ blame: null as FileBlame | null }));
vi.mock('../../lib/resources', () => ({ useBlame: () => ({ blame: fixture.blame, error: null, retry: () => {} }) }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-13T12:00:00Z') }));
vi.mock('../../lib/router', () => ({ useRoute: () => ({ hash: '' }), paths: {} }));
vi.mock('./line-height', () => ({ useSourceLineHeight: () => 20 }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
// Render the open card as well as its trigger; real popover interaction is checked in the browser.
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>();
  const Children = ({ children }: { children: ReactNode }) => <>{children}</>;
  return { ...actual, Popover: Object.assign(Children, { Trigger: Children, Content: Children, Title: Children }) };
});

it('renders a bot by name in Blame, its summary and its open card without an owner or model label', () => {
  fixture.blame = { path: 'deps.txt', ref: 'a'.repeat(40), lines: 2, ranges: [{ start: 1, lines: 2, provenance: {
    commit: 'a'.repeat(40), at: '2026-10-13T10:00:00Z', subject: 'Bump dependencies', kind: 'bot',
    agent: { name: 'Dependabot', tool: 'dependabot[bot]' }, owner: { name: 'Example Owner', github: 'example-owner' }, confidence: 'inferred',
  } }] };
  const html = renderToStaticMarkup(<BlameView path="deps.txt" head={fixture.blame.ref} content={'one\ntwo\n'} />);
  expect(html).toContain('class="blame__share-name">Dependabot');
  expect(html).toContain('class="blame__name">Dependabot');
  expect(html).toContain('<dt>Bot</dt><dd>Dependabot</dd>');
  expect(html).toContain('dependabot[bot]');
  expect(html).toContain('Inferred from the commit');
  expect(html).not.toMatch(/<dt>Model|<dt>Owner|for @|example-owner/);
});
