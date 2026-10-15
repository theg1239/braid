import * as scanner from '../../shared/secrets';
import { publicRosterId } from '../repositories/provenance';
import { afterEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import { edgeCache } from '../test/edge-cache';
import { Workspace } from '../workspace/workspace';
import { storageFixture } from '../test/storage';
import { publicRepository } from '../test/public-repository';
import { publicResponse } from './public-view';
import { digest, sessionToken } from './auth';
import { secretFindings } from '../../shared/secrets';
import { pem } from '../test/pem';
import { MIRROR_NETWORK_LIMIT } from '../github/mirrors';

const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => { if (!result.ok) throw new Error(`${result.status}: ${result.error}`); return result.data; };
type Fixture = Awaited<ReturnType<typeof publicRepository>>;
const call = (f: Fixture, path: string, headers: Record<string, string> = {}, env = f.env) =>
  api.fetch(new Request(`https://braid.example${path}`, { headers: { 'x-braid-workspace': 'w', 'cf-connecting-ip': '198.51.100.7', ...headers } }), env);

describe('B: withholding', () => {
  it('withholds a merged overlap with a private key on every task route', async () => {
    const f = await publicRepository();
    try {
      const db = storageFixture();
      db.storage.sql.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const put = (key: string, value: unknown) => db.storage.sql.exec('INSERT INTO records (key, value) VALUES (?, ?)', key, typeof value === 'string' ? value : JSON.stringify(value));
      const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
      const block = `${pem('PRIVATE')}\n${body}\n${pem('PRIVATE', 'END')}\n`;
      const lane = (id: string, after: string) => ({ id, name: id, role: 'Agent', color: 'blue', status: 'merged', task: 'Deploy', scope: [], summary: 'Done', rationale: 'Because', checks: [], changes: [{ path: 'deploy/key.ts', before: '', after, additions: 1, deletions: 0 }] });
      put('line-stats-version', '1'); put('revision', '3'); put('context', []); put('activity', []);
      put('project', { id: 'repo', name: 'Relay', description: '', branch: 'main', head: f.base, stack: [] });
      put('capabilities', { mode: 'live', artifacts: true, ai: false, storage: 'durable-object', authenticated: true, model: 'm', namespace: 'n', canWrite: false });
      put('mission-order', ['mission-1']);
      put('mission:mission-1', { id: 'mission-1', title: 'Deploy keys', intent: 'Deploys', status: 'merged', createdAt: '2026-10-01T00:00:00.000Z', baseCommit: f.base, mergeCommit: f.base, source: 'live', execution: 'cloud',
        agents: [lane('atlas', `export const key = \`${block}\`;\n`), lane('sable', 'export const key = process.env.DEPLOY_KEY;\n')],
        collisions: [{ id: 'c1', path: 'deploy/key.ts', agentIds: ['atlas', 'sable'], resolution: { agentId: 'sable', reason: 'Use the environment.', resolvedAt: '2026-10-01T00:00:00.000Z' } }] });
      const workspace = new Workspace(db.ctx, { ...f.h.env, LIVE_ENABLED: 'true', AI_MODEL: 'm', ARTIFACTS_NAMESPACE: 'n' } as never);
      await db.ready();
      const env = { ...f.env, WORKSPACES: { ...f.env.WORKSPACES, get: () => workspace } } as never;
      const results: Record<string, string> = {};
      for (const path of ['/api/state', '/api/missions', '/api/missions/mission-1', '/api/missions/mission-1/integration', '/api/missions/mission-1/diff?agent=atlas&path=deploy/key.ts']) {
        const response = await call(f, path, {}, env), text = await response.text();
        results[path] = `${response.status} ${text.includes(body) ? 'LEAK' : 'withheld'}`;
      }
      expect(Object.values(results).every(value => value === '200 withheld')).toBe(true);
    } finally { await f.close(); }
  });

  it('redacts stored policy details and copied reviewer summaries', async () => {
    const f = await publicRepository();
    try {
      // Before round two the gateway named people by email; such changes keep that name in their stored policy decision.
      const change = ok(await f.h.submit({ kind: 'owner', id: 'user:email:alice@corp.example', name: 'alice@corp.example' }, { title: 'Docs', summary: 'Docs', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
      const text = await (await call(f, `/api/changes/${change.id}`)).text();
      expect(text).not.toContain('alice@corp.example');
      const shard = f.h.shard(parseInt(change.id[3], 16));
      ok(await shard.review(f.h.context('sable', parseInt(change.id[3], 16)), change.id, { revision: 1, verdict: 'escalate', summary: 'Ask reviewer@corp.example to fix it.' }));
      const reviewed = await (await call(f, `/api/changes/${change.id}`)).json() as { policy: { requirements: { id: string; detail: string }[] } };
      expect(reviewed.policy.requirements.find(requirement => requirement.id === 'risk')!.detail).toContain('Ask [private email] to fix it.');
      expect(JSON.stringify(reviewed)).not.toContain('reviewer@corp.example');
    } finally { await f.close(); }
  });
});

describe('C: detection', () => {
  it('detects long lines and rotated private-key bodies under unchanged headers', () => {
    const token = 'braid_agent_' + '5e6f7a8b'.repeat(8);
    const longLine = `{"pad":"${'p'.repeat(500_000)}","token":"${token}"}`;
    const findings = secretFindings([{ path: 'b.json', before: null, after: longLine }]);
    const header = pem('RSA PRIVATE'), footer = pem('RSA PRIVATE', 'END');
    const rotated = secretFindings([{ path: 'deploy/key.pem', before: `${header}\nOLDBODYOLDBODYOLDBODY\n${footer}\n`, after: `${header}\nNEWBODYMIIEvQIBADANBgkqhkiG9w0BAQEF\n${footer}\n` }]);
    expect(findings.some(x => x.rule === 'braid-token')).toBe(true);
    expect(rotated).toMatchObject([{ rule: 'private-key', path: 'deploy/key.pem', line: 2 }]);
  });
});

describe('D: public people ids', () => {
  it('ignores person ids in imported trailers without resolving them', async () => {
    const f = await publicRepository();
    try {
      // An owner imports or syncs a commit whose trailer names someone else's account id.
      const sha = f.h.git.commitTree({ 'README.md': '# Relay\n' }, f.base, 'Update readme\n\nBraid-Change: #1 user:email:bob@corp.example\nBraid-Task: user:github:4242 Probe');
      f.h.git.native(['update-ref', 'refs/heads/main', sha]);
      await f.h.trunk.provenance(f.h.repository, [sha]);
      const anonymous = await (await call(f, `/api/provenance?commits=${sha}`)).json() as { change?: { id: string }; task?: { id: string } }[];
      // Bob's public id, as his commits (<id>@people.braid.local) and his changes (person:<id>) show it in any public repository.
      f.directory.list({ id: 'email:bob@corp.example', name: 'Bob', email: 'bob@corp.example' });
      const bob = f.directory.publicPerson('email:bob@corp.example');
      const lookup = vi.spyOn(f.directory, 'publicPerson');
      const elsewhere = await (await publicResponse(Response.json({ author: { owner: { id: 'user:email:bob@corp.example' } } }), '/api/changes/x', f.env)).json() as { author: { owner: { id: string } } };

      expect(anonymous[0]?.change).toBeUndefined();
      expect(anonymous[0]?.task).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(elsewhere.author.owner.id).toBe(`person:${bob}`);
    } finally { await f.close(); }
  });
});

describe('E: budgets', () => {
  const budgeted = (f: Fixture) => ({ ...f.env, ANONYMOUS_LIMITER: undefined, PUBLIC_EXPENSIVE_LIMITER: undefined }) as never;
  it('charges signed-in non-members', async () => {
    const f = await publicRepository();
    try {
      const token = await sessionToken('strong-session-secret-for-tests-123456789');
      await f.security.issue(await digest(token), Date.now() + 86_400_000, { id: 'github:999', email: 'outsider@example.com', name: 'Outsider' });
      const statuses: number[] = [];
      for (let i = 0; i < 301; i++) statuses.push((await call(f, '/api/queue', { cookie: `__Host-braid-session=${token}`, 'cf-connecting-ip': '203.0.113.9' }, budgeted(f))).status);
      expect(statuses).toContain(429);
    } finally { await f.close(); }
  });
  it('charges failed lookups before calling the directory', async () => {
    const f = await publicRepository();
    try {
      let lookups = 0;
      const publicRead = f.directory.publicRead.bind(f.directory);
      f.directory.publicRead = async (id: string) => { lookups++; return publicRead(id); };
      const statuses: number[] = [];
      for (let i = 0; i < 400; i++) statuses.push((await call(f, '/api/state', { 'x-braid-workspace': `unknown-${i}`, 'cf-connecting-ip': '192.0.2.44' }, budgeted(f))).status);
      expect(statuses.filter(status => status === 404)).toHaveLength(300);
      expect(statuses.filter(status => status === 429)).toHaveLength(100);
      expect(lookups).toBe(300);
    } finally { await f.close(); }
  });
});

describe('G: public build budget', () => {
  it('limits each network to ten cold builds so another network can browse', async () => {
    const f = await publicRepository();
    try {
      const files = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`docs/f${i}.md`, `line ${i}\n`]));
      const sha = f.h.git.commitTree(files, f.base, 'Docs');
      f.h.git.native(['update-ref', 'refs/heads/main', sha]);
      const attacker: number[] = [];
      for (let i = 0; i < 30; i++) attacker.push((await call(f, `/api/blame?path=docs/f${i}.md`, { 'cf-connecting-ip': '198.51.100.20' })).status);
      const victim = await call(f, '/api/blame?path=docs/f31.md', { 'cf-connecting-ip': '203.0.113.50' });
      expect(attacker.filter(status => status === 200)).toHaveLength(10);
      expect(attacker.filter(status => status === 503)).toHaveLength(20);
      expect(victim.status).toBe(200);
      expect((await call(f, '/api/blame?path=docs/f0.md', { 'cf-connecting-ip': '198.51.100.20' })).status).toBe(200);
    } finally { await f.close(); }
  });
});


afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });


it('keeps reported models containing pipes separate from another owner', async () => {
  const f = await publicRepository();
  try {
    // Mallory's own agent reports a model naming Bob's account in the owner position of the roster key.
    const mallory = { kind: 'agent' as const, id: 'agent:mallory', name: 'Agent', owner: { id: 'user:github:999', name: 'Mallory' } };
    ok(await f.h.submit(mallory, { title: 'Docs', summary: 'Docs', baseCommit: f.base, model: 'claude-opus-5|email:bob@corp.example|claude-code', agent: { tool: 'claude-code/2.4.1' }, files: [{ path: 'README.md', content: '# Relay\nDocs\n' }] }));
    const roster = await (await api.fetch(new Request('https://braid.example/api/agents', { headers: { 'x-braid-workspace': 'w', 'cf-connecting-ip': '198.51.100.7' } }), f.env)).json() as { id: string; models: string[] }[];
    // The roster id Bob's own claude-opus-5 + claude-code agent has in any public repository.
    f.directory.list({ id: 'email:bob@corp.example', email: 'bob@corp.example', name: 'Bob' });
    const bobs = await publicRosterId(f.env, 'claude-opus-5|user:email:bob@corp.example|claude-code');
    expect(roster[0]?.id).not.toBe(bobs);
  } finally { await f.close(); }
});


