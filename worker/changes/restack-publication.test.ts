import { expect, it, vi } from 'vitest';
import api from '../http/api';
import { digest, sessionToken } from '../http/auth';
import { publicRepository } from '../test/public-repository';
import { storageFixture } from '../test/storage';
import { Workspace } from '../workspace/workspace';
import { seedWorkspace } from '../workspace/seed';
import type { BraidEnv } from '../env';

const ok = <T>(result: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

it('does not publish a withheld prerequisite through a restack Git branch', async () => {
  const f = await publicRepository(), store = storageFixture();
  try {
    // Entirely synthetic scanner fixture, never a real credential.
    const syntheticSecret = 'ghp_' + 'A1b2'.repeat(9);
    const confidential = `export const key = '${syntheticSecret}';\n// unpublished customer ledger\n`;
    const parent = ok(await f.h.submit('parent', { title: 'Configure client', summary: 'Configure client', baseCommit: f.base,
      files: [{ path: 'client.ts', content: confidential }] }));
    const child = ok(await f.h.submit('child', { title: 'Write client docs', summary: 'Write client docs', baseCommit: f.base,
      dependsOn: [parent.id], files: [{ path: 'guide.md', content: 'Client usage\n' }] }));
    const withheld = await f.anonymous(`/api/changes/${parent.id}/diff?path=client.ts`);
    expect(await withheld.json()).toMatchObject({ withheld: true, before: null, after: null });
    expect(f.h.git.native(['for-each-ref', '--format=%(refname)', 'refs/heads/braid/stacks/'])).toBe('');

    const token = await sessionToken(f.env.SESSION_SECRET);
    await f.security.issue(await digest(token), Date.now() + 86_400_000, f.alice);
    const restacked = await api.fetch(new Request(`https://braid.example/api/changes/${child.id}/restack`, {
      method: 'POST', headers: { cookie: `__Host-braid-session=${token}`, 'x-braid-workspace': 'w',
        origin: 'https://braid.example', 'content-type': 'application/json', 'idempotency-key': 'r6-restack-withheld-parent' },
      body: JSON.stringify({ previousRevision: 1 }),
    }), f.env);
    expect.soft(restacked.status, 'A withheld prerequisite must be cleaned before materializing it in Git').toBe(409);
    expect(f.h.head()).toBe(f.base); // Main staying fixed does not make publishing another branch safe.

    const advertisement = await f.anonymous('/git/w.git/info/refs?service=git-upload-pack');
    expect(advertisement.status).toBe(200);
    const wire = await advertisement.text();
    const published = /([0-9a-f]{40}) refs\/heads\/braid\/stacks\//.exec(wire)?.[1];
    expect.soft(published, 'The unsigned Git advertisement exposes the new stack commit').toBeUndefined();

    // Use the real Workspace file API to demonstrate retrieval without any member credentials.
    const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false,
      authenticated: true, storage: 'durable-object', model: 'fixture', namespace: 'fixture' });
    seed.project = { ...seed.project, id: 'repo', head: f.base, branch: 'main' };
    await store.storage.put('workspace', seed);
    const workspace = new Workspace(store.ctx, f.env); await store.ready();
    f.env.WORKSPACES = { idFromName: (name: string) => name, get: () => workspace, getByName: () => f.h.workspace } as unknown as BraidEnv['WORKSPACES'];
    if (published) {
      const leaked = await f.anonymous(`/api/repository?ref=${published}&path=client.ts`);
      expect(leaked.status).toBe(200);
      const text = await leaked.text();
      expect.soft(text).not.toContain(syntheticSecret);
      expect.soft(text).not.toContain('unpublished customer ledger');
    }
  } finally {
    await store.settled(); store.db.close(); await f.close(); vi.unstubAllGlobals();
  }
});
