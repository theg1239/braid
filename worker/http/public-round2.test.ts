import { organizationWithRepository } from '../test/organization';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { publicRepository } from '../test/public-repository';
import { Directory } from '../accounts/directory';
import { storageFixture } from '../test/storage';
import { publicResponse } from './public-view';
import { anonymousNetwork } from './public-access';
import { addedBraidTokens, secretFindings } from '../../shared/secrets';
import { digest, sessionToken } from './auth';
import type { BraidEnv } from '../env';
import { gitAuthor, ownerOf, publicAuthor, publicRosterId, rosterId } from '../repositories/provenance';
import { agentKey } from '../../shared/provenance';
import { mintAccess } from './agent-token';
import { publicRead, waitForPublicReads } from './public-access';
import { pem } from '../test/pem';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => { if (!result.ok) throw new Error(result.error); return result.data; };

describe('round 2 publication regressions', () => {
  it('detects and serves a 500 KB base64 file in low tens of milliseconds', async () => {
    const content = Buffer.from(Array.from({ length: 375000 }, (_, i) => (i * 2654435761) >>> 24)).toString('base64');
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const files = [{ path: 'notebook.json', before: null, after: content }];
      expect(secretFindings(files)).toEqual([]);
      expect(addedBraidTokens(files)).toEqual([]);
      const response = await publicResponse(Response.json({ path: 'notebook.json', content }), '/api/repository');
      expect((await response.json() as { content: string }).content).toBe(content);
      samples.push(performance.now() - start);
    }
    const median = samples.sort((a, b) => a - b)[2];
    console.log(`500 KB detection + public serving median: ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(50);
  });

  it('revokes a live connection on a long line and withholds the entire revision in every state', async () => {
    const f = await publicRepository();
    try {
      const token = 'braid_agent_' + '5e6f7a8b'.repeat(8);
      await f.security.issueAgent(await digest(token), { id: 'long-line-grant', user: f.alice, workspaceId: 'w', scope: 'work', label: 'Agent', expires: Date.now() + 86400000 });
      const change = ok(await f.h.submit('sable', { title: 'Configure', summary: 'Configure', baseCommit: f.base, files: [{ path: 'config.json', content: `{"pad":"${'p'.repeat(16000)}","token":"${token}"}` }, { path: 'safe.ts', content: 'const unpublished = true;' }] }));
      await f.h.settle();
      expect(await f.security.agent(await digest(token))).toBeNull();
      const shard = f.h.shard(parseInt(change.id[3], 16));
      expect(ok(await shard.get(change.id))).toMatchObject({ status: 'revise', guards: [expect.objectContaining({ kind: 'secrets' })] });
      const sql = (shard as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      for (const status of ['open', 'closed', 'landing', 'landed']) {
        const stored = JSON.parse(sql.exec<{ value: string }>('SELECT value FROM changes WHERE id = ?', change.id).one().value);
        stored.status = status;
        sql.exec('UPDATE changes SET status = ?, value = ? WHERE id = ?', status, JSON.stringify(stored), change.id);
        const response = await f.anonymous(`/api/changes/${change.id}/diff?path=safe.ts`);
        expect(await response.json()).toMatchObject({ withheld: true, before: null, after: null });
      }
    } finally { await f.close(); }
  });

  it('withholds losing private-key proposals in merged tasks, state, integration and file reads', async () => {
    const f = await publicRepository(), db = storageFixture();
    try {
      const { seedWorkspace } = await import('../workspace/seed');
      const { Workspace } = await import('../workspace/workspace');
      const seed = seedWorkspace('demo', { mode: 'live', artifacts: true, ai: true, storage: 'durable-object', authenticated: true, canWrite: false, model: 'm', namespace: 'n' });
      seed.project = { id: 'repo', name: 'Repo', description: '', head: f.base, branch: 'main', stack: [] };
      const mission = seed.missions[0], body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
      mission.id = 'mission-merged-overlap'; mission.status = 'merged'; mission.source = 'live'; mission.baseCommit = f.base;
      mission.agents = mission.agents.slice(0, 2).map((agent, i) => ({ ...agent, status: 'merged', changes: [{ path: 'deploy/key.ts', before: '', after: i ? 'process.env.DEPLOY_KEY' : `${pem('PRIVATE')}\n${body}\n${pem('PRIVATE', 'END')}`, additions: 3, deletions: 0 }] }));
      mission.collisions = [{ id: 'overlap', path: 'deploy/key.ts', agentIds: mission.agents.map(a => a.id), resolution: { agentId: mission.agents[1].id, reason: 'Read environment', resolvedAt: new Date().toISOString() } }];
      db.db.exec('CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      for (const key of ['project', 'context', 'activity', 'capabilities'] as const) db.db.prepare('INSERT INTO records VALUES (?, ?)').run(key, JSON.stringify(seed[key]));
      for (const [key, value] of [['mission-order', JSON.stringify([mission.id])], [`mission:${mission.id}`, JSON.stringify(mission)], ['line-stats-version', '1'], ['revision', '1']]) db.db.prepare('INSERT INTO records VALUES (?, ?)').run(key, value);
      await db.storage.put('repository-key', f.h.repository);
      const workspace = new Workspace(db.ctx, f.env); await db.ready();
      f.env.WORKSPACES = { ...f.env.WORKSPACES, get: () => workspace } as unknown as BraidEnv['WORKSPACES'];
      for (const path of ['/api/state', `/api/missions/${mission.id}`, `/api/tasks/${mission.id}`, `/api/missions/${mission.id}/integration`, `/api/missions/${mission.id}/diff?agent=${mission.agents[0].id}&path=deploy/key.ts`]) {
        const response = await f.anonymous(path), text = await response.text();
        expect(response.status).toBe(200); expect(text).not.toContain(body); expect(text).toContain('"withheld":true');
      }
    } finally { db.db.close(); await f.close(); }
  });

  it('rescans legacy negative secret flags before serving older revisions or comparisons', async () => {
    const f = await publicRepository();
    try {
      const token = 'braid_agent_' + '7a8b9c0d'.repeat(8);
      const change = ok(await f.h.submit('sable', { title: 'Configure', summary: 'Configure', baseCommit: f.base, files: [{ path: 'config.json', content: JSON.stringify({ pad: 'p'.repeat(16000), token }) }, { path: 'safe.ts', content: 'const unpublished = true;' }] }));
      const index = parseInt(change.id[3], 16), shard = f.h.shard(index);
      const { ContentStore } = await import('../workspace/content');
      const content = new ContentStore((shard as unknown as { ctx: DurableObjectState }).ctx.storage);
      const key = `patch:${change.id}:1`, patch = content.get<Record<string, unknown>>(key)!;
      patch.secrets = false; delete patch.secretScanVersion;
      content.put(key, patch);
      ok(await shard.revise(f.h.context('sable', index), change.id, { previousRevision: 1, baseCommit: f.base, summary: 'Clean', files: [{ path: 'safe.ts', content: 'const safe = true;' }] }, 'legacy-negative-scan-revision-key'));
      expect(await (await f.anonymous(`/api/changes/${change.id}/diff?path=safe.ts&revision=1`)).json()).toMatchObject({ before: null, after: null, withheld: true });
      expect(await (await f.anonymous(`/api/changes/${change.id}/compare?since=1`)).json()).toMatchObject({ files: [], withheld: true });
      expect(await (await f.anonymous(`/api/changes/${change.id}/diff?path=safe.ts`)).json()).toMatchObject({ after: 'const safe = true;' });
      expect(ok(await shard.diff(f.h.repository, change.id, 'config.json', 1)).after).toContain(token);
    } finally { await f.close(); }
  });

  it('uses random stable people ids for legacy stored roster keys and author addresses', async () => {
    const f = await publicRepository();
    try {
      const owner = ownerOf(f.alice, null), author = { kind: 'agent' as const, id: 'agent:a', name: 'Claude', model: 'claude', owner };
      const key = agentKey(author)!;
      const publicId = f.directory.publicPerson(f.alice.id);
      expect(f.directory.publicPerson(`user:${f.alice.id}`)).toBe(publicId);
      expect(gitAuthor(await publicAuthor(f.env, author)).email).toBe(`${publicId}@people.braid.local`);
      const id = await publicRosterId(f.env, key);
      for (const domain of ['gmail.com', 'outlook.com', 'example.com', 'corp.example']) {
        const guessedOwner = `user:email:alice@${domain}`;
        expect(gitAuthor(await publicAuthor(f.env, author)).email).not.toBe(`${createHash('sha256').update(guessedOwner).digest('hex')}@people.braid.local`);
        expect(id).not.toBe(await rosterId(`claude|${guessedOwner}|`));
      }
      ok(await f.h.submit(author, { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
      expect(await (await f.anonymous('/api/agents')).json()).toMatchObject([{ id }]);
      expect(await (await f.anonymous(`/api/changes?agent=${id}`)).json()).toMatchObject({ items: [expect.objectContaining({ title: 'Docs' })] });
      const reopened = new Directory(f.db.ctx, { SESSION_SECRET: 'rotated-secret' } as BraidEnv);
      expect(reopened.publicPerson(f.alice.id)).toBe(publicId);
      expect(reopened.auditLog(f.alice.id, 't', Number.MAX_SAFE_INTEGER)[0].actor).toBe('Alice');
      expect((await publicAuthor(f.env, author)).owner?.id).toBe(owner.id);
    } finally { await f.close(); }
  });

  it('rechecks revocations on every request and immediately denies leaked access tokens', async () => {
    const f = await publicRepository();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const lookup = vi.spyOn(f.security, 'accessRevoked');
      const token = await mintAccess(f.env, { grant: 'grant', user: f.alice, workspace: 'w', team: 't', scope: 'work', agent: 'a', name: 'Agent', exp: Date.now() + 300000 });
      const membership = vi.spyOn(f.directory, 'access');
      for (let i = 0; i < 3; i++) expect((await f.anonymous('/api/queue', { authorization: `Bearer ${token}` })).status).toBe(200);
      expect(membership).toHaveBeenCalledTimes(3);
      expect(membership).toHaveBeenCalledWith({ ...f.alice, username: null, avatarUrl: null }, 'w', false);
      expect(lookup).toHaveBeenCalledTimes(3);
      const { setupGuide } = await import('./setup-guide');
      expect(setupGuide('/auth.md', 'https://braid.example', new URLSearchParams())).toContain('Connection revocation is rechecked on every request');
      await f.security.revokeLeakedToken(token);
      expect(f.security.accessRevoked('grant')).toBe(true);
      expect((await f.anonymous('/api/state', { authorization: `Bearer ${token}` })).status).toBe(401);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it('persists forced privacy and waits until every old public lookup lease expires before importing', async () => {
    const f = await publicRepository();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      expect(await publicRead(f.env, 'w')).toMatchObject({ ok: true });
      const until = f.directory.repositoryLinked('w', true, f.alice.id);
      expect(f.directory.list(f.alice)[0].workspaces[0].visibility).toBe('private');
      expect(f.directory.repositoryLinked('w', true, f.alice.id)).toBe(until);
      let imported = false;
      const pending = waitForPublicReads(until).then(() => { imported = true; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(imported).toBe(false);
      expect(await publicRead(f.env, 'w')).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(1); await pending;
      expect(imported).toBe(true);
      expect(await publicRead(f.env, 'w')).toMatchObject({ ok: false, status: 404 });
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it('omits CI and GitHub checks unless the linked GitHub source is known public', async () => {
    const f = await publicRepository();
    try {
      const change = ok(await f.h.submit('sable', { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
      const sql = (f.h.shard(parseInt(change.id[3], 16)) as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      const stored = JSON.parse(sql.exec<{ value: string }>('SELECT value FROM changes WHERE id = ?', change.id).one().value);
      stored.checks.push({ revision: 1, label: 'Private CI', status: 'passed', source: 'ci', detail: 'Private check https://ci.example/acme/private' }, { revision: 1, label: 'GitHub', status: 'passed', source: 'github', detail: 'https://github.com/acme/private/checks/1' });
      sql.exec('UPDATE changes SET value = ? WHERE id = ?', JSON.stringify(stored), change.id);
      const trunkSql = (f.h.trunk as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      for (const privacy of [undefined, true, false]) {
        trunkSql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?)', 'github', JSON.stringify({ link: { fullName: 'acme/private', private: privacy } }));
        const text = await (await f.anonymous(`/api/changes/${change.id}`)).text();
        if (privacy === false) expect(text).toContain('https://ci.example');
        // Braid's own link to the pull request is not a check's; no external address may remain.
        else { expect(text.replace(/"html_url":"https:\/\/braid\.example\/[^"]*"/g, '')).not.toContain('https://'); expect(text).not.toContain('Private CI'); }
      }
      expect(JSON.stringify(ok(await f.h.shard(parseInt(change.id[3], 16)).get(change.id)))).toContain('https://ci.example');
    } finally { await f.close(); }
  });

  it('returns retryable 503 when the shared repository cold-build budget is exhausted', async () => {
    const f = await publicRepository();
    const cacheDb = storageFixture();
    try {
      const change = ok(await f.h.submit('sable', { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
      const shard = f.h.shard(parseInt(change.id[3], 16));
      ok(await shard.revise(f.h.context('sable', parseInt(change.id[3], 16)), change.id, { previousRevision: 1, baseCommit: f.base, summary: 'More docs', files: [{ path: 'README.md', content: '# Relay\nMore docs\n' }] }, 'cold-diff-budget-request-key'));
      (shard as unknown as { cache: unknown }).cache = new (await import('../changes/cache')).ObjectCache(cacheDb.storage.sql);
      (f.h.trunk as unknown as { policyCache: unknown }).policyCache = undefined;
      for (let i = 0; i < 30; i++) f.h.trunk.publicBuild(`network-${i % 3}`);
      const { Trunk } = await import('../changes/trunk');
      const reopened = new Trunk((f.h.trunk as unknown as { ctx: DurableObjectState }).ctx, f.h.env);
      expect(reopened.publicBuild().allowed).toBe(false);
      for (const path of ['/api/policy', '/api/instructions', '/api/blame?path=README.md', `/api/changes/${change.id}/diff?path=README.md`, `/api/changes/${change.id}/compare?since=1`]) {
        const response = await f.anonymous(path);
        expect(response.status, path).toBe(503); expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      }
      expect((await f.h.trunk.policy(f.h.repository)).head).toBe(f.base);
      expect((await f.anonymous('/api/policy')).status).toBe(200);
      // Members can fill the cache even while public builds are exhausted.
      expect(ok(await shard.diff(f.h.repository, change.id, 'README.md')).after).toContain('More docs');
      expect((await f.anonymous(`/api/changes/${change.id}/diff?path=README.md`)).status).toBe(200);
    } finally { cacheDb.db.close(); await f.close(); }
  });

  it('shares a 60/minute expensive budget across public endpoints and exempts members', async () => {
    const f = await publicRepository();
    try {
      const change = ok(await f.h.submit('sable', { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
      for (let i = 0; i < 60; i++) expect((await f.anonymous(`/api/changes/${change.id}/diff?path=README.md`)).status).toBe(200);
      for (const path of [`/api/changes/${change.id}/diff?path=README.md`, '/api/repository?path=README.md&download=1', '/api/policy', '/api/instructions', '/api/blame?path=README.md']) expect((await f.anonymous(path)).status, path).toBe(429);
      const { default: api } = await import('./api');
      expect((await api.fetch(new Request('https://braid.example/git/w.git/git-upload-pack', { method: 'POST', body: 'pack', headers: { 'cf-connecting-ip': '198.51.100.7' } }), f.env)).status).toBe(429);
      const token = await sessionToken(f.env.SESSION_SECRET);
      await f.security.issue(await digest(token), Date.now() + 86400000, f.alice);
      for (let i = 0; i < 305; i++) expect((await f.anonymous('/api/queue', { cookie: `__Host-braid-session=${token}` })).status).toBe(200);
      expect((await f.anonymous(`/api/changes/${change.id}/diff?path=README.md`, { cookie: `__Host-braid-session=${token}` })).status).toBe(200);
    } finally { await f.close(); }
  });

  it('charges conditional public reads before serving them and shares mapped IPv4 budgets across signed-in and signed-out viewers', async () => {
    const f = await publicRepository();
    try {
      f.env.ANONYMOUS_LIMITER = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
      const read = vi.fn(async () => new Response(null, { status: 304 }));
      f.env.WORKSPACES = { ...f.env.WORKSPACES, get: () => ({ fetch: read }) } as unknown as BraidEnv['WORKSPACES'];
      for (let i = 0; i < 10; i++) expect((await f.anonymous('/api/state')).status).toBe(304);
      expect(f.env.ANONYMOUS_LIMITER.limit).toHaveBeenCalledTimes(10);
      f.env.ANONYMOUS_LIMITER = undefined;
      for (let i = 0; i < 300; i++) expect((await f.anonymous('/api/state', { 'if-none-match': '*' })).status).toBe(304);
      read.mockClear();
      expect((await f.anonymous('/api/state', { 'if-none-match': '*' })).status).toBe(429);
      expect(read).not.toHaveBeenCalled();
      const { default: api } = await import('./api');
      f.env.ANONYMOUS_LIMITER = undefined;
      const token = await sessionToken(f.env.SESSION_SECRET);
      await f.security.issue(await digest(token), Date.now() + 86400000, { id: 'outsider', name: 'Outsider', email: 'outsider@example.com' });
      for (let i = 0; i < 300; i++) expect((await api.fetch(new Request('https://braid.example/api/repos?limit=20', { headers: { 'cf-connecting-ip': i % 2 ? '::ffff:203.0.113.7' : '203.0.113.7', ...(i % 2 ? { cookie: `__Host-braid-session=${token}` } : {}) } }), f.env)).status).toBe(200);
      expect((await f.anonymous('/api/repos?limit=20', { 'cf-connecting-ip': '203.0.113.7' })).status).toBe(429);
    } finally { await f.close(); }
  });

  it('keeps private GitHub links locked and allows an explicit owner publication after unlinking', async () => {
    const f = await publicRepository();
    try {
      f.directory.repositoryImported('w', false);
      f.directory.repositoryLinked('w', true, f.alice.id);
      const token = await sessionToken(f.env.SESSION_SECRET);
      await f.security.issue(await digest(token), Date.now() + 86400000, f.alice);
      const patch = () => import('./api').then(({ default: api }) => api.fetch(new Request('https://braid.example/api/teams/t/workspaces/w', { method: 'PATCH', headers: { cookie: `__Host-braid-session=${token}`, origin: 'https://braid.example', 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'public' }) }), f.env));
      expect((await patch()).status).toBe(409);
      f.directory.repositoryUnlinked('w');
      expect(f.directory.list(f.alice)[0].workspaces[0].visibility).toBe('private');
      expect((await patch()).status).toBe(200);
    } finally { await f.close(); }
  });
  it('serves main content and names verbatim', async () => {
    const content = 'git@github.com:org/repo.git\nalice@corp.example\n' + 'braid_agent_' + 'a1b2c3d4'.repeat(8);
    const response = await publicResponse(Response.json({ path: 'alice@corp.example.txt', content }), '/api/repository');
    expect(await response.json()).toEqual({ path: 'alice@corp.example.txt', content });
    const download = await publicResponse(new Response(content, { headers: { 'content-type': 'application/octet-stream' } }), '/api/repository');
    expect(await download.text()).toBe(content);
  });

  it('finds and extracts credentials anywhere on long lines, private keys and AWS secret keys', () => {
    const token = 'braid_agent_' + 'a1b2c3d4'.repeat(8);
    const after = 'p'.repeat(16000) + ` "${token}"\n${pem('PRIVATE')}\nMIIEbody\n${pem('PRIVATE', 'END')}\naws_secret_access_key = ` + 'aB2cD3eF4gH5'.repeat(3) + 'aB2c';
    const files = [{ path: 'config.json', before: null, after }];
    expect(secretFindings(files).map(f => f.rule)).toEqual(['braid-token', 'private-key', 'private-key', 'private-key', 'aws-secret-key']);
    expect(addedBraidTokens(files)).toEqual([token]);
  });

  it('maps IPv4-mapped IPv6 to the full IPv4 address', () => {
    expect(anonymousNetwork('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(anonymousNetwork('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(anonymousNetwork('::ffff:198.51.100.1')).not.toBe(anonymousNetwork('::ffff:203.0.113.7'));
    expect(anonymousNetwork('2001:db8:1:2:aaaa::1')).toBe(anonymousNetwork('2001:db8:1:2:bbbb::2'));
  });

  it('keeps renamed team and repository slugs bound to their original owner', async () => {
    const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
    try {
      const alice = { id: 'alice', name: 'Alice', email: 'alice@example.com' };
      const team = organizationWithRepository(directory, alice, 'Acme', 'public'), repo = team.workspaces[0];
      directory.updateTeam(alice.id, { teamId: team.id, slug: 'acme-new' });
      directory.updateWorkspace(alice.id, { teamId: team.id, workspaceId: repo.id, slug: 'repo-new' });
      const squatter = organizationWithRepository(directory, { id: 'bob', name: 'Bob', email: 'bob@example.com' }, 'Acme', 'public');
      expect(squatter.slug).not.toBe('acme');
      expect(ok(await directory.resolveRepository(null, 'acme', repo.slug))).toMatchObject({ workspaceId: repo.id, owner: { slug: 'acme-new' }, repo: { slug: 'repo-new' } });
      expect(() => directory.updateTeam('bob', { teamId: squatter.id, slug: 'acme' })).toThrow();
      expect(directory.createWorkspace(alice.id, team.id, 'Repository').slug).not.toBe(repo.slug);
    } finally { db.db.close(); }
  });

  it('builds cold public policy, instructions, blame and diffs on demand', async () => {
    const f = await publicRepository();
    try {
      expect((await f.anonymous('/api/policy')).status).toBe(200);
      expect((await f.anonymous('/api/instructions')).status).toBe(200);
      expect((await f.anonymous('/api/blame?path=README.md')).status).toBe(200);
      const change = ok(await f.h.submit('sable', { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
      const shard = f.h.shard(parseInt(change.id[3], 16));
      const cacheDb = storageFixture();
      try {
        (shard as unknown as { cache: unknown }).cache = new (await import('../changes/cache')).ObjectCache(cacheDb.storage.sql);
        expect((await f.anonymous(`/api/changes/${change.id}/diff?path=README.md`)).status).toBe(200);
      } finally { cacheDb.db.close(); }
    } finally { await f.close(); }
  });

  it('charges signed-in nonmembers to the same 300/minute public network budget', async () => {
    const f = await publicRepository();
    try {
      f.env.ANONYMOUS_LIMITER = undefined;
      const token = await sessionToken(f.env.SESSION_SECRET);
      await f.security.issue(await digest(token), Date.now() + 86400000, { id: 'outsider', name: 'Outsider', email: 'outsider@example.com' });
      for (let i = 0; i < 300; i++) expect((await f.anonymous('/api/repos?limit=20', i % 2 ? { cookie: `__Host-braid-session=${token}` } : undefined)).status).toBe(200);
      expect((await f.anonymous('/api/repos?limit=20', { cookie: `__Host-braid-session=${token}` })).status).toBe(429);
    } finally { await f.close(); }
  });
});
