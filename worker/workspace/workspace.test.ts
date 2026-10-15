import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentStore } from './content';
import { HISTORY_RETRY_MS, Workspace } from './workspace';
import { storageFixture } from '../test/storage';
import { recordingAnswers } from '../test/rpc-answers';
import type { BraidEnv, RunParams } from '../env';
import { runAgentLoop, type SandboxResult, type SandboxTask } from '../agents/loop';
import { hostedErrors } from '../agents/errors';
import { HttpError, type Result } from '../errors';
import { MissionWorkflow } from './workflow';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { AgentFailureStage, HostedEnvironment, IntegrationPreview, ProjectImport, WorkspaceSnapshot } from '../../shared/types';
import { BASE_FILES, seedWorkspace } from './seed';
import { commitFiles } from '../git/push';
import { GitError } from '../git/transport';
import { copyBranches } from '../repositories/branches';
import { SUBMISSION_BYTES } from '../schemas';

vi.mock('../git/push', async importOriginal => ({ ...await importOriginal<typeof import('../git/push')>(), commitFiles: vi.fn() }));
vi.mock('../repositories/branches', () => ({ copyBranches: vi.fn(async () => ({ branches: ['main'], failed: [], remaining: 0 })) }));
const head = 'a'.repeat(40), merged = 'b'.repeat(40);
const databases: ReturnType<typeof storageFixture>[] = [];
beforeEach(() => {
  vi.mocked(commitFiles).mockReset().mockResolvedValue(merged);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network access is forbidden in workspace tests.'); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const fixture of databases.splice(0)) fixture.db.close();
});
const ownerHeaders = { 'x-braid-user-id': 'test-owner', 'x-braid-actor': 'owner@example.test', 'x-braid-workspace': 'workspace-1', 'x-braid-team': 'team-1' };
const connection = (id: string, expires = Date.now() + 3_600_000) => ({ 'x-braid-connection': id, 'x-braid-connection-expires': String(expires) });
async function fixture(seed?: WorkspaceSnapshot, options: { ai?: boolean; workflows?: boolean; headers?: Record<string, string> } = {}) {
  const db = storageFixture();
  databases.push(db);
  if (seed) await db.storage.put('workspace', seed);
  const baseFiles: Record<string, string | Uint8Array> = { ...BASE_FILES, '.node-version': '24', 'package-lock.json': '{}', '.braid/policy.json': JSON.stringify({ version: 1, install: 'npm ci', checks: ['npm test'] }) };
  const baseModes: Record<string, string> = {};
  const repositories = new Map<string, ReturnType<typeof repository>>();
  function repository(name: string) {
    const state = { head };
    return {
      [Symbol.dispose]() {}, state,
      readCommit: vi.fn(async (_hash: string) => ({ treeHash: 'c'.repeat(40) })),
      readTree: vi.fn(async (hash: string): Promise<ArtifactsTreeEntry[]> => {
        const prefix = hash.startsWith('tree:') ? hash.slice(5) : '';
        const entries = new Map<string, ArtifactsTreeEntry>();
        for (const path of new Set([...Object.keys(baseFiles), ...Object.keys(baseModes)])) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length), slash = rest.indexOf('/'), name = slash < 0 ? rest : rest.slice(0, slash);
          const mode = slash < 0 ? baseModes[path] ?? '100644' : '40000';
          const type = mode === '40000' ? 'tree' : mode === '120000' ? 'symlink' : mode === '160000' ? 'gitlink' : mode === '100755' ? 'exec' : 'blob';
          if (!entries.has(name) || slash < 0) entries.set(name, { name, mode, type, hash: type === 'tree' ? `tree:${prefix}${name}/` : `blob:${path}` });
        }
        return [...entries.values()];
      }),
      // Artifacts log entries carry their root tree, as readCommit does.
      log: vi.fn(async (_options?: unknown) => state.head ? [{ hash: state.head, treeHash: 'c'.repeat(40) }] : []),
      info: vi.fn(async () => ({ name, remote: `https://git.example/${name}`, defaultBranch: 'main' })),
      createToken: vi.fn(async (scope?: string, _ttl?: number) => ({ plaintext: name === 'project' ? 'secret-git-token' : `fake-${scope}-${name}?expires=0` })),
      revokeToken: vi.fn(async (_token: string) => {}),
      readFile: vi.fn(async ({ path }: { ref: string; path: string }) => {
        const content = baseFiles[path];
        return Object.hasOwn(baseFiles, path) ? new Blob([typeof content === 'string' ? content : new Uint8Array(content).buffer]) : null;
      }),
      readBlob: vi.fn(async (hash: string): Promise<Blob | null> => {
        const path = hash.startsWith('blob:') ? hash.slice(5) : null;
        if (path === null || !Object.hasOwn(baseFiles, path)) return null;
        const content = baseFiles[path];
        return new Blob([typeof content === 'string' ? content : new Uint8Array(content).buffer]);
      }),
      fork: vi.fn(async (forkName: string, _options?: unknown) => {
        const fork = repository(forkName); fork.state.head = state.head;
        repositories.set(forkName, fork);
        return { name: forkName, remote: `https://git.example/${forkName}`, token: 'initial-fork-secret' };
      }),
    };
  }
  const repo = repository('project');
  repositories.set('project', repo);
  const instance = { status: vi.fn(async () => ({ status: 'running' })) };
  const workflows = { create: vi.fn(async (_options: { id: string }) => instance), get: vi.fn(async (_id: string) => instance) };
  const artifacts = { get: vi.fn(async (name: string) => repositories.get(name) ?? repo), create: vi.fn(async () => ({ name: 'project', remote: 'https://git.example/project', defaultBranch: 'main', token: 'initial-secret' })), import: vi.fn(async () => ({ name: 'project', remote: 'https://git.example/project', defaultBranch: 'main', token: 'initial-secret' })) };
  const grant = { scope: 'work', workspaceId: 'workspace-1', user: { id: 'test-owner', email: 'owner@example.test', name: 'Owner' } };
  const security = { consume: vi.fn(async () => ({ allowed: true })), agent: vi.fn(async (_digest: string): Promise<typeof grant | undefined> => grant) };
  const directory = { repositoryImported: vi.fn(async () => {}), repositoryActivity: vi.fn(async (_workspace: string, _updatedAt: string, _description?: string) => {}), access: vi.fn(async (_user: unknown, _workspaceId: string, _write: boolean): Promise<Result<{ teamId: string }>> => ({ ok: true, data: { teamId: 'team-1' } })) };
  const ai = { run: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ response: { summary: 'Clarify setup', rationale: 'Document the setup steps.', files: [{ path: 'README.md', content: '# Updated setup\n' }] } })) };
  const sandbox = { run: vi.fn(async (_task: SandboxTask): Promise<SandboxResult & Disposable> => ({ [Symbol.dispose]() {}, summary: 'Clarify setup', rationale: 'Document the setup steps.', files: [{ path: 'README.md', content: '# Updated setup\n' }], checks: [{ label: 'node --test', status: 'passed', detail: 'Executed in the sandbox; exit 0.' }] })) };
  Object.assign(db.ctx, { exports: { AgentSandbox: { getByName: () => sandbox } } });
  const env = { AUTH_MODE: 'owner-key', LIVE_ENABLED: 'true', AI_MODEL: 'test', ARTIFACTS_NAMESPACE: 'test', ARTIFACTS: artifacts, AI: options.ai === false ? undefined : ai, MISSIONS: options.workflows === false ? undefined : workflows, DIRECTORY: { idFromName: () => 'directory', get: () => directory }, SECURITY: { idFromName: () => 'security', get: () => security } } as unknown as BraidEnv;
  let workspace = new Workspace(db.ctx, env); await db.ready();
  const restart = async () => { workspace = new Workspace(db.ctx, env); await db.ready(); return workspace; };
  const request = (path: string, body?: unknown, key: string = crypto.randomUUID(), headers: Record<string, string> = {}) => workspace.fetch(new Request(`https://braid.example${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-braid-mode': 'live', 'x-braid-role': 'owner', 'x-braid-actor': 'owner', 'content-type': 'application/json', 'idempotency-key': key, ...options.headers, ...headers }, body: body ? JSON.stringify(body) : undefined }));
  const state = async () => await (await request('/api/state')).json() as WorkspaceSnapshot;
  const jobs = () => db.storage.sql.exec<{ id: string; value: string }>('SELECT id, value FROM jobs').toArray();
  const proposal = (missionId: string, agentId = 'atlas') => {
    const row = db.storage.sql.exec<{ value: string }>('SELECT value FROM git_plans WHERE id = ?', `proposal:${missionId}:${agentId}`).toArray()[0];
    return new ContentStore(db.storage).get<{ files: Record<string, string>; preparedCommit?: string }>(`plan:proposal:${missionId}:${agentId}`) ?? (row ? JSON.parse(row.value) : undefined);
  };
  return { db, repo, repositories, baseFiles, baseModes, artifacts, workflows, instance, ai, sandbox, directory, security, grant, env, restart, request, state, jobs, proposal, current: () => workspace };
}
async function launch(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
  const body = { title: 'Add delivery retries', intent: 'Recover transient errors without changing permanent failures.', ...overrides }, key = crypto.randomUUID();
  const response = await f.request('/api/missions', body, key);
  expect(response.status).toBe(202);
  const { missionId } = await response.json() as { missionId: string };
  return { body, key, missionId };
}
const submission = (overrides: Record<string, unknown> = {}) => ({ baseCommit: head, summary: 'Clarify local setup', rationale: 'Explain the local coding workflow.', model: 'Codex', files: [{ path: 'docs/local.md', content: '# Local setup\n' }], ...overrides });
describe('repository browser API', () => {
  it('enumerates the full tree beyond the text snapshot and paginates without dropping files', async () => {
    const f = await fixture(); await launch(f, { execution: 'local' });
    for (let i = 0; i < 450; i++) f.baseFiles[`assets/file-${i}.bin`] = new Uint8Array([0, 255]);
    f.baseFiles['.github/workflows/ci.yml'] = 'name: CI\n';
    const root = await (await f.request('/api/repository/tree')).json() as { entries: { path: string }[] };
    expect(root.entries.map(e => e.path)).toContain('.github');
    const paths: string[] = []; let cursor: string | null = null;
    do {
      const response = await f.request(`/api/repository/tree?ref=${head}&path=assets${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.status).toBe(200);
      const page = await response.json() as { ref: string; entries: { path: string }[]; nextCursor: string | null };
      expect(page.ref).toBe(head); paths.push(...page.entries.map(e => e.path)); cursor = page.nextCursor;
    } while (cursor);
    expect(paths.length).toBe(450); expect(new Set(paths).size).toBe(450);
    expect(f.repo.readFile).not.toHaveBeenCalled();
    expect((await f.state()).files).not.toHaveProperty('assets/file-0.bin');
  });
  it('disposes every Artifacts answer while it reads trees and files', async () => {
    const f = await fixture(); await launch(f, { execution: 'local' });
    const answers = recordingAnswers(f.env.ARTIFACTS);
    f.env.ARTIFACTS = answers.binding;
    for (const path of ['/api/repository', '/api/repository?path=README.md', '/api/repository?path=README.md&download=1']) expect((await f.request(path)).status, path).toBe(200);
    expect(answers.undisposed()).toEqual([]);
  });
  it('returns binary and large descriptors without truncating the downloadable file', async () => {
    const f = await fixture(); await launch(f, { execution: 'local' });
    const bytes = new Uint8Array([0, 255, 10, 20]); f.baseFiles['image.bin'] = bytes;
    f.baseFiles['large.txt'] = 'x'.repeat(500_001);
    expect(await (await f.request('/api/repository?path=image.bin')).json()).toMatchObject({ content: '', kind: 'binary', size: 4, ref: head });
    expect(await (await f.request('/api/repository?path=large.txt')).json()).toMatchObject({ content: '', kind: 'large', size: 500_001 });
    const binary = await f.request('/api/repository?path=image.bin&download=1');
    expect(binary.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(bytes);
    expect((await (await f.request('/api/repository?path=large.txt&download=1')).text()).length).toBe(500_001);
  });
  it('reads symlink objects without following them and identifies submodules without reading blobs', async () => {
    const f = await fixture(); await launch(f, { execution: 'local' });
    f.baseModes['link'] = '120000'; f.baseModes['module'] = '160000';
    f.repo.readBlob.mockResolvedValue(new Blob(['../target']));
    expect(await (await f.request('/api/repository?path=link')).json()).toMatchObject({ kind: 'symlink', content: '../target' });
    expect(f.repo.readBlob).toHaveBeenCalledWith('blob:link'); expect(f.repo.readFile).not.toHaveBeenCalled();
    expect(await (await f.request('/api/repository?path=module')).json()).toMatchObject({ kind: 'submodule', hash: 'blob:module' });
    expect((await f.request('/api/repository/tree?path=link')).status).toBe(404);
    expect((await f.request('/api/repository/tree?path=module')).status).toBe(404);
  });
  it('describes oversized Artifacts blobs and refuses a download that cannot complete', async () => {
    const f = await fixture(); await launch(f, { execution: 'local' }); f.baseFiles['huge.bin'] = '';
    f.repo.readBlob.mockRejectedValue(Object.assign(new Error('too large'), { code: 'MEMORY_LIMIT' }));
    expect(await (await f.request('/api/repository?path=huge.bin')).json()).toMatchObject({ kind: 'large', path: 'huge.bin' });
    const download = await f.request('/api/repository?path=huge.bin&download=1');
    expect(download.status).toBe(413); expect(await download.json()).toMatchObject({ error: expect.stringContaining('full Git checkout') });
  });
});
async function localTask(options: { agentCount?: number; ai?: boolean; workflows?: boolean; headers?: Record<string, string> } = {}) {
  const f = await fixture(undefined, options);
  const task = await launch(f, { execution: 'local', agentCount: options.agentCount });
  const path = `/api/missions/${task.missionId}`;
  const checkout = (agentId = 'atlas', headers: Record<string, string> = connection('codex')) => f.request(`${path}/agents/${agentId}/checkout`, {}, undefined, headers);
  const submit = (body = submission(), key: string = crypto.randomUUID(), agentId = 'atlas', headers: Record<string, string> = connection('codex')) => f.request(`${path}/agents/${agentId}/submit`, body, key, headers);
  const fork = async (agentId = 'atlas') => {
    const agent = (await f.state()).missions.find(mission => mission.id === task.missionId)!.agents.find(agent => agent.id === agentId)!;
    return f.repositories.get(agent.repo!)!;
  };
  return { ...f, ...task, path, checkout, submit, fork };
}
async function expectError(response: Response, status: number, message: RegExp) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: expect.stringMatching(message) });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
describe('durable repository operations', () => {
  it('queues blame after the import copy finishes, including completion after eviction', async () => {
    const f = await fixture(undefined, { headers: { ...ownerHeaders, 'x-braid-repository': 'team:team-1:repository:workspace-1' } });
    const warmBlame = vi.fn(async () => {});
    Object.assign(f.env, { TRUNKS: { getByName: () => ({ warmBlame }) } });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    await f.db.settled();
    expect(warmBlame).not.toHaveBeenCalled();
    await f.request('/api/repository/tree'); await f.db.settled();
    expect(warmBlame).not.toHaveBeenCalled();
    await f.restart(); await f.db.storage.deleteAlarm(); await f.current().alarm(); await f.db.settled();
    expect(warmBlame).toHaveBeenCalledExactlyOnceWith('team:team-1:repository:workspace-1', head);
    await f.current().alarm(); await f.db.settled();
    expect(warmBlame).toHaveBeenCalledTimes(1);
  });

  it('queues blame on a member root read of an existing repository but not an anonymous read', async () => {
    const f = await fixture(undefined, { headers: { ...ownerHeaders, 'x-braid-repository': 'team:team-1:repository:workspace-1' } });
    await f.request('/api/project', { name: 'project' }); await f.db.settled();
    const warmBlame = vi.fn(async () => {});
    Object.assign(f.env, { TRUNKS: { getByName: () => ({ warmBlame }) } });
    expect((await f.request('/api/repository/tree', undefined, undefined, { 'x-braid-public': 'true', 'x-braid-role': 'viewer' })).status).toBe(200);
    await f.db.settled(); expect(warmBlame).not.toHaveBeenCalled();
    expect((await f.request('/api/repository/tree')).status).toBe(200);
    await f.db.settled();
    expect(warmBlame).toHaveBeenCalledExactlyOnceWith('team:team-1:repository:workspace-1', head);
  });

  it('returns an immediately ready import as 201 and completes the sample without polling', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    const response = await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: 'project', head, stack: [] });
    expect(f.repo.log).toHaveBeenCalledTimes(1);
    expect(f.artifacts.import).toHaveBeenCalledWith({ source: { url: 'https://github.com/example/project.git', depth: 1 }, target: { name: 'r-workspace1-project', opts: { description: '' } } });
    expect(f.directory.repositoryImported).toHaveBeenCalledWith('workspace-1', true, '', true);
    expect(f.repo.revokeToken).toHaveBeenCalledWith('initial-secret');
    expect(await f.db.storage.get('pending-project')).toBeUndefined();
    const sample = await fixture(); sample.repo.state.head = '';
    expect((await sample.request('/api/project', { name: 'project' })).status).toBe(201);
    expect(sample.repo.log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitFiles)).toHaveBeenCalledWith(expect.objectContaining({ initialize: true }));
  });
  it('acknowledges an unready import, replays 202 and finishes from its alarm after eviction', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders }); f.repo.state.head = '';
    // Publication calls are unavailable until history is ready; creation must not depend on them.
    f.directory.repositoryImported.mockRejectedValueOnce(new Error('Directory unavailable'));
    const body = { name: 'project', sourceUrl: 'https://github.com/example/project.git' }, key = crypto.randomUUID();
    const response = await f.request('/api/project', body, key);
    expect(response.status).toBe(202);
    const { importing } = await response.json() as { importing: ProjectImport };
    expect(importing).toEqual({ name: 'project', source: 'example/project', startedAt: expect.any(String), branch: 'main' });
    expect(await f.state()).toMatchObject({ importing, project: { id: '' } });
    expect(f.directory.repositoryImported).not.toHaveBeenCalled();
    // The expected branch, then HEAD: neither has a commit yet, so no token is minted to name a branch.
    expect(f.repo.log).toHaveBeenCalledTimes(2);
    expect(f.repo.createToken).not.toHaveBeenCalled();
    expect(f.repo.revokeToken).not.toHaveBeenCalled();
    const due = await f.db.storage.getAlarm();
    expect(due).toBeGreaterThanOrEqual(Date.parse(importing.startedAt) + 2_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 2_000);
    await f.restart();
    const replay = await f.request('/api/project', body, key);
    expect(replay.status).toBe(202); expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(await replay.json()).toEqual({ importing });
    expect((await f.request('/api/project', body)).status).toBe(202);
    expect(f.artifacts.import).toHaveBeenCalledTimes(1); expect(f.security.consume).toHaveBeenCalledTimes(2);
    f.repo.state.head = head;
    await f.db.storage.deleteAlarm();
    await expect(f.current().alarm()).rejects.toThrow('Directory unavailable');
    expect(await f.db.storage.getAlarm()).toBeGreaterThan(Date.now());
    await f.restart(); await f.db.storage.deleteAlarm(); await f.current().alarm();
    const finished = await f.state();
    expect(finished.project).toMatchObject({ id: 'r-workspace1-project', name: 'project', head });
    expect(finished.files).toEqual({}); expect(finished).not.toHaveProperty('importing');
    expect(finished.activity.filter(event => event.message === 'Imported a repository into Artifacts')).toHaveLength(1);
    expect(await f.db.storage.get('repository-source')).toEqual({ public: true });
    expect(await f.db.storage.get('pending-project')).toBeUndefined();
    expect(f.repo.revokeToken).toHaveBeenCalledWith('initial-secret');
    expect(JSON.stringify(finished)).not.toContain('secret');
    expect(f.directory.access).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-owner' }), 'workspace-1', true);
    // The default branch opened, and the same run read the source's other branches: none here.
    expect(vi.mocked(copyBranches)).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: 'main', history: expect.objectContaining({ copy: { boundary: [head] } }) }));
    expect(finished.project.branches).toEqual(['main']); expect(finished).not.toHaveProperty('branchCopy');
    expect(await f.db.storage.get('branch-copy')).toBeUndefined(); expect(await f.db.storage.get('history-copy')).toBe('complete');
    expect((await f.request('/api/project', body, key)).status).toBe(202);
  });
  it('finishes an import on the branch its HEAD names when Artifacts reports main', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    // The copy's only branch is the source's default, stable; Artifacts still reports main.
    f.repo.log.mockImplementation(async (options?: unknown) => (options as { ref?: string } | undefined)?.ref === 'main' ? [] : [{ hash: head, treeHash: 'c'.repeat(40) }]);
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(String(input)).toBe('https://git.example/project/info/refs?service=git-upload-pack');
      return new Response(`${pkt('# service=git-upload-pack\n')}0000${pkt(`${head} HEAD\0multi_ack symref=HEAD:refs/heads/stable\n`)}${pkt(`${head} refs/heads/stable\n`)}0000`,
        { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    });
    try {
      const response = await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ name: 'project', head, branch: 'stable' });
      expect(f.repo.createToken).toHaveBeenCalledWith('read', 60);
      expect(f.repo.revokeToken).toHaveBeenCalledWith('secret-git-token');
      expect(await f.db.storage.get('pending-project')).toBeUndefined();
    } finally { fetch.mockRestore(); }
  });
  it('follows an import accepted before background imports from the next state read', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders }); f.repo.state.head = '';
    await f.db.storage.put('pending-project', { name: 'r-workspace1-project', displayName: 'project', description: '', sourceUrl: 'https://github.com/example/project.git', remote: 'https://git.example/project', branch: 'main', attempted: true });
    const { importing } = await f.state();
    expect(importing).toEqual({ name: 'project', source: 'example/project', startedAt: expect.any(String), branch: 'main' });
    expect(await f.db.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 500);
    f.repo.state.head = head;
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    const finished = await f.state();
    expect(finished.project).toMatchObject({ name: 'project', head });
    expect(finished).not.toHaveProperty('importing');
  });
  it('copies an import\'s other branches from the alarm, skipping refused ones, then stops', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    expect(await f.db.storage.get('branch-copy')).toMatchObject({ sourceUrl: 'https://github.com/example/project.git', shallow: head, failed: [], attempts: 0 });
    vi.mocked(copyBranches).mockResolvedValueOnce({ branches: ['main', 'feature/login'], failed: ['broken'], remaining: 1 })
      .mockResolvedValueOnce({ branches: ['main', 'feature/login', 'stable'], failed: [], remaining: 0 });
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(vi.mocked(copyBranches).mock.lastCall![0]).toMatchObject({ source: { remote: 'https://github.com/example/project.git', token: '' }, target: { remote: 'https://git.example/project', token: 'secret-git-token' }, defaultBranch: 'main', history: { copy: { boundary: [head] } } });
    expect(f.repo.revokeToken).toHaveBeenCalledWith('secret-git-token');
    let state = await f.state();
    expect(state.project.branches).toEqual(['main', 'feature/login']); expect(state.branchCopy).toEqual({ remaining: 1 });
    expect(await f.db.storage.getAlarm()).not.toBeNull();
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(vi.mocked(copyBranches).mock.lastCall![0].skip).toEqual(new Set(['broken']));
    state = await f.state();
    expect(state.project.branches).toEqual(['main', 'feature/login', 'stable']); expect(state).not.toHaveProperty('branchCopy');
    expect(state.activity[0].message).toBe('Copied 2 branches from the source');
    expect(await f.db.storage.get('branch-copy')).toBeUndefined();
  });
  it('keeps each landed part of history through a failed run, then records that a commit too large to push stopped it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    const deeper = 'a'.repeat(40);
    // A part is durable as soon as it lands, before the run that copied it ends.
    let landed: unknown;
    vi.mocked(copyBranches).mockImplementationOnce(async options => {
      await options.history!.saved({ boundary: [deeper], depth: 512, copied: 256 });
      landed = await f.db.storage.get('branch-copy');
      throw new Error('The Git server could not be reached.');
    }).mockResolvedValueOnce({ branches: ['main'], failed: [], remaining: 0, history: { boundary: [deeper], depth: 1, copied: 256, stopped: true } });
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(landed).toMatchObject({ history: { boundary: [deeper], depth: 512, copied: 256 }, attempts: 0 });
    expect(await f.db.storage.get('branch-copy')).toMatchObject({ history: { boundary: [deeper], depth: 512, copied: 256 }, attempts: 1 });
    expect(await f.db.storage.get('history-copy')).toEqual({ failedAt: expect.any(Number) });
    vi.advanceTimersByTime(10_000);
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(vi.mocked(copyBranches).mock.lastCall![0].history!.copy).toEqual({ boundary: [deeper], depth: 512, copied: 256 });
    expect(await f.db.storage.get('branch-copy')).toBeUndefined();
    expect(await f.db.storage.get('history-copy')).toBe('too-large');
  });
  it('logs a failed branch copy by code without exposing upstream text or reports, and retries it', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(copyBranches).mockRejectedValueOnce(Object.assign(new Error('remote private-fixture-token'), { code: 'UPSTREAM_UNAVAILABLE', report: { detail: 'private-fixture-report' } }));
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ event: 'branch_copy_failed', code: 'UPSTREAM_UNAVAILABLE', attempts: 1 }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-fixture');
    expect(await f.db.storage.get('branch-copy')).toMatchObject({ attempts: 1 });
    expect(await f.db.storage.getAlarm()).not.toBeNull();
  });
  it('keeps a refused copy with its original authority and waits before checking again', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    vi.mocked(copyBranches).mockRejectedValueOnce(new HttpError(403, 'GitHub refused this repository.'));
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(await f.db.storage.get('branch-copy')).toMatchObject({ attempts: 1, authorization: { user: { id: 'test-owner' } }, nextAttempt: expect.any(Number) });
    expect(await f.db.storage.get('history-copy')).toEqual({ failedAt: expect.any(Number) });
  });
  it('resumes after five failed history runs and a restart without losing a landed boundary or moving main', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    const boundary = 'c'.repeat(40);
    const copy = vi.mocked(copyBranches);
    copy.mockImplementationOnce(async options => {
      await options.history!.saved({ boundary: [boundary], depth: 128, copied: 256 });
      throw new GitError('unreachable', 'The source is unavailable.');
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) copy.mockRejectedValueOnce(new GitError('unreachable', 'The source is unavailable.'));
      await f.db.storage.deleteAlarm(); await f.current().alarm();
      expect(await f.db.storage.get('branch-copy')).toMatchObject({ attempts: attempt, history: { boundary: [boundary], copied: 256 }, authorization: { user: { id: 'test-owner' } } });
      if (attempt < 5) vi.advanceTimersByTime(10_000 * attempt);
    }
    const afterFailures = copy.mock.calls.length;
    await f.restart(); await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(copy).toHaveBeenCalledTimes(afterFailures);
    expect(await f.db.storage.getAlarm()).toBe(Date.now() + HISTORY_RETRY_MS);
    vi.advanceTimersByTime(HISTORY_RETRY_MS);
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(copy).toHaveBeenCalledTimes(afterFailures + 1);
    expect(copy.mock.lastCall![0].history!.copy).toEqual({ boundary: [boundary], depth: 128, copied: 256 });
    expect(await f.db.storage.get('branch-copy')).toBeUndefined();
    expect(await f.db.storage.get('history-copy')).toBe('complete');
    expect((await f.state()).project.head).toBe(head);
  });
  it('resumes a retired copy from retained import metadata and rechecks its owner before creating a token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    await f.db.storage.delete('branch-copy');
    await f.db.storage.put('history-copy', { failedAt: Date.now() - HISTORY_RETRY_MS });
    const copy = vi.mocked(copyBranches); copy.mockClear(); f.repo.createToken.mockClear();
    f.directory.access.mockResolvedValue({ ok: false, status: 403, error: 'Owner removed.' });
    await f.restart(); await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(copy).not.toHaveBeenCalled(); expect(f.repo.createToken).not.toHaveBeenCalled();
    expect(await f.db.storage.get('branch-copy')).toMatchObject({ authorization: { user: { id: 'test-owner' } }, attempts: 1 });
    f.directory.access.mockResolvedValue({ ok: true, data: { teamId: 'team-1' } });
    vi.advanceTimersByTime(HISTORY_RETRY_MS);
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(copy).toHaveBeenCalledTimes(1); expect(await f.db.storage.get('history-copy')).toBe('complete');
  });
  it('wakes a retired import from an ordinary state read before any write token is issued', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    await f.db.settled();
    await f.db.storage.delete('branch-copy'); await f.db.storage.deleteAlarm();
    const copy = vi.mocked(copyBranches); copy.mockClear(); f.repo.createToken.mockClear();
    await f.restart();
    expect((await f.request('/api/state')).status).toBe(200);
    await f.db.settled();
    expect(await f.db.storage.get('branch-copy')).toMatchObject({ authorization: { user: { id: 'test-owner' } }, attempts: 0 });
    expect(await f.db.storage.getAlarm()).not.toBeNull();
    expect(copy).not.toHaveBeenCalled(); expect(f.repo.createToken).not.toHaveBeenCalled();
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(copy).toHaveBeenCalledTimes(1); expect(await f.db.storage.get('history-copy')).toBe('complete');
  });
  it('does not infer missing import authority or revive a completed or size-limited copy', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    await f.db.storage.delete('branch-copy');
    const copy = vi.mocked(copyBranches); copy.mockClear();
    for (const state of ['complete', 'too-large']) {
      await f.db.storage.put('history-copy', state);
      await f.current().alarm();
      expect(copy).not.toHaveBeenCalled();
    }
    await f.db.storage.delete('repository-import');
    await f.db.storage.put('history-copy', { failedAt: 0 });
    await f.current().alarm();
    expect(copy).not.toHaveBeenCalled(); expect(await f.db.storage.get('branch-copy')).toBeUndefined();
  });
  it('copies history no deeper than a limit the workspace recorded, and the default branch alone', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    await f.db.storage.put('history-limit', 4_000);
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    vi.mocked(copyBranches).mockResolvedValueOnce({ branches: ['main'], failed: [], remaining: 0, history: { boundary: ['a'.repeat(40)], copied: 4_000, limit: 4_000, stopped: true } });
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(vi.mocked(copyBranches).mock.lastCall![0]).toMatchObject({ defaultOnly: true, history: { copy: { boundary: [head], limit: 4_000 } } });
    expect(await f.db.storage.get('history-copy')).toBe('too-large');
  });
  it('stops a copy for good the first time Artifacts says the repository is full', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' })).status).toBe(201);
    vi.mocked(copyBranches).mockRejectedValueOnce(new GitError('full', 'This repository reached its storage limit.'));
    await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(vi.mocked(copyBranches)).toHaveBeenCalledTimes(1);
    expect(await f.db.storage.get('branch-copy')).toBeUndefined();
    expect(await f.db.storage.get('history-copy')).toBe('too-large');
  });
  it('answers an import Artifacts is still copying, stops it with the reason a later refusal gives, and lets another source replace it', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders });
    let refuse!: () => void;
    f.artifacts.import.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(Object.assign(new Error('Missing'), { code: 'NOT_FOUND' })); }));
    const started = Date.now();
    const response = await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/missing.git' });
    expect(response.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await response.json() as { importing: ProjectImport }).importing).toEqual({ name: 'project', source: 'example/missing', startedAt: expect.any(String) });
    refuse(); await f.db.settled();
    expect((await f.state()).importing).toMatchObject({ error: 'That repository was not found. Check the URL and that the repository is public.' });
    // Artifacts kept nothing, so another source takes the stopped import's place.
    f.repo.info.mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: 'NOT_FOUND' }));
    const replaced = await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project.git' });
    expect(replaced.status).toBe(201);
    expect((await f.state()).project).toMatchObject({ name: 'project', head });
  });
  it('restarts a stopped import when the same source is chosen again, and opens it on the branch its copy has', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders }); f.repo.state.head = '';
    const body = { name: 'project', sourceUrl: 'https://github.com/example/project.git' };
    expect((await f.request('/api/project', body)).status).toBe(202);
    // Stopped at the limit while waiting for main, though the copy's only branch is stable.
    await f.db.storage.put('pending-project', { ...await f.db.storage.get<Record<string, unknown>>('pending-project'), branch: 'main', error: 'The import did not finish. Try again.' });
    f.repo.log.mockImplementation(async (options?: unknown) => (options as { ref?: string } | undefined)?.ref === 'main' ? [] : [{ hash: head, treeHash: 'c'.repeat(40) }]);
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`${pkt('# service=git-upload-pack\n')}0000${pkt(`${head} HEAD\0symref=HEAD:refs/heads/stable\n`)}${pkt(`${head} refs/heads/stable\n`)}0000`,
      { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }));
    try {
      const restarted = await f.request('/api/project', body);
      expect(restarted.status).toBe(202);
      expect((await restarted.json() as { importing: ProjectImport }).importing).not.toHaveProperty('error');
      await f.db.storage.deleteAlarm(); await f.current().alarm();
      expect((await f.state()).project).toMatchObject({ name: 'project', head, branch: 'stable' });
    } finally { fetch.mockRestore(); }
  });
  it('backs off readiness checks to five seconds and keeps provider failures pending', async () => {
    const f = await fixture(); f.repo.log.mockRejectedValueOnce(Object.assign(new Error('Importing'), { code: 'IMPORT_IN_PROGRESS' }));
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://gitlab.com/example/group/project.git' })).status).toBe(202);
    const pending = await f.db.storage.get<Record<string, unknown>>('pending-project');
    f.repo.state.head = '';
    for (const [elapsed, delay] of [[0, 2_000], [10_000, 3_000], [30_000, 5_000], [60_000, 5_000]]) {
      const at = Date.now();
      await f.db.storage.put('pending-project', { ...pending, startedAt: new Date(at - elapsed).toISOString() });
      await f.db.storage.deleteAlarm(); await f.current().alarm();
      expect(await f.db.storage.getAlarm()).toBeGreaterThanOrEqual(at + delay);
      expect(await f.db.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + delay);
    }
    expect((await f.state()).importing?.source).toBe('https://gitlab.com/example/group/project.git');
    expect((await f.state()).importing).not.toHaveProperty('error');
  });
  it('publishes the deadline error, invalidates state validators and idempotently restarts the import', async () => {
    const f = await fixture(); f.repo.state.head = '';
    const body = { name: 'project', sourceUrl: 'https://github.com/example/project' }, key = crypto.randomUUID();
    expect((await f.request('/api/project', body, key)).status).toBe(202);
    const before = await f.request('/api/state'), etag = before.headers.get('etag')!;
    const pending = await f.db.storage.get<Record<string, unknown>>('pending-project');
    const startedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    await f.db.storage.put('pending-project', { ...pending, startedAt });
    await f.db.storage.deleteAlarm(); await f.restart(); await f.current().alarm();
    expect(await f.db.storage.getAlarm()).toBeNull();
    const state = await f.request('/api/state', undefined, undefined, { 'if-none-match': etag });
    expect(state.status).toBe(200);
    const error = 'The import did not finish. Try again.';
    expect(await state.json()).toMatchObject({ importing: { error, startedAt } });
    expect(await (await f.request('/api/project', body, key)).json()).toMatchObject({ importing: { error } });
    const retryKey = crypto.randomUUID(), retry = await f.request('/api/project/import/retry', {}, retryKey);
    expect(retry.status).toBe(202);
    const restarted = await retry.json() as { importing: ProjectImport };
    expect(restarted.importing).not.toHaveProperty('error'); expect(restarted.importing.startedAt).not.toBe(startedAt);
    expect(await f.db.storage.getAlarm()).toBeGreaterThan(Date.now());
    const replay = await f.request('/api/project/import/retry', {}, retryKey);
    expect(replay.status).toBe(202); expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(await replay.json()).toEqual(restarted); expect(f.repo.info).toHaveBeenCalledTimes(1);
    expect(f.artifacts.import).toHaveBeenCalledTimes(1); expect(f.security.consume).toHaveBeenCalledTimes(2);
    f.repo.state.head = head; await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect((await f.state()).project.head).toBe(head); expect(await f.state()).not.toHaveProperty('importing');
  });
  it('reimports a missing target on retry and keeps the original source and depth', async () => {
    const f = await fixture(); f.repo.state.head = '';
    const sourceUrl = 'https://codeberg.org/example/project.git';
    expect((await f.request('/api/project', { name: 'project', sourceUrl })).status).toBe(202);
    f.repo.info.mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: 'NOT_FOUND' }));
    expect((await f.request('/api/project/import/retry', {})).status).toBe(202);
    expect(f.artifacts.import).toHaveBeenCalledTimes(2);
    expect(f.artifacts.import).toHaveBeenLastCalledWith({ source: { url: sourceUrl, depth: 1 }, target: { name: 'project', opts: { description: '' } } });
    expect(f.security.consume).toHaveBeenCalledTimes(2);
    f.repo.state.head = head; await f.db.storage.deleteAlarm(); await f.current().alarm();
    expect(await f.state()).not.toHaveProperty('importing');
  });
  it('acknowledges retry while the target is still preparing without starting a second import', async () => {
    const f = await fixture(); f.repo.state.head = '';
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project' })).status).toBe(202);
    f.repo.info.mockRejectedValueOnce(Object.assign(new Error('Importing'), { code: 'IMPORT_IN_PROGRESS' }));
    expect((await f.request('/api/project/import/retry', {})).status).toBe(202);
    expect(f.artifacts.import).toHaveBeenCalledTimes(1);
    expect(await f.db.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
  it('omits import state from public viewers and keeps retry restricted to owners', async () => {
    const f = await fixture(); f.repo.state.head = '';
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/private-source' })).status).toBe(202);
    const member = await f.request('/api/state', undefined, undefined, { 'x-braid-role': 'viewer' });
    expect(await member.json()).toHaveProperty('importing');
    const anonymous = await f.request('/api/state', undefined, undefined, { 'x-braid-public': 'true', 'x-braid-role': 'viewer' });
    expect(await anonymous.text()).not.toContain('private-source');
    await expectError(await f.request('/api/project/import/retry', {}, undefined, { 'x-braid-role': 'viewer' }), 403, /Only an owner/);
    await expectError(await f.request('/api/project/import/retry', []), 400, /JSON object/);
    await expectError(await f.request('/api/project/import/retry', {}, undefined, { 'idempotency-key': '' }), 400, /Idempotency-Key/);
  });
  it('preserves earlier job alarms when importing and earlier import alarms when delivering jobs or activity', async () => {
    const f = await fixture(); f.repo.state.head = '';
    const earlier = Date.now() + 1_000; await f.db.storage.setAlarm(earlier);
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project' })).status).toBe(202);
    expect(await f.db.storage.getAlarm()).toBe(earlier);
    const jobs = await fixture(); await launch(jobs);
    await jobs.db.storage.put('pending-project', { name: 'project', displayName: 'project', description: '', sourceUrl: 'https://github.com/example/project', remote: 'https://git.example/project', branch: 'main', startedAt: new Date().toISOString() });
    jobs.repo.state.head = '';
    await jobs.db.storage.put('directory-activity', { workspaceId: 'workspace-1', updatedAt: new Date().toISOString(), description: '' });
    jobs.directory.repositoryActivity.mockRejectedValueOnce(new Error('Directory unavailable'));
    await jobs.db.storage.deleteAlarm();
    const at = Date.now(); await jobs.current().alarm();
    expect(jobs.workflows.create).toHaveBeenCalledTimes(1); expect(jobs.jobs()).toHaveLength(1);
    expect(await jobs.db.storage.getAlarm()).toBeGreaterThanOrEqual(at + 2_000);
    expect(await jobs.db.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 2_000);
  });
  it('rejects organization pages before reserving an import or consuming its budget', async () => {
    const f = await fixture();
    await expectError(await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/orgs/ACM-VIT/repositories' }), 400, /repository URL/);
    expect(f.artifacts.import).not.toHaveBeenCalled();
    expect(f.security.consume).not.toHaveBeenCalled();
    expect(await f.db.storage.get('pending-project')).toBeUndefined();
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project' })).status).toBe(201);
    expect(await f.current().publicationMetadata()).toMatchObject({ sourcePublic: true });
    expect(await (await f.restart()).publicationMetadata()).toMatchObject({ sourcePublic: true });
  });
  it('recovers a legacy invalid import only after confirming its target is absent', async () => {
    const f = await fixture();
    await f.db.storage.put('pending-project', { name: 'project', displayName: 'project', description: 'Built together in Braid', sourceUrl: 'https://github.com/orgs/ACM-VIT/repositories', attempted: true });
    await f.restart();
    f.artifacts.get.mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: 'NOT_FOUND' }));
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project' })).status).toBe(201);
    expect(f.artifacts.import).toHaveBeenCalledTimes(1);
    expect(await f.db.storage.get('pending-project')).toBeUndefined();
  });
  it.each(['existing', 'IMPORT_IN_PROGRESS', 'INTERNAL_ERROR'])('keeps an invalid old reservation when the target is %s', async condition => {
    const f = await fixture();
    const pending = { name: 'project', displayName: 'project', description: 'Built together in Braid', sourceUrl: 'https://github.com/orgs/ACM-VIT/repositories', attempted: true };
    await f.db.storage.put('pending-project', pending);
    if (condition !== 'existing') f.artifacts.get.mockRejectedValueOnce(Object.assign(new Error('Unconfirmed'), { code: condition }));
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project' })).status).toBe(409);
    expect(f.artifacts.import).not.toHaveBeenCalled();
    expect(await f.db.storage.get('pending-project')).toEqual(pending);
  });
  it.each(['INVALID_URL', 'NOT_FOUND', 'REMOTE_AUTH_REQUIRED'])('releases a rejected %s import after confirming no target was created', async code => {
    const f = await fixture();
    f.artifacts.import.mockRejectedValueOnce(Object.assign(new Error('Provider detail must not be returned'), { code }));
    f.artifacts.get.mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: 'NOT_FOUND' }));
    const response = await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/missing' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('Provider detail');
    expect(await f.db.storage.get('pending-project')).toBeUndefined();
    expect((await f.request('/api/project', { name: 'project', sourceUrl: 'https://github.com/example/project' })).status).toBe(201);
  });
  it('preserves uncertain import recovery even if a later attempt reports an invalid source', async () => {
    const f = await fixture(), key = crypto.randomUUID(), body = { name: 'project', sourceUrl: 'https://github.com/example/project' };
    f.artifacts.import.mockRejectedValueOnce(new Error('Response lost'));
    expect((await f.request('/api/project', body, key)).status).toBe(500);
    f.artifacts.import.mockRejectedValueOnce(Object.assign(new Error('Invalid source'), { code: 'INVALID_URL' }));
    expect((await f.request('/api/project', body, key)).status).toBe(500);
    expect(await f.db.storage.get('pending-project')).toBeTruthy();
    f.artifacts.import.mockRejectedValueOnce(Object.assign(new Error('Exists'), { code: 'ALREADY_EXISTS' }));
    expect((await f.request('/api/project', body, key)).status).toBe(201);
  });
  it('persists accepted task receipts and retries an unavailable workflow using its original ID after eviction', async () => {
    const f = await fixture(), task = await launch(f), original = f.jobs()[0].id;
    vi.useFakeTimers({ toFake: ['Date'] });
    await f.restart();
    const repeated = await f.request('/api/missions', task.body, task.key);
    expect(repeated.headers.get('idempotency-replayed')).toBe('true');
    expect(await repeated.json()).toEqual({ missionId: task.missionId });
    expect((await f.state()).missions).toHaveLength(1);
    f.workflows.create.mockRejectedValueOnce(new Error('Workflow unavailable'));
    f.workflows.get.mockRejectedValueOnce(new Error('Workflow not created'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await f.current().alarm(); warn.mockRestore();
    expect(f.jobs()).toHaveLength(1);
    expect(await f.db.storage.getAlarm()).toBeGreaterThan(Date.now());
    await f.restart();
    await f.current().alarm(); // An early alarm cannot skip the persisted backoff.
    expect(f.workflows.create).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1000); await f.current().alarm();
    expect(f.workflows.create.mock.calls.map(args => (args[0] as { id: string }).id)).toEqual([original, original]);
  });
  it('reconciles a lost creation response and ignores callbacks from a superseded operation', async () => {
    const f = await fixture(), task = await launch(f), operation = f.jobs()[0].id;
    f.workflows.create.mockRejectedValueOnce(new Error('Response lost after successful creation'));
    await f.current().alarm(); await f.restart(); await f.current().alarm();
    expect(f.workflows.create).toHaveBeenCalledTimes(1);
    await f.current().failAgent(task.missionId, 'atlas', 'Stale failure', 'old-operation');
    expect((await f.state()).missions[0].agents[0].status).toBe('queued');
    for (const agent of (await f.state()).missions[0].agents) await f.current().failAgent(task.missionId, agent.id, 'Failure from the active operation', operation);
    await f.current().finishMission(task.missionId, operation); await f.current().alarm();
    expect((await f.state()).missions[0].status).toBe('failed'); expect(f.jobs()).toHaveLength(0);
  });
  it('reserves import identity before calling Artifacts and recovers after a lost import response', async () => {
    const f = await fixture(), key = crypto.randomUUID(), body = { name: 'project', sourceUrl: 'https://github.com/example/project.git' };
    f.artifacts.import.mockRejectedValueOnce(new Error('Lost response'));
    expect((await f.request('/api/project', body, key)).status).toBe(500);
    await f.restart();
    expect((await f.request('/api/project', { ...body, name: 'another' })).status).toBe(409);
    expect(f.artifacts.import).toHaveBeenCalledTimes(1);
    f.artifacts.import.mockRejectedValueOnce(Object.assign(new Error('Exists'), { code: 'ALREADY_EXISTS' }));
    expect((await f.request('/api/project', body, key)).status).toBe(201);
    await f.restart();
    expect((await f.request('/api/project', body, key)).headers.get('idempotency-replayed')).toBe('true');
    expect(f.artifacts.import).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await f.state())).not.toContain('initial-secret');
    expect(JSON.stringify(await f.state())).not.toContain('secret-git-token');
  });
  it('recovers the exact staged integration and Git receipt after a push response is lost', async () => {
    const seed = seedWorkspace('demo', { mode: 'live', artifacts: true, ai: true, authenticated: true, model: 'test', namespace: 'test', storage: 'durable-object', canWrite: false });
    const mission = seed.missions[0]; mission.source = 'live'; seed.project.remote = 'https://git.example/project';
    for (const overlap of mission.collisions) overlap.resolution = { agentId: overlap.agentIds[0], reason: 'Reviewed the bounded retry behavior.', resolvedAt: new Date().toISOString() };
    const f = await fixture(seed), path = `/api/missions/${mission.id}`;
    const preview = await (await f.request(`${path}/integration`)).json() as { fingerprint: string };
    expect((await f.request(`${path}/merge`, { integrationFingerprint: preview.fingerprint })).status).toBe(202);
    const operation = f.jobs()[0].id;
    vi.mocked(commitFiles).mockImplementationOnce(async options => { await options.onPrepared!(merged); throw new Error('Push response lost'); });
    await expect(f.current().integrateMission(mission.id, operation)).rejects.toThrow();
    const first = structuredClone(vi.mocked(commitFiles).mock.calls[0][0].files);
    await f.restart();
    vi.mocked(commitFiles).mockImplementationOnce(async options => { expect(options.preparedCommit).toBe(merged); expect(options.files).toEqual(first); return merged; });
    expect(await f.current().integrateMission(mission.id, operation)).toEqual({ commit: merged });
    await f.restart();
    const result = await f.state(); expect(result.project.head).toBe(merged); expect(result.missions[0].status).toBe('merged');
    expect(result.files[`.braid/missions/${mission.id}/decision.json`]).toContain(preview.fingerprint);
    expect(f.repo.revokeToken).toHaveBeenCalledTimes(2);
  });
});

