import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import api from './api';
import type { BraidEnv } from '../env';

// Node accepts redirect: 'error', but the deployed Workers runtime rejects it.
// Validate the real handler's outbound options in workerd without making network requests.
let runtime: Miniflare;
beforeAll(() => {
  runtime = new Miniflare({ workers: [{ config: {
    name: 'avatar-request-test', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: `
      export default { async fetch(request) {
        const { url, redirect } = await request.json();
        try { new Request(url, { redirect }); return new Response(null, { status: 204 }); }
        catch { return new Response(null, { status: 400 }); }
      } };
    ` } } },
  } }] });
});
afterAll(async () => { await runtime.dispose(); });
afterEach(() => { vi.restoreAllMocks(); });

function fixture(upstream: Response) {
  const avatar = vi.fn(async () => 123);
  const env = {
    AUTH_MODE: 'github',
    DIRECTORY: { idFromName: () => 'directory', get: () => ({ avatar }) },
    SECURITY: { idFromName: () => 'security', get: () => ({}) },
    IP_LIMITER: { limit: async () => ({ success: true }) },
    ANONYMOUS_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as BraidEnv;
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const checked = await runtime.dispatchFetch('http://local.test/', {
      method: 'POST', body: JSON.stringify({ url: String(input), redirect: init?.redirect }),
    });
    if (!checked.ok) throw new TypeError('Workers rejected the outbound request options.');
    return upstream;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const call = () => api.fetch(new Request('https://braid.example/api/owners/alice/avatar'), env);
  return { call, transport, avatar };
}

describe('avatar proxy in the Workers runtime', () => {
  it('serves an upstream image using options supported by workerd', async () => {
    const f = fixture(new Response('image-bytes', { headers: { 'content-type': 'image/png' } }));
    const response = await f.call();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await response.text()).toBe('image-bytes');
  });

  it.each<{ status: number; headers: Record<string, string> }>([
    { status: 302, headers: { location: 'https://untrusted.example/avatar', 'content-type': 'image/png' } },
    { status: 200, headers: { 'content-type': 'text/html' } },
    { status: 503, headers: { 'content-type': 'image/png' } },
  ])('refuses and releases an invalid upstream response ($status)', async ({ status, headers }) => {
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream({ cancel }), { status, headers });
    const f = fixture(upstream);
    const response = await f.call();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'Avatar unavailable.' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.transport.mock.calls[0][1]?.redirect).toBe('manual');
  });
});
