import { describe, expect, it } from 'vitest';
import { landedProvenance, ownerOf } from './provenance';
import { changesRoute } from '../changes/router';
import { publicResponse } from '../http/public-view';
import type { BraidEnv } from '../env';
import type { ChangeAuthor, Provenance } from '../../shared/types';

const author: ChangeAuthor = { kind: 'agent', id: 'agent:fixture', name: 'Codex', tool: 'codex',
  owner: ownerOf({ id: 'email:fixture-private@example.test', name: 'Fixture', username: 'fixture' }, { id: 17, login: 'fixture' }) };
const paths = ['content', 'path', 'before', 'after', 'paths', 'beforePath', 'afterPath', 'access-token.ts', 'credentials.ts', 'email'];
const provenance = landedProvenance('a'.repeat(40), '2026-10-13T00:00:00Z', {
  changeId: 'ch_0000000000000', number: 1, revision: 1, title: 'Task merge', author,
  fileAuthors: Object.fromEntries(paths.map(path => [path, author])), approvedBy: 'Fixture',
});

describe('per-file provenance is metadata even when a filename is a reserved metadata key', () => {
  it.each([false, true])('does not leak owner email through the actual provenance route (public=%s)', async publicViewer => {
    const env = { TRUNKS: { getByName: () => ({ provenance: async () => [provenance] }) },
      DIRECTORY: { idFromName: () => 'directory', get: () => ({ publicPerson: async () => 'opaque-person' }) } } as unknown as BraidEnv;
    const request = new Request(`https://braid.test/api/provenance?commits=${provenance.commit}`);
    let response = (await changesRoute(request, env, { repository: 'fixture', mode: 'live', role: 'viewer', publicViewer }))!;
    if (publicViewer) response = await publicResponse(response, '/api/provenance', env);
    const text = await response.text();
    expect.soft(text).not.toContain(author.owner!.email);
    expect.soft(text).not.toContain('fixture-private@example.test');
    if (publicViewer) expect.soft(text).not.toContain(author.owner!.id);
    const [row] = JSON.parse(text) as Provenance[];
    expect.soft(Object.keys(row.files!).sort()).toEqual([...paths].sort());
    for (const path of paths) {
      expect.soft(row.files?.[path]?.agent?.name, path).toBe('Codex');
      expect.soft(row.files?.[path]?.owner?.email, path).toBeUndefined();
    }
  });
});