describe('dual execution task creation', () => {
  it.each([undefined, 1, 2, 3])('creates %s local lanes without AI bindings or Workflows', async agentCount => {
    const f = await localTask({ agentCount, ai: false, workflows: false });
    await f.restart();
    await f.current().alarm();
    const state = await f.state(), mission = state.missions[0];
    expect(mission).toMatchObject({ execution: 'local', source: 'live', status: 'running', baseCommit: head });
    expect(mission.agents).toHaveLength(agentCount ?? 1);
    expect(mission.agents.every(agent => agent.status === 'queued' && agent.scope.join() === '*')).toBe(true);
    expect(state.capabilities.ai).toBe(false);
    expect(f.jobs()).toHaveLength(0);
    expect(await f.db.storage.getAlarm()).toBeNull();
    expect(f.ai.run).not.toHaveBeenCalled();
    expect(f.workflows.create).not.toHaveBeenCalled();
    expect(f.workflows.get).not.toHaveBeenCalled();
  });

  it('records optional progress only for the active claimant and replays it without duplicate activity', async () => {
    const f = await localTask();
    const path = `${f.path}/agents/atlas/progress`, message = 'Implementation complete; checking the combined result.';
    await expectError(await f.request(path, { message }, undefined, connection('codex')), 409, /Start this task/);
    await f.checkout();
    await expectError(await f.request(path, { message }, undefined, connection('other')), 403, /connected agent/);
    const key = crypto.randomUUID();
    const response = await f.request(path, { message }, key, connection('codex'));
    expect(response.status).toBe(200);
    await f.restart();
    expect((await f.request(path, { message }, key, connection('codex'))).headers.get('idempotency-replayed')).toBe('true');
    const state = await f.state(), task = state.missions.find(item => item.id === f.missionId)!;
    expect(task.agents[0].progress?.message).toBe(message);
    expect(state.activity.filter(item => item.message === message)).toHaveLength(1);
    expect(task.agents[0].checks).toEqual([]);
    await f.submit();
    await expectError(await f.request(path, { message: 'Late update' }, undefined, connection('codex')), 409, /Start this task/);
  });

  it('completes a local proposal without AI or Workflows', async () => {
    const f = await localTask({ ai: false, workflows: false });
    expect((await f.checkout()).status).toBe(200);
    expect((await f.submit()).status).toBe(200);
    expect((await f.state()).missions[0].status).toBe('review');
    expect(f.ai.run).not.toHaveBeenCalled();
    expect(f.workflows.create).not.toHaveBeenCalled();
    expect(f.jobs()).toHaveLength(0);
  });

  it.each([{}, { execution: 'cloud', agentCount: 1 }, { execution: 'cloud', agentCount: 2 }, { execution: 'cloud', agentCount: 3 }])('delivers the requested hosted approaches through a durable Workflow for %j', async input => {
    const f = await fixture(), task = await launch(f, input);
    const mission = (await f.state()).missions[0];
    expect(mission).toMatchObject({ execution: 'cloud', source: 'live' });
    const count = 'agentCount' in input ? input.agentCount : 3;
    expect(mission.agents).toHaveLength(count!);
    // A hosted lane goes by the model that runs it.
    if (count === 1) expect(mission.agents[0]).toMatchObject({ name: 'Test', model: 'test', scope: ['*'], task: expect.stringContaining('implementation, tests and documentation') });
    else expect(mission.agents.map(agent => agent.name)).toEqual(['Test (Reliability)', 'Test (Security)', 'Test (Developer experience)'].slice(0, count));
    expect(f.jobs()).toHaveLength(1);
    await f.current().alarm();
    expect(f.workflows.create).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ missionId: task.missionId, agentIds: ['atlas', 'sable', 'reed'].slice(0, count), action: 'run' }) }));
    expect(f.ai.run).not.toHaveBeenCalled();
  });

  it.each([0, 4, -1, 1.5, '2', true])('rejects invalid local agent count %j', async agentCount => {
    const f = await fixture();
    expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
    await expectError(await f.request('/api/missions', { title: 'Task', intent: 'Improve setup.', execution: 'local', agentCount }), 400, /one to three/);
    expect((await f.state()).missions).toHaveLength(0);
    expect(f.jobs()).toHaveLength(0);
  });

  it('rejects an unknown executor and local execution in the recorded example', async () => {
    const f = await fixture();
    expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
    await expectError(await f.request('/api/missions', { title: 'Task', intent: 'Improve setup.', execution: 'unknown' }), 400, /local or Cloudflare/);
    const demo = await fixture();
    await expectError(await demo.request('/api/missions', { title: 'Task', intent: 'Improve setup.', execution: 'local' }, undefined, { 'x-braid-mode': 'demo' }), 400, /recorded example/);
  });
});