it('persists legacy task findings once and never rescans proposals on public reads', async () => {
  const f = await publicRepository();
  try {
    const db = storageFixture();
    db.storage.sql.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const put = (key: string, value: unknown) => db.storage.sql.exec('INSERT INTO records (key, value) VALUES (?, ?)', key, typeof value === 'string' ? value : JSON.stringify(value));
    const hostile = 'sk-'.repeat(100_000); // 300 KB on one line
    put('line-stats-version', '1'); put('revision', '1'); put('context', []); put('activity', []);
    put('project', { id: 'repo', name: 'Relay', description: '', branch: 'main', head: f.base, stack: [] });
    put('capabilities', { mode: 'live', artifacts: true, ai: false, storage: 'durable-object', authenticated: true, model: 'm', namespace: 'n', canWrite: false });
    put('mission-order', ['mission-1']);
    put('mission:mission-1', { id: 'mission-1', title: 'Task', intent: 'Task', status: 'review', createdAt: '2026-10-01T00:00:00.000Z', baseCommit: f.base, source: 'live', execution: 'cloud', collisions: [],
      agents: [{ id: 'atlas', name: 'atlas', role: 'Agent', color: 'blue', status: 'review', task: 'T', scope: [], summary: 'S', rationale: 'R', checks: [], changes: [{ path: 'data.txt', before: '', after: hostile, additions: 1, deletions: 0 }] }] });
    const workspace = new Workspace(db.ctx, { ...f.h.env, LIVE_ENABLED: 'true', AI_MODEL: 'm', ARTIFACTS_NAMESPACE: 'n' } as never);
    await db.ready();
    const env = { ...f.env, WORKSPACES: { ...f.env.WORKSPACES, get: () => workspace } } as never;
    const scan = vi.spyOn(scanner, 'secretFindings');
    for (let i = 0; i < 3; i++) {
      const response = await api.fetch(new Request('https://braid.example/api/state', { headers: { 'x-braid-workspace': 'w', 'cf-connecting-ip': `198.51.100.${i + 1}` } }), env);
      await response.text();
    }
    expect(scan).not.toHaveBeenCalled();
    new Workspace(db.ctx, { ...f.h.env, LIVE_ENABLED: 'true', AI_MODEL: 'm', ARTIFACTS_NAMESPACE: 'n' } as never);
    await db.ready();
    expect(scan).not.toHaveBeenCalled();
    db.db.close();
  } finally { await f.close(); }
}, 120_000);

