import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
const state = vi.hoisted(() => ({ identity: false, keys: [] as (string | null)[] }));
vi.mock('../lib/router', () => ({ useRoute: () => ({ query: new URLSearchParams('review=requested') }), paths: { pulls: (filter: string) => `/pulls?${filter}`, queue: () => '/queue' } }));
vi.mock('../lib/polling', () => ({ publicPolling: () => false }));
vi.mock('../lib/title', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'repo', name: 'Repository' }, capabilities: { identity: state.identity ? { id: 'owner' } : undefined } }), canWrite: () => false }));
vi.mock('../lib/needs', () => ({ ATTENTION_KEY: 'attention', attentionList: vi.fn() }));
vi.mock('../lib/live', () => ({ useLive: (key: string | null) => { state.keys.push(key); return { data: key && key !== 'queue' ? { items: [], nextCursor: null, counts: { open: 1, attention: 1, revise: 0, queued: 0, landing: 0, closed: 0, landed: 0 } } : null, loading: false, error: null }; } }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ href, children, ...props }: React.ComponentProps<'a'>) => <a href={href} {...props}>{children}</a> }));
vi.mock('../components/queue/QueueControl', () => ({ QueueControl: () => null }));
vi.mock('../components/repo/RepositorySetup', () => ({ NoRepositoryPanel: () => null }));
vi.mock('../account/SetupPrompt', () => ({ SetupPromptButton: () => null }));
import { PullsScreen } from './PullsScreen';
beforeEach(() => { state.identity = false; state.keys = []; });
describe('pull request filters', () => {
  it('shows visitors Open even at a Needs you URL, with no personal filter or attention read', () => {
    const html = renderToStaticMarkup(<PullsScreen />);
    expect(textOf(html)).not.toContain('Needs you'); expect(html).toContain('href="/pulls?open" class="list__filter" aria-current="page"');
    expect(state.keys).toContain('changes:list:open'); expect(state.keys).not.toContain('attention');
  });
  it('keeps Needs you available to a signed-in identity', () => {
    state.identity = true;
    expect(textOf(renderToStaticMarkup(<PullsScreen />))).toContain('Needs you'); expect(state.keys).toContain('attention');
  });
});
