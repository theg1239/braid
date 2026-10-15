import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeScreen } from './CodeScreen';
import type { ProjectImport } from '../../shared/types';

const state = vi.hoisted(() => ({
  file: { status: 'error', message: 'File not found.', httpStatus: 404 } as { status: 'error'; message: string; httpStatus: number } | { status: 'loading' } | { status: 'ready'; content: string; kind: 'text' | 'binary' },
  path: 'nope/none.ts',
  hash: '',
  mirror: false,
  projectId: 'relay',
  importing: undefined as ProjectImport | undefined,
}));
vi.mock('../lib/router', () => ({ useRoute: () => ({ screen: 'code', repo: { owner: 'openai', repo: 'codex' }, path: state.path, hash: state.hash, ref: 'main', view: 'blob' }), navigate: vi.fn(), paths: { commits: (_ref: string, path: string) => `/commits/main/${path}`, commit: (sha: string) => `/commit/${sha}`, code: (path: string) => `/blob/main/${path}`, search: () => '/search', pull: (number: number) => `/pull/${number}`, agents: () => '/agents' } }));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: state.projectId, branch: 'main', head: 'a'.repeat(40), name: 'Relay' }, importing: state.importing, missions: [], files: {} }), useWorkspace: () => ({ error: null, errorCode: null }), canWrite: () => false }));
vi.mock('../account/mirrors', async original => ({ ...await original<typeof import('../account/mirrors')>(), useMirror: () => state.mirror ? { source: 'https://github.com/openai/codex', importing: true } : null }));
vi.mock('../lib/api', () => ({ api: {}, changes: {}, errorMessage: () => '', onWorkspaceReset: () => () => {} }));
vi.mock('../lib/live', () => ({ useLive: () => ({ data: null }) }));
vi.mock('../lib/hooks', () => ({ useCopy: () => [null, vi.fn()], useNow: () => Date.now() }));
vi.mock('../lib/needs', () => ({ useHeaderCounts: () => ({ review: 0 }), LATEST_KEY: 'changes:list:latest', latestList: vi.fn() }));
vi.mock('../lib/palette', () => ({ openPalette: vi.fn() }));
vi.mock('../lib/recent', () => ({ recordRecent: vi.fn() }));
vi.mock('../lib/resources', () => ({
  knownDirectory: () => false, primeBlame: vi.fn(), primeTree: vi.fn(),
  useRead: () => ({ value: undefined, error: null, retry: vi.fn() }),
  useRepositoryFile: () => ({ result: state.file, pending: state.file.status === 'loading', retry: vi.fn() }),
  useRepositoryTree: () => ({ tree: { entries: [], nextCursor: null }, pending: false, retry: vi.fn() }),
}));
vi.mock('../account/RepositoryGate', () => ({ useRepository: () => ({ address: null }) }));
vi.mock('../components/pulls/Bits', () => ({ AuthorChip: () => null, CheckStateIcon: () => null }));
vi.mock('../components/repo/ConnectButton', () => ({ ConnectButton: () => null }));
vi.mock('../components/repo/ImportBar', () => ({ ImportBar: ({ importing }: { importing: ProjectImport }) => <div className="import-bar">Importing {importing.source}</div> }));
vi.mock('../components/repo/RepositorySetup', () => ({ RepositorySetup: () => <div>Set up repository</div> }));
vi.mock('../components/code', () => ({ FileView: ({ render }: { render: string }) => <div data-render={render}>File contents</div>, isMarkdown: (path: string) => path.endsWith('.md') }));
vi.mock('../components/code/blame', () => ({ BlameView: () => null }));
vi.mock('../components/code/BranchMenu', () => ({ BranchMenu: () => <button>main</button> }));
vi.mock('../components/ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));

beforeEach(() => { state.path = 'nope/none.ts'; state.hash = ''; state.mirror = false; state.projectId = 'relay'; state.importing = undefined; state.file = { status: 'error', message: 'File not found.', httpStatus: 404 }; });
describe('code page search and missing-file controls', () => {
  it('opens Markdown search anchors in Code rather than Preview', () => {
    state.path = 'README.md'; state.hash = '#L7'; state.file = { status: 'ready', content: '# Readme', kind: 'text' };
    expect(renderToStaticMarkup(<CodeScreen />)).toContain('data-render="code"');
    state.hash = '';
    expect(renderToStaticMarkup(<CodeScreen />)).toContain('data-render="preview"');
  });
  it('keeps file actions disabled in place after a failed read and while loading', () => {
    let out = renderToStaticMarkup(<CodeScreen />);
    expect(out).toContain('File not found');
    for (const status of ['error', 'loading'] as const) {
      if (status === 'loading') state.file = { status };
      out = renderToStaticMarkup(<CodeScreen />);
      expect(out).toMatch(/<button[^>]*disabled=""[^>]*><span[^>]*>History<\/span>/);
      expect(out).toMatch(/<button[^>]*disabled=""[^>]*><span[^>]*>Download<\/span>/);
      expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Copy file"/);
      expect(out).not.toContain('href="/commits/');
    }
  });
  it('shows one heading and a quiet branch-root link, without a nonexistent breadcrumb or retry', () => {
    const out = renderToStaticMarkup(<CodeScreen />);
    expect(out.match(/<h1\b/g)).toHaveLength(1);
    expect(out).toContain('Browse files');
    expect(out).not.toContain('href="/blob/main/nope"');
    expect(out).not.toContain('Try again');
    expect(out).not.toContain('role="alert"');
  });
  it('retains History for existing text and binary files', () => {
    for (const kind of ['text', 'binary'] as const) {
      state.file = { status: 'ready', content: 'hello', kind };
      expect(renderToStaticMarkup(<CodeScreen />)).toContain('History');
    }
  });
  it('places repository search next to Go to file on Code', () => {
    state.path = '';
    const out = renderToStaticMarkup(<CodeScreen />);
    expect(out).toContain('Go to file');
    expect(out).toContain('aria-label="Search this repository"');
    expect(out.indexOf('Go to file')).toBeLessThan(out.indexOf('class="repo-search"'));
  });
  it('keeps repository search mounted on file pages, including missing files', () => {
    expect(renderToStaticMarkup(<CodeScreen />)).toContain('aria-label="Search this repository"');
    state.file = { status: 'ready', content: 'hello', kind: 'text' };
    expect(renderToStaticMarkup(<CodeScreen />)).toContain('aria-label="Search this repository"');
  });
});

describe('mirror first visits', () => {
  beforeEach(() => { state.mirror = true; state.path = ''; state.projectId = ''; state.importing = { source: 'openai/codex', name: 'codex', startedAt: '2026-10-13T12:00:00Z', branch: 'main' }; });
  it('keeps the Code layout with the source and elapsed time until a preview or readable tip exists', () => {
    const out = renderToStaticMarkup(<CodeScreen />);
    expect(out).toContain('class="repo-box"');
    expect(out).toContain('role="status"');
    expect(out).toContain('Copying');
    expect(out).toContain('openai/codex');
    expect(out).not.toContain('Set up repository');
  });
  it('shows the import preview as soon as it is readable', () => {
    state.importing!.preview = true;
    const out = renderToStaticMarkup(<CodeScreen />);
    expect(out).toContain('class="import-bar"');
    expect(out).toContain('openai/codex');
    expect(out).toContain('class="repo-box"');
    expect(out).not.toContain('Set up repository');
  });
  it('opens Code when the shallow tip exists, even while more branches copy', () => {
    state.projectId = 'codex';
    const out = renderToStaticMarkup(<CodeScreen />);
    expect(out).toContain('class="repo-box"');
    expect(out).not.toContain('class="import-bar"');
  });
});
