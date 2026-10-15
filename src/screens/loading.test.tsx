import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeOf } from '../lib/router';
import { CodeScreen } from './CodeScreen';
import { LoadingShell } from '../components/ui/LoadingShell';
import { LoadingContent } from '../components/ui/LoadingContent';
import { ScreenSkeleton } from '../components/ui/ScreenSkeleton';
import { SkeletonRows } from '../components/ui/Skeleton';
import type { Account } from '../../shared/account';

const state = vi.hoisted(() => { vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', origin: 'https://braid.test' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() }); return ({ route: {} as ReturnType<typeof routeOf>, account: null as Account | null, tree: null as unknown, pending: false, latest: null as unknown, head: 'a'.repeat(40) }); });
vi.mock('../lib/router', async original => ({ ...await original<typeof import('../lib/router')>(), useRoute: () => state.route }));
vi.mock('../account/AccountProvider', () => ({ useAccount: () => ({ account: state.account, accounts: true, loading: !state.account, error: null }) }));
vi.mock('../account/RepositoryGate', () => ({ useRepository: () => ({ address: state.route.repo, scope: 'repo', visibility: 'public' }) }));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'repo', name: 'the-everything-assistant', branch: 'stable', head: state.head }, missions: [], files: {}, capabilities: { canWrite: false, mode: 'live' } }), canWrite: () => false }));
vi.mock('../lib/needs', () => ({ useHeaderCounts: () => ({ open: 0, tasks: 0, review: 0 }), LATEST_KEY: 'changes:list:latest', latestList: vi.fn() }));
vi.mock('../lib/live', () => ({ useLive: (key: string) => ({ data: key === 'changes:list:latest' ? state.latest : null, loading: true, error: null }) }));
vi.mock('../lib/hooks', () => ({ useNow: () => 0, useCopy: () => [null, vi.fn()] }));
vi.mock('../lib/resources', () => ({ useRepositoryTree: () => ({ tree: state.tree, pending: state.pending, error: null, more: vi.fn(), retry: vi.fn() }), useRepositoryFile: () => ({ result: { status: 'loading' }, pending: true, retry: vi.fn() }), knownDirectory: () => false, primeBlame: vi.fn(), primeTree: vi.fn() }));
vi.mock('../components/repo/ConnectButton', () => ({ ConnectButton: () => <button>Code</button> }));
vi.mock('../components/code/BranchMenu', () => ({ BranchMenu: ({ current }: { current: string }) => <button>{current}</button>, referenceLabel: (value: string) => value }));
vi.mock('../components/code/CodeSearch', () => ({ CodeSearch: () => <input aria-label="Search code" /> }));
vi.mock('../components/code', () => ({ isMarkdown: (path: string) => path.endsWith('.md'), FileView: () => null }));

/** Kumo's Loader is an SVG with role=status; the skeletons' status regions are elements that keep the layout. */
const SPINNER = /<svg[^>]*role="status"/;

beforeEach(() => { state.route = routeOf('/testtt/the-everything-assistant'); state.account = null; state.tree = null; state.pending = false; state.latest = null; state.head = 'a'.repeat(40); });

