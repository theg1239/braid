import { expect, it, vi } from 'vitest';
import { publicRepository } from '../test/public-repository';
import { storageFixture } from '../test/storage';
import { seedWorkspace } from '../workspace/seed';
import { Workspace } from '../workspace/workspace';
import { anonymousNetwork } from '../http/public-access';
import { digest, sessionToken } from '../http/auth';
import type { BraidEnv } from '../env';

it.each([false, true])('regression control: both search gateways replace forged internal headers (member=%s)', async member => {
  const f = await publicRepository(), db = storageFixture();
  try {
    const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'fixture', namespace: 'fixture' });
    seed.project = { ...seed.project, id: 'repo', head: f.base, branch: 'main' };
    await db.storage.put('workspace', seed);
    const workspace = new Workspace(db.ctx, f.env); await db.ready();
    f.env.WORKSPACES = { idFromName: (name: string) => name, get: () => workspace, getByName: () => f.h.workspace } as unknown as BraidEnv['WORKSPACES'];
    let cookie = '';
    if (member) {
      const user = { id: 'member-fixture', name: 'Member', email: 'member@example.test' };
      const invite = await f.directory.invite(f.alice.id, 't', { email: user.email, role: 'member' });
      await f.directory.accept(user, invite.token);
      const token = await sessionToken(f.env.SESSION_SECRET);
      await f.security.issue(await digest(token), Date.now() + 60_000, user);
      cookie = `__Host-braid-session=${token}`;
    }
    for (let i = 0; i < 30; i++) expect(f.h.trunk.publicBuild(`network-${i}`).allowed).toBe(true);
    const budget = vi.spyOn(f.h.trunk, 'publicBuild');
    const forwarded = vi.spyOn(workspace, 'fetch');
    const forged = { cookie, 'x-braid-public': member ? 'true' : 'false', 'x-braid-public-network': 'forged-network' };
    const direct = await f.anonymous('/api/repository/search?q=Relay', forged);
    expect(direct.status).toBe(member ? 200 : 503);
    const query = `repo:${f.team.slug}/${f.team.workspaces[0].slug} Relay`;
    const global = await f.anonymous(`/api/search?${new URLSearchParams({ q: query })}`, forged);
    expect(global.status).toBe(200);
    expect(await global.json()).toMatchObject(member ? { unavailable: [], matchCount: 1 } : { unavailable: [{ name: f.team.workspaces[0].slug }], matchCount: 0 });
    expect(forwarded).toHaveBeenCalledTimes(2);
    const network = await digest(anonymousNetwork('198.51.100.7'));
    for (const [request] of forwarded.mock.calls) {
      expect(request.headers.get('x-braid-public')).toBe(member ? null : 'true');
      expect(request.headers.get('x-braid-public-network')).toBe(member ? null : network);
    }
    if (member) expect(budget).not.toHaveBeenCalled();
    else for (const [charged] of budget.mock.calls) expect(charged).toBe(network);
  } finally {
    await db.settled(); db.db.close(); await f.close(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
