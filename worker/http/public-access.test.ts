import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeCache } from '../test/edge-cache';
import { publicRead } from './public-access';
import type { BraidEnv } from '../env';

/** One Directory for every isolate; each `env` object stands for one isolate's memo. */
function directory(visibility: Record<string, 'public' | 'private'>) {
  const lookups = vi.fn(async (workspaceId: string) => visibility[workspaceId] === 'public' ? { ok: true as const, data: { teamId: `team-${workspaceId}`, workspaceId } } : { ok: false as const, status: 404 as const, error: 'Repository not found.' });
  const isolate = () => ({ DIRECTORY: { idFromName: (name: string) => name, get: () => ({ publicRead: lookups }) } } as unknown as BraidEnv);
  return { lookups, isolate, visibility };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('public read leases', () => {
  it('asks the Directory once per data center for a public repository and keeps the lease within the isolate', async () => {
    const kept = edgeCache(), { lookups, isolate } = directory({ w: 'public', p: 'private' });
    const first = isolate(), second = isolate();
    const answers = await Promise.all([publicRead(first, 'w'), publicRead(first, 'w'), publicRead(second, 'w'), publicRead(first, 'p'), publicRead(second, 'p')]);
    expect(answers.slice(0, 3)).toEqual([{ ok: true, data: { teamId: 'team-w', workspaceId: 'w' } }, { ok: true, data: { teamId: 'team-w', workspaceId: 'w' } }, { ok: true, data: { teamId: 'team-w', workspaceId: 'w' } }]);
    expect(answers.slice(3)).toEqual([{ ok: false, status: 404, error: 'Repository not found.' }, { ok: false, status: 404, error: 'Repository not found.' }]);
    // The two isolates each looked the public repository up once, concurrently; a third, later, finds the lease at the edge.
    expect(lookups.mock.calls.map(([id]) => id).sort()).toEqual(['p', 'p', 'w', 'w']);
    expect(await publicRead(isolate(), 'w')).toMatchObject({ ok: true });
    expect(lookups).toHaveBeenCalledTimes(4);
    // A private or unknown repository never enters the shared cache.
    expect([...kept.keys()]).toEqual(['https://public.braid.invalid/w']);
    await publicRead(isolate(), 'p');
    expect(lookups).toHaveBeenCalledTimes(5);
  });

  it('sees a repository turn private within five seconds of the lease, wherever the lease was read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    edgeCache();
    const { lookups, isolate, visibility } = directory({ w: 'public' });
    const first = isolate();
    expect(await publicRead(first, 'w')).toMatchObject({ ok: true });
    // Four seconds later another isolate reads the lease from the edge and may trust it for one more second only.
    vi.advanceTimersByTime(4_000);
    const second = isolate();
    expect(await publicRead(second, 'w')).toMatchObject({ ok: true });
    expect(lookups).toHaveBeenCalledTimes(1);
    visibility.w = 'private';
    vi.advanceTimersByTime(1_001);
    expect(await publicRead(second, 'w')).toMatchObject({ ok: false, status: 404 });
    expect(await publicRead(first, 'w')).toMatchObject({ ok: false, status: 404 });
    expect(lookups).toHaveBeenCalledTimes(3);
  });

  it('drops a failed lookup so the next read asks again', async () => {
    edgeCache();
    const lookups = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ ok: true, data: { teamId: 't', workspaceId: 'w' } });
    const env = { DIRECTORY: { idFromName: (name: string) => name, get: () => ({ publicRead: lookups }) } } as unknown as BraidEnv;
    await expect(publicRead(env, 'w')).rejects.toThrow('busy');
    expect(await publicRead(env, 'w')).toMatchObject({ ok: true });
  });
});