describe('loading frame', () => {
  it('renders the real repository address and all tabs before the account resolves', () => {
    const html = renderToStaticMarkup(<LoadingShell />);
    expect(html).toContain('>testtt</a>');
    expect(html).toContain('>the-everything-assistant</a>');
    for (const path of ['', '/pulls', '/agents', '/settings']) expect(html).toContain(`href="/testtt/the-everything-assistant${path}"`);
    for (const text of ['Go to file', 'Search code', 'Loading latest commit', 'Loading files', 'Loading README']) expect(html).toContain(text);
    expect(html).not.toMatch(SPINNER);
  });
  it('keeps one frame when a workspace or screen is still loading inside it', () => {
    expect(renderToStaticMarkup(<LoadingContent value={true}><LoadingShell /></LoadingContent>)).not.toContain('repo-head');
  });
  it('shows the recorded-example banner before the snapshot', () => {
    state.route = routeOf('/example/relay');
    expect(renderToStaticMarkup(<LoadingShell />)).toContain('Recorded example');
  });
  it('does not guess landing or dashboard while the account is pending', () => {
    state.route = routeOf('/');
    const html = renderToStaticMarkup(<LoadingShell />);
    expect(html).toContain('Loading account');
    expect(html).not.toContain('The Git platform');
    expect(html).not.toContain('Needs your review');
  });
  it('keeps a dashboard frame when the signed-in account is known and its screen is still loading', () => {
    state.route = routeOf('/');
    state.account = { user: { id: 'maya', name: 'Maya', email: 'maya@example.com' }, provider: 'github', signupEnabled: true, methods: { github: true, email: false, passkeys: false }, organizations: [{ id: 'acme', slug: 'acme', name: 'Acme', role: 'owner', workspaces: [{ id: 'relay', organizationId: 'acme', slug: 'relay', name: 'Relay', visibility: 'private', createdAt: '2026-10-14T10:00:00Z' }] }] };
    const html = renderToStaticMarkup(<ScreenSkeleton route={state.route} />);
    expect(html).toContain('Loading dashboard');
    expect(html).toContain('Loading inbox');
    expect(html).toContain('Repositories');
    expect(html).toContain('skeleton-line');
    expect(html).not.toMatch(SPINNER);
  });
  it.each(['/example/relay/blob/main/src/delivery.ts', '/example/relay/blame/main/src/delivery.ts', '/example/relay/tree/main/src', '/example/relay/commits/main', '/example/relay/commit/aaaaaaa', '/example/relay/branches', '/example/relay/compare/main...feature', '/example/relay/search?q=delivery', '/example/relay/pulls', '/example/relay/pull/23', '/example/relay/pull/23/checks', '/example/relay/pull/23/files', '/example/relay/agents', '/example/relay/tasks/task_1', '/example/relay/queue'])('has a route-shaped skeleton with no spinner: %s', href => {
    const html = renderToStaticMarkup(<ScreenSkeleton route={routeOf(href)} />);
    expect(html).toContain('skeleton-line');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(SPINNER);
  });
});

describe('Code reads', () => {
  it.each([false, true])('keeps skeleton rows before effects and throughout a slow read (pending=%s)', pending => {
    state.pending = pending;
    const html = renderToStaticMarkup(<CodeScreen />);
    expect(html).toContain('Loading files');
    expect(html).toContain('Loading README');
    expect(html).not.toMatch(SPINNER);
    expect(html).not.toContain('No files yet');
  });
  it('shows an empty repository after its snapshot confirms there is no commit', () => {
    state.head = '';
    const html = renderToStaticMarkup(<CodeScreen />);
    expect(html).toContain('the-everything-assistant is empty');
    expect(html).toContain('https://braid.test/git/repo.git');
    expect(html).toContain('git push -u braid HEAD:main');
    expect(html).toContain('Copy commands');
    expect(html).not.toContain('Loading files');
    expect(html).not.toContain('Loading README');
  });
  it('does not put the repository name in the latest-commit slot', () => {
    const html = renderToStaticMarkup(<CodeScreen />);
    expect(html).toContain('Loading latest commit');
    expect(html).not.toContain('class="commit-bar__author">the-everything-assistant');
  });
  it.each(['blob', 'blame'])('keeps file controls and a viewport-filling skeleton while %s loads', view => {
    state.route = routeOf(`/testtt/the-everything-assistant/${view}/stable/src/index.ts`);
    const html = renderToStaticMarkup(<CodeScreen />);
    expect(html).toContain('class="file-bar__view"');
    expect(html).toContain(view === 'blame' ? 'blame-skeleton' : 'code-skeleton');
    expect(html).toContain('class="repo-layout"');
    expect(html).not.toMatch(SPINNER);
  });
  it('uses deterministic rectangular rows', () => {
    const a = renderToStaticMarkup(<SkeletonRows rows={4} />);
    expect(a).toBe(renderToStaticMarkup(<SkeletonRows rows={4} />));
    expect(a.match(/class="skeleton-row"/g)).toHaveLength(4);
    expect(a).not.toContain('circle');
  });
});
