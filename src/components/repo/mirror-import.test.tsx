import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { MirrorImport, MirrorImportBar } from './MirrorImport';
import { MirrorError } from './MirrorError';
import { routeOf } from '../../lib/router';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', origin: 'https://braid.test' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() });
  return { error: null as string | null, errorCode: null as string | null };
});
vi.mock('../../store/workspace', () => ({ useWorkspace: () => state }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-14T14:44:43Z') }));
vi.mock('../../lib/live', () => ({ useLive: vi.fn() }));

const importing = { name: 'oss-scanner', source: 'anthropics/oss-scanner', branch: 'main', startedAt: '2026-10-14T14:44:28Z' };
const source = 'https://github.com/anthropics/oss-scanner';
beforeEach(() => { state.error = null; state.errorCode = null; });

it('uses the commit row for the real source and elapsed time without a spinner or invented percentage', () => {
  const html = renderToStaticMarkup(<MirrorImport importing={importing} source={source} branch="main" route={routeOf('/anthropics/oss-scanner')} />);
  expect(html).toContain('class="repo-bar"'); expect(html).toContain('class="repo-box"');
  expect(html).toContain('class="commit-bar" role="status"');
  expect(html).toContain('Copying'); expect(html).toContain('15s');
  expect(html).toContain(`href="${source}"`); expect(html).toContain('anthropics/oss-scanner');
  expect(html).toContain('Loading files'); expect(html).toContain('aria-live="off"');
  expect(html).not.toMatch(/<svg[^>]*role="status"|progressbar|spinner/);
  expect(html.replace(/<[^>]+>/g, '')).not.toMatch(/[0-9]%/);
});

it('keeps the requested file layout while the mirror copies', () => {
  const html = renderToStaticMarkup(<MirrorImport importing={importing} source={source} branch="main" route={routeOf('/anthropics/oss-scanner/blob/main/README.md')} />);
  expect(html).toContain('class="repo-layout"'); expect(html).toContain('class="repo__file"');
  expect(html).toContain('aria-label="README.md"'); expect(html).toContain('Copying file');
  expect(html).toContain('role="tablist"'); expect(html).toContain('Preview'); expect(html).toContain('History'); expect(html).toContain('Download');
  expect(html).toContain('aria-label="Copy file"'); expect(html).toContain('aria-label="Search this repository"');
  expect(html).not.toContain('No files yet');
});

it('does not invent a start time before the server reserves the import', () => {
  const html = renderToStaticMarkup(<MirrorImportBar source={source} />);
  expect(html).toContain('Preparing mirror'); expect(html).not.toContain('15s');
});

it('replaces a retained importing snapshot with the typed terminal error from a later poll', () => {
  state.error = 'Too large to mirror.'; state.errorCode = 'mirror_too_large';
  const html = renderToStaticMarkup(<MirrorImport importing={importing} source={source} branch="main" route={routeOf('/anthropics/oss-scanner')} />);
  expect(html).toContain('40 MB'); expect(html).toContain('Open on GitHub');
  expect(html).not.toMatch(/Copying|Loading files|skeleton-line/);
});

it('explains the import limit by the server code, independently of its message', () => {
  const html = renderToStaticMarkup(<MirrorError message="The copy is too large." code="mirror_too_large" address={{ owner: 'acm-vit', repo: 'cli-top' }} />);
  expect(html).toContain('40 MB'); expect(html).toContain('href="https://github.com/acm-vit/cli-top"');
  expect(html).not.toContain('Try again');
  expect(renderToStaticMarkup(<MirrorError message="Too large to mirror." address={{ owner: 'acm-vit', repo: 'cli-top' }} />)).not.toContain('40 MB');
});
