import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { CommitPage } from '../../../shared/history';
import { absoluteTime } from '../../lib/format';
import { MirrorSource } from './MirrorSource';
import { MirrorCodeHeader } from './MirrorCodeHeader';
import { RepositoryHeader } from '../shell/RepositoryHeader';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { location: { pathname: '/openai/codex', search: '', hash: '', origin: 'https://braid.test' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() });
  return { history: undefined as CommitPage | undefined };
});
vi.mock('./mirror-history', () => ({ useMirrorHistory: () => ({ value: state.history, head: 'a'.repeat(40), error: null }) }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'codex', branch: 'main' } }) }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-14T10:07:00Z') }));
vi.mock('../shell/GlobalHeader', () => ({ GlobalHeader: ({ details, children }: { details: ReactNode; children: ReactNode }) => <header>{details}{children}</header> }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ children, ...props }: { children: ReactNode; href: string }) => <a {...props}>{children}</a> }));

const address = { owner: 'openai', repo: 'codex' };
const mirror = { source: 'https://github.com/openai/codex', syncedAt: '2026-10-14T10:00:00Z', importing: false, claimable: false };
beforeEach(() => { state.history = undefined; });

describe('mirror repository chrome', () => {
  it.each(['public', 'private'] as const)('identifies a %s mirror in its visibility badge', visibility => {
    const html = renderToStaticMarkup(<RepositoryHeader snapshot={null} screen="code" address={address} visibility={visibility} mirror={mirror} />);
    expect(html).toContain(`${visibility === 'public' ? 'Public' : 'Private'} mirror`);
  });

  it('keeps the source quiet and puts the absolute sync time only in the title', () => {
    const html = renderToStaticMarkup(<MirrorSource address={address} mirror={mirror} snapshot={null} />);
    expect(html).toContain(`href="${mirror.source}"`);
    expect(html).toContain(`title="Synced ${absoluteTime(mirror.syncedAt)}"`);
    expect(html.replace(/<[^>]+>/g, '').trim()).toBe('mirrored from github.com/openai/codex');
    expect(html).not.toMatch(/<svg|<time/);
  });

  it('uses the regular commit skeleton while history is pending', () => {
    const html = renderToStaticMarkup(<MirrorCodeHeader />);
    expect(html).toContain('loading-commit');
    expect(html).not.toContain('mirror-commit');
  });

  it('shows the latest attributed commit without adding a contributor strip to Code', () => {
    state.history = { ref: 'a'.repeat(40), path: '', nextCursor: null, items: [{ hash: 'a'.repeat(40), title: 'Keep file navigation stable', at: mirror.syncedAt, author: { kind: 'agent', id: 'codex', name: 'Codex' } }] };
    const html = renderToStaticMarkup(<MirrorCodeHeader />);
    expect(html).toContain('Keep file navigation stable');
    expect(html).toContain('Commits');
    expect(html).not.toMatch(/mirror-authorship|Last \d+ commits/);
  });
});
