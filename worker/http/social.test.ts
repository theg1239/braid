import { describe, expect, it, vi } from 'vitest';
import { servePage, socialTags, socialTitle } from './social';
import type { BraidEnv } from '../env';

const url = (path: string) => new URL(path, 'https://request.example');
const origin = 'https://deployment.example';
// These asset passthrough controls never reach repository visibility lookup.
const DIRECTORY = {} as BraidEnv['DIRECTORY'];

describe('URL-only social titles', () => {
  it.each([
    ['/', 'Braid · The Git platform for agent fleets'],
    ['/index.html', 'Braid · The Git platform for agent fleets'],
    ['/explore?q=secret', 'Explore · Braid'],
    ['/example/relay', 'example/relay · Braid'],
    ['/unknown/private/', 'unknown/private · Braid'],
    ['/maya/relay/pull/69?tab=files', 'Pull request #69 · maya/relay'],
    [`/maya/relay/commit/${'424c7a5'.padEnd(40, 'a')}`, 'Commit 424c7a5 · maya/relay'],
    ['/maya/relay/blob/main/src/delivery.ts', 'src/delivery.ts · maya/relay'],
    ['/maya/relay/blame/feature%2Fdelivery/src/a%20file.ts', 'src/a file.ts · maya/relay'],
    ['/maya/relay/blob/main/src/%E6%96%87%E4%BB%B6.ts', 'src/文件.ts · maya/relay'],
    ['/maya/relay/blob/main/src/%E0%A4%A.ts', 'src/%E0%A4%A.ts · maya/relay'],
    ['/maya/relay/pull/not-a-number', 'maya/relay · Braid'],
    ['/maya/relay/commit/not-a-sha', 'maya/relay · Braid'],
    ['/maya/relay/blob/main', 'maya/relay · Braid'],
    ['/maya/relay/agents', 'maya/relay · Braid'],
    ['/settings/account', 'Braid'],
    ['/organizations/new', 'Braid'],
    ['/orgs/maya/people', 'Braid'],
  ])('%s → %s', (path, title) => {
    expect(socialTitle(url(path))).toBe(title);
  });

  it('does not expose query parameters, fragments, or an asserted repository description', () => {
    const tags = socialTags(url('/unknown/private?description=confidential&token=secret#hidden'), origin);
    expect(tags).toContain('content="unknown/private · Braid"');
    expect(tags).not.toMatch(/confidential|secret|hidden/);
  });
});