it('looks up only Braid author/owner fields and never mints an unknown person on read', async () => {
  const f = await publicRepository();
  try {
    const before = f.db.storage.sql.exec('SELECT * FROM public_people').toArray();
    expect(f.directory.publicPerson('email:unknown@corp.example')).toBeUndefined();
    const lookup = vi.spyOn(f.directory, 'publicPerson');
    const response = await publicResponse(Response.json({ change: { id: `user:${f.alice.id}` }, task: { id: 'user:github:999' }, agent: { id: `user:${f.alice.id}` },
      author: { id: `user:${f.alice.id}` }, owner: { id: 'user:email:unknown@corp.example', name: 'Unknown' } }), '/api/provenance', f.env);
    const data = await response.json() as { change: { id: string }; task: { id: string }; agent: { id: string }; author: { id: string }; owner: { id?: string } };
    expect(data.author.id).toBe(`person:${f.directory.publicPerson(f.alice.id)}`);
    expect(data.change.id).not.toBe(data.author.id);
    expect(data.agent.id).not.toBe(data.author.id);
    expect(data.task.id).toBe('user:github:999');
    expect(data.owner.id).toBeUndefined();
    expect(lookup.mock.calls.flat()).not.toContain('github:999');
    expect(f.db.storage.sql.exec('SELECT * FROM public_people').toArray()).toEqual(before);
  } finally { await f.close(); }
});