describe('continuing with completed work', () => {
  it('closes unused local lanes, survives restart, and merges only completed work with provenance', async () => {
    const f = await localTask({ agentCount: 3 });
    await f.checkout();
    const key = crypto.randomUUID();
    expect((await f.submit(submission(), key)).status).toBe(200);
    const before = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect((await f.request(`${f.path}/finish`, { agentIds: ['atlas'] })).status).toBe(200);
    await f.restart();
    expect((await f.state()).missions[0].agents.map(agent => agent.status)).toEqual(['review', 'skipped', 'skipped']);
    expect((await f.request(`${f.path}/finish`, { agentIds: ['atlas'] })).status).toBe(200);
    await expectError(await f.checkout('sable'), 409, /owner closed/);
    await expectError(await f.submit(submission(), undefined, 'sable'), 409, /owner closed/);
    expect((await f.submit(submission(), key)).headers.get('idempotency-replayed')).toBe('true');
    const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect(preview.ready).toBe(true);
    expect(preview.fingerprint).not.toBe(before.fingerprint);
    expect(preview.files.map(file => file.path)).toEqual(['docs/local.md']);
    expect(preview.handoff).toContain('Closed by the owner; excluded from this result.');
    await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: before.fingerprint }), 409, /changed after you reviewed/);
    expect((await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint })).status).toBe(202);
    await f.current().integrateMission(f.missionId, f.jobs()[0].id);
    const state = await f.state();
    expect(state.missions[0].agents.map(agent => agent.status)).toEqual(['merged', 'skipped', 'skipped']);
    const ledger = JSON.parse(state.files[`.braid/missions/${f.missionId}/decision.json`]);
    expect(ledger.lanes.map((lane: { status: string }) => lane.status)).toEqual(['review', 'skipped', 'skipped']);
  });

  it('requires owner access and the exact completed proposal set, including late submissions', async () => {
    const f = await localTask({ agentCount: 3, headers: ownerHeaders });
    await expectError(await f.request(`${f.path}/finish`, { agentIds: [] }), 409, /no completed work/);
    await f.checkout(); await f.submit();
    await expectError(await f.request(`${f.path}/finish`, { agentIds: ['atlas'] }, undefined, { 'x-braid-role': 'viewer' }), 403, /Only an owner/);
    await expectError(await f.request(`${f.path}/finish`, { agentIds: ['atlas'] }, undefined, connection('agent')), 403, /Only an owner/);
    for (const agentIds of [undefined, [123]]) await expectError(await f.request(`${f.path}/finish`, { agentIds }), 400, /agents whose work you reviewed/);
    for (const agentIds of [['atlas', 'atlas'], ['sable']]) await expectError(await f.request(`${f.path}/finish`, { agentIds }), 409, /proposals changed/);
    await f.checkout('sable'); await f.submit(submission(), undefined, 'sable');
    await expectError(await f.request(`${f.path}/finish`, { agentIds: ['atlas'] }), 409, /proposals changed/);
    f.directory.access.mockResolvedValueOnce({ ok: false, status: 403, error: 'Forbidden.' });
    await expectError(await f.request(`${f.path}/finish`, { agentIds: ['atlas', 'sable'] }), 403, /no longer has repository access/);
    expect((await f.state()).missions[0].status).toBe('running');
  });

  it('cannot close a lane while its proposal is publishing', async () => {
    const f = await localTask({ agentCount: 3 });
    await f.checkout(); await f.submit(); await f.checkout('sable');
    const started = deferred(), release = deferred();
    vi.mocked(commitFiles).mockImplementationOnce(async () => { started.resolve(); await release.promise; return merged; });
    const pending = f.submit(submission(), undefined, 'sable');
    await started.promise;
    try { await expectError(await f.request(`${f.path}/finish`, { agentIds: ['atlas'] }), 409, /current Git operation/); }
    finally { release.resolve(); }
    expect((await pending).status).toBe(200);
    expect((await f.state()).missions[0].agents[1].status).toBe('review');
  });

  it('retains failed test checks and overlap decisions when the owner closes a waiting lane', async () => {
    const f = await localTask({ agentCount: 3 });
    await f.checkout(); await f.submit(submission({ tests: [{ command: 'npm test', result: 'failed' }] }));
    await f.checkout('sable'); await f.submit(submission({ files: [{ path: 'docs/local.md', content: '# Different result\n' }] }), undefined, 'sable');
    expect((await f.request(`${f.path}/finish`, { agentIds: ['sable', 'atlas'] })).status).toBe(200);
    const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect(preview.totals.unresolved).toBe(1);
    expect(preview.ready).toBe(false);
    await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint }), 409, /failed checks/);
  });

  it('recovers a finished hosted proposal after other agents fail, but never while they run', async () => {
    const f = await fixture(), task = await launch(f), operation = f.jobs()[0].id;
    const path = `/api/missions/${task.missionId}`;
    await f.current().runAgent(task.missionId, 'atlas', operation);
    await expectError(await f.request(`${path}/finish`, { agentIds: ['atlas'] }), 409, /hosted agents are still running/);
    for (const id of ['sable', 'reed']) await f.current().failAgent(task.missionId, id, 'Generation failed', operation);
    await f.current().finishMission(task.missionId, operation);
    expect((await f.state()).missions[0].error).toBe('Generation failed');
    expect((await f.request(`${path}/finish`, { agentIds: ['atlas'] })).status).toBe(200);
    expect((await f.state()).missions[0].error).toBeUndefined();
    const preview = await (await f.request(`${path}/integration`)).json() as IntegrationPreview;
    expect(preview.ready).toBe(true);
    await f.current().failAgent(task.missionId, 'sable', 'Late workflow message', operation);
    await expect(f.current().runAgent(task.missionId, 'sable', operation)).rejects.toThrow();
    const after = await (await f.request(`${path}/integration`)).json() as IntegrationPreview;
    expect(after.fingerprint).toBe(preview.fingerprint);
  });
});