describe('social tag attributes', () => {
  it.each(['owner', 'repo', 'path'] as const)('escapes HTML and attribute delimiters in %s', field => {
    const hostile = `"><b>&'`;
    const encoded = encodeURIComponent(hostile);
    const path = field === 'owner' ? `/${encoded}/r` : field === 'repo' ? `/o/${encoded}` : `/o/r/blob/main/${encoded}`;
    const tags = socialTags(url(path), origin);
    const safe = '&quot;&gt;&lt;b&gt;&amp;&#39;';
    const title = field === 'owner' ? `${safe}/r · Braid` : field === 'repo' ? `o/${safe} · Braid` : `${safe} · o/r`;
    expect(tags).toContain(`<meta property="og:title" content="${title}" />`);
    expect(tags).toContain(`<meta name="twitter:title" content="${title}" />`);
    expect(tags).not.toContain('<b>');
    expect(tags.split('\n').every(tag => /^<meta (?:property|name)="[\w:]+" content="[^"<>]*" \/>$/.test(tag))).toBe(true);
  });

  it('uses the deployment origin even when the incoming host differs', () => {
    const tags = socialTags(url('/o/r'), `${origin}/`);
    expect(tags).toContain(`<meta property="og:image" content="${origin}/og.png" />`);
    expect(tags).toContain(`<meta name="twitter:image" content="${origin}/og.png" />`);
    expect(tags).not.toContain('request.example');
    expect(tags).toContain('property="og:image:width" content="1200"');
    expect(tags).toContain('property="og:image:height" content="630"');
    const imageAlt = 'Braid’s mark and name with “Give your agents room to breathe.” beside an aerial view of silver river channels converging into one across black volcanic sand.';
    expect(tags).toContain(`property="og:image:alt" content="${imageAlt}"`);
    expect(tags).toContain(`name="twitter:image:alt" content="${imageAlt}"`);
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
  });

  it('uses the local request origin when PUBLIC_ORIGIN is unset for development', () => {
    expect(socialTags(new URL('http://127.0.0.1:5281/o/r'), '')).toContain('content="http://127.0.0.1:5281/og.png"');
  });

  it('limits long titles to 70 Unicode characters without splitting a character', () => {
    const tags = socialTags(url(`/o/r/blob/main/${encodeURIComponent('🧵'.repeat(80))}`), origin);
    const title = /property="og:title" content="([^"]*)"/.exec(tags)![1];
    expect(Array.from(title)).toHaveLength(70);
    expect(title).toBe(`${'🧵'.repeat(69)}…`);
    expect(tags).toContain(`name="twitter:title" content="${title}"`);
  });

  it('normalizes control characters and keeps descriptions within 200 characters', () => {
    const tags = socialTags(url('/o/r/blob/main/one%0Atwo%00.ts'), origin);
    expect(tags).toContain('content="one two .ts · o/r"');
    const description = /property="og:description" content="([^"]*)"/.exec(tags)![1];
    expect(description.length).toBeLessThanOrEqual(200);
    expect(tags).toContain(`name="twitter:description" content="${description}"`);
  });
});

describe('asset response handling', () => {
  it('preserves source-module requests and validators in the Vite development server', async () => {
    const request = new Request(url('/src/main.tsx'), { headers: { 'sec-fetch-dest': 'script', 'if-none-match': 'source-module' } });
    const response = new Response('export {};', { headers: { 'content-type': 'text/javascript' } });
    const fetch = vi.fn(async (asset: Request) => {
      expect(asset).toBe(request);
      expect(asset.headers.get('if-none-match')).toBe('source-module');
      return response;
    });
    expect(await servePage(request, { ASSETS: { fetch } as unknown as Fetcher, PUBLIC_ORIGIN: origin, DIRECTORY })).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['image/png', 200, 'GET'],
    ['text/javascript', 200, 'GET'],
    ['application/json', 200, 'GET'],
    ['text/html', 404, 'GET'],
    ['text/html', 200, 'HEAD'],
  ])('passes through %s, %s, %s without an HTML rewrite', async (contentType, status, method) => {
    const response = new Response(method === 'HEAD' ? null : 'asset', { status, headers: { 'content-type': contentType } });
    const fetch = vi.fn(async () => response);
    const env = { ASSETS: { fetch } as unknown as Fetcher, PUBLIC_ORIGIN: origin, DIRECTORY };
    expect(await servePage(new Request(url('/o/r'), { method }), env)).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not pass shared-index validators to assets or mutate the incoming request', async () => {
    const request = new Request(url('/o/r/blob/feature%2Ffix/a.ts?secret=hidden'), { headers: { 'if-none-match': 'shared-index', 'if-modified-since': 'Mon, 12 Oct 2026 00:00:00 GMT', range: 'bytes=0-32767', 'if-range': 'shared-index' } });
    const fetch = vi.fn(async (asset: Request) => {
      expect(asset.url).toBe('https://request.example/');
      expect(asset.headers.has('if-none-match')).toBe(false);
      expect(asset.headers.has('if-modified-since')).toBe(false);
      expect(asset.headers.has('range')).toBe(false);
      expect(asset.headers.has('if-range')).toBe(false);
      return new Response('asset');
    });
    await servePage(request, { ASSETS: { fetch } as unknown as Fetcher, PUBLIC_ORIGIN: origin, DIRECTORY });
    expect(request.headers.get('if-none-match')).toBe('shared-index');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