it('charges recorded examples before opening a workspace, including conditional reads', async () => {
  const f = await publicRepository();
  try {
    const work = vi.fn(async () => new Response(null, { status: 304 }));
    f.env.WORKSPACES = { ...f.env.WORKSPACES, get: () => ({ fetch: work }) } as never;
    f.env.ANONYMOUS_LIMITER = { limit: vi.fn(async () => ({ success: false })) } as never;
    const session = vi.spyOn(f.security, 'exampleSession');
    const response = await call(f, '/api/state', { 'x-braid-workspace': 'demo' });
    expect(response.status).toBe(429);
    expect(session).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('reads the example from a shared copy until a change, and keeps a network past its sessions read-only', async () => {
  const f = await publicRepository();
  try {
    const keys: string[] = [];
    const work = vi.fn(async (_request: Request) => Response.json({ capabilities: { mode: 'demo' } }, { headers: { etag: '"shared"' } }));
    const kept = edgeCache();
    f.env.WORKSPACES = { ...f.env.WORKSPACES, idFromName: (name: string) => { keys.push(name); return name; }, get: () => ({ fetch: work }) } as never;
    const sessions = vi.spyOn(f.security, 'exampleSession').mockResolvedValue({ retryAfter: 3_600 } as never);
    const hour = Math.floor(Date.now() / 3_600_000);
    // Reading needs no session: the hour's shared copy answers once and the data center keeps the answer.
    const read = await call(f, '/api/state', { 'x-braid-workspace': 'demo' });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ capabilities: { mode: 'demo', canWrite: true } });
    expect(read.headers.get('set-cookie')).toBeNull();
    // Clients revalidate with the validator they were given, which also covers the repository's address.
    const etag = read.headers.get('etag')!;
    for (const validator of [`W/${etag}`, `"stale", ${etag}`, '*']) expect((await call(f, '/api/state', { 'x-braid-workspace': 'demo', 'if-none-match': validator })).status).toBe(304);
    expect(work).toHaveBeenCalledTimes(1);
    expect(sessions).not.toHaveBeenCalled();
    expect(new Set(keys)).toEqual(new Set([`demo:shared:any:${hour}`]));
    expect([...kept.keys()]).toEqual([`https://example.braid.invalid/${hour}/api/state`]);
    // A change counts a session; past the network's sessions it is refused, and a marker keeps the network read-only.
    const change = (cookie?: string) => api.fetch(new Request('https://braid.example/api/missions', { method: 'POST', body: '{}',
      headers: { 'x-braid-workspace': 'demo', 'cf-connecting-ip': '198.51.100.7', origin: 'https://braid.example', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }), f.env);
    const refused = await change();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ code: 'example_session_limit', error: "This network has used today's example sessions. You can still read everything." });
    const marker = refused.headers.get('set-cookie')!;
    expect(marker).toMatch(/^braid-demo-shared=\d+\.[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=36\d\d/);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(await (await call(f, '/api/state', { 'x-braid-workspace': 'demo', cookie: marker.split(';')[0] })).json()).toEqual({ capabilities: { mode: 'demo', canWrite: false } });
    // The shared data stayed the same, but the visitor's permission did not. Do not return
    // a 304 that leaves the browser showing the previous canWrite:true snapshot.
    const capped = await call(f, '/api/state', { 'x-braid-workspace': 'demo', cookie: marker.split(';')[0], 'if-none-match': etag });
    expect(capped.status).toBe(200);
    expect(await capped.json()).toEqual({ capabilities: { mode: 'demo', canWrite: false } });
    expect((await change(marker.split(';')[0])).status).toBe(429);
    expect(sessions).toHaveBeenCalledTimes(1);
    // Signed for the shared copy, the marker is not an example session: as one, the change is counted again.
    expect((await change(`braid-demo=${marker.split(';')[0].split('=')[1]}`)).status).toBe(429);
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it('gives each deploy its own shared copy and cached answers', async () => {
  const f = await publicRepository();
  try {
    const keys: string[] = [];
    const kept = edgeCache();
    f.env.WORKSPACES = { ...f.env.WORKSPACES, idFromName: (name: string) => { keys.push(name); return name; }, get: () => ({ fetch: async () => Response.json({ capabilities: { mode: 'demo' } }) }) } as never;
    const hour = Math.floor(Date.now() / 3_600_000);
    for (const build of ['first', 'second']) {
      f.env.BUILD_ID = build;
      expect((await call(f, '/api/state', { 'x-braid-workspace': 'demo' })).status).toBe(200);
    }
    expect(keys).toEqual([`demo:shared:any:${hour}.first`, `demo:shared:any:${hour}.second`]);
    expect([...kept.keys()]).toEqual([`https://example.braid.invalid/${hour}.first/api/state`, `https://example.braid.invalid/${hour}.second/api/state`]);
  } finally { await f.close(); }
});

it('creates a copy of the example near its visitor, and the shared copy once per region', async () => {
  const f = await publicRepository();
  try {
    const opened: [string, unknown][] = [];
    const work = vi.fn(async (_request: Request) => Response.json({ capabilities: { mode: 'demo' } }));
    edgeCache();
    f.env.WORKSPACES = { ...f.env.WORKSPACES, idFromName: (name: string) => name, get: (name: string, options?: unknown) => { opened.push([name, options]); return { fetch: work }; } } as never;
    const visit = (cf: Record<string, string>) => {
      const request = new Request('https://braid.example/api/state', { headers: { 'x-braid-workspace': 'demo', 'cf-connecting-ip': '198.51.100.7' } });
      Object.defineProperty(request, 'cf', { value: cf });
      return api.fetch(request, f.env);
    };
    expect((await visit({ continent: 'AS', country: 'IN', longitude: '72.8' })).status).toBe(200);
    expect((await visit({ continent: 'NA', country: 'US', longitude: '-122.4' })).status).toBe(200);
    expect((await visit({ continent: 'EU', country: 'DE', longitude: '13.4' })).status).toBe(200);
    const hour = Math.floor(Date.now() / 3_600_000);
    expect(opened).toEqual([[`demo:shared:apac:${hour}`, { locationHint: 'apac' }], [`demo:shared:wnam:${hour}`, { locationHint: 'wnam' }], [`demo:shared:weur:${hour}`, { locationHint: 'weur' }]]);
  } finally { await f.close(); }
});

it('withholds screenshots and command output per revision while members keep access', async () => {
  const f = await publicRepository();
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const evidence = [{ kind: 'screenshot', page: '/', viewport: 'desktop', width: 1, height: 1, contentType: 'image/png', data: png },
      { kind: 'command', command: 'npm test', exitCode: 1, output: 'PRIVATE OUTPUT FROM SECRET REVISION' }];
    const change = ok(await f.h.submit('sable', { title: 'Secret', summary: 'Secret', baseCommit: f.base,
      files: [{ path: 'key.pem', content: `${pem('PRIVATE')}\nMIIEactualbody\n${pem('PRIVATE', 'END')}` }], evidence }));
    const shard = f.h.shard(parseInt(change.id[3], 16));
    const image = change.evidence!.find(item => item.kind === 'screenshot')!;
    if (image.kind !== 'screenshot') throw new Error('Missing screenshot');
    expect((await call(f, `/api/changes/${change.id}/evidence/${image.image}`)).status).toBe(404);
    expect(await (await call(f, `/api/changes/${change.id}`)).json()).toMatchObject({ evidence: [], checks: [] });
    expect(ok(await shard.image(change.id, image.image)).bytes.length).toBeGreaterThan(0);
    expect(ok(await shard.get(change.id)).evidence).toHaveLength(2);
    ok(await shard.revise(f.h.context('sable', parseInt(change.id[3], 16)), change.id, { previousRevision: 1, baseCommit: f.base,
      summary: 'Clean', files: [{ path: 'safe.ts', content: 'safe' }], evidence: [{ kind: 'command', command: 'npm test', exitCode: 0, output: 'PUBLIC OUTPUT' }] }, 'clean-evidence-round3-key'));
    const visible = await (await call(f, `/api/changes/${change.id}`)).text();
    expect(visible).toContain('PUBLIC OUTPUT');
    expect(visible).not.toContain('PRIVATE OUTPUT');
    expect((await call(f, `/api/changes/${change.id}/evidence/${image.image}`)).status).toBe(404);
  } finally { await f.close(); }
});

it('migrates unambiguous stored roster keys and line counts without changing public ids', async () => {
  const f = await publicRepository();
  try {
    const { ChangeShard } = await import('../changes/shard');
    const { Trunk } = await import('../changes/trunk');
    const { agentKey } = await import('../../shared/provenance');
    const author = { kind: 'agent' as const, id: 'agent:legacy', name: 'Claude', model: 'claude', owner: { id: `user:${f.alice.id}`, name: 'Alice' }, tool: 'claude-code' };
    const change = ok(await f.h.submit(author, { title: 'Legacy', summary: 'Legacy', baseCommit: f.base, agent: { tool: 'claude-code' }, files: [{ path: 'README.md', content: '# Legacy' }] }));
    const key = agentKey(author)!, old = `claude|user:${f.alice.id}|claude-code`;
    const publicId = await publicRosterId(f.env, old);
    const shard = f.h.shard(parseInt(change.id[3], 16)), ctx = (shard as unknown as { ctx: DurableObjectState }).ctx;
    const stats = shard.agentStats()[0];
    ctx.storage.sql.exec('UPDATE changes SET agent_key = ?', old);
    ctx.storage.sql.exec('DELETE FROM agent_stats');
    ctx.storage.sql.exec('INSERT INTO agent_stats VALUES (?, ?)', old, JSON.stringify({ ...stats, key: old, sentBack: 7 }));
    ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'agent-key-version'");
    const reopened = new ChangeShard(ctx, f.h.env);
    expect(reopened.agentStats()[0]).toMatchObject({ key, sentBack: 7, counts: stats.counts });
    expect(await publicRosterId(f.env, reopened.agentStats()[0].key)).toBe(publicId);
    const trunkCtx = (f.h.trunk as unknown as { ctx: DurableObjectState }).ctx;
    trunkCtx.storage.sql.exec('INSERT INTO commits (sha, provenance, agent, added, alive) VALUES (?, ?, ?, 5, 3)', f.base,
      JSON.stringify({ commit: f.base, kind: 'agent', agent: { model: 'claude', tool: 'claude-code' }, owner: author.owner }), old);
    trunkCtx.storage.sql.exec("DELETE FROM meta WHERE key = 'agent-key-version'");
    expect(await new Trunk(trunkCtx, f.h.env).agentLines(f.h.repository, true)).toEqual({ [key]: { added: 5, alive: 3 } });
  } finally { await f.close(); }
});

it("lets only the operator's seeding key past a spent network admission budget", async () => {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input).startsWith('https://github.com/')
    ? Promise.resolve(new Response('', { status: 401 })) : originalFetch(input, init));
  const f = await publicRepository();
  try {
    const key = 'k'.repeat(40);
    f.env.ANONYMOUS_LIMITER = undefined; f.env.MIRROR_SEED_TOKEN = key;
    for (let i = 0; i < MIRROR_NETWORK_LIMIT; i++) expect((await call(f, `/api/repos/missing/repo-${i}`)).status).toBe(404);
    expect((await call(f, '/api/repos/missing/visitor')).status).toBe(429);
    expect((await call(f, '/api/repos/missing/guess', { 'x-braid-mirror-seed': 'k'.repeat(39) })).status).toBe(429);
    // Past the budget, the GitHub lookup itself answers: this source does not exist.
    expect((await call(f, '/api/repos/missing/seeded', { 'x-braid-mirror-seed': key })).status).toBe(404);
    f.env.MIRROR_SEED_TOKEN = 'short';
    expect((await call(f, '/api/repos/missing/short-key', { 'x-braid-mirror-seed': 'short' })).status).toBe(429);
  } finally { await f.close(); }
});

it('charges unknown repository addresses before their lookup and leaves member addresses exempt', async () => {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input).startsWith('https://github.com/')
    ? Promise.resolve(new Response('', { status: 401 })) : originalFetch(input, init));
  const f = await publicRepository();
  try {
    f.env.ANONYMOUS_LIMITER = undefined;
    const lookup = vi.spyOn(f.directory, 'resolveRepository');
    for (let i = 0; i < 300; i++) expect((await call(f, `/api/repos/missing/repo-${i}`)).status).toBe(i < MIRROR_NETWORK_LIMIT ? 404 : 429);
    expect((await call(f, '/api/repos/missing/another')).status).toBe(429);
    expect(lookup).toHaveBeenCalledTimes(300);
    const token = await sessionToken(f.env.SESSION_SECRET);
    await f.security.issue(await digest(token), Date.now() + 86400000, f.alice);
    expect((await call(f, `/api/repos/${f.team.slug}/${f.team.workspaces[0].slug}`, { cookie: `__Host-braid-session=${token}` })).status).toBe(200);
  } finally { await f.close(); }
});