describe('concurrent repository tasks', () => {
  it('pins independent tasks for two owners, allows a merge while another runs, and rejects its stale result', async () => {
    const f = await localTask({ headers: ownerHeaders });
    const secondOwner = { ...ownerHeaders, 'x-braid-user-id': 'second-owner', 'x-braid-actor': 'second@example.test' };
    const start = await f.request('/api/missions', { title: 'Independent task', intent: 'Document a different feature.', execution: 'local' }, undefined, secondOwner);
    expect(start.status).toBe(202);
    const { missionId: second } = await start.json() as { missionId: string };
    const secondPath = `/api/missions/${second}`;
    const independent = { ...secondOwner, ...connection('second-agent') };
    await f.checkout(); await f.submit();
    const before = (await f.state()).missions.find(m => m.id === second)!;
    expect(before).toMatchObject({ status: 'running', baseCommit: head, agents: [expect.objectContaining({ status: 'queued' })] });
    const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect((await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint })).status).toBe(202);
    await f.current().integrateMission(f.missionId, f.jobs().find(job => job.id.includes('-merge-'))!.id);
    expect((await f.request(`${secondPath}/agents/atlas/checkout`, {}, undefined, independent)).status).toBe(200);
    expect((await f.request(`${secondPath}/agents/atlas/submit`, submission({ files: [{ path: 'docs/other.md', content: '# Other feature\n' }] }), undefined, independent)).status).toBe(200);
    const state = await f.state();
    expect(state.missions.find(m => m.id === f.missionId)?.status).toBe('merged');
    expect(state.missions.find(m => m.id === second)?.status).toBe('review');
    expect(state.missions.find(m => m.id === second)?.agents[0].changes[0].path).toBe('docs/other.md');
    const stale = await (await f.request(`${secondPath}/integration`)).json() as IntegrationPreview;
    expect(stale.ready).toBe(false);
    await expectError(await f.request(`${secondPath}/merge`, { integrationFingerprint: stale.fingerprint }), 409, /main branch changed/);
  });

  it('advances every recorded task independently in the same alarm', async () => {
    const f = await fixture();
    const headers = { 'x-braid-mode': 'demo' };
    await f.request('/api/state', undefined, undefined, headers);
    for (const title of ['Task one', 'Task two']) expect((await f.request('/api/missions', { title, intent: 'Replay a task.' }, undefined, headers)).status).toBe(202);
    for (let i = 0; i < 5; i++) await f.current().alarm();
    const state = await (await f.request('/api/state', undefined, undefined, headers)).json() as WorkspaceSnapshot;
    expect(state.missions.slice(0, 2).map(m => m.status)).toEqual(['review', 'review']);
    expect(state.missions.slice(0, 2).every(m => m.agents.every(agent => agent.changes.length > 0))).toBe(true);
  });
});

describe('local checkout and lane ownership', () => {
  it('returns only a short-lived read token and keeps tokens out of persisted snapshots', async () => {
    const f = await localTask();
    const response = await f.checkout();
    expect(response.status).toBe(200);
    const checkout = await response.json() as { token: string; remote: string };
    const fork = await f.fork();
    expect(checkout).toMatchObject({ missionId: f.missionId, agentId: 'atlas', baseCommit: head, branch: 'main', remote: (await fork.info()).remote, scope: ['*'] });
    expect(checkout.token).toBe(`fake-read-${(await fork.info()).name}`);
    expect(fork.createToken).toHaveBeenCalledExactlyOnceWith('read', 600);
    expect(fork.revokeToken).toHaveBeenCalledExactlyOnceWith('initial-fork-secret');
    expect(commitFiles).not.toHaveBeenCalled();
    await f.restart();
    const snapshot = JSON.stringify(await f.state());
    const persisted = JSON.stringify(f.db.storage.sql.exec('SELECT key, value FROM records').toArray());
    const exported = JSON.stringify(await (await f.request('/api/export')).json());
    for (const value of [snapshot, persisted, exported]) {
      expect(value).not.toContain(checkout.token);
      expect(value).not.toContain('initial-fork-secret');
      expect(value).not.toContain('initial-secret');
      expect(value).not.toContain('secret-git-token');
    }
  });

  it('reopens the fork an earlier attempt created', async () => {
    const f = await localTask();
    const create = f.repo.fork.getMockImplementation()!;
    f.repo.fork.mockImplementationOnce(async (name, options) => { await create(name, options); throw Object.assign(new Error('Exists'), { code: 'ALREADY_EXISTS' }); });
    const response = await f.checkout();
    expect(response.status).toBe(200);
    const fork = await f.fork();
    expect((await response.json() as { remote: string }).remote).toBe((await fork.info()).remote);
    expect(fork.revokeToken).not.toHaveBeenCalled();
  });

  it('can start after main moved and publishes against the original pinned parent', async () => {
    const f = await localTask();
    f.repo.fork.mockImplementationOnce(async forkName => {
      // Advance the fork immediately after creation, as a late fork from current main would be.
      const original = await f.repo.info();
      const fork = { ...f.repo, state: { head: merged }, info: vi.fn(async () => ({ ...original, name: forkName, remote: `https://git.example/${forkName}` })), log: vi.fn(async () => [{ hash: merged, treeHash: 'c'.repeat(40) }]) };
      f.repositories.set(forkName, fork);
      return { name: forkName, remote: `https://git.example/${forkName}`, token: 'initial-fork-secret' };
    });
    expect((await f.checkout()).status).toBe(200);
    expect((await f.submit()).status).toBe(200);
    expect(commitFiles).toHaveBeenCalledWith(expect.objectContaining({ expectedHead: merged, parentCommit: head }));
    expect((await f.state()).missions[0].baseCommit).toBe(head);
  });

  it('isolates claims and forks for separate Codex and Claude connections', async () => {
    const f = await localTask({ agentCount: 2 });
    expect((await f.checkout('atlas', connection('codex'))).status).toBe(200);
    expect((await f.checkout('sable', connection('claude'))).status).toBe(200);
    await f.restart();
    await expectError(await f.checkout('atlas', connection('claude')), 409, /Another local agent/);
    await expectError(await f.submit(submission(), undefined, 'atlas', connection('claude')), 403, /current local connection/);
    const [atlas, sable] = await Promise.all([f.fork('atlas'), f.fork('sable')]);
    expect((await atlas.info()).remote).not.toBe((await sable.info()).remote);
    expect((await f.checkout('atlas', connection('codex'))).status).toBe(200);
    expect(f.repo.fork).toHaveBeenCalledTimes(2);
    expect(atlas.createToken.mock.calls.every(([scope]) => scope === 'read')).toBe(true);
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it('expires claims, permits renewal, and rejects the previous connection after transfer', async () => {
    const f = await localTask(), started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    expect((await f.checkout('atlas', connection('old', started + 1000))).status).toBe(200);
    clock.mockReturnValue(started + 1001);
    await expectError(await f.submit(submission(), undefined, 'atlas', connection('old')), 403, /Check out this lane/);
    expect((await f.checkout('atlas', connection('new'))).status).toBe(200);
    await expectError(await f.submit(submission(), undefined, 'atlas', connection('old')), 403, /current local connection/);
    expect((await f.submit(submission(), undefined, 'atlas', connection('new'))).status).toBe(200);
    expect(f.repo.fork).toHaveBeenCalledTimes(1);
  });

  it('caps a lane claim at one hour even for a longer connection', async () => {
    const f = await localTask(), started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    expect((await f.checkout('atlas', connection('old', started + 86_400_000))).status).toBe(200);
    clock.mockReturnValue(started + 3_600_000);
    expect((await f.checkout('atlas', connection('new'))).status).toBe(200);
    expect(f.repo.fork).toHaveBeenCalledTimes(1);
  });

  it('requires checkout before a proposal can publish and rejects unknown or cloud lanes', async () => {
    const f = await localTask();
    await expectError(await f.submit(), 403, /Check out this lane/);
    await expectError(await f.checkout('missing'), 404, /lane not found/);
    const cloud = await fixture(), task = await launch(cloud);
    await expectError(await cloud.request(`/api/missions/${task.missionId}/agents/atlas/checkout`, {}), 409, /created for local agents/);
    await expectError(await cloud.request(`/api/missions/${task.missionId}/agents/atlas/submit`, submission()), 409, /created for local agents/);
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it('prevents checkout and submission after owner cancellation, including after restart', async () => {
    const f = await localTask({ agentCount: 2 });
    expect((await f.checkout()).status).toBe(200);
    await expectError(await f.request(`${f.path}/cancel`, {}, undefined, { 'x-braid-role': 'viewer' }), 403, /Only an owner/);
    expect((await f.request(`${f.path}/cancel`, {})).status).toBe(200);
    await f.restart();
    await expectError(await f.checkout(), 409, /no longer accepting/);
    await expectError(await f.checkout('sable'), 409, /no longer accepting/);
    await expectError(await f.submit(), 409, /no longer accepting/);
    const mission = (await f.state()).missions[0];
    expect(mission).toMatchObject({ status: 'failed', cancelled: true });
    expect(mission.agents.every(agent => agent.status === 'failed')).toBe(true);
    expect(commitFiles).not.toHaveBeenCalled();
    expect(f.jobs()).toHaveLength(0);
  });
});

describe('local submission validation and review', () => {
  it.each([
    { name: 'stale base', fields: { baseCommit: 'c'.repeat(40) }, status: 409, error: /different base/ },
    { name: 'protected path', fields: { files: [{ path: '.braid/missions/forged.md', content: 'forged' }] }, status: 400, error: /protected paths/ },
    { name: 'secret path', fields: { files: [{ path: 'config/.env.production', content: 'value' }] }, status: 400, error: /protected paths/ },
    { name: 'binary content', fields: { files: [{ path: 'docs/local.md', content: 'text\0data' }] }, status: 400, error: /UTF-8|Binary/ },
    { name: 'malformed Unicode', fields: { files: [{ path: 'docs/local.md', content: '\ud800' }] }, status: 400, error: /UTF-8/ },
  ])('rejects $name before staging or issuing write credentials', async ({ fields, status, error }) => {
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    await expectError(await f.submit(submission(fields)), status, error);
    expect(f.proposal(f.missionId)).toBeUndefined();
    expect((await f.fork()).createToken).toHaveBeenCalledExactlyOnceWith('read', 600);
    expect(commitFiles).not.toHaveBeenCalled();
    expect((await f.state()).missions[0].agents[0].status).toBe('working');
  });

  it('enforces the Artifacts push allowance before staging or issuing write credentials', async () => {
    const validate = vi.spyOn(await import('../git/push'), 'validateGitChanges');
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    const files = (bytes: number) => [{ path: 'docs/local.md', content: 'x'.repeat(bytes) }];
    const message = /Cloudflare Artifacts accepts about 30 MB per push/;
    // Observe the generated provenance capsule without mocking the real validator.
    await expectError(await f.submit(submission({ files: files(29_000_000) })), 413, message);
    const capsule = Object.entries(validate.mock.calls.at(-1)![2]).find(([path]) => path.startsWith('.braid/missions/'))![1];
    if (typeof capsule !== 'string') throw new Error('Expected the task provenance capsule.');
    const available = 29_000_000 - Buffer.byteLength(capsule);
    await expectError(await f.submit(submission({ files: files(available + 1) })), 413, message);
    expect(f.proposal(f.missionId)).toBeUndefined();
    expect((await f.fork()).createToken).toHaveBeenCalledExactlyOnceWith('read', 600);
    expect((await f.fork()).readFile).not.toHaveBeenCalled();
    expect(commitFiles).not.toHaveBeenCalled();
    expect((await f.state()).missions[0].agents[0].status).toBe('working');
    expect((await f.submit(submission({ files: files(available - 1) }))).status).toBe(200);
    const published = vi.mocked(commitFiles).mock.calls[0][0].files;
    expect(Object.values(published).reduce((sum, value) => sum + Buffer.byteLength(value as string), 0)).toBe(29_000_000 - 1);
    expect((await f.state()).missions[0].agents[0].status).toBe('review');
  });

  it('accepts escaped text whose JSON encoding exceeds 200 KB', async () => {
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    const body = submission({ files: [{ path: 'docs/indent.txt', content: '\t'.repeat(128_000) }] });
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeGreaterThan(200_000);
    expect((await f.submit(body)).status).toBe(200);
    expect(vi.mocked(commitFiles).mock.calls[0][0].files['docs/indent.txt']).toHaveLength(128_000);
  });

  it('enforces the streamed Workers RPC allowance before decoding a submission', async () => {
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    expect(SUBMISSION_BYTES).toBe(31 * 1024 * 1024);
    const envelope = Buffer.byteLength(JSON.stringify(submission({ padding: '' })));
    const body = (bytes: number) => submission({ padding: 'x'.repeat(bytes - envelope) });
    await expectError(await f.submit(body(SUBMISSION_BYTES + 1)), 413, /Cloudflare Workers limits serialized RPC messages to 32 MiB\. Keep JSON submissions below 31 MiB/);
    expect(commitFiles).not.toHaveBeenCalled();
    expect((await f.fork()).readFile).not.toHaveBeenCalled();
    expect(f.proposal(f.missionId)).toBeUndefined();
    expect((await f.fork()).createToken).toHaveBeenCalledExactlyOnceWith('read', 600);
    expect((await f.submit(body(SUBMISSION_BYTES - 1))).status).toBe(200);
    expect(commitFiles).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'NUL binary', content: 'before\0binary', status: 400 },
    { name: 'control-byte binary', content: 'before\u0001binary', status: 400 },
    { name: 'invalid UTF-8', content: new Uint8Array([0xc3, 0x28]), status: 400 },
    { name: 'oversized base', content: 'x'.repeat(6 * 1_048_576 + 1), status: 413 },
  ])('rejects replacing a $name base file', async ({ content, status }) => {
    const f = await localTask();
    f.baseFiles['docs/local.md'] = content;
    expect((await f.checkout()).status).toBe(200);
    await expectError(await f.submit(), status, /Binary|UTF-8 base|base files exceed/);
    expect((await f.fork()).readFile).toHaveBeenCalledExactlyOnceWith({ ref: head, path: 'docs/local.md' });
    expect(commitFiles).not.toHaveBeenCalled();
    expect(f.proposal(f.missionId)).toBeUndefined();
  });

  it('reads complete files from the pinned Git base instead of cached or omitted model context', async () => {
    const complete = `${'a'.repeat(45_000)}\nOriginal last line\n`;
    const f = await localTask();
    f.baseFiles['docs/large.md'] = complete;
    f.baseFiles['docs/omitted.md'] = '# Omitted from model context\n';
    expect((await f.checkout()).status).toBe(200);
    const files = [
      { path: 'docs/large.md', content: `${complete}New line\n` },
      { path: 'docs/omitted.md', content: '# Now updated\n' },
      { path: 'docs/new.md', content: '# New file\n' },
    ];
    expect((await f.submit(submission({ files }))).status).toBe(200);
    const mission = (await f.state()).missions[0];
    expect(await Promise.all(mission.agents[0].changes.map(file => f.request(`${f.path}/diff?agent=atlas&path=${encodeURIComponent(file.path)}&ref=${file.contentRef}`).then(response => response.json())))).toEqual([
      expect.objectContaining({ path: 'docs/large.md', before: complete, after: `${complete}New line\n`, additions: 1, deletions: 0 }),
      expect.objectContaining({ path: 'docs/omitted.md', before: '# Omitted from model context\n', after: '# Now updated\n' }),
      expect.objectContaining({ path: 'docs/new.md', before: '', after: '# New file\n' }),
    ]);
    expect((await f.fork()).readFile.mock.calls).toEqual(files.map(file => [{ ref: head, path: file.path }]));
    const commit = vi.mocked(commitFiles).mock.calls[0][0];
    expect(commit).toMatchObject({ expectedHead: head, branch: 'main', remote: mission.agents[0].remote });
    expect(commit.files[`.braid/missions/${f.missionId}/codex.md`]).toContain('Execution: local\nAgent-reported model: Codex');
    expect(commit.files[`.braid/missions/${f.missionId}/codex.md`]).toContain('not independently verified');
    expect(Object.keys(commit.files)).not.toContain(`.braid/missions/${f.missionId}/atlas.md`);
  });

  it('preserves a UTF-8 BOM and rejects unchanged files against their actual Git contents', async () => {
    const f = await localTask();
    f.baseFiles['docs/local.md'] = '\ufeff# Existing document\n';
    expect((await f.checkout()).status).toBe(200);
    await expectError(await f.submit(submission({ files: [{ path: 'docs/local.md', content: f.baseFiles['docs/local.md'] }] })), 400, /no changed files/);
    expect((await f.submit(submission({ files: [{ path: 'docs/local.md', content: '\ufeff# Updated document\n' }] }))).status).toBe(200);
    const file = (await f.state()).missions[0].agents[0].changes[0];
    expect(await (await f.request(`${f.path}/diff?agent=atlas&path=${file.path}&ref=${file.contentRef}`)).json()).toMatchObject({ before: '\ufeff# Existing document\n' });
    expect(commitFiles).toHaveBeenCalledTimes(1);
  });

  it('excludes unchanged files from the commit while retaining changed and new files', async () => {
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    expect((await f.submit(submission({ files: [{ path: 'README.md', content: BASE_FILES['README.md'] }, { path: 'docs/new.md', content: '# New\n' }] }))).status).toBe(200);
    const committed = vi.mocked(commitFiles).mock.calls[0][0].files;
    expect(committed).not.toHaveProperty('README.md');
    expect((await f.state()).missions[0].agents[0].changes.map(file => file.path)).toEqual(['docs/new.md']);
  });

  it.each(['passed', 'not-run', 'failed'])('keeps a %s local test report unverified and blocks failed checks', async result => {
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    expect((await f.submit(submission({ tests: [{ command: 'npm test', result, detail: 'Reported by the local agent.' }] }))).status).toBe(200);
    const mission = (await f.state()).missions[0];
    expect(mission.status).toBe('review');
    expect(mission.agents[0].checks).toContainEqual(expect.objectContaining({ label: 'Local report: npm test', status: result === 'failed' ? 'failed' : 'warning', detail: expect.stringContaining('not independently verified') }));
    const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect(preview.ready).toBe(result !== 'failed');
    if (result === 'failed') {
      await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint }), 409, /failed checks/);
      expect(f.jobs()).toHaveLength(0);
    }
    expect(f.ai.run).not.toHaveBeenCalled();
  });

  it('rejects an array-valued failed test report instead of downgrading it to a warning', async () => {
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    await expectError(await f.submit(submission({ tests: [{ command: 'npm test', result: ['failed'] }] })), 400, /Test results/);
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it('requires resolution of overlapping local lanes before merging and preserves their context', async () => {
    const f = await localTask({ agentCount: 2 });
    expect((await f.checkout()).status).toBe(200);
    expect((await f.checkout('sable', connection('claude'))).status).toBe(200);
    expect((await f.submit(submission({ files: [{ path: 'docs/local.md', content: '# Codex proposal\n' }] }))).status).toBe(200);
    expect((await f.state()).missions[0].status).toBe('running');
    (await f.fork()).state.head = merged;
    expect((await f.checkout()).status).toBe(200);
    expect((await f.submit(submission({ model: 'Claude Code', files: [{ path: 'docs/local.md', content: '# Claude proposal\n' }] }), undefined, 'sable', connection('claude'))).status).toBe(200);
    const mission = (await f.state()).missions[0];
    expect(mission.status).toBe('review');
    expect(mission.agents.map(agent => agent.model)).toEqual(['Codex', 'Claude Code']);
    expect(mission.collisions).toEqual([{ id: 'collision-docs/local.md', path: 'docs/local.md', agentIds: ['atlas', 'sable'] }]);
    const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect(preview.ready).toBe(false);
    await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint }), 409, /overlapping file/);
    // A choice without a reason records none; a reason is the person's own words.
    const decided = async () => (await f.state()).missions.find(item => item.id === f.missionId)!.collisions[0].resolution;
    expect((await f.request(`${f.path}/resolve`, { collisionId: mission.collisions[0].id, agentId: 'atlas' })).status).toBe(200);
    expect(await decided()).toEqual({ agentId: 'atlas', resolvedAt: expect.any(String) });
    expect((await f.request(`${f.path}/resolve`, { collisionId: mission.collisions[0].id, agentId: 'sable', reason: 'The Claude proposal describes both supported local agents.' })).status).toBe(200);
    expect(await decided()).toMatchObject({ agentId: 'sable', reason: 'The Claude proposal describes both supported local agents.' });
    const resolved = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect(resolved.ready).toBe(true);
    expect((await f.request(`${f.path}/merge`, { integrationFingerprint: resolved.fingerprint })).status).toBe(202);
    expect(await f.current().integrateMission(f.missionId, f.jobs()[0].id)).toEqual({ commit: merged });
    const integration = vi.mocked(commitFiles).mock.calls.at(-1)![0];
    expect(integration.files['docs/local.md']).toBe('# Claude proposal\n');
    expect(integration.files[`.braid/missions/${f.missionId}/decision.json`]).toContain(resolved.fingerprint);
    expect(integration.files[`.braid/missions/${f.missionId}/decision.json`]).toContain('The Claude proposal describes both supported local agents.');
    expect((await f.state()).missions[0].status).toBe('merged');
  });

  it('accepts concurrent submissions from separate lanes without mixing their commits or proposals', async () => {
    const f = await localTask({ agentCount: 2 });
    expect((await f.checkout()).status).toBe(200);
    expect((await f.checkout('sable', connection('claude'))).status).toBe(200);
    const atlasRemote = (await (await f.fork()).info()).remote;
    const otherCommit = 'c'.repeat(40);
    vi.mocked(commitFiles).mockImplementation(async options => {
      const commit = options.remote === atlasRemote ? merged : otherCommit;
      await options.onPrepared!(commit);
      return commit;
    });
    const responses = await Promise.all([
      f.submit(submission({ files: [{ path: 'docs/local.md', content: '# Codex proposal\n' }] })),
      f.submit(submission({ model: 'Claude Code', files: [{ path: 'docs/local.md', content: '# Claude proposal\n' }] }), undefined, 'sable', connection('claude')),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map(response => response.json()))).toEqual([{ commit: merged }, { commit: otherCommit }]);
    await f.restart();
    const mission = (await f.state()).missions[0];
    expect(mission.status).toBe('review');
    expect(await Promise.all(mission.agents.map(async agent => ({ model: agent.model, commit: agent.commit, content: (await (await f.request(`${f.path}/diff?agent=${agent.id}&path=${agent.changes[0].path}&ref=${agent.changes[0].contentRef}`)).json() as {after:string}).after })))).toEqual([
      { model: 'Codex', commit: merged, content: '# Codex proposal\n' },
      { model: 'Claude Code', commit: otherCommit, content: '# Claude proposal\n' },
    ]);
    expect(mission.collisions).toHaveLength(1);
    expect(commitFiles).toHaveBeenCalledTimes(2);
  });

  it('rejects merging a reviewed local task after the trunk has moved', async () => {
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    expect((await f.submit()).status).toBe(200);
    f.repo.state.head = 'c'.repeat(40);
    const next = await f.request('/api/missions', { title: 'Refresh from trunk', intent: 'Inspect current trunk.', execution: 'local' });
    expect(next.status).toBe(202);
    const { missionId } = await next.json() as { missionId: string };
    expect((await f.request(`/api/missions/${missionId}/cancel`, {})).status).toBe(200);
    const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect(preview.ready).toBe(false);
    await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint }), 409, /main branch changed/);
    expect(f.jobs()).toHaveLength(0);
    expect(commitFiles).toHaveBeenCalledTimes(1);
  });
});

