import { renderToReadableStream } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSnapshot } from '../../../shared/types';
import { routeOf } from '../../lib/router';
import { RepositoryHeader } from './RepositoryHeader';

vi.hoisted(() => { vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', origin: 'https://braid.test' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() }); });
vi.mock('../../lib/router', async original => ({ ...await original<typeof import('../../lib/router')>(), useRoute: () => routeOf('/theg1239/lecrev/agents') }));
vi.mock('../../account/AccountProvider', () => ({ useAccount: () => ({ account: null, accounts: true, loading: false, error: null, signOut: vi.fn() }) }));
vi.mock('../../account/addresses', () => ({ useRepositoryAddress: () => ({ status: 'loading' }) }));
vi.mock('../../dashboard/inbox', () => ({ useInbox: () => ({ needsYou: 0 }) }));
vi.mock('../../lib/live', () => ({ useLive: () => ({ data: null }) }));
vi.mock('../../lib/prefetch', () => ({ canPrefetch: () => false, prefetchHref: vi.fn() }));
vi.mock('../../store/workspace', () => ({ canWrite: () => true }));

const snapshot = { project: { id: 'repo', name: 'lecrev' }, capabilities: {} } as WorkspaceSnapshot;
async function tabs(counts?: { open: number | null; tasks: number | null }) {
  const stream = await renderToReadableStream(<RepositoryHeader snapshot={snapshot} screen="agents" address={{ owner: 'theg1239', repo: 'lecrev' }} counts={counts} />);
  await stream.allReady;
  const html = await new Response(stream).text();
  return html.match(/<nav class="repo-head__tabs".*?<\/nav>/s)?.[0] ?? '';
}

describe('repository tab counts', () => {
  it('holds a count’s place only while it is unknown, and shows no hole for a known zero', async () => {
    const loading = await tabs();
    expect(loading.match(/class="repo-tab__count"[^>]*visibility:hidden/g)).toHaveLength(2);
    const known = await tabs({ open: 0, tasks: 3 });
    expect(known).not.toContain('visibility:hidden');
    expect(known.match(/class="repo-tab__count"/g)).toHaveLength(1);
    expect(known).toContain('>3</span>');
  });
});
