import { afterEach, describe, expect, it } from 'vitest';
import { Directory } from '../accounts/directory';
import { storageFixture } from '../test/storage';
import { reconcileProvenance } from './provenance';
import { changesRoute } from '../changes/router';
import { personHandle } from '../../shared/people';
import type { BraidEnv } from '../env';
import type { FileBlame, Provenance } from '../../shared/types';

let db: ReturnType<typeof storageFixture>;
afterEach(async () => { if (db) { await db.settled(); db.db.close(); } });
function fixture() {
  db = storageFixture();
  const directory = new Directory(db.ctx, {} as BraidEnv);
  const user = { id: 'account-one', name: 'theg', email: 'private@example.test' };
  directory.account(user, { id: 123, login: 'theg1239' }, true);
  const env = { DIRECTORY: { idFromName: () => 'directory', get: () => directory } } as unknown as BraidEnv;
  return { directory, user, env };
}
const inferred = (name: string, email: string): Provenance => ({ commit: 'a'.repeat(40), at: '2026-10-13T00:00:00Z', subject: 'Readme', kind: 'human', owner: { name, email }, confidence: 'inferred' });

describe('Git author reconciliation', () => {
  it('matches private emails and old and new noreply logins, and prefers the current Braid username', () => {
    const { directory, user } = fixture();
    directory.setUsername(user, 'ishaan');
    const owners = directory.gitPeople([
      { name: 'theg', email: 'PRIVATE@example.test' },
      { name: 'theg', email: '123+theg1239@users.noreply.github.com' },
      { name: 'theg', email: 'theg1239@users.noreply.github.com' },
      { name: 'theg1239' }, { name: '@THEG1239' }, { name: 'ishaan' },
    ]);
    expect(owners.map(personHandle)).toEqual(Array(6).fill('@ishaan'));
    expect(owners.every(owner => !('email' in owner))).toBe(true);
  });
  it('keeps unmatched Git names and refuses ambiguous accounts or display-name guesses', () => {
    const { directory } = fixture();
    directory.account({ id: 'account-two', name: 'theg', email: 'other@example.test' }, { id: 456, login: 'second-person' }, true);
    expect(directory.gitPeople([{ name: 'theg' }, { name: 'vercel', email: 'build@example.test' }])).toEqual([{ name: 'theg' }, { name: 'vercel' }]);
    // Conflicting email and login evidence cannot select either person as certain.
    expect(directory.gitPeople([{ name: 'second-person', email: 'private@example.test' }])).toEqual([{ name: 'second-person' }]);
    expect(personHandle(directory.gitPeople([{ name: 'Someone', email: '789+outside@users.noreply.github.com' }])[0])).toBe('@outside');
  });
  it('reconciles cached inferred owners again after a rename without changing witnessed attribution', async () => {
    const { directory, user, env } = fixture();
    const rows = [inferred('theg', user.email), { ...inferred('theg1239', user.email), kind: 'agent' as const, agent: { name: 'Codex', tool: 'codex' } },
      { ...inferred('Original owner', user.email), confidence: 'braid' as const }];
    const first = await reconcileProvenance(env, rows);
    expect(first.slice(0, 2).map(row => personHandle(row.owner!))).toEqual(['@theg1239', '@theg1239']);
    expect(first[1]).toMatchObject({ agent: { name: 'Codex', tool: 'codex' }, confidence: 'inferred' });
    expect(first[2]).toBe(rows[2]);
    directory.setUsername(user, 'new-handle');
    expect((await reconcileProvenance(env, rows))[0].owner?.name).toBe('@new-handle');
  });
  it.each([false, true])('returns public labels and no emails from cached blame and provenance (public=%s)', async publicViewer => {
    const { env, user } = fixture();
    const rows = [inferred('theg', user.email), { ...inferred('theg1239', user.email), kind: 'agent' as const, agent: { name: 'Codex' } }];
    const blame: FileBlame = { path: 'README.md', ref: 'b'.repeat(40), lines: 2, ranges: rows.map((provenance, index) => ({ start: index + 1, lines: 1, provenance })) };
    Object.assign(env, { TRUNKS: { getByName: () => ({ blame: async () => ({ ok: true, data: blame }), provenance: async () => rows }) } });
    const gateway = { repository: 'imported', mode: 'live' as const, role: 'viewer' as const, publicViewer };
    const response = await changesRoute(new Request('https://braid.test/api/blame?path=README.md'), env, gateway);
    const text = await response!.text();
    expect(text).not.toContain(user.email); expect(text).not.toContain('"email"');
    expect((JSON.parse(text) as FileBlame).ranges.map(range => personHandle(range.provenance.owner!))).toEqual(['@theg1239', '@theg1239']);
    const provenance = await changesRoute(new Request(`https://braid.test/api/provenance?commits=${'a'.repeat(40)}`), env, gateway);
    expect(await provenance!.text()).not.toContain('"email"');
  });
});