describe('durable local submission recovery', () => {
  it('stages large valid proposals and merges in SQLite rather than oversized KV values', async () => {
    const setup = await localTask();
    expect((await setup.checkout()).status).toBe(200);
    const put = setup.db.storage.put.bind(setup.db.storage);
    vi.spyOn(setup.db.storage, 'put').mockImplementation((async (key: string, value: unknown) => {
      if (new TextEncoder().encode(JSON.stringify(value)).length > 131_072) throw new Error('KV value exceeds 128 KiB.');
      return put(key, value);
    }) as typeof setup.db.storage.put);
    const content = '\t'.repeat(128_000);
    const response = await setup.submit(submission({ files: [{ path: 'docs/large.txt', content }] }));
    expect(response.status).toBe(200);
    expect(setup.proposal(setup.missionId)?.files['docs/large.txt']).toBe(content);
    await setup.restart();
    const preview = await (await setup.request(`${setup.path}/integration`)).json() as IntegrationPreview;
    expect((await setup.request(`${setup.path}/merge`, { integrationFingerprint: preview.fingerprint })).status).toBe(202);
    expect(await setup.current().integrateMission(setup.missionId, setup.jobs()[0].id)).toEqual({ commit: merged });
    await setup.restart();
    const state = await setup.state();
    expect(state.missions[0].status).toBe('merged');
    expect(state.files['docs/large.txt']).toBeUndefined();
    expect(vi.mocked(commitFiles).mock.calls.at(-1)![0].files['docs/large.txt']).toBe(content);
  });
  it('bounds the combined before-images of local proposals', async () => {
    const setup = await localTask();
    setup.baseFiles['docs/first.txt'] = 'x'.repeat(3_145_729);
    setup.baseFiles['docs/second.txt'] = 'y'.repeat(3_145_729);
    expect((await setup.checkout()).status).toBe(200);
    await expectError(await setup.submit(submission({ files: [{ path: 'docs/first.txt', content: 'First' }, { path: 'docs/second.txt', content: 'Second' }] })), 413, /combined base files/);
    expect(commitFiles).not.toHaveBeenCalled();
    expect(setup.proposal(setup.missionId)).toBeUndefined();
  });
  it('replays the exact result across eviction without another commit and rejects changed payloads', async () => {
    const f = await localTask(), key = crypto.randomUUID(), body = submission();
    expect((await f.checkout()).status).toBe(200);
    const first = await f.submit(body, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ commit: merged });
    await f.restart();
    const repeated = await f.submit(body, key);
    expect(repeated.headers.get('idempotency-replayed')).toBe('true');
    expect(await repeated.json()).toEqual({ commit: merged });
    await expectError(await f.submit(submission({ rationale: 'A different rationale.' }), key), 409, /different operation/);
    await expectError(await f.submit(submission({ files: [{ path: 'docs/local.md', content: '# Different proposal\n' }] })), 409, /proposal changed/);
    const samePayload = await f.submit(body);
    expect(samePayload.status).toBe(200);
    expect(await samePayload.json()).toEqual({ commit: merged });
    expect(commitFiles).toHaveBeenCalledTimes(1);
    expect((await f.fork()).readFile).toHaveBeenCalledTimes(1);
    expect((await f.state()).activity.filter(event => event.message.includes('pushed a proposal'))).toEqual([expect.objectContaining({ detail: `1 file · ${merged.slice(0, 7)}` })]);
  });

  it.each([false, true])('recovers the exact prepared commit after a lost push response with expired claim=%s', async expired => {
    const f = await localTask(), key = crypto.randomUUID(), body = submission(), started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    expect((await f.checkout('atlas', connection('codex', started + 1000))).status).toBe(200);
    const fork = await f.fork();
    vi.mocked(commitFiles).mockImplementationOnce(async options => {
      await options.onPrepared!(merged);
      fork.state.head = merged;
      throw new Error('Push completed but the response was lost.');
    });
    await expectError(await f.submit(body, key), 502, /could not be committed/);
    const staged = f.proposal(f.missionId);
    expect(staged?.preparedCommit).toBe(merged);
    await f.restart();
    if (expired) {
      clock.mockReturnValue(started + 1001);
      await expectError(await f.submit(body, key), 403, /Check out this lane/);
      expect((await f.checkout()).status).toBe(200);
    }
    await expectError(await f.submit(submission({ summary: 'Changed while retrying' })), 409, /saved submission/);
    vi.mocked(commitFiles).mockImplementationOnce(async options => {
      expect(options.preparedCommit).toBe(merged);
      expect(options.files).toEqual(staged!.files);
      expect(options.expectedHead).toBe(head);
      return merged;
    });
    const recovered = await f.submit(body, key);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ commit: merged });
    await f.restart();
    expect((await f.submit(body, key)).headers.get('idempotency-replayed')).toBe('true');
    expect((await f.state()).missions[0]).toMatchObject({ status: 'review', agents: [expect.objectContaining({ status: 'review', commit: merged })] });
    expect(f.repo.fork).toHaveBeenCalledTimes(1);
    expect(fork.readFile).toHaveBeenCalledTimes(1);
    expect(commitFiles).toHaveBeenCalledTimes(2);
    expect(fork.revokeToken.mock.calls.filter(([token]) => token.startsWith('fake-write-'))).toHaveLength(2);
  });

  it('does not renew a fork that moved to an unrecorded commit', async () => {
    const f = await localTask();
    expect((await f.checkout()).status).toBe(200);
    const fork = await f.fork();
    fork.state.head = 'c'.repeat(40);
    await f.restart();
    await expectError(await f.checkout(), 502, /no longer matches the task base/);
    expect(fork.createToken).toHaveBeenCalledTimes(1);
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it('recovers a completed proposal if its submission receipt was not saved', async () => {
    const f = await localTask(), key = crypto.randomUUID(), body = submission();
    expect((await f.checkout()).status).toBe(200);
    const execute = f.db.storage.sql.exec.bind(f.db.storage.sql);
    let failReceipt = true;
    const sql = vi.spyOn(f.db.storage.sql, 'exec').mockImplementation((query, ...bindings) => {
      if (failReceipt && query.startsWith('INSERT INTO requests') && bindings[0] === key) {
        failReceipt = false;
        throw new Error('Receipt storage interrupted.');
      }
      return execute(query, ...bindings);
    });
    await expectError(await f.submit(body, key), 502, /could not be committed/);
    sql.mockRestore();
    await f.restart();
    expect((await f.state()).missions[0].agents[0].commit).toBe(merged);
    const recovered = await f.submit(body, key);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ commit: merged });
    expect((await f.submit(body, key)).headers.get('idempotency-replayed')).toBe('true');
    expect(commitFiles).toHaveBeenCalledTimes(1);
    const agent = (await f.state()).missions[0].agents[0];
    expect(agent.error).toBeUndefined();
    expect(agent.failureStage).toBeUndefined();
  });

  it('serializes publishing within a lane and refuses cancellation during a push', async () => {
    const f = await localTask(), key = crypto.randomUUID(), body = submission();
    expect((await f.checkout()).status).toBe(200);
    const started = deferred(), release = deferred();
    vi.mocked(commitFiles).mockImplementationOnce(async options => {
      await options.onPrepared!(merged);
      started.resolve();
      await release.promise;
      return merged;
    });
    const pending = f.submit(body, key);
    await started.promise;
    try {
      await expectError(await f.submit(body, key), 409, /already publishing/);
      await expectError(await f.checkout(), 409, /preparing or publishing/);
      await expectError(await f.request(`${f.path}/cancel`, {}), 409, /current Git operation/);
    } finally { release.resolve(); }
    expect((await pending).status).toBe(200);
    expect(commitFiles).toHaveBeenCalledTimes(1);
    expect((await f.submit(body, key)).headers.get('idempotency-replayed')).toBe('true');
  });
});

