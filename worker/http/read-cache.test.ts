import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedPublicRead } from './read-cache';
import { cachedRepositoryRead } from './repository-cache';
import { publicRead } from './public-access';
import { edgeCache } from '../test/edge-cache';
import { Timings } from './timing';
import type { BraidEnv } from '../env';

const key = () => new Request(`https://reads.braid.invalid/${crypto.randomUUID()}`);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('public read cache', () => {
  it('shares a miss and keeps independently consumable responses across isolates until the original expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); edgeCache();
    const request = key(), read = vi.fn(async () => Response.json({ value: 1 }));
    const responses = await Promise.all(Array.from({ length: 5 }, () => cachedPublicRead(request, 5, read)));
    expect(await Promise.all(responses.map(response => response.json()))).toEqual(Array(5).fill({ value: 1 }));
    expect(read).toHaveBeenCalledOnce();
    vi.resetModules();
    const isolated = (await import('./read-cache')).cachedPublicRead;
    vi.setSystemTime(Date.now() + 4_000);
    const hit = await isolated(request, 5, read);
    expect(await hit.json()).toEqual({ value: 1 });
    expect(hit.headers.has('cache-control')).toBe(false); expect(hit.headers.has('x-braid-cache-until')).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 1_001);
    await isolated(request, 5, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never keeps errors, personal cookies, or a failed in-flight read', async () => {
    edgeCache();
    for (const response of [new Response('Unavailable', { status: 503 }), new Response('Personal', { headers: { 'set-cookie': 'session=private' } })]) {
      const request = key(), read = vi.fn(async () => response.clone());
      await cachedPublicRead(request, 5, read); await cachedPublicRead(request, 5, read);
      expect(read).toHaveBeenCalledTimes(2);
    }
    const request = key(), read = vi.fn().mockRejectedValueOnce(new Error('upstream')).mockResolvedValueOnce(Response.json({ recovered: true }));
    await expect(cachedPublicRead(request, 5, read)).rejects.toThrow('upstream');
    expect(await (await cachedPublicRead(request, 5, read)).json()).toEqual({ recovered: true });
  });

  it.each(['open', 'match', 'put'])('serves published repository content through a cache %s failure and logs safe diagnostics', async stage => {
    const failure = Object.assign(new Error('private upstream diagnostic'), { code: 'CACHE_UNAVAILABLE' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('caches', { open: async () => {
      if (stage === 'open') throw failure;
      return { match: async () => { if (stage === 'match') throw failure; }, put: async () => { if (stage === 'put') throw failure; } };
    } });
    const lookup = vi.fn(async () => ({ ok: true, data: { teamId: 'team', ownerSlug: 'owner', repoSlug: 'repo' } }));
    const env = { DIRECTORY: { idFromName: () => 'directory', get: () => ({ publicRead: lookup }) } } as unknown as BraidEnv;
    expect(await publicRead(env, crypto.randomUUID())).toMatchObject({ ok: true });
    expect(lookup).toHaveBeenCalledOnce();
    const read = vi.fn(async () => Response.json({ content: '# Read me' }, { headers: { 'x-braid-ref': 'c'.repeat(40) } }));
    const response = await cachedRepositoryRead(new Request('https://braid.test/api/repository?path=README.md'), 'repo', 'build', new Timings(), true, read);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ content: '# Read me' });
    expect(read).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    const logs = warn.mock.calls.map(([line]) => JSON.parse(line));
    expect(logs).toContainEqual(expect.objectContaining({ event: stage === 'match' ? 'read_cache_lookup_failed' : `read_cache_${stage === 'put' ? 'write' : stage}_failed`, code: 'CACHE_UNAVAILABLE' }));
    expect(JSON.stringify(logs)).not.toContain('private upstream diagnostic');
  });
});
