import { organizationWithRepository } from '../test/organization';
import { afterEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import { Directory } from '../accounts/directory';
import { publicMetadata } from './public-view';
import { gitAuthor, ownerOf } from '../repositories/provenance';
import { RESERVED_OWNERS } from '../../shared/routes';
import { parsePath } from '../../src/lib/address';
import { storageFixture } from '../test/storage';
import { unoccupiedGitHubNames } from '../test/github-names';
import { publicRepository } from '../test/public-repository';
import type { BraidEnv } from '../env';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => { if (!result.ok) throw new Error(result.error); return result.data; };

describe('public repository security review regressions', () => {
  it('redacts Braid metadata while preserving content fields', () => {
    const token = 'braid_agent_' + 'a1b2c3d4'.repeat(8);
    expect(publicMetadata({ before: token, after: token, content: token, actor: 'josé@example.com', reviewer: 'renée@exämple.org' }))
      .toEqual({ before: token, after: token, content: token, actor: '[private email]', reviewer: '[private email]' });
  });
  it('uses the Directory public identity in Git author addresses', () => {
    const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
    const person = { id: 'email:alice.smith@corp.example', name: 'alice.smith' };
    const author = gitAuthor({ kind: 'agent', id: 'agent:a', name: 'Claude', owner: ownerOf(person, null, directory.recordPerson(person.id)) });
    expect(author.email).toMatch(/^[a-f0-9]{32}@people\.braid\.local$/);
    expect(author.email).not.toContain('alice');
    db.db.close();
  });
  it('gives reserved and non-Latin team names reachable addresses and private defaults', () => {
    const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
    ['你好', 'Blob', 'Tree', 'Blame', 'Changes', 'Missions', 'Policy', 'Rules', 'Context', 'Landing', 'cdn-cgi'].forEach((name, index) => {
      const team = organizationWithRepository(directory, { id: `u${index}`, email: `u${index}@example.com`, name: `U${index}` }, name);
      expect(RESERVED_OWNERS.has(team.slug)).toBe(false);
      expect(parsePath(`/${team.slug}/${team.workspaces[0].slug}`).repo).not.toBeNull();
      expect(team.workspaces[0].visibility).toBe('private');
      if (name === '你好') expect(team.slug).toMatch(/^organization-[a-z0-9]{6}$/);
    });
    const owner = { id: 'non-latin', email: 'owner@example.com', name: 'Owner' }, team = organizationWithRepository(directory, owner, '你好');
    expect(team.slug).not.toBe(directory.list({ id: 'u0', email: 'u0@example.com', name: 'U0' })[0].slug);
    expect(directory.createWorkspace(owner.id, team.id, '你好').slug).toMatch(/^repo-[a-z0-9]{6}$/);
    db.db.close();
  });
  it('withholds the whole unlanded secret revision through the real gateway and shard', async () => {
    const f = await publicRepository();
    try {
      const token = 'braid_agent_' + 'a1b2c3d4'.repeat(8);
      const change = ok(await f.h.submit('sable', { title: 'Configure the client', summary: 'Configure the client', baseCommit: f.base, files: [{ path: 'src/client.ts', content: `export const token = '${token}';\nconst unpublished = true;\n` }] }));
      await f.h.settle();
      const response = await f.anonymous(`/api/changes/${change.id}/diff?path=src/client.ts`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ before: null, after: null, withheld: true });
    } finally { await f.close(); }
  });
  it('rejects account-id probes in the public author filter', async () => {
    const f = await publicRepository();
    try {
      ok(await f.h.submit({ kind: 'owner', id: `user:${f.alice.id}`, name: f.alice.email }, { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\n\nDocs.\n' }] }));
      for (const email of ['alice@corp.example', 'bob@corp.example']) expect((await f.anonymous(`/api/changes?author=${encodeURIComponent(`user:email:${email}`)}`)).status).toBe(400);
    } finally { await f.close(); }
  });
  it('caps anonymous provenance and never loads unknown commits from Artifacts', async () => {
    const f = await publicRepository();
    try {
      const reads = vi.spyOn(f.h.git.repository, 'readCommit');
      const shas = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(40, 'f'));
      expect((await f.anonymous(`/api/provenance?commits=${shas.join(',')}`)).status).toBe(400);
      for (let round = 0; round < 3; round++) {
        const response = await f.anonymous(`/api/provenance?commits=${shas.slice(0, 20).join(',')}`);
        expect(response.status).toBe(200); expect(await response.json()).toEqual([]);
      }
      expect(reads).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});

describe('remaining publication boundaries', () => {
  it('lets only owners rename fallback addresses with strict bodies and reserved-name protection', async () => {
    unoccupiedGitHubNames();
    const f = await publicRepository();
    try {
      const { digest, sessionToken } = await import('./auth');
      const ownerToken = await sessionToken(f.env.SESSION_SECRET);
      await f.security.issue(await digest(ownerToken), Date.now() + 86400000, f.alice);
      const patch = (body: unknown, token = ownerToken) => api.fetch(new Request('https://braid.example/api/teams/t', { method: 'PATCH', headers: { cookie: `__Host-braid-session=${token}`, 'content-type': 'application/json', origin: 'https://braid.example' }, body: JSON.stringify(body) }), f.env);
      expect((await patch({ slug: 'blob' })).status).toBe(400);
      expect((await patch({ slug: 'changed', visibility: 'public' })).status).toBe(400);
      const member = { id: 'member', email: 'member@example.com', name: 'Member' }, memberToken = await sessionToken(f.env.SESSION_SECRET);
      await f.directory.accept(member, (await f.directory.invite(f.alice.id, 't', { email: member.email, role: 'member' })).token);
      await f.security.issue(await digest(memberToken), Date.now() + 86400000, member);
      expect((await patch({ slug: 'changed' }, memberToken)).status).toBe(403);
      const response = await patch({ slug: 'changed' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 't', slug: 'changed', workspaces: [expect.objectContaining({ id: 'w' })] });
      expect(await f.directory.resolveRepository(null, 'changed', 'repository')).toMatchObject({ ok: true, data: { workspaceId: 'w' } });
      const other = organizationWithRepository(f.directory, f.alice, 'Other');
      expect((await patch({ slug: other.slug })).status).toBe(409);
    } finally { await f.close(); }
  });
  it('revokes live leaked credentials in another workspace, including their minted access tokens, and audits without storing the token', async () => {
    const f = await publicRepository();
    try {
      const { digest } = await import('./auth');
      const { mintAccess } = await import('./agent-token');
      const workspace = f.directory.createWorkspace(f.alice.id, 't', 'Other').id;
      const token = 'braid_agent_' + 'b2c3d4e5'.repeat(8);
      const grant = { id: 'connection-other', user: f.alice, workspaceId: workspace, scope: 'work' as const, label: 'Claude', expires: Date.now() + 86400000 };
      await f.security.issueAgent(await digest(token), grant);
      const access = await mintAccess(f.env, { grant: grant.id, user: f.alice, workspace, team: 't', agent: grant.id, name: 'Claude', scope: 'work', exp: Date.now() + 300000 });
      const change = ok(await f.h.submit('sable', { title: 'Client', summary: 'Client', baseCommit: f.base, files: [{ path: 'client.ts', content: token }] }));
      expect(f.security.agent(await digest(token))).toBeNull();
      expect((await f.anonymous('/api/state', { authorization: `Bearer ${access}`, 'x-braid-workspace': workspace })).status).toBe(401);
      expect(change.next).toContain('Revoked 1 live Braid connection');
      expect(f.directory.auditLog(f.alice.id, 't', Number.MAX_SAFE_INTEGER)).toContainEqual(expect.objectContaining({ action: 'agent.secret-revoked', target: grant.id }));
      expect(JSON.stringify(f.securityDb.db.prepare('SELECT * FROM security_audit').all())).not.toContain(token);
      const accessGrant = { ...grant, id: 'access-only' };
      await f.security.issueAgent(await digest('braid_agent_' + 'c3d4e5f6'.repeat(8)), accessGrant);
      const leakedAccess = await mintAccess(f.env, { grant: accessGrant.id, user: f.alice, workspace, team: 't', agent: accessGrant.id, name: 'Claude', scope: 'work', exp: Date.now() + 300000 });
      ok(await f.h.submit('sable', { title: 'Other client', summary: 'Other client', baseCommit: f.base, files: [{ path: 'other.ts', content: leakedAccess }] }));
      expect(f.security.accessRevoked(accessGrant.id)).toBe(true);
    } finally { await f.close(); }
  });
  it('keeps an earlier secret revision withheld after a clean revision and preserves member diffs', async () => {
    const f = await publicRepository();
    try {
      const { shardOf } = await import('../changes/names');
      const token = 'braid_agent_' + 'd4e5f6a7'.repeat(8);
      const change = ok(await f.h.submit('sable', { title: 'Client', summary: 'Client', baseCommit: f.base, files: [{ path: 'client.ts', content: token }] }));
      const shard = f.h.shard(shardOf(change.id)!);
      ok(await shard.revise(f.h.context('sable', shardOf(change.id)!), change.id, { previousRevision: 1, baseCommit: f.base, summary: 'Clean', files: [{ path: 'client.ts', content: 'const safe = true;' }] }, 'clean-revision-request-1234'));
      for (const suffix of ['revision=1', 'revision=2&since=1']) expect(await (await f.anonymous(`/api/changes/${change.id}/diff?path=client.ts&${suffix}`)).json()).toMatchObject({ before: null, after: null, withheld: true });
      expect(ok(await shard.diff(f.h.repository, change.id, 'client.ts', 1)).after).toBe(token);
      expect(await (await f.anonymous(`/api/changes/${change.id}/diff?path=client.ts`)).json()).toMatchObject({ after: 'const safe = true;' });
    } finally { await f.close(); }
  });
  it('allows only opaque roster ids for public author and agent filters', async () => {
    const f = await publicRepository();
    try {
      ok(await f.h.submit({ kind: 'agent', id: 'agent:claude', name: 'Claude', model: 'claude', owner: ownerOf(f.alice, null) }, { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
      const roster = await (await f.anonymous('/api/agents')).json() as { id: string }[];
      expect(roster[0].id).toMatch(/^roster:[a-f0-9]{64}$/);
      for (const filter of ['author', 'agent']) expect(await (await f.anonymous(`/api/changes?${filter}=${roster[0].id}`)).json()).toMatchObject({ items: [expect.objectContaining({ title: 'Docs' })] });
      expect((await f.anonymous(`/api/changes?agent=${encodeURIComponent('claude|user:email:alice@corp.example|')}`)).status).toBe(400);
    } finally { await f.close(); }
  });
  it('shares IPv6 /64 budgets and caches positive and unknown publicRead lookups for at most five seconds', async () => {
    const { anonymousNetwork, publicRead } = await import('./public-access');
    expect(anonymousNetwork('2001:db8:abcd:42::1')).toBe(anonymousNetwork('2001:0db8:abcd:0042:ffff::2'));
    expect(anonymousNetwork('::1')).toBe('0:0:0:0::/64');
    expect(anonymousNetwork('203.0.113.7')).toBe('203.0.113.7');
    const f = await publicRepository();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const lookup = vi.spyOn(f.directory, 'publicRead');
      await Promise.all([publicRead(f.env, 'w'), publicRead(f.env, 'w'), publicRead(f.env, 'unknown'), publicRead(f.env, 'unknown')]);
      expect(lookup).toHaveBeenCalledTimes(2);
      f.directory.updateWorkspace(f.alice.id, { teamId: 't', workspaceId: 'w', visibility: 'private' });
      vi.advanceTimersByTime(5001);
      expect(await publicRead(f.env, 'w')).toMatchObject({ ok: false, status: 404 });
      f.env.ANONYMOUS_LIMITER = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
      expect((await f.anonymous('/api/repos?limit=20')).status).toBe(429);
    } finally { vi.useRealTimers(); await f.close(); }
  });
  it('never migrates visibility or reads unmigrated workspaces for anonymous directory requests', async () => {
    const db = storageFixture(), metadata = vi.fn(async () => ({ sourcePublic: true, description: 'Legacy' }));
    const directory = new Directory(db.ctx, { WORKSPACES: { getByName: () => ({ publicationMetadata: metadata }) } } as unknown as BraidEnv);
    const team = organizationWithRepository(directory, { id: 'owner', email: 'owner@example.com', name: 'Owner' }, 'Legacy');
    const workspace = team.workspaces[0];
    db.db.prepare('UPDATE workspaces SET legacy_visibility = 1').run();
    const writes = db.db.prepare('SELECT total_changes() AS total').get()!.total;
    await directory.publicRead(workspace.id); await directory.publicRead('unknown'); await directory.resolveRepository(null, team.slug, workspace.slug); await directory.publicRepositories(100);
    expect(metadata).not.toHaveBeenCalled();
    expect(db.db.prepare('SELECT total_changes() AS total').get()!.total).toBe(writes);
    db.db.close();
  });
  it('does not spend demo sessions on any /git/demo.git path', async () => {
    const f = await publicRepository();
    try {
      const sessions = vi.spyOn(f.security, 'exampleSession');
      for (let index = 0; index < 15; index++) expect((await f.anonymous('/git/demo.git/info/refs?service=git-upload-pack')).status).toBe(404);
      expect(sessions).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('uses one not-found message for unknown and other-team workspaces', () => {
    const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
    const team = organizationWithRepository(directory, { id: 'owner', email: 'owner@example.com', name: 'Owner' }, 'Private');
    for (const workspace of ['unknown', team.workspaces[0].id]) expect(() => directory.authorize('outsider', workspace, false)).toThrow('Repository not found.');
    db.db.close();
  });
  it('locks private GitHub links, audits forced privacy and permits public links without republishing', () => {
    const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
    const user = { id: 'owner', email: 'owner@example.com', name: 'Owner' }, team = organizationWithRepository(directory, user, 'Linked', 'public'), workspace = team.workspaces[0].id;
    directory.repositoryLinked(workspace, true, user.id);
    expect(directory.list(user)[0].workspaces[0].visibility).toBe('private');
    expect(() => directory.updateWorkspace(user.id, { teamId: team.id, workspaceId: workspace, visibility: 'public' })).toThrow('The linked GitHub repository is private.');
    expect(directory.auditLog(user.id, team.id, Number.MAX_SAFE_INTEGER)).toContainEqual(expect.objectContaining({ action: 'repository.made-private' }));
    directory.repositoryLinked(workspace, false, user.id);
    expect(directory.list(user)[0].workspaces[0].visibility).toBe('private');
    expect(directory.updateWorkspace(user.id, { teamId: team.id, workspaceId: workspace, visibility: 'public' }).visibility).toBe('public');
    db.db.close();
  });
});

describe('public read publication surfaces', () => {
  it('withholds secret tasks everywhere and redacts only Braid metadata', async () => {
    const f = await publicRepository(), db = storageFixture();
    try {
      const { seedWorkspace } = await import('../workspace/seed');
      const { Workspace } = await import('../workspace/workspace');
      const { publicPathAllowed } = await import('./agent-auth');
      const token = 'braid_agent_' + 'e5f6a7b8'.repeat(8);
      const secret = ok(await f.h.submit('sable', { title: 'Configure', summary: 'Configure', baseCommit: f.base, files: [{ path: 'src/client.ts', content: `${token}\nconst unpublished = true;` }] }));
      const seed = seedWorkspace('demo', { mode: 'live', artifacts: true, ai: true, storage: 'durable-object', authenticated: true, canWrite: false, model: 'test', namespace: 'test' });
      seed.project = { id: 'repo', name: 'Repo', description: 'Contact josé@example.com', head: f.base, branch: 'main', stack: [] };
      seed.context = [{ id: 'note', title: 'Contact', body: 'renée@exämple.org', author: f.alice.email, kind: 'constraint', createdAt: new Date().toISOString() }];
      const mission = seed.missions[0];
      mission.id = 'mission-public'; mission.baseCommit = f.base; mission.source = 'live'; mission.collisions = [];
      mission.agents = [{ ...mission.agents[0], changes: [{ path: 'src/client.ts', before: '', after: `${token}\nconst unpublished = true;`, additions: 2, deletions: 0 }, { path: 'safe.ts', before: '', after: 'const unpublishedOtherFile = true;', additions: 1, deletions: 0 }], change: { id: secret.id, number: secret.number, status: secret.status } }];
      mission.reviewSelection = { agentIds: [mission.agents[0].id], actor: f.alice.email, selectedAt: new Date().toISOString() };
      const root = f.h.git.commitTree({ 'README.md': '# Contact josé@example.com\n', 'src/router.ts': 'export const routes = [];\n' });
      f.h.git.native(['update-ref', 'refs/heads/main', root]); seed.project.head = root;
      db.db.exec('CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      for (const key of ['project', 'context', 'activity', 'capabilities'] as const) db.db.prepare('INSERT INTO records VALUES (?, ?)').run(key, JSON.stringify(seed[key]));
      db.db.prepare('INSERT INTO records VALUES (?, ?)').run('mission-order', JSON.stringify([mission.id]));
      db.db.prepare('INSERT INTO records VALUES (?, ?)').run(`mission:${mission.id}`, JSON.stringify(mission));
      db.db.prepare('INSERT INTO records VALUES (?, ?)').run('line-stats-version', '1');
      db.db.prepare('INSERT INTO records VALUES (?, ?)').run('revision', '1');
      await db.storage.put('repository-key', f.h.repository);
      const getArtifacts = f.h.artifacts.get.getMockImplementation()!;
      f.h.artifacts.get.mockImplementation(async () => ({ ...await getArtifacts(), readFile: async ({ ref, path }: { ref: string; path: string }) => new Blob([f.h.git.native(['show', `${ref}:${path}`])]) }) as never);
      const workspace = new Workspace(db.ctx, f.env); await db.ready();
      f.env.WORKSPACES = { ...f.env.WORKSPACES, get: () => workspace } as unknown as BraidEnv['WORKSPACES'];
      await f.h.trunk.blame(f.h.repository, 'README.md');
      await f.h.trunk.provenance(f.h.repository, [f.base]);
      const totals = db.db.prepare('SELECT total_changes() AS total').get()!.total;
      const paths = ['/api/state', '/api/repository/tree', '/api/repository?path=README.md', '/api/repository?path=README.md&download=1', '/api/changes', `/api/changes/${secret.id}`, `/api/changes/${secret.id}/diff?path=src/client.ts`, `/api/changes/${secret.id}/compare?since=1`, `/api/changes/${secret.id}/evidence/${'a'.repeat(64)}.png`, '/api/queue', '/api/coordination?paths=src/client.ts', '/api/coordination/hot', '/api/policy', '/api/instructions', '/api/blame?path=README.md', `/api/provenance?commits=${f.base}`, '/api/agents', '/api/missions', '/api/tasks', ...['missions', 'tasks'].flatMap(prefix => [`/api/${prefix}/${mission.id}`, `/api/${prefix}/${mission.id}/integration`, `/api/${prefix}/${mission.id}/diff?agent=${mission.agents[0].id}&path=safe.ts`])];
      const { EMAIL_PATTERN } = await import('../../shared/privacy');
      for (const path of paths) {
        expect(publicPathAllowed(new URL(path, 'https://braid.example').pathname, 'GET'), path).toBe(true);
        const response = await f.anonymous(path), text = await response.text();
        expect(response.status, path).toBeLessThan(500);
        if (!path.startsWith('/api/repository?')) expect(text, path).not.toMatch(EMAIL_PATTERN);
        expect(text, path).not.toContain(token);
        expect(text, path).not.toContain('const unpublished');
      }
      expect(db.db.prepare('SELECT total_changes() AS total').get()!.total).toBe(totals);
      const { integrationPreview } = await import('../workspace/integration');
      const preview = await integrationPreview(mission, mission.baseCommit, seed.context);
      expect(preview.handoff).not.toMatch(EMAIL_PATTERN);
    } finally { db.db.close(); await f.close(); }
  });
});

describe('attribution and queue caching', () => {
  it('serves warm blame, provenance and comparisons with no Artifacts calls or storage writes', async () => {
    const f = await publicRepository();
    try {
      await f.h.trunk.blame(f.h.repository, 'README.md');
      const member = await f.h.trunk.provenance(f.h.repository, [f.base]);
      const change = ok(await f.h.submit('sable', { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
      const { shardOf } = await import('../changes/names');
      const index = shardOf(change.id)!, shard = f.h.shard(index);
      ok(await shard.revise(f.h.context('sable', index), change.id, { previousRevision: 1, baseCommit: f.base, summary: 'More docs', files: [{ path: 'README.md', content: '# Relay\nMore docs\n' }] }, 'readonly-revision-request-1234'));
      const shardSql = (shard as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      shardSql.exec("INSERT OR REPLACE INTO meta VALUES ('directory-activity', '2099-01-01T00:00:00.000Z')");
      const shardWrites = shardSql.exec<{ total: number }>('SELECT total_changes() AS total').one().total;
      const activity = vi.spyOn(f.directory, 'repositoryActivity'); activity.mockClear();
      const sql = (f.h.trunk as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      const writes = sql.exec<{ total: number }>('SELECT total_changes() AS total').one().total;
      const artifacts = vi.spyOn(f.h.artifacts, 'get'); artifacts.mockClear();
      expect(await (await f.anonymous(`/api/provenance?commits=${f.base}`)).json()).toEqual(publicMetadata(member));
      expect((await f.anonymous('/api/blame?path=README.md')).status).toBe(200);
      for (const suffix of ['', '/diff?path=README.md', '/compare?since=1']) expect((await f.anonymous(`/api/changes/${change.id}${suffix}`)).status).toBe(200);
      expect(artifacts).not.toHaveBeenCalled(); expect(activity).not.toHaveBeenCalled();
      expect(shardSql.exec<{ total: number }>('SELECT total_changes() AS total').one().total).toBe(shardWrites);
      expect(sql.exec<{ total: number }>('SELECT total_changes() AS total').one().total).toBe(writes);
    } finally { await f.close(); }
  });
  it('withholds private or unknown GitHub queue links and preserves known public links', async () => {
    const f = await publicRepository();
    try {
      const sql = (f.h.trunk as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      const set = (key: string, value: unknown) => sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?)', key, JSON.stringify(value));
      const link = { fullName: 'acme/private-repo', defaultBranch: 'main', mode: 'pull-requests', linkedBy: 'Owner', linkedAt: new Date().toISOString() };
      set('verifying', [{ batch: { id: 'batch', status: 'verifying' }, plan: { entries: [] }, github: { pr: 3, url: 'https://github.com/acme/private-repo/pull/3', state: 'pending', reason: 'Checks pending' }, ci: { required: ['ci'], statuses: { ci: { url: 'https://ci.example/private-repo' } } } }]);
      for (const visibility of [undefined, true, false]) {
        set('github', { link: { ...link, private: visibility }, status: 'synced' });
        const text = await (await f.anonymous('/api/queue')).text();
        if (visibility === false) expect(text).toContain(link.fullName);
        else { expect(text).not.toContain(link.fullName); expect(text).not.toContain('https://'); }
      }
      expect(JSON.stringify(await f.h.trunk.status(f.h.repository))).toContain(link.fullName);
    } finally { await f.close(); }
  });
  it('does not persist workspace initialization on public reads', async () => {
    const { Workspace } = await import('../workspace/workspace');
    const db = storageFixture(), workspace = new Workspace(db.ctx, {} as BraidEnv); await db.ready();
    const writes = db.db.prepare('SELECT total_changes() AS total').get()!.total;
    const put = vi.spyOn(db.storage, 'put');
    const response = await workspace.fetch(new Request('https://braid.example/api/state', { headers: { 'x-braid-mode': 'live', 'x-braid-public': 'true', 'x-braid-repository': 'team:t:repository:w' } }));
    expect(response.status).toBe(200); expect(put).not.toHaveBeenCalled();
    expect(db.db.prepare('SELECT total_changes() AS total').get()!.total).toBe(writes);
    db.db.close();
  });
});

describe('GitHub visibility synchronization', () => {
  it('rechecks privacy when an already verifying GitHub PR finishes', async () => {
    const f = await publicRepository();
    try {
      const { execFileSync } = await import('node:child_process');
      const { fakeGitHub } = await import('../test/fake-github');
      const github = fakeGitHub({ root: f.h.git.root, gitOrigin: f.h.git.remote.replace(/\/repo\.git$/, '') });
      Object.assign(f.h.env, github.env);
      execFileSync('git', ['--git-dir', github.path, 'fetch', '--quiet', `${f.h.git.root}/repo.git`, 'main:main']);
      const authorization = { user: f.alice, teamId: 't', workspaceId: 'w' };
      expect(await f.h.trunk.linkGitHub(f.h.repository, { ...github.link('pull-requests'), authorization })).toMatchObject({ ok: true });
      await f.h.trunk.configure(f.h.repository, { enabled: true, actor: 'Owner', authorization });
      github.state.checks = () => [{ name: 'ci / test', status: 'in_progress', conclusion: null }];
      const change = ok(await f.h.submit('sable', { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'docs.md', content: 'Docs\n' }] }));
      await f.h.settle(2);
      const status = await f.h.trunk.status(f.h.repository);
      expect(status.landing?.status).toBe('verifying');
      github.state.private = true;
      github.state.checks = () => [{ name: 'ci / test', status: 'completed', conclusion: 'success' }];
      github.protect(true);
      const writes = f.directory.repositoryLinked.bind(f.directory);
      vi.spyOn(f.directory, 'repositoryLinked').mockImplementation((workspace, isPrivate, actor) => {
        if (isPrivate) expect(f.h.head()).toBe(f.base);
        return writes(workspace, isPrivate, actor);
      });
      await f.h.trunk.githubEvent(f.h.repository, { name: 'check_suite', sha: status.landing!.head });
      await f.h.settle(1);
      expect(f.directory.list(f.alice)[0].workspaces[0].visibility).toBe('private');
      expect(await f.h.shard(Number.parseInt(change.id[3], 16)).get(change.id)).toMatchObject({ ok: true, data: { status: 'landed' } });
      expect(f.directory.auditLog(f.alice.id, 't', Number.MAX_SAFE_INTEGER)).toContainEqual(expect.objectContaining({ action: 'repository.made-private' }));
    } finally { await f.close(); }
  }, 60000);
  it('forces privacy before linking a private source and rechecks privacy before importing new commits', async () => {
    const f = await publicRepository();
    try {
      const { execFileSync } = await import('node:child_process');
      const { fakeGitHub } = await import('../test/fake-github');
      const github = fakeGitHub({ root: f.h.git.root, gitOrigin: f.h.git.remote.replace(/\/repo\.git$/, '') });
      Object.assign(f.h.env, github.env);
      execFileSync('git', ['--git-dir', github.path, 'fetch', '--quiet', `${f.h.git.root}/repo.git`, 'main:main']);
      const link = { ...github.link('pull-requests'), authorization: { user: f.alice, teamId: 't', workspaceId: 'w' } };
      github.state.private = true;
      expect(await f.h.trunk.linkGitHub(f.h.repository, link)).toMatchObject({ ok: true });
      expect(f.directory.list(f.alice)[0].workspaces[0].visibility).toBe('private');
      expect(() => f.directory.updateWorkspace(f.alice.id, { teamId: 't', workspaceId: 'w', visibility: 'public' })).toThrow('The linked GitHub repository is private.');
      await f.h.trunk.unlinkGitHub(f.h.repository);
      github.state.private = false;
      expect(await f.h.trunk.linkGitHub(f.h.repository, link)).toMatchObject({ ok: true });
      f.directory.updateWorkspace(f.alice.id, { teamId: 't', workspaceId: 'w', visibility: 'public' });
      const sourceHead = f.h.git.commitTree({ 'README.md': '# Private upstream\n', 'src/router.ts': 'export const routes = [];\n' }, f.base);
      execFileSync('git', ['--git-dir', github.path, 'fetch', '--quiet', `${f.h.git.root}/repo.git`, `${sourceHead}:refs/heads/incoming`]);
      github.git(['update-ref', 'refs/heads/main', sourceHead]);
      github.state.private = true;
      const { publicRead } = await import('./public-access');
      expect(await publicRead(f.env, 'w')).toMatchObject({ ok: true });
      let deadline = 0, imports = 0;
      const upstream = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === `${f.h.git.remote}/git-receive-pack` && init?.method === 'POST') {
          imports++;
          expect(Date.now()).toBeGreaterThanOrEqual(deadline);
          expect(await publicRead(f.env, 'w')).toMatchObject({ ok: false, status: 404 });
        }
        return upstream(input, init);
      });
      const writes = f.directory.repositoryLinked.bind(f.directory);
      const order = vi.spyOn(f.directory, 'repositoryLinked').mockImplementation((workspace, isPrivate, actor) => {
        if (isPrivate) expect(f.h.head()).toBe(f.base);
        deadline = writes(workspace, isPrivate, actor);
        return deadline;
      });
      ok(await f.h.submit('sable', { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'docs.md', content: 'Docs\n' }] }));
      await f.h.trunk.configure(f.h.repository, { enabled: true, actor: 'Owner', authorization: { user: f.alice, teamId: 't', workspaceId: 'w' } });
      await f.h.settle(2);
      expect(order).toHaveBeenCalledWith('w', true, f.alice.id);
      expect(imports).toBeGreaterThan(0);
      expect(f.directory.list(f.alice)[0].workspaces[0].visibility).toBe('private');
      expect(f.h.git.native(['show', 'main:README.md'])).toBe('# Private upstream\n');
      expect(f.directory.auditLog(f.alice.id, 't', Number.MAX_SAFE_INTEGER).filter(row => row.action === 'repository.made-private')).toHaveLength(2);
    } finally { await f.close(); }
  }, 60000);
});