describe('local owner and connection authorization', () => {
  it('rejects checkout if the task owner no longer has access', async () => {
    const f = await localTask({ headers: ownerHeaders });
    f.directory.access.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden.' });
    await expectError(await f.checkout(), 403, /no longer has repository access/);
    expect(f.repo.fork).not.toHaveBeenCalled();
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it('rechecks owner access after preparing a fork and before issuing its read token', async () => {
    const f = await localTask({ headers: ownerHeaders });
    const createFork = f.repo.fork.getMockImplementation()!;
    f.repo.fork.mockImplementationOnce(async (...args) => {
      const result = await createFork(...args);
      f.directory.access.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden.' });
      return result;
    });
    await expectError(await f.checkout(), 403, /no longer has repository access/);
    expect((await f.fork()).createToken).not.toHaveBeenCalled();
    expect(await f.db.storage.get(`local-claim:${f.missionId}:atlas`)).toBeUndefined();
  });

  it.each(['revoked', 'read-only', 'wrong-workspace', 'wrong-user'] as const)('rejects a %s connection grant before staging a submission', async invalid => {
    const f = await localTask({ headers: { ...ownerHeaders, 'x-braid-connection-digest': 'digest-codex' } });
    expect((await f.checkout()).status).toBe(200);
    if (invalid === 'revoked') f.security.agent.mockResolvedValue(undefined);
    if (invalid === 'read-only') f.security.agent.mockResolvedValue({ ...f.grant, scope: 'read' });
    if (invalid === 'wrong-workspace') f.security.agent.mockResolvedValue({ ...f.grant, workspaceId: 'other-workspace' });
    if (invalid === 'wrong-user') f.security.agent.mockResolvedValue({ ...f.grant, user: { ...f.grant.user, id: 'other-owner' } });
    await expectError(await f.submit(), 403, /connection was revoked or expired/);
    expect(f.proposal(f.missionId)).toBeUndefined();
    expect((await f.fork()).createToken).toHaveBeenCalledExactlyOnceWith('read', 600);
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it('rechecks authorization after loading the proposal base and before creating a write token', async () => {
    const f = await localTask({ headers: ownerHeaders });
    expect((await f.checkout()).status).toBe(200);
    const fork = await f.fork(), readFile = fork.readFile.getMockImplementation()!;
    fork.readFile.mockImplementationOnce(async options => {
      const blob = await readFile(options);
      f.directory.access.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden.' });
      return blob;
    });
    await expectError(await f.submit(), 403, /no longer has repository access/);
    expect(fork.createToken).toHaveBeenCalledExactlyOnceWith('read', 600);
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it.each(['owner-revoked', 'team-changed', 'grant-revoked', 'writes-disabled'] as const)('stops a prepared commit before push if %s', async invalid => {
    const f = await localTask({ headers: { ...ownerHeaders, 'x-braid-connection-digest': 'digest-codex' } });
    expect((await f.checkout()).status).toBe(200);
    f.directory.access.mockClear();
    f.security.agent.mockClear();
    let pushed = false;
    vi.mocked(commitFiles).mockImplementationOnce(async options => {
      if (invalid === 'owner-revoked') f.directory.access.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden.' });
      if (invalid === 'team-changed') f.directory.access.mockResolvedValue({ ok: true, data: { teamId: 'other-team' } });
      if (invalid === 'grant-revoked') f.security.agent.mockResolvedValue(undefined);
      if (invalid === 'writes-disabled') f.env.LIVE_ENABLED = 'false';
      await options.onPrepared!(merged);
      pushed = true;
      return merged;
    });
    await expectError(await f.submit(), invalid === 'writes-disabled' ? 503 : 403, /no longer has repository access|does not match|revoked or expired|writes are disabled/);
    expect(pushed).toBe(false);
    expect(f.directory.access).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-owner' }), 'workspace-1', true);
    expect(f.security.agent).toHaveBeenCalledWith('digest-codex');
    const staged = f.proposal(f.missionId);
    expect(staged).toBeDefined();
    expect(staged!.preparedCommit).toBeUndefined();
    const fork = await f.fork();
    expect(fork.createToken).toHaveBeenLastCalledWith('write', 900);
    expect(fork.revokeToken).toHaveBeenLastCalledWith(`fake-write-${(await fork.info()).name}?expires=0`);
    expect((await f.state()).missions[0].agents[0].commit).toBeUndefined();
  });

  it('requires team owner authorization when owner-key mode is disabled', async () => {
    const f = await localTask();
    f.env.AUTH_MODE = 'account';
    await expectError(await f.checkout(), 403, /no team owner authorization/);
    expect(f.repo.fork).not.toHaveBeenCalled();
  });
});

describe('hosted agents and safe failure reporting', () => {
  it('hands the sandbox a pinned repository and constraints, not selected source files', async () => {
    const f = await fixture(), task = await launch(f, { agentCount: 1 });
    const original = 'Keep this file complete.\n'.repeat(10_000);
    f.baseFiles['packages/deep/large.ts'] = original;
    f.sandbox.run.mockResolvedValue({ [Symbol.dispose]() {}, summary: 'Complete the change', rationale: 'Read and edit a large tracked file.', files: [{ path: 'packages/deep/large.ts', content: original + '// changed\n' }], checks: [{ label: 'npm test', status: 'passed', detail: 'Executed in the sandbox; exit 0.' }] });
    expect(await f.current().runAgent(task.missionId, 'atlas', f.jobs()[0].id)).toEqual({ commit: merged });
    const agent = (await f.state()).missions[0].agents[0];
    expect(f.sandbox.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repo: agent.repo, remote: agent.remote, baseCommit: head, scope: ['*'], workspaceId: 'test-workspace' }));
    expect(f.sandbox.run.mock.calls[0][0]).not.toHaveProperty('files');
    expect(f.ai.run).not.toHaveBeenCalled();
    expect(agent.checks).toContainEqual({ label: 'npm test', status: 'passed', detail: 'Executed in the sandbox; exit 0.' });
    expect(agent.changes[0]).toMatchObject({ path: 'packages/deep/large.ts', contentRef: expect.any(String) });
    expect(vi.mocked(commitFiles).mock.calls[0][0].files['packages/deep/large.ts']).toBe(original + '// changed\n');
    expect(vi.mocked(commitFiles).mock.calls[0][0].files[`.braid/missions/${task.missionId}/test.md`]).toContain('Execution: Cloudflare sandbox');
  });

  it('keeps separate context files when hosted agents use the same model', async () => {
    const f = await fixture(), task = await launch(f, { agentCount: 3 });
    for (const agent of (await f.state()).missions[0].agents) await f.current().runAgent(task.missionId, agent.id, f.jobs()[0].id);
    const paths = vi.mocked(commitFiles).mock.calls.flatMap(([commit]) => Object.keys(commit.files).filter(path => path.startsWith('.braid/missions/')));
    expect(paths).toEqual([1, 2, 3].map(index => `.braid/missions/${task.missionId}/test-${index}.md`));
  });

  it('supports hosted deletions and executable files while preserving untouched binary and special paths', async () => {
    const f = await fixture(), task = await launch(f, { agentCount: 1 });
    f.baseFiles['removed.txt'] = 'old\n'; f.baseFiles['binary.bin'] = new Uint8Array([0, 255, 1]); f.baseModes['link'] = '120000';
    f.sandbox.run.mockResolvedValue({ [Symbol.dispose]() {}, summary: 'Update scripts', rationale: 'Remove obsolete text and add an executable.', files: [{ path: 'removed.txt', content: null }, { path: 'scripts/run.sh', content: '#!/bin/sh\ntrue\n', mode: '100755' }], checks: [] });
    await f.current().runAgent(task.missionId, 'atlas', f.jobs()[0].id);
    const files = vi.mocked(commitFiles).mock.calls[0][0].files;
    expect(files['removed.txt']).toBeNull(); expect(files['scripts/run.sh']).toMatchObject({ mode: '100755' });
    expect(files).not.toHaveProperty('binary.bin'); expect(files).not.toHaveProperty('link');
  });

  it('revalidates authorization before publishing a completed sandbox result', async () => {
    const f = await fixture(undefined, { headers: ownerHeaders }), task = await launch(f, { agentCount: 1 });
    f.sandbox.run.mockImplementation(async () => {
      f.directory.access.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden.' });
      return { [Symbol.dispose]() {}, summary: 'Done', rationale: 'Completed.', files: [{ path: 'README.md', content: '# Updated\n' }], checks: [] };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(f.current().runAgent(task.missionId, 'atlas', f.jobs()[0].id)).resolves.toMatchObject({ failure: { retryable: false, message: expect.stringContaining('no longer has repository access'), evidence: { status: 403 } } });
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it('retains a prepared hosted result for retry without rerunning the sandbox', async () => {
    const f = await fixture(), task = await launch(f, { agentCount: 1 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(commitFiles).mockRejectedValueOnce(new Error('lost response'));
    await expect(f.current().runAgent(task.missionId, 'atlas', f.jobs()[0].id)).rejects.toThrow();
    await f.restart();
    await f.current().runAgent(task.missionId, 'atlas', f.jobs()[0].id);
    expect(f.sandbox.run).toHaveBeenCalledTimes(1);
    expect(commitFiles).toHaveBeenCalledTimes(2);
  });

  it.each(['atlas', 'sable', 'reed'])('allows %s to read and change any task-relevant file', async agentId => {
    const f = await fixture(), task = await launch(f);
    f.sandbox.run.mockResolvedValue({ [Symbol.dispose]() {}, summary: 'Document setup', rationale: 'Document the supported setup.', files: [{ path: 'docs/setup.md', content: '# Setup\n' }], checks: [] });
    await f.current().runAgent(task.missionId, agentId, f.jobs()[0].id);
    const agent = (await f.state()).missions[0].agents.find(agent => agent.id === agentId)!;
    expect(agent.scope).toEqual(['*']);
    expect(agent.status).toBe('review');
  });

  const failures: { stage: AgentFailureStage; expected: string }[] = [
    { stage: 'authorization', expected: 'Owner authorization could not be verified. Reconnect as an owner before retrying.' },
    { stage: 'fork', expected: 'The isolated Git workspace could not be prepared. Check Artifacts availability before retrying.' },
    { stage: 'generation', expected: 'The hosted agent stopped before returning a proposal. Choose Start again to retry.' },
    { stage: 'validation', expected: 'Submit at least 1 changed file.' },
    { stage: 'publish', expected: 'The proposal could not be committed to its isolated Git fork. Check repository access before retrying.' },
  ];
  it.each(failures)('preserves a safe $stage failure through eviction and failAgent', async ({ stage, expected }) => {
    const f = await fixture(undefined, { headers: ownerHeaders }), task = await launch(f), operation = f.jobs()[0].id;
    const diagnostic = 'private-provider-diagnostic-must-not-leak';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (stage === 'authorization') f.directory.access.mockRejectedValue(new Error(diagnostic));
    if (stage === 'fork') f.repo.fork.mockRejectedValue(new Error(diagnostic));
    if (stage === 'generation') f.sandbox.run.mockRejectedValue(new Error(diagnostic));
    if (stage === 'validation') f.sandbox.run.mockResolvedValue({ [Symbol.dispose]() {}, summary: 'Completed', rationale: 'Done.', files: [], checks: [] });
    if (stage === 'publish') vi.mocked(commitFiles).mockRejectedValue(new Error(diagnostic));
    if (stage === 'validation') await expect(f.current().runAgent(task.missionId, 'atlas', operation)).resolves.toMatchObject({ failure: { retryable: false, message: expected, evidence: { reason: stage, status: 400 } } });
    else await expect(f.current().runAgent(task.missionId, 'atlas', operation)).rejects.toThrow(expected);
    await f.restart();
    await f.current().failAgent(task.missionId, 'atlas', 'The workflow exhausted its retries.', operation);
    const snapshot = await f.state(), agent = snapshot.missions[0].agents[0];
    expect(agent).toMatchObject({ status: 'failed', failureStage: stage, error: expected });
    expect(snapshot.activity[0]).toMatchObject({ type: 'error', detail: expected });
    expect(JSON.stringify(snapshot)).not.toContain(diagnostic);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(diagnostic);
    if (stage !== 'publish') expect(commitFiles).not.toHaveBeenCalled();
    if (stage === 'validation') expect(f.sandbox.run).toHaveBeenCalledTimes(1);
  });

  it('keeps what a hosted run established across its reports, while each report replaces the run state', async () => {
    const f = await fixture(), task = await launch(f, { agentCount: 1 }), operation = f.jobs()[0].id;
    const agentId = (await f.state()).missions[0].agents[0].id;
    const prepared = [{ command: 'mise use -g go@1.24', status: 'passed' as const }];
    let seen: HostedEnvironment | undefined;
    f.sandbox.run.mockImplementation(async task => {
      const report = (environment: HostedEnvironment) => f.current().sandboxCheckpoint(task.missionId, task.agentId, 'Working', environment);
      await report({ status: 'running', prepared });
      await report({ status: 'retrying', retry: { attempt: 1, limit: 3, nextAt: new Date().toISOString() } });
      await report({ status: 'running' });
      seen = (await f.state()).missions[0].agents[0].environment;
      throw new Error('Stop after the reports.');
    });
    await f.current().runAgent(task.missionId, agentId, operation).catch(() => {});
    expect(seen).toMatchObject({ status: 'running', prepared, preflight: { commit: expect.any(String) } });
    expect(seen).not.toHaveProperty('retry');
  });

  it('preserves a known safe Git error instead of replacing it with the generic Workflow failure', async () => {
    const f = await fixture(), task = await launch(f), operation = f.jobs()[0].id;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = 'Git redirects are not allowed. No credentials were forwarded.';
    vi.mocked(commitFiles).mockRejectedValueOnce(new GitError('redirect', message));
    await expect(f.current().runAgent(task.missionId, 'atlas', operation)).rejects.toThrow(message);
    await f.current().failAgent(task.missionId, 'atlas', 'Hosted execution failed.', operation);
    expect((await f.state()).missions[0].agents[0]).toMatchObject({ status: 'failed', failureStage: 'publish', error: message });
  });

  it('finishes an exhausted model outage with its real reason without multiplying retries in Workflow', async () => {
    const f = await fixture(), task = await launch(f, { agentCount: 1 }), operation = f.jobs()[0].id;
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ai = { run: vi.fn().mockRejectedValue(new Error('3040: private model diagnostic')) };
    f.sandbox.run.mockImplementation(async task => ({ [Symbol.dispose]() {}, ...await runAgentLoop(task, ai as unknown as Ai,
      { exec: async () => { throw new Error('No command should execute'); }, collect: async () => { throw new Error('No result should be collected'); }, checkpoint: message => f.current().sandboxCheckpoint(task.missionId, task.agentId, message) }, Date.now() + 60_000) }));
    const env = { ...f.env, WORKSPACES: { idFromString: () => 'workspace-1', get: () => ({
      runAgent: async (...args: Parameters<Workspace['runAgent']>) => ({ [Symbol.dispose]() {}, ...await f.current().runAgent(...args) }),
      failAgent: (...args: Parameters<Workspace['failAgent']>) => f.current().failAgent(...args),
      finishMission: (...args: Parameters<Workspace['finishMission']>) => f.current().finishMission(...args),
    }) } } as unknown as BraidEnv;
    const step = { do: async (_name: string, options: { retries: { limit: number } } | (() => Promise<unknown>), run?: () => Promise<unknown>) => {
      const work = typeof options === 'function' ? options : run!;
      const retries = typeof options === 'function' ? 0 : options.retries.limit;
      for (let attempt = 0; ; attempt++) {
        try { return await work(); }
        catch (error) { if (attempt >= retries) throw error; await f.restart(); }
      }
    } } as unknown as WorkflowStep;
    const workflow = new MissionWorkflow({} as ExecutionContext, env);
    const result = workflow.run({ payload: { workspaceId: 'workspace-1', missionId: task.missionId, action: 'run', agentIds: ['atlas'], operationId: operation } } as WorkflowEvent<RunParams>, step);
    await vi.runAllTimersAsync(); await result;
    await f.restart();
    const snapshot = await f.state();
    expect(snapshot.missions[0]).toMatchObject({ status: 'failed', error: hostedErrors.capacity, agents: [{ status: 'failed', failureStage: 'generation', error: hostedErrors.capacity, completedAt: expect.any(String) }] });
    expect(ai.run).toHaveBeenCalledTimes(4); // The initial call and three model retries, with no fresh Workflow run.
    expect(f.sandbox.run).toHaveBeenCalledTimes(1);
    expect(commitFiles).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain('private model diagnostic');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private model diagnostic');
  });

  it('does not run a hosted model for an unsubmitted local lane', async () => {
    const f = await localTask();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(f.current().runAgent(f.missionId, 'atlas')).resolves.toMatchObject({ failure: { retryable: false, message: expect.stringContaining('This task waits for a local agent'), evidence: { status: 409 } } });
    expect(f.ai.run).not.toHaveBeenCalled();
    expect(f.repo.fork).not.toHaveBeenCalled();
    expect(commitFiles).not.toHaveBeenCalled();
  });
});

describe('large local results and task revisions', () => {
  it('stores a large multi-file result as lazy diffs, exports it completely, and publishes deletions and modes', async () => {
    const f = await localTask({ headers: ownerHeaders });
    f.baseFiles['old.md'] = 'Remove this\n';
    expect((await f.checkout()).status).toBe(200);
    const files = Array.from({ length: 16 }, (_, i) => ({ path: `src/part-${i}.ts`, content: `// ${i}\n${'界😀\n'.repeat(8000)}` }));
    expect((await f.submit(submission({ files: [...files, { path: 'old.md', content: null }, { path: 'run.sh', content: '#!/bin/sh\n', mode: '100755' }, { path: 'empty.txt', content: '' }] }))).status).toBe(200);
    const beforeRestart = await f.request('/api/state'), etag = beforeRestart.headers.get('etag');
    const state = await beforeRestart.json() as WorkspaceSnapshot, agent = state.missions[0].agents[0];
    expect(JSON.stringify(state).length).toBeLessThan(25_000);
    expect(agent.changes).toHaveLength(19);
    expect(agent.changes.every(file => file.contentRef && file.before === '' && file.after === '')).toBe(true);
    const first = agent.changes[0], path = `${f.path}/diff?agent=atlas&path=${first.path}&ref=${first.contentRef}`;
    expect(await (await f.request(path)).json()).toMatchObject({ before: '', after: files[0].content, additions: 8001 });
    await expectError(await f.request(`${f.path}/diff?agent=sable&path=${first.path}&ref=${first.contentRef}`), 404, /not found/);
    await expectError(await f.request(path.replace(first.contentRef!, 'stale')), 409, /proposal changed/);
    await f.restart();
    expect((await f.request('/api/state', undefined, undefined, { 'if-none-match': etag! })).status).toBe(304);
    const backup = await (await f.request('/api/export')).json() as { schema: number; inputs: object[]; contentChunks: { id: string; part: number; value: string }[] };
    expect(backup.schema).toBe(2);
    const restored = JSON.parse(backup.contentChunks.filter(row => row.id === `diff:${first.contentRef}`).sort((a, b) => a.part - b.part).map(row => row.value).join(''));
    expect(restored.after).toBe(files[0].content);
    expect(JSON.stringify(backup.inputs)).not.toContain('authorization');
    expect(backup.contentChunks.some(row => row.id.startsWith('plan:'))).toBe(false);
    const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect((await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint })).status).toBe(202);
    await f.current().integrateMission(f.missionId, f.jobs()[0].id);
    const edits = vi.mocked(commitFiles).mock.calls.at(-1)![0].files;
    expect(edits['old.md']).toBeNull(); expect(edits['empty.txt']).toBe('');
    expect(edits['run.sh']).toEqual({ content: '#!/bin/sh\n', mode: '100755' });
    expect(edits[files[0].path]).toBe(files[0].content);
    expect((await f.state()).files).not.toHaveProperty('old.md');
  });

  it('fails closed when stored review text is missing and recreates storage after a recorded reset', async () => {
    const f = await localTask(); await f.checkout(); await f.submit();
    const file = (await f.state()).missions[0].agents[0].changes[0];
    f.db.storage.sql.exec('DELETE FROM content_chunks WHERE id = ?', `diff:${file.contentRef}`);
    await expectError(await f.request(`${f.path}/diff?agent=atlas&path=${file.path}&ref=${file.contentRef}`), 503, /content is temporarily unavailable/);
    const demo = await fixture(), headers = { 'x-braid-mode': 'demo' };
    expect((await demo.request('/api/reset', {}, undefined, headers)).status).toBe(200);
    expect(() => new ContentStore(demo.db.storage).put('diff:test', { after: 'restored' })).not.toThrow();
  });

  it('revises the same task, replaces check evidence, invalidates review, and keeps earlier receipts and provenance', async () => {
    const f = await localTask(), firstKey = crypto.randomUUID(); await f.checkout();
    const first = submission({ tests: [{ command: 'old check', result: 'failed' }] });
    expect((await f.submit(first, firstKey)).status).toBe(200);
    (await f.fork()).state.head = merged;
    const previous = (await f.state()).missions[0];
    expect(await (await f.checkout()).json()).toMatchObject({ previousCommit: merged, baseCommit: head });
    expect((await f.state()).missions[0].agents[0]).toEqual(previous.agents[0]);
    const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    const revisedCommit = 'd'.repeat(40), secondKey = crypto.randomUUID();
    vi.mocked(commitFiles).mockResolvedValueOnce(revisedCommit);
    const revised = submission({ previousCommit: merged, files: [{ path: 'docs/local.md', content: 'Corrected\n' }], tests: [{ command: 'new check', result: 'passed' }] });
    expect(await (await f.submit(revised, secondKey)).json()).toEqual({ commit: revisedCommit });
    const result = (await f.state()).missions[0];
    expect(result).toMatchObject({ id: f.missionId, baseCommit: head, status: 'review', agents: [{ revision: 2, previousCommit: merged, commit: revisedCommit }] });
    expect(result.agents[0].checks.some(check => check.label === 'Local report: old check')).toBe(false);
    expect(result.agents[0].checks.some(check => check.label === 'Local report: new check')).toBe(true);
    await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint }), 409, /integration changed/);
    await f.restart();
    expect(await (await f.submit(first, firstKey)).json()).toEqual({ commit: merged });
    expect(await (await f.submit(revised, secondKey)).json()).toEqual({ commit: revisedCommit });
    expect(commitFiles).toHaveBeenCalledTimes(2);
    expect(new ContentStore(f.db.storage).get(`result:${f.missionId}:atlas:${merged}`)).toMatchObject({ baseCommit: head, agent: { commit: merged, checks: previous.agents[0].checks } });
    await expectError(await f.submit(submission({ previousCommit: merged, summary: 'Outdated revision' })), 409, /proposal changed/);
  });

  it('recovers a pending revision after a lost push without replacing it or accepting a merge', async () => {
    const f = await localTask(); await f.checkout(); await f.submit(); (await f.fork()).state.head = merged;
    const oldPreview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    const key = crypto.randomUUID(), commit = 'd'.repeat(40), body = submission({ previousCommit: merged, summary: 'Revised after feedback' });
    vi.mocked(commitFiles).mockImplementationOnce(async options => { await options.onPrepared!(commit); (await f.fork()).state.head = commit; throw new Error('Response lost'); });
    await expectError(await f.submit(body, key), 502, /could not be committed/);
    await f.restart();
    await expectError(await f.request(`${f.path}/agents/atlas/update`, {}, undefined, connection('codex')), 409, /pending submission/);
    await expectError(await f.submit({ ...body, summary: 'Different edits' }), 409, /saved submission/);
    await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: oldPreview.fingerprint }), 409, /running|review|complete|must finish/);
    vi.mocked(commitFiles).mockResolvedValueOnce(commit);
    expect(await (await f.submit(body, key)).json()).toEqual({ commit });
    expect(vi.mocked(commitFiles).mock.calls.at(-1)![0]).toMatchObject({ preparedCommit: commit, expectedHead: merged, parentCommit: head });
    expect((await f.state()).missions[0].agents[0]).toMatchObject({ revision: 2, commit });
  });

  it('fetches main without repinning evidence, then accepts a freshly checked result against that base', async () => {
    const f = await localTask(); await f.checkout(); await f.submit(); (await f.fork()).state.head = merged;
    const main = 'c'.repeat(40), final = 'd'.repeat(40); f.repo.state.head = main;
    const old = (await f.state()).missions[0];
    const update = await f.request(`${f.path}/agents/atlas/update`, {}, undefined, connection('codex'));
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ baseCommit: main, previousCommit: merged, remote: 'https://git.example/project' });
    expect(f.repo.createToken).toHaveBeenLastCalledWith('read', 600);
    expect((await f.state()).missions[0]).toEqual(old);
    const stale = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect(stale.ready).toBe(false);
    await expectError(await f.submit(submission({ previousCommit: merged, baseCommit: 'e'.repeat(40) })), 409, /Main changed/);
    vi.mocked(commitFiles).mockResolvedValueOnce(final);
    const fresh = submission({ baseCommit: main, previousCommit: merged, tests: [{ command: 'fresh full check', result: 'passed' }] });
    expect(await (await f.submit(fresh)).json()).toEqual({ commit: final });
    expect(vi.mocked(commitFiles).mock.calls.at(-1)![0]).toMatchObject({ expectedHead: main, parentCommit: main });
    const task = (await f.state()).missions[0];
    expect(task).toMatchObject({ id: f.missionId, baseCommit: main, status: 'review', agents: [{ previousCommit: merged, revision: 2 }] });
    expect(task.agents[0].repo).not.toBe(old.agents[0].repo);
    const current = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
    expect(current.ready).toBe(true); expect(current.fingerprint).not.toBe(stale.fingerprint);
    await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: stale.fingerprint }), 409, /integration changed/);
  });

  it('renews a claim after an updated-base publication stops before preparing its commit', async () => {
    const f = await localTask(); await f.checkout(); await f.submit(); (await f.fork()).state.head = merged;
    const main = 'c'.repeat(40), final = 'd'.repeat(40); f.repo.state.head = main;
    const body = submission({ previousCommit: merged, baseCommit: main }), key = crypto.randomUUID();
    vi.mocked(commitFiles).mockRejectedValueOnce(new Error('Git transport unavailable before preparing the commit'));
    expect((await f.submit(body, key)).status).toBe(502);
    await f.db.storage.put(`local-claim:${f.missionId}:atlas`, { claimant: 'codex', expires: 0 });
    await f.restart();
    expect((await f.submit(body, key)).status).toBe(403);
    expect((await f.checkout()).status).toBe(200);
    vi.mocked(commitFiles).mockResolvedValueOnce(final);
    expect(await (await f.submit(body, key)).json()).toEqual({ commit: final });
    expect((await f.state()).missions[0]).toMatchObject({ baseCommit: main, agents: [{ revision: 2, previousCommit: merged, commit: final }] });
  });

  it('keeps update grants scoped to the current claimant and cannot update an older multi-proposal task', async () => {
    const f = await localTask(); await f.checkout();
    await expectError(await f.request(`${f.path}/agents/atlas/update`, {}, undefined, connection('other-agent')), 409, /claimed/);
    await expectError(await f.request(`${f.path}/agents/atlas/update`, {}, undefined, { 'x-braid-role': 'member' }), 403, /Only an owner/);
    const multi = await localTask({ agentCount: 2 }); await multi.checkout();
    await expectError(await multi.request(`${multi.path}/agents/atlas/update`, {}, undefined, connection('codex')), 409, /one coordinating agent/);
  });

  it.each([
    { name: 'overlapping file and directory', files: [{ path: 'new', content: null }, { path: 'new/file.txt', content: 'text' }], status: 400 },
    { name: 'directory replacement', files: [{ path: 'src', content: 'text' }], status: 400 },
    { name: 'file ancestor', files: [{ path: 'README.md/child.txt', content: 'text' }], status: 400 },
    { name: 'symlink', files: [{ path: 'link', content: 'text' }], mode: '120000', status: 400 },
    { name: 'submodule', files: [{ path: 'link', content: null }], mode: '160000', status: 400 },
  ])('rejects $name before replacing a reviewed result', async ({ files, mode, status }) => {
    const f = await localTask(); await f.checkout(); await f.submit(); (await f.fork()).state.head = merged;
    const prior = (await f.state()).missions[0], plan = f.proposal(f.missionId);
    if (mode) f.baseModes.link = mode;
    expect((await f.submit(submission({ previousCommit: merged, files }))).status).toBe(status);
    expect((await f.state()).missions[0]).toEqual(prior);
    expect(f.proposal(f.missionId)).toEqual(plan);
    expect(commitFiles).toHaveBeenCalledTimes(1);
    vi.mocked(commitFiles).mockResolvedValueOnce('c'.repeat(40));
    expect((await f.submit(submission({ previousCommit: merged, summary: 'Corrected revision' }))).status).toBe(200);
  });

  it('accepts 1,000 changed directory trees beside the provenance capsule in a revision', async () => {
    const f = await localTask(); await f.checkout(); await f.submit(); (await f.fork()).state.head = merged;
    const files = Array.from({ length: 1000 }, (_, i) => ({ path: `pkg-${i}/src/index.ts`, content: 'text' }));
    const revised = 'c'.repeat(40);
    vi.mocked(commitFiles).mockResolvedValueOnce(revised);
    expect((await f.submit(submission({ previousCommit: merged, files }))).status).toBe(200);
    const published = vi.mocked(commitFiles).mock.calls.at(-1)![0].files;
    expect(Object.keys(published)).toHaveLength(1001);
    expect(Object.entries(published).filter(([path]) => path.startsWith('.braid/missions/'))).toHaveLength(1);
    for (const file of files) expect(published[file.path]).toBe(file.content);
    expect((await f.state()).missions[0].agents[0]).toMatchObject({ revision: 2, previousCommit: merged, commit: revised, status: 'review' });
  });

  it('enforces the Workers tree-metadata allowance before staging a revision', async () => {
    const f = await localTask(); await f.checkout(); await f.submit(); const fork = await f.fork(); fork.state.head = merged;
    const prior = (await f.state()).missions[0], plan = f.proposal(f.missionId)!;
    // All edited ancestors are new in this root and contribute an empty [] each.
    const ancestors = new Set(Object.keys(plan.files).flatMap(path => path.split('/').slice(0, -1).map((_, i) => path.split('/').slice(0, i + 1).join('/'))));
    const emptyTreesBytes = ancestors.size * 2, target = 29_000_000 + 1 - emptyTreesBytes;
    const entry = { name: 'x'.repeat(200), type: 'blob' as const, mode: '100644', hash: head };
    const unit = Buffer.byteLength(JSON.stringify(entry)) + 1;
    const entries = Array.from({ length: Math.floor((target - 1) / unit) }, (_, i) => ({ ...entry, name: String(i).padStart(200, 'x') }));
    let remaining = target - (1 + entries.length * unit);
    for (let i = 0; remaining; i++) { const added = Math.min(40, remaining); entries[i].name += 'x'.repeat(added); remaining -= added; }
    expect(Buffer.byteLength(JSON.stringify(entries)) + emptyTreesBytes).toBe(29_000_000 + 1);
    fork.readTree.mockResolvedValueOnce(entries);
    await expectError(await f.submit(submission({ previousCommit: merged })), 413, /Cloudflare Workers provides 128 MB of memory.*29 MB working allowance for Git tree metadata/);
    expect((await f.state()).missions[0]).toEqual(prior);
    expect(f.proposal(f.missionId)).toEqual(plan);
    expect(fork.createToken).toHaveBeenCalledTimes(2);
    expect(commitFiles).toHaveBeenCalledTimes(1);
    entries[0].name = entries[0].name.slice(0, -2);
    expect(Buffer.byteLength(JSON.stringify(entries)) + emptyTreesBytes).toBe(29_000_000 - 1);
    fork.readTree.mockResolvedValueOnce(entries);
    const revised = 'c'.repeat(40);
    vi.mocked(commitFiles).mockResolvedValueOnce(revised);
    expect((await f.submit(submission({ previousCommit: merged }))).status).toBe(200);
    expect(commitFiles).toHaveBeenCalledTimes(2);
    expect((await f.state()).missions[0].agents[0]).toMatchObject({ revision: 2, previousCommit: merged, commit: revised, status: 'review' });
  });

  it('does not publish unchanged files merely because their regular mode was supplied', async () => {
    const f = await localTask(); await f.checkout();
    await expectError(await f.submit(submission({ files: [{ path: 'README.md', content: f.baseFiles['README.md'], mode: '100644' }] })), 400, /no changed files/);
    expect(f.proposal(f.missionId)).toBeUndefined(); expect(commitFiles).not.toHaveBeenCalled();
  });
});

