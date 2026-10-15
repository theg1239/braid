import { afterEach, expect, it, vi } from 'vitest';
import { changesRoute } from './router';
import { recordedExample, type ExampleState } from './demo';
import type { BraidEnv } from '../env';
import type { Change, ChangeDiff } from '../../shared/types';

const state: ExampleState = { decisions: {}, changes: [], since: Date.UTC(2026, 9, 13) };
afterEach(() => vi.useRealTimers());

it('keeps private visitor comments and places their shard near the workspace', async () => {
  const comment = { id: 'visitor-comment', body: 'Keep the focused file.', author: { kind: 'human', id: 'visitor', name: 'You' }, revision: 2, createdAt: '2026-10-13T00:00:00Z' };
  const example = await recordedExample(), target = example.change('22', state);
  const comments = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, [comment]])));
  const getByName = vi.fn(() => ({ exampleComments: comments }));
  const env = { WORKSPACES: { idFromName: (id: string) => id, get: () => ({ exampleState: async () => state }) }, CHANGES: { getByName } } as unknown as BraidEnv;
  const response = (await changesRoute(new Request('https://braid.test/api/changes/22'), env, { repository: 'demo:visitor', mode: 'demo', role: 'demo', location: 'weur' }))!;
  expect((await response.json() as Change).comments).toEqual([comment]);
  expect(comments).toHaveBeenCalledWith([target.id]);
  expect(getByName).toHaveBeenCalledWith(expect.any(String), { locationHint: 'weur' });
});

it('chooses the first file of the requested revision and still honors explicit paths', async () => {
  const example = await recordedExample();
  for (const number of ['22', '23']) {
    const change = example.change(number, state);
    for (let revision = 1; revision <= change.revision; revision++) {
      const first = example.diff(number, '', { revision }, state);
      expect(first.revision).toBe(revision);
      expect(first).toEqual(example.diff(change.id, first.path, { revision }, state));
    }
    expect(example.diff(number, '', {}, state).path).toBe(change.files.map(file => file.path).sort()[0]);
  }
  expect(() => example.diff('22', '', { since: 2 }, state)).toThrow('Compare with an earlier revision.');
  expect(() => example.diff('23', 'missing.ts', {}, state)).toThrow('does not include');
});

it('accepts an omitted path at the route boundary without opening a comment shard', async () => {
  const getByName = vi.fn();
  const env = { WORKSPACES: { idFromName: (id: string) => id, get: () => ({ exampleState: async () => state }) }, CHANGES: { getByName } } as unknown as BraidEnv;
  for (const suffix of ['', '?path=', '?path=public%2Fstatus.html']) {
    const response = (await changesRoute(new Request(`https://braid.test/api/changes/23/diff${suffix}`), env, { repository: 'demo:shared:weur:497744.build', mode: 'demo', role: 'viewer' }))!;
    expect(response.status).toBe(200);
    expect(await response.json() as ChangeDiff).toMatchObject({ path: 'public/status.html', revision: 1, after: expect.stringContaining('<!doctype html>') });
  }
  expect(getByName).not.toHaveBeenCalled();
});


it('never opens a comment shard for the immutable shared detail, list or conversation', async () => {
  const getByName = vi.fn();
  const env = { WORKSPACES: { idFromName: (id: string) => id, get: () => ({ exampleState: async () => state }) }, CHANGES: { getByName } } as unknown as BraidEnv;
  const read = async (path: string) => (await changesRoute(new Request(`https://braid.test${path}`), env, { repository: 'demo:shared:weur:497744.build', mode: 'demo', role: 'viewer' }))!;
  const detail = await (await read('/api/changes/22')).json() as Change;
  expect(detail.comments).toHaveLength(2);
  expect(await (await read('/api/changes/22/comments')).json()).toEqual(detail.comments);
  expect((await read('/api/changes?status=done')).status).toBe(200);
  expect(getByName).not.toHaveBeenCalled();
});
