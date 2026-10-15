import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSnapshot } from '../../../shared/types';
import { openPalette } from '../../lib/palette';
import { navigate, paths, setRouteBase } from '../../lib/router';
import { CommandMenu } from './CommandMenu';

type Item = { id: string; title: string; hint?: string; run: () => void };
type Menu = { items: { id: string; items: Item[] }[]; onSelect: (item: Item) => void; onOpenChange: (open: boolean) => void };
const state = vi.hoisted(() => {
  vi.stubGlobal('window', { location: { pathname: '/example/relay', search: '', hash: '', origin: 'https://braid.test' }, addEventListener: vi.fn() });
  return { query: 'delivery', accounts: true, user: null as { id: string } | null, menu: null as Menu | null };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: () => [state.query, vi.fn()] }));
vi.mock('@cloudflare/kumo', () => ({ CommandPalette: {
  Root: (props: Menu) => { state.menu = props; return null; },
  Input: () => null, List: () => null, Results: () => null, Empty: () => null, Footer: () => null,
} }));
vi.mock('../../lib/router', async original => ({ ...await original<typeof import('../../lib/router')>(), navigate: vi.fn() }));
vi.mock('../../lib/live', () => ({ useLive: () => ({ data: null }) }));
vi.mock('../../lib/hooks', () => ({ useCopy: () => [false, vi.fn()] }));
vi.mock('../../lib/recent', () => ({ readRecent: () => [] }));
vi.mock('../../store/workspace', () => ({ useWorkspace: () => ({ refresh: vi.fn() }), canWrite: () => false, newMissionBlocker: () => 'Sign in' }));
vi.mock('../../account/AccountProvider', () => ({ useAccount: () => ({ accounts: state.accounts, account: { user: state.user } }) }));

const snapshot = { project: { id: 'relay' }, capabilities: { mode: 'demo' }, files: {}, missions: [] } as unknown as WorkspaceSnapshot;
function search(scope: 'all' | 'files' = 'all', value: WorkspaceSnapshot | null = snapshot) {
  renderToStaticMarkup(<CommandMenu open onOpenChange={() => {}} snapshot={value} onNewTask={() => {}} scope={scope} onScopeChange={() => {}} />);
  return state.menu!.items.find(group => group.id === 'search')?.items ?? [];
}
beforeEach(() => { state.query = 'delivery'; state.accounts = true; state.user = null; state.menu = null; vi.mocked(navigate).mockClear(); setRouteBase('/example/relay'); });

describe('command menu code search', () => {
  it.each([null, { id: 'maya' }])('offers this repository before all repositories for %j', user => {
    state.user = user;
    const items = search();
    expect(items.map(item => item.hint)).toEqual(['This repository', user ? 'All repositories' : 'All repositories · Sign in']);
    state.menu!.onSelect(items[0]);
    expect(navigate).toHaveBeenCalledWith('/example/relay/search?q=delivery');
  });
  it('preserves a signed-out query through sign-in instead of showing empty global results', () => {
    state.query = 'delivery "retry later"';
    const items = search();
    state.menu!.onSelect(items[1]);
    expect(navigate).toHaveBeenCalledWith(paths.signin(paths.globalSearch(state.query)));
  });
  it('lets a signed-in viewer search all accessible repositories', () => {
    state.user = { id: 'maya' };
    const items = search(); state.menu!.onSelect(items[1]);
    expect(navigate).toHaveBeenCalledWith('/search?q=delivery');
  });
  it('keeps single-owner search inside the repository', () => {
    state.accounts = false; setRouteBase('');
    const items = search(); expect(items).toHaveLength(1); state.menu!.onSelect(items[0]);
    expect(navigate).toHaveBeenCalledWith('/search?q=delivery');
  });
  it('does not offer a repository search before a repository is available', () => {
    expect(search('all', null).map(item => item.hint)).toEqual(['All repositories · Sign in']);
  });
  it('keeps file-only and empty searches free of code search commands', () => {
    expect(search('files')).toEqual([]); state.query = '  '; expect(search()).toEqual([]);
  });
});

describe('command menu focus', () => {
  // Kumo's palette has no trigger element, so without this the close would leave focus on the body.
  class FakeElement { focus = vi.fn(); }
  const opener = new FakeElement();
  const main = new FakeElement();
  beforeEach(() => {
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('document', { activeElement: opener, getElementById: vi.fn((id: string) => (id === 'main' ? main : null)) });
    opener.focus.mockClear(); main.focus.mockClear();
    window.location.pathname = '/example/relay';
    openPalette();
  });
  it('returns focus to the control that asked for the menu when it closes in place', () => {
    search();
    state.menu!.onOpenChange(false);
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(main.focus).not.toHaveBeenCalled();
  });
  it('returns to the opener after a command that stays on the page', () => {
    const items = search(); vi.mocked(navigate).mockImplementationOnce(() => {});
    state.menu!.onSelect(items[0]);
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(main.focus).not.toHaveBeenCalled();
  });
  it('continues on the new page after a command that opens one', () => {
    const items = search(); vi.mocked(navigate).mockImplementationOnce(() => { window.location.pathname = '/example/relay/search'; });
    state.menu!.onSelect(items[0]);
    expect(main.focus).toHaveBeenCalledTimes(1);
  });
});