it('pins new local tasks without scanning hosted model context', async () => {
  const f = await localTask();
  // Project creation reads its initial overview; task creation only reads the head.
  const input = f.db.storage.sql.exec<{value:string}>('SELECT value FROM inputs WHERE mission = ?', f.missionId).toArray()[0];
  expect(JSON.parse(input.value).files).toEqual({});
  expect(JSON.parse(input.value).context).toEqual((await f.state()).context);
});

it('blocks stale review if a new publication plan was saved just before eviction', async () => {
  const f = await localTask(); await f.checkout(); await f.submit();
  const content = new ContentStore(f.db.storage), key = `plan:proposal:${f.missionId}:atlas`;
  const plan = content.get<Record<string, unknown>>(key)!;
  content.put(key, { ...plan, previousCommit: merged, submissionSignature: 'pending-revision', publishedCommit: undefined, preparedCommit: undefined });
  await f.restart();
  // The public result can still be the prior ready result during this crash window.
  const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
  await expectError(await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint }), 409, /pending submission/);
  expect(f.jobs()).toHaveLength(0);
});

it('cannot replace a published result whose public snapshot was not saved before eviction', async () => {
  const f = await localTask(); await f.checkout(); await f.submit(); (await f.fork()).state.head = merged;
  const saved = f.db.storage.sql.exec<{ value: string }>('SELECT value FROM records WHERE key = ?', `mission:${f.missionId}`).toArray()[0].value;
  const published = 'c'.repeat(40), key = crypto.randomUUID(), body = submission({ previousCommit: merged, summary: 'Published revision' });
  vi.mocked(commitFiles).mockImplementationOnce(async options => { await options.onPrepared!(published); return published; });
  expect((await f.submit(body, key)).status).toBe(200); (await f.fork()).state.head = published;
  // Keep the immutable published plan, but model eviction before its snapshot and receipt were saved.
  f.db.storage.sql.exec('UPDATE records SET value = ? WHERE key = ?', saved, `mission:${f.missionId}`);
  f.db.storage.sql.exec('DELETE FROM requests WHERE key = ?', key);
  await f.restart();
  const main = 'd'.repeat(40); f.repo.state.head = main;
  await expectError(await f.submit(submission({ previousCommit: merged, baseCommit: main, summary: 'Replacement before recovery' })), 409, /saved submission/);
  expect(commitFiles).toHaveBeenCalledTimes(2);
  vi.mocked(commitFiles).mockResolvedValueOnce(published);
  expect(await (await f.submit(body, key)).json()).toEqual({ commit: published });
  expect(vi.mocked(commitFiles).mock.calls.at(-1)![0].preparedCommit).toBe(published);
  expect((await f.state()).missions[0].agents[0]).toMatchObject({ revision: 2, commit: published, previousCommit: merged });
});

it('recovers a landed merge when migration changes its preview fingerprint', async () => {
  const f = await localTask(); await f.checkout(); await f.submit();
  const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
  expect((await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint })).status).toBe(202);
  const landed = 'c'.repeat(40), operation = f.jobs()[0].id;
  vi.mocked(commitFiles).mockImplementationOnce(async options => { await options.onPrepared!(landed); f.repo.state.head = landed; throw new Error('Lost push response before deploy'); });
  await expect(f.current().integrateMission(f.missionId, operation)).rejects.toThrow();
  const content = new ContentStore(f.db.storage), key = `plan:merge-plan:${f.missionId}`;
  const plan = content.get<Record<string, unknown>>(key)!;
  content.put(key, { ...plan, fingerprint: 'pre-migration-fingerprint' });
  await f.restart();
  expect(await f.current().integrateMission(f.missionId, operation)).toEqual({ commit: landed });
  expect(commitFiles).toHaveBeenCalledTimes(2);
  const state = await f.state();
  expect(state.missions[0]).toMatchObject({ status: 'merged', mergeCommit: landed });
  expect(state.files[`.braid/missions/${f.missionId}/decision.json`]).toBe((plan.files as Record<string, string>)[`.braid/missions/${f.missionId}/decision.json`]);
});

it('runs CLI start, committed revisions, fetched main and resubmission against the real Workspace protocol', async () => {
  const cli = await import(new URL('../../public/cli/braid.mjs', import.meta.url).href);
  const root = mkdtempSync(join(tmpdir(), 'braid-protocol-'));
  const dir = join(root, 'checkout'), upstream = join(root, 'upstream'); mkdirSync(dir);
  const native = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Protocol fixture', GIT_AUTHOR_EMAIL: 'protocol@example.test', GIT_COMMITTER_NAME: 'Protocol fixture', GIT_COMMITTER_EMAIL: 'protocol@example.test' },
  });
  try {
    native(dir, ['init', '--template=', '--initial-branch=main']);
    writeFileSync(join(dir, 'file.txt'), 'Original\n'); native(dir, ['add', '.']); native(dir, ['commit', '-m', 'Pinned base']);
    const base = native(dir, ['rev-parse', 'HEAD']).toString().trim();
    native(root, ['clone', '--no-local', dir, upstream]);
    const f = await fixture();
    expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
    f.repo.state.head = base; f.baseFiles['file.txt'] = 'Original\n';
    const task = await (await f.request('/api/missions', { title: 'Protocol fixture', intent: 'Change file.txt', execution: 'local' })).json() as { missionId: string };
    const link = `https://braid.example/tasks/${task.missionId}?workspace=workspace-1`;
    const options = {
      env: { ...process.env, BRAID_CONFIG_HOME: join(root, 'config'), BRAID_ACCESS_TOKEN: `braid_agent_${'a'.repeat(64)}`, BRAID_WORKSPACE_ID: 'workspace-1' }, log: () => {},
      fetch: async (url: string, init: RequestInit = {}) => {
        const parsed = new URL(url); expect(parsed.origin).toBe('https://braid.example');
        const headers = new Headers(init.headers);
        return f.request(parsed.pathname + parsed.search, init.body ? JSON.parse(String(init.body)) : undefined, headers.get('idempotency-key') ?? undefined, connection('codex'));
      },
      git: (args: string[], gitOptions: { cwd?: string } = {}) => {
        if (args[0] === 'fetch') {
          // Network and Artifacts are adapted; Git's actual fetch and index semantics run.
          return native(gitOptions.cwd!, args.map(arg => arg.startsWith('https://git.example/') ? upstream : arg));
        }
        return cli.runGit(args, gitOptions);
      },
    };
    await cli.start({ task: link, dir }, options);
    expect(JSON.parse(readFileSync(join(dir, '.braid/task.json'), 'utf8'))).toMatchObject({ baseCommit: base, submissionMode: 'commits' });
    writeFileSync(join(dir, 'file.txt'), 'First result\n'); native(dir, ['add', 'file.txt']); native(dir, ['commit', '-m', 'First result']);
    expect(await cli.submit({ dir, summary: 'First result' }, options)).toEqual({ commit: merged });
    let taskState = (await f.state()).missions[0]; f.repositories.get(taskState.agents[0].repo!)!.state.head = merged;
    await cli.start({ task: link, dir }, options);
    writeFileSync(join(dir, 'file.txt'), 'Revised result\n'); native(dir, ['add', 'file.txt']); native(dir, ['commit', '-m', 'Revise']);
    const second = 'c'.repeat(40); vi.mocked(commitFiles).mockResolvedValueOnce(second);
    expect(await cli.submit({ dir, summary: 'Revised result' }, options)).toEqual({ commit: second });
    taskState = (await f.state()).missions[0]; f.repositories.get(taskState.agents[0].repo!)!.state.head = second;
    writeFileSync(join(upstream, 'concurrent.txt'), 'Other task\n'); native(upstream, ['add', '.']); native(upstream, ['commit', '-m', 'Main advanced']);
    const main = native(upstream, ['rev-parse', 'HEAD']).toString().trim(); f.repo.state.head = main;
    const localHead = native(dir, ['rev-parse', 'HEAD']).toString().trim();
    await cli.update({ dir }, options);
    expect(native(dir, ['rev-parse', 'HEAD']).toString().trim()).toBe(localHead);
    expect((await f.state()).missions[0].baseCommit).toBe(base);
    await cli.start({ task: link, dir }, options);
    expect(JSON.parse(readFileSync(join(dir, '.braid/task.json'), 'utf8'))).toMatchObject({ baseCommit: main, acceptedBase: base, previousCommit: second });
    native(dir, ['merge', '--no-edit', '--no-gpg-sign', main]);
    const final = 'd'.repeat(40); vi.mocked(commitFiles).mockResolvedValueOnce(final);
    expect(await cli.submit({ dir, summary: 'Checked against updated main' }, options)).toEqual({ commit: final });
    expect((await f.state()).missions[0]).toMatchObject({ baseCommit: main, agents: [{ revision: 3, previousCommit: second }] });
    const publish = vi.mocked(commitFiles).mock.calls.at(-1)![0];
    expect(publish.parentCommit).toBe(main); expect(publish.files['file.txt']).toBe('Revised result\n');
    expect(publish.files).not.toHaveProperty('concurrent.txt');
    const preview = await (await f.request(`/api/missions/${task.missionId}/integration`)).json() as IntegrationPreview;
    expect((await f.request(`/api/missions/${task.missionId}/merge`, { integrationFingerprint: preview.fingerprint })).status).toBe(202);
    await f.current().integrateMission(task.missionId, f.jobs()[0].id);
    const ledger = JSON.parse(String(vi.mocked(commitFiles).mock.calls.at(-1)![0].files[`.braid/missions/${task.missionId}/decision.json`]));
    expect(ledger.lanes[0].history.map((entry: { commit: string }) => entry.commit)).toEqual([second, merged]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);

it('can explicitly close a failed pending publication and merge the other completed result', async () => {
  const f = await localTask({ agentCount: 2 }); await f.checkout(); await f.checkout('sable', connection('claude'));
  expect((await f.submit()).status).toBe(200);
  vi.mocked(commitFiles).mockRejectedValueOnce(new Error('Lost publication response'));
  await expectError(await f.submit(submission({ summary: 'Another approach' }), undefined, 'sable', connection('claude')), 502, /could not be committed/);
  expect((await f.request(`${f.path}/finish`, { agentIds: ['atlas'] })).status).toBe(200);
  await f.restart();
  const preview = await (await f.request(`${f.path}/integration`)).json() as IntegrationPreview;
  expect(preview.ready).toBe(true);
  expect((await f.request(`${f.path}/merge`, { integrationFingerprint: preview.fingerprint })).status).toBe(202);
  await f.current().integrateMission(f.missionId, f.jobs()[0].id);
  expect((await f.state()).missions[0].status).toBe('merged');
  expect(vi.mocked(commitFiles).mock.calls.at(-1)![0].message).toContain('Integrate 1 proposal with 0 human decisions.');
});
describe('tasks that land through the queue', () => {
  it('turns a single-agent result into a change with its capsule and follows it to landing', async () => {
    const t = await localTask({ headers: { 'x-braid-repository': 'team:team-1:repository:workspace-1' } });
    const submitted: { context: unknown; body: Record<string, unknown>; key: string }[] = [];
    const shard = {
      submit: vi.fn(async (context: unknown, body: Record<string, unknown>, key: string) => { submitted.push({ context, body, key }); return { ok: true, data: { id: 'ch_3abcdefabcdef', number: 7, status: 'open', revision: 1, next: '0 of 1 reviewer approval for revision 1.' } }; }),
      get: vi.fn(async () => ({ ok: true, data: { revision: 1 } })),
      revise: vi.fn(async (_context: unknown, _id: string, body: Record<string, unknown>) => ({ ok: true, data: { id: 'ch_3abcdefabcdef', number: 7, status: 'open', revision: Number(body.previousRevision) + 1 } })),
    };
    Object.assign(t.env, { TRUNKS: { getByName: () => ({ status: async () => ({ enabled: true }) }) }, CHANGES: { getByName: () => shard } });
    expect((await t.checkout()).status).toBe(200);
    // What the agent showed with its result goes on to the change.
    const evidence = [{ kind: 'command', command: 'npm test', exitCode: 0, output: 'Tests: 3 passed' },
      { kind: 'screenshot', page: '/', viewport: 'desktop', width: 1, height: 1, contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }];
    // The gateway names the person whose connection submits; the run comes with the result.
    const owner = { id: 'user:u-ishaan', name: 'Ishaan', email: '1+theg1239@users.noreply.github.com', github: 'theg1239' };
    const run = { tool: 'codex/1.8.0', session: 's_7' };
    const coAuthors = ['GPT-6.1 Sol <gpt-6.1-sol@agents.braid.local>'];
    expect((await t.submit(submission({ evidence, model: 'gpt-6.1-sol', agent: run, coAuthors }), undefined, 'atlas', { ...connection('codex'), 'x-braid-owner': encodeURIComponent(JSON.stringify(owner)) })).status).toBe(200);
    const mission = (await t.state()).missions.find(item => item.id === t.missionId)!;
    expect(mission.agents[0]).toMatchObject({ name: 'GPT-6.1 Sol', change: { id: 'ch_3abcdefabcdef', number: 7, status: 'open' } });
    expect(submitted).toHaveLength(1);
    const [{ context, body }] = submitted;
    expect(context).toMatchObject({ repository: 'team:team-1:repository:workspace-1', system: true, actor: { kind: 'agent', id: 'agent:codex', model: 'gpt-6.1-sol', owner } });
    expect(body).toMatchObject({ title: 'Add delivery retries', taskId: t.missionId, baseCommit: head, summary: 'Clarify local setup', model: 'gpt-6.1-sol', agent: run, coAuthors });
    const paths = (body.files as { path: string }[]).map(file => file.path);
    expect(paths).toContain('docs/local.md');
    expect(paths).toContain(`.braid/missions/${t.missionId}/gpt-6-1-sol.md`);
    expect((context as { checks: unknown }).checks).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Local execution', status: 'warning' }), expect.objectContaining({ label: 'Local run: npm test', status: 'warning' })]));
    expect(body.evidence).toEqual(evidence);
    // The landed change completes the task with its commit.
    await t.current().taskChange(t.missionId, { id: 'ch_3abcdefabcdef', number: 7, status: 'landed', commit: merged });
    const landed = (await t.state()).missions.find(item => item.id === t.missionId)!;
    expect(landed).toMatchObject({ status: 'merged', mergeCommit: merged });
    expect((await t.state()).activity[0]).toMatchObject({ type: 'merge', message: 'Merged pull request #7' });
  });

  function queueShard(number: number) {
    const submitted: { context: Record<string, unknown>; body: Record<string, unknown>; key: string }[] = [];
    const shard = { submit: vi.fn(async (context: Record<string, unknown>, body: Record<string, unknown>, key: string) => {
      submitted.push({ context, body, key });
      return { ok: true, data: { id: `ch_5abcdef${String(number).padStart(6, '0')}`, number, status: 'queued', revision: 1 } };
    }) };
    return { shard, submitted };
  }

  it('combines non-overlapping multi-agent work without asking anyone', async () => {
    const t = await localTask({ agentCount: 2, headers: { 'x-braid-repository': 'team:team-1:repository:workspace-1' } });
    const { shard, submitted } = queueShard(8);
    Object.assign(t.env, { TRUNKS: { getByName: () => ({ status: async () => ({ enabled: true }) }) }, CHANGES: { getByName: () => shard } });
    await t.checkout(); await t.checkout('sable', connection('claude'));
    const owner = { name: 'Maya Chen', github: 'maya-chen' };
    expect((await t.submit(submission(), undefined, 'atlas', { ...connection('codex'), 'x-braid-owner': encodeURIComponent(JSON.stringify(owner)) })).status).toBe(200);
    expect(shard.submit).not.toHaveBeenCalled();
    expect((await t.submit(submission({ files: [{ path: 'docs/other.md', content: '# Other\n' }] }), undefined, 'sable', connection('claude'))).status).toBe(200);
    expect(submitted).toHaveLength(1);
    const [{ context, body }] = submitted;
    // No person approved it, so the repository's rules decide.
    expect(context).toMatchObject({ system: true, actor: { kind: 'agent', id: `task:${t.missionId}`, owner } });
    expect(context.approvedBy).toBeUndefined();
    const paths = (body.files as { path: string }[]).map(file => file.path);
    expect(paths).toEqual(expect.arrayContaining(['docs/local.md', 'docs/other.md', `.braid/missions/${t.missionId}/decision.json`, `.braid/missions/${t.missionId}/codex-1.md`, `.braid/missions/${t.missionId}/codex-2.md`]));
    expect(paths.some(path => /\/(atlas|sable|reed)\.md$/.test(path))).toBe(false);
    expect((await t.state()).missions.find(item => item.id === t.missionId)!.agents.map(agent => agent.change?.number)).toEqual([8, 8]);
  });

  it('lands an overlap the person resolved as one approved change, even after main moved', async () => {
    const t = await localTask({ agentCount: 2, headers: { 'x-braid-repository': 'team:team-1:repository:workspace-1' } });
    const { shard, submitted } = queueShard(9);
    Object.assign(t.env, { TRUNKS: { getByName: () => ({ status: async () => ({ enabled: true }) }) }, CHANGES: { getByName: () => shard } });
    await t.checkout(); await t.checkout('sable', connection('claude'));
    expect((await t.submit()).status).toBe(200);
    expect((await t.submit(submission({ files: [{ path: 'docs/local.md', content: '# A different result\n' }] }), undefined, 'sable', connection('claude'))).status).toBe(200);
    // The agents disagree about one file, so nothing is submitted until a person chooses.
    expect(shard.submit).not.toHaveBeenCalled();
    const [collision] = (await t.state()).missions.find(item => item.id === t.missionId)!.collisions;
    expect((await t.request(`${t.path}/resolve`, { collisionId: collision.id, agentId: 'sable', reason: 'Clearer for new readers.' })).status).toBe(200);
    // The queue lands other work meanwhile; the task's result still lands.
    await t.current().trunkAdvanced('f'.repeat(40), { batchId: 'b_other', landed: 3, ejected: 0 });
    const preview = await (await t.request(`${t.path}/integration`)).json() as IntegrationPreview;
    expect(preview).toMatchObject({ ready: true, blocker: null });
    expect(preview.checks.find(check => check.label === 'Base revision')).toMatchObject({ status: 'passed', detail: expect.stringContaining('landing queue') });
    const landed = await t.request(`${t.path}/merge`, { integrationFingerprint: preview.fingerprint });
    expect(landed.status).toBe(202);
    expect(await landed.json()).toMatchObject({ change: { number: 9 } });
    const [{ context, body }] = submitted;
    expect(context).toMatchObject({ system: true, approvedBy: expect.any(String), actor: { kind: 'agent', id: `task:${t.missionId}` } });
    expect((body.files as { path: string; content: string }[]).find(file => file.path === 'docs/local.md')!.content).toBe('# A different result\n');
    // No direct push happens; a repeated request returns the same change.
    expect(t.jobs().filter(job => job.id.includes('-merge-'))).toHaveLength(0);
    expect(await (await t.request(`${t.path}/merge`, { integrationFingerprint: preview.fingerprint })).json()).toMatchObject({ change: { number: 9 } });
    expect(shard.submit).toHaveBeenCalledTimes(1);
    await expectError(await t.request(`${t.path}/resolve`, { collisionId: collision.id, agentId: 'atlas', reason: 'Changed my mind.' }), 409, /only while a task is in review/);
    await t.current().taskChange(t.missionId, { id: 'ch_5abcdef000009', number: 9, status: 'landed', commit: merged });
    expect((await t.state()).missions.find(item => item.id === t.missionId)).toMatchObject({ status: 'merged', mergeCommit: merged });
  });

  it('keeps the review-and-merge flow when landing is off', async () => {
    const t = await localTask({ headers: { 'x-braid-repository': 'team:team-1:repository:workspace-1' } });
    const shard = { submit: vi.fn() };
    Object.assign(t.env, { TRUNKS: { getByName: () => ({ status: async () => ({ enabled: false }) }) }, CHANGES: { getByName: () => shard } });
    expect((await t.checkout()).status).toBe(200);
    expect((await t.submit()).status).toBe(200);
    expect(shard.submit).not.toHaveBeenCalled();
    expect((await t.state()).missions.find(item => item.id === t.missionId)!.status).toBe('review');
  });

  it('never merges directly while the landing queue cannot answer', async () => {
    const t = await localTask({ headers: { 'x-braid-repository': 'team:team-1:repository:workspace-1' } });
    const status = vi.fn(async () => ({ enabled: false }));
    Object.assign(t.env, { TRUNKS: { getByName: () => ({ status }) } });
    await t.checkout(); expect((await t.submit()).status).toBe(200);
    const preview = await (await t.request(`${t.path}/integration`)).json() as IntegrationPreview;
    status.mockRejectedValue(Object.assign(new Error('Trunk unavailable'), { overloaded: true }));
    const merge = await t.request(`${t.path}/merge`, { integrationFingerprint: preview.fingerprint });
    expect(merge.status).toBe(503);
    expect(merge.headers.get('retry-after')).toBe('1');
    expect(t.jobs()).toHaveLength(0);
    expect((await t.state()).missions.find(item => item.id === t.missionId)!.status).toBe('review');
  });
});


describe('repository discovery activity', () => {
  it('retries a failed directory notification across a restart without failing the durable write', async () => {
    const f = await fixture();
    expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
    const headers = { 'x-braid-repository': 'team:team-1:repository:workspace-1' };
    await f.request('/api/state', undefined, undefined, headers);
    f.directory.repositoryActivity.mockRejectedValueOnce(new Error('Directory unavailable'));
    const response = await f.request('/api/context', { title: 'A rule', body: 'Keep reads public', kind: 'constraint' }, undefined, headers);
    expect(response.status).toBe(201);
    expect(await f.db.storage.get('directory-activity')).toMatchObject({ workspaceId: 'workspace-1' });
    const restarted = await f.restart();
    await restarted.alarm();
    expect(await f.db.storage.get('directory-activity')).toBeUndefined();
    expect(f.directory.repositoryActivity).toHaveBeenCalledTimes(2);
    expect(f.directory.repositoryActivity).toHaveBeenLastCalledWith('workspace-1', expect.any(String), expect.any(String));
    await f.request('/api/state', undefined, undefined, headers);
    expect(f.directory.repositoryActivity).toHaveBeenCalledTimes(2);
  });
});


describe('read-only task endpoints', () => {
  it('reads both mission and task aliases with a viewer role and refuses a viewer mutation', async () => {
    const f = await fixture(), { missionId } = await launch(f);
    const viewer = { 'x-braid-role': 'viewer' };
    for (const prefix of ['missions', 'tasks']) {
      const collection = await f.request(`/api/${prefix}`, undefined, undefined, viewer);
      expect(collection.status).toBe(200);
      expect(await collection.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: missionId })]));
      const detail = await f.request(`/api/${prefix}/${missionId}`, undefined, undefined, viewer);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: missionId, title: 'Add delivery retries' });
    }
    expect((await f.request(`/api/missions/${missionId}/merge`, {}, undefined, viewer)).status).toBe(403);
  });
});

