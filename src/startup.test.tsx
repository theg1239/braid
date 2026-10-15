import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefetchCode, prefetchMarkdown } from './components/code/viewer';
import { changes } from './lib/api';
import { primeLive } from './lib/live';
import { warmEntry } from './startup';

vi.mock('./components/code/viewer', () => ({ prefetchCode: vi.fn(), prefetchMarkdown: vi.fn() }));
vi.mock('./lib/api', () => ({ changes: { list: vi.fn() } }));
vi.mock('./lib/live', () => ({ primeLive: vi.fn((_key: string, fetcher: () => unknown) => fetcher()) }));
vi.mock('./lib/router', async () => {
  const { routeOf, isExample } = await import('./lib/address');
  return { isExample, routeOf: (href: string) => routeOf(href, 'https://braid.test') };
});

function warm(path: string) {
  vi.stubGlobal('window', { location: new URL(path, 'https://braid.test') });
  warmEntry();
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('entry warmup', () => {
  it.each(['/example/relay/blob/main/src/delivery.ts', '/example/relay/pull/23/files'])('evaluates the viewer before a code screen mounts: %s', (path) => {
    warm(path);
    expect(prefetchCode).toHaveBeenCalledOnce();
    expect(prefetchMarkdown).not.toHaveBeenCalled();
  });

  it('also prepares the Markdown renderer for a Markdown file', () => {
    warm('/example/relay/blob/main/README.md');
    expect(prefetchMarkdown).toHaveBeenCalledOnce();
  });

  it.each(['/', '/explore', '/example/relay', '/example/relay/tree/main/src', '/example/relay/pull/23', '/example/relay/blame/main/src/delivery.ts', '/acme/repo/blame/main/README.md'])('keeps the heavy viewer off other routes: %s', (path) => {
    warm(path);
    expect(prefetchCode).not.toHaveBeenCalled();
    expect(prefetchMarkdown).not.toHaveBeenCalled();
  });

  it('starts the recorded example Open list using the screen cache key before account rendering', () => {
    warm('/example/relay/pulls');
    expect(vi.mocked(primeLive).mock.calls[0][0]).toBe('changes:list:open');
    expect(changes.list).toHaveBeenCalledWith({ status: 'open,revise,attention,queued,landing', limit: 25 });
  });

  it('honors an explicit Closed filter', () => {
    warm('/example/relay/pulls?state=closed');
    expect(vi.mocked(primeLive).mock.calls[0][0]).toBe('changes:list:closed');
    expect(changes.list).toHaveBeenCalledWith({ status: 'landed,closed', limit: 25 });
  });

  it.each(['/acme/private/pulls', '/pulls', '/example/relay/pulls?agent=model'])('does not speculate on an unresolved scope or agent list: %s', (path) => {
    warm(path);
    expect(primeLive).not.toHaveBeenCalled();
  });
});
