import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaProxy, MEDIA_SANDBOX } from './media-proxy';

const proxied = (url: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) =>
  new Request(`https://braid.example/api/media?url=${encodeURIComponent(url)}`, { headers });
const refusal = async (request: Request) => mediaProxy(request).then(() => null, (error: { status: number }) => error.status);

afterEach(() => { vi.unstubAllGlobals(); });

describe('README media proxy', () => {
  it('serves a remote image from Braid under a sandbox, sending the host no cookies, referrer or page', async () => {
    const network = vi.fn(async () => new Response('png', { headers: { 'content-type': 'image/png', 'content-length': '3', 'set-cookie': 'tracker=1' } }));
    vi.stubGlobal('fetch', network);
    const answer = await mediaProxy(proxied('https://img.example/badge.png'));
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('png');
    expect(answer.headers.get('content-type')).toBe('image/png');
    expect(answer.headers.get('content-security-policy')).toBe(MEDIA_SANDBOX);
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
    expect(answer.headers.get('set-cookie')).toBeNull();
    const [, init] = network.mock.calls[0] as unknown as [URL, RequestInit];
    expect(new Headers(init.headers).get('cookie')).toBeNull();
    expect(new Headers(init.headers).get('referer')).toBeNull();
  });

  it('follows https redirects, as an uploaded GitHub video takes, and passes ranges through for seeking', async () => {
    const network = vi.fn(async (url: URL, init?: RequestInit) => String(url).startsWith('https://github.com/')
      ? new Response(null, { status: 302, headers: { location: 'https://objects.example/video.mp4?sig=1' } })
      : new Response('part', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes 0-3/${new Headers(init?.headers).get('range') ? 100 : 4}`, 'accept-ranges': 'bytes' } }));
    vi.stubGlobal('fetch', network);
    const answer = await mediaProxy(proxied('https://github.com/user-attachments/assets/0f9a6a4e-5c1b-4f62-9c55-2b0c3c1a7d11', { 'sec-fetch-site': 'same-origin', range: 'bytes=0-3' }));
    expect(answer.status).toBe(206);
    expect(answer.headers.get('content-range')).toBe('bytes 0-3/100');
    expect(answer.headers.get('accept-ranges')).toBe('bytes');
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('refuses other sites, other schemes, credentials, redirects off https, and too many redirects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-type': 'image/png' } })));
    expect(await refusal(proxied('https://img.example/a.png', {}))).toBe(403);
    expect(await refusal(proxied('https://img.example/a.png', { 'sec-fetch-site': 'cross-site' }))).toBe(403);
    expect(await refusal(proxied('http://img.example/a.png'))).toBe(400);
    expect(await refusal(proxied('https://user:secret@img.example/a.png'))).toBe(400);
    expect(await refusal(proxied('not a url'))).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://img.example/a.png' } })));
    expect(await refusal(proxied('https://img.example/a.png'))).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://[' } })));
    expect(await refusal(proxied('https://img.example/a.png'))).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(null, { status: 302, headers: { location: `${url}x` } })));
    expect(await refusal(proxied('https://img.example/a.png'))).toBe(502);
  });

  it('serves only images and videos, within their size limits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<script>', { headers: { 'content-type': 'text/html' } })));
    expect(await refusal(proxied('https://img.example/page'))).toBe(415);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) } })));
    expect(await refusal(proxied('https://img.example/huge.png'))).toBe(413);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 404, headers: { 'content-type': 'image/png' } })));
    expect(await refusal(proxied('https://img.example/missing.png'))).toBe(502);
  });

  it('keeps an SVG from running as Braid when it is opened on its own', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg onload="alert(1)"/>', { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } })));
    const answer = await mediaProxy(proxied('https://img.example/logo.svg'));
    expect(answer.headers.get('content-type')).toBe('image/svg+xml');
    expect(answer.headers.get('content-security-policy')).toContain('sandbox');
    expect(answer.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