it('preserves published policy and instructions verbatim but redacts Braid decisions', async () => {
  const policy = { guards: {}, reviewers: [{ name: 'reviewer@corp.example' }] };
  const instructions = [{ id: 'rule', text: 'Contact alice@corp.example' }];
  expect(await (await publicResponse(Response.json({ policy, instructions }), '/api/policy')).json()).toEqual({ policy, instructions });
  expect(await (await publicResponse(Response.json({ instructions }), '/api/instructions')).json()).toEqual({ instructions });
  expect(await (await publicResponse(Response.json({ policy: { requirements: [{ detail: 'Contact alice@corp.example' }] } }), '/api/changes/x')).json())
    .toEqual({ policy: { requirements: [{ detail: 'Contact [private email]' }] } });
});

it('persists cold-build network shares across eviction and resets them after a minute', async () => {
  const f = await publicRepository();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { Trunk } = await import('../changes/trunk');
    for (let i = 0; i < 10; i++) expect(f.h.trunk.publicBuild('network-a').allowed).toBe(true);
    const reopened = new Trunk((f.h.trunk as unknown as { ctx: DurableObjectState }).ctx, f.h.env);
    expect(reopened.publicBuild('network-a')).toMatchObject({ allowed: false, retryAfter: 60 });
    for (const network of ['network-b', 'network-c']) for (let i = 0; i < 10; i++) expect(reopened.publicBuild(network).allowed).toBe(true);
    expect(reopened.publicBuild('network-d').allowed).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(reopened.publicBuild('network-a').allowed).toBe(true);
  } finally { vi.useRealTimers(); await f.close(); }
});
