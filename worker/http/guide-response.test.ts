import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import api from './api';
import { setupGuide } from './setup-guide';
import { guideResponse, prefersGuideHtml } from './guide-response';
import { edgeCache } from '../test/edge-cache';
import type { BraidEnv } from '../env';

const origin = 'https://braid.example';
const env = { PUBLIC_ORIGIN: origin, BUILD_ID: 'guide-test' } as BraidEnv;
const paths = ['/llms.txt', '/setup.md', '/changes.md', '/auth.md', '/local-agents.md', '/skills/braid/SKILL.md'];
const subtype = (path: string) => path === '/skills/braid/SKILL.md' ? 'markdown' : 'plain';
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const get = (path: string, accept?: string, bindings = env) => api.fetch(new Request(`${origin}${path}`, { headers: accept ? { accept } : {} }), bindings);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('guide content negotiation', () => {
  it.each([
    [null, false], ['', false], ['*/*', false], ['text/*', false], ['text/plain', false], ['application/json', false],
    ['text/html', true], ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', true],
    ['text/html,text/plain', false], ['text/plain;q=0.8,text/html;q=0.9', true], ['text/html;q=0.1,text/plain;q=0.9', false],
    ['text/html;q=0,*/*;q=1', false], ['text/html;q=0.1,text/*;q=0.9', false], ['text/*;q=0.5,text/html;q=0.8', true],
    ['text/html;q=0.5,text/*;q=0', true], ['text/html;q=0.5,text/plain;q=0.4,*/*;q=1', true],
    ['TEXT/HTML;Charset="UTF-8";Q=1.000,text/plain;q=0.5', true], ['text/html;charset=iso-8859-1,*/*', false],
    ['text/html;q=1.1,*/*', false], ['text/html;q=0.1234,*/*', false], ['text/html;q="1",*/*', false],
    ['text/html;q=1;q=0,*/*', false], ['*/html', false], ['text/html/broken', false],
    ['text/plain;note="x,text/html;q=1",text/plain', false], ['text/plain;note="x;\\\"y,text/html",text/html', true],
  ])('negotiates Accept %j as HTML=%s', (accept, html) => expect(prefersGuideHtml(accept)).toBe(html));

  it.each(paths)('serves readable HTML at %s with the identical guide as escaped preformatted text', async path => {
    const response = await get(path, 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('vary')).toBe('Accept');
    const html = await response.text();
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('white-space:pre-wrap'); expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain("16px/1.6 'Geist Mono'"); expect(html).toContain("url('/fonts/GeistMono-latin.woff2')");
    expect(html).toContain(`<pre>${escape(setupGuide(path, origin)!)}</pre>`);
    expect(html).not.toContain('<script');
  });

  it.each(paths)('preserves exact bytes and type at %s for agents, even after a browser warmed the cache', async path => {
    await get(path, 'text/html');
    for (const accept of [undefined, '*/*', 'text/plain', 'text/markdown', 'application/json', 'text/html;q=0', `text/${subtype(path)};q=1,text/html;q=0.5`]) {
      const response = await get(path, accept);
      expect(response.headers.get('content-type')).toBe(`text/${subtype(path)}; charset=utf-8`);
      expect(response.headers.get('cache-control')).toBe(path === '/local-agents.md' ? 'no-store' : 'public, max-age=300');
      expect(response.headers.get('vary')).toBe('Accept');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(setupGuide(path, origin)!));
    }
  });

  it.each(paths.filter(path => path !== '/local-agents.md').flatMap(path => [['text/html', '*/*'], ['*/*', 'text/html']].map(order => [path, ...order])))('separates both edge variants at %s when %s warms the cache first', async (path, first, second) => {
    const kept = edgeCache();
    for (const accept of [first, second, first, second]) {
      const response = await get(path, accept);
      expect(response.headers.get('content-type')).toBe(accept === 'text/html' ? 'text/html; charset=utf-8' : `text/${subtype(path)}; charset=utf-8`);
      expect(response.headers.get('vary')).toBe('Accept');
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
      expect(response.headers.has('x-braid-cache-until')).toBe(false);
      expect(await response.text()).toContain(accept === 'text/html' ? `<pre>${escape(setupGuide(path, origin)!)}</pre>` : setupGuide(path, origin)!);
    }
    expect(kept.size).toBe(2);
    expect([...kept.keys()]).toEqual(expect.arrayContaining([expect.stringContaining(`/html${path}`), expect.stringContaining(`/text${path}`)]));
    const newer = { ...env, BUILD_ID: 'next-build' } as BraidEnv;
    await get(path, 'text/html', newer);
    const other = { ...env, PUBLIC_ORIGIN: 'https://other.example' } as BraidEnv;
    expect(await (await get(path, 'text/html', other)).text()).toContain(`<pre>${escape(setupGuide(path, other.PUBLIC_ORIGIN)!)}</pre>`);
    expect(kept.size).toBe(4);
  });

  it('escapes HTML-like commands and keeps the existing local font bytes', async () => {
    const text = '</pre><script>alert("guide")</script>&lt;owner&gt;\n<owner>/<repo> & "key"';
    const html = await (await guideResponse(new Request(`${origin}/setup.md`, { headers: { accept: 'text/html' } }), text, origin, 'escape-test')).text();
    expect(html).toContain(`<pre>${escape(text)}</pre>`); expect(html).not.toContain('<script>');
    expect(readFileSync(new URL('../../public/fonts/GeistMono-latin.woff2', import.meta.url)))
      .toEqual(readFileSync(new URL('../../src/fonts/GeistMono-latin.woff2', import.meta.url)));
  });

  it('never opens the edge cache or shares personalized guides, including simultaneous HTML and text requests', async () => {
    const kept = edgeCache();
    const open = vi.spyOn(caches, 'open');
    await Promise.all(['', '?mission=task-one&agent=atlas&workspace=repo-one', '?mission=task-two&agent=sable&workspace=repo-two'].flatMap(query => ['text/html', '*/*'].map(async accept => {
      const response = await get(`/local-agents.md${query}`, accept);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Accept');
      const text = setupGuide('/local-agents.md', origin, new URLSearchParams(query))!;
      const body = await response.text();
      if (accept === 'text/html') {
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(body).toContain(`<pre>${escape(text)}</pre>`);
      } else expect(body).toBe(text);
    })));
    expect(kept.size).toBe(0); expect(open).not.toHaveBeenCalled();
  });
});