describe('hosted tasks on a person’s own provider', () => {
  const owner = { ...ownerHeaders, 'x-braid-repository': 'team:team-1:repository:workspace-1' };
  async function providerFixture(choice: { ok: true; model: string; version: string } | { ok: false; error: string } = { ok: true, model: 'gpt-5', version: 'key-v1' }) {
    const f = await fixture(undefined, { headers: owner });
    const providerChoice = vi.fn((_user: string, _provider: string) => choice);
    Object.assign(f.security, { providerChoice });
    return { ...f, providerChoice };
  }

  it('runs the starter’s chosen model and hands the sandbox a reference to their key, never the key', async () => {
    const f = await providerFixture();
    const task = await launch(f, { provider: 'openai', agentCount: 2 });
    expect(f.providerChoice).toHaveBeenCalledExactlyOnceWith('test-owner', 'openai');
    const lanes = (await f.state()).missions[0].agents;
    expect(lanes.map(agent => [agent.model, agent.provider, agent.name.split(' (')[0]])).toEqual([['gpt-5', 'openai', 'GPT-5'], ['gpt-5', 'openai', 'GPT-5']]);
    await f.current().runAgent(task.missionId, lanes[0].id, f.jobs()[0].id);
    const sent = f.sandbox.run.mock.calls[0][0];
    expect(sent).toMatchObject({ model: 'gpt-5', provider: { id: 'openai', owner: 'test-owner', version: 'key-v1' } });
    // The snapshot names the provider, not whose key it is.
    expect(JSON.stringify(await f.state())).not.toContain('key-v1');
  });
  it('keeps Workers AI tasks free of any provider', async () => {
    const f = await providerFixture();
    const task = await launch(f, { agentCount: 1 });
    await f.current().runAgent(task.missionId, (await f.state()).missions[0].agents[0].id, f.jobs()[0].id);
    expect(f.providerChoice).not.toHaveBeenCalled();
    expect(f.sandbox.run.mock.calls[0][0]).not.toHaveProperty('provider');
  });
  it('refuses a provider the starter has not connected, and anyone but a signed-in person', async () => {
    const f = await providerFixture({ ok: false, error: 'Connect Anthropic in Settings → Agents first.' });
    expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
    const start = (headers: Record<string, string> = {}) => f.request('/api/missions', { title: 'Retries', intent: 'Add retries.', provider: 'anthropic' }, undefined, headers);
    await expectError(await start(), 409, /Connect Anthropic in Settings → Agents first/);
    await expectError(await start({ 'x-braid-connection-digest': 'agent-digest' }), 403, /signed-in person/);
    await expectError(await f.request('/api/missions', { title: 'Retries', intent: 'Add retries.', provider: 'openai', execution: 'local' }), 400, /hosted agents/);
    expect((await f.state()).missions).toHaveLength(0);
    const ownerKey = await fixture();
    expect((await ownerKey.request('/api/project', { name: 'project' })).status).toBe(201);
    await expectError(await ownerKey.request('/api/missions', { title: 'Retries', intent: 'Add retries.', provider: 'openai' }), 403, /signed-in person/);
  });
  it('never runs a lane on a key whose owner is not the person who started the task', async () => {
    const f = await providerFixture();
    const task = await launch(f, { provider: 'openai', agentCount: 1 });
    const row = f.db.storage.sql.exec<{ value: string }>('SELECT value FROM inputs WHERE mission = ?', task.missionId).toArray()[0];
    const input = JSON.parse(row.value);
    f.db.storage.sql.exec('UPDATE inputs SET value = ? WHERE mission = ?', JSON.stringify({ ...input, provider: { ...input.provider, owner: 'second-owner' } }), task.missionId);
    const result = await f.current().runAgent(task.missionId, (await f.state()).missions[0].agents[0].id, f.jobs()[0].id).catch((error: Error) => ({ failure: { message: error.message } }));
    expect(result).toMatchObject({ failure: { message: expect.stringMatching(/provider connection is missing/) } });
    expect(f.sandbox.run).not.toHaveBeenCalled();
  });
});

it('recovers a lost Workflow response after publication without another commit or proposal revision', async () => {
  const f = await fixture(), task = await launch(f, { agentCount: 1 }), operation = f.jobs()[0].id;
  let lost = false;
  const calls: string[] = [], sleeps: string[] = [];
  const env = { ...f.env, WORKSPACES: { idFromString: () => 'workspace-1', get: () => ({
    runAgent: async (...args: Parameters<Workspace['runAgent']>) => {
      const result = await f.current().runAgent(...args);
      if (!lost) { lost = true; await f.restart(); throw new Error('Workflow RPC result was lost'); }
      return { [Symbol.dispose]() {}, ...result };
    },
    hostedWorkflowFailure: (...args: Parameters<Workspace['hostedWorkflowFailure']>) => f.current().hostedWorkflowFailure(...args),
    failAgent: (...args: Parameters<Workspace['failAgent']>) => f.current().failAgent(...args),
    finishMission: (...args: Parameters<Workspace['finishMission']>) => f.current().finishMission(...args),
  }) } } as unknown as BraidEnv;
  const step = {
    do: async (name: string, options: unknown, run?: () => Promise<unknown>) => { calls.push(name); return typeof options === 'function' ? options() : run!(); },
    sleep: async (_name: string, delay: string) => { sleeps.push(delay); },
  } as unknown as WorkflowStep;
  await new MissionWorkflow({} as ExecutionContext, env).run({ payload: { workspaceId: 'workspace-1', missionId: task.missionId, action: 'run', agentIds: ['atlas'], operationId: operation } } as WorkflowEvent<RunParams>, step);
  expect(calls).toContain('run atlas retry 1'); expect(sleeps).toEqual(['1 seconds']);
  expect(commitFiles).toHaveBeenCalledTimes(1); expect(f.sandbox.run).toHaveBeenCalledTimes(1);
  expect((await f.state()).missions[0]).toMatchObject({ status: 'review', agents: [{ status: 'review', commit: merged }] });
  const published = (await f.state()).missions[0].agents[0];
  const revision = published.revision;
  await f.current().runAgent(task.missionId, 'atlas', operation);
  expect((await f.state()).missions[0].agents[0].revision).toBe(revision);
  expect(commitFiles).toHaveBeenCalledTimes(1);
});

it('restarts an errored Workflow under the same ID with bounded persisted backoff', async () => {
  const f = await fixture();
  await launch(f, { agentCount: 1 });
  const operation = f.jobs()[0].id;
  const restart = vi.fn(async () => {}); Object.assign(f.instance, { restart });
  f.instance.status.mockResolvedValue({ status: 'errored' });
  vi.useFakeTimers({ toFake: ['Date'] });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.current().alarm();
    expect((await f.state()).missions[0].agents[0].environment).toMatchObject({ status: 'retrying', failure: { cause: 'workflow_step', evidence: { code: 'errored' } }, retry: { attempt, limit: 3 } });
    expect(restart).toHaveBeenCalledTimes(attempt - 1);
    await f.restart(); vi.setSystemTime(Date.now() + 1000 * 2 ** (attempt - 1));
    await f.current().alarm(); expect(restart).toHaveBeenCalledTimes(attempt);
  }
  await f.current().alarm();
  expect(f.jobs()).toHaveLength(0); expect(restart).toHaveBeenCalledTimes(3);
  expect((await f.state()).missions[0]).toMatchObject({ status: 'failed', agents: [{ environment: { status: 'failed', failure: { cause: 'workflow_step' } } }] });
  expect(f.workflows.create).toHaveBeenCalledTimes(1);
  for (const args of f.workflows.get.mock.calls) expect(args[0]).toBe(operation);
  expect(f.sandbox.run).not.toHaveBeenCalled();
});

it('bounds Workflow delivery failures and retains their status on the task', async () => {
  const f = await fixture(); await launch(f, { agentCount: 1 });
  f.workflows.create.mockRejectedValue(new Error('unavailable')); f.workflows.get.mockRejectedValue(new Error('unavailable'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (let attempt = 0; attempt <= 3; attempt++) {
    await f.current().alarm(); await f.restart(); vi.setSystemTime(Date.now() + 1000 * 2 ** attempt);
  }
  expect(f.workflows.create).toHaveBeenCalledTimes(4); expect(f.jobs()).toHaveLength(0);
  expect((await f.state()).missions[0]).toMatchObject({ status: 'failed', agents: [{ environment: { status: 'failed', failure: { cause: 'workflow_step', evidence: { operation: 'Workflow delivery or status' } } } }] });
  expect(f.sandbox.run).not.toHaveBeenCalled();
});

it('starts a hosted task on a repository with no setup or check commands', async () => {
  const f = await fixture();
  expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
  delete f.baseFiles['.braid/policy.json'];
  const response = await f.request('/api/missions', { title: 'Document how to run it', intent: 'Write a README section', agentCount: 1 });
  expect(response.status).toBe(202);
  const state = await f.state();
  expect(state.missions[0]).toMatchObject({ status: 'running', agents: [{ environment: { status: 'preflight', preflight: { checks: [], missing: [] } } }] });
  expect(state.missions[0].agents[0].environment!.preflight!.setup).toBeUndefined();
  expect(f.jobs()).toHaveLength(1);
});

it('shows fixed text, never an internal error, when a task cannot be queued', async () => {
  const f = await fixture();
  expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
  vi.spyOn(f.current() as unknown as { enqueue: () => Promise<void> }, 'enqueue').mockRejectedValueOnce(new Error('SQLITE_FULL: private storage detail'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await f.request('/api/missions', { title: 'Queue it', intent: 'Make a change', agentCount: 1 })).status).toBeGreaterThanOrEqual(500);
  expect((await f.state()).missions[0]).toMatchObject({ status: 'failed', error: 'The task workflow could not start. Retry the task.', agents: [{ environment: { status: 'failed', failure: { cause: 'workflow_step', evidence: { reason: 'launch' } } } }] });
});

it('reports a broken policy before spending a task allowance or starting a Workflow', async () => {
  const f = await fixture();
  expect((await f.request('/api/project', { name: 'project' })).status).toBe(201);
  f.baseFiles['.braid/policy.json'] = '{'; f.security.consume.mockClear();
  const response = await f.request('/api/missions', { title: 'Needs setup', intent: 'Make a change', agentCount: 1 });
  expect(response.status).toBe(202);
  const state = await f.state();
  expect(state.missions[0]).toMatchObject({ status: 'failed', agents: [{ status: 'failed', environment: { status: 'failed', failure: { cause: 'preflight', action: 'edit_setup' } } }] });
  expect(f.security.consume).not.toHaveBeenCalled(); expect(f.jobs()).toHaveLength(0);
  expect(f.workflows.create).not.toHaveBeenCalled(); expect(f.sandbox.run).not.toHaveBeenCalled(); expect(f.repo.fork).not.toHaveBeenCalled();
  expect(f.repo.readFile.mock.calls.every(([request]) => request.ref === head)).toBe(true);
});
it('keeps executable setup private while redacting its public preflight', async () => {
  const f = await fixture(); const setup = 'TOKEN=private-fixture-token npm ci';
  f.baseFiles['.braid/policy.json'] = JSON.stringify({ version: 1, install: setup, checks: ['npm test'] });
  const task = await launch(f, { agentCount: 1 });
  expect(JSON.stringify(await f.state())).not.toContain('private-fixture-token');
  await f.current().runAgent(task.missionId, 'atlas', f.jobs()[0].id);
  expect(f.sandbox.run.mock.calls[0][0].preflight?.setup).toBe(setup);
  expect(JSON.stringify(await f.state())).not.toContain('private-fixture-token');
});
