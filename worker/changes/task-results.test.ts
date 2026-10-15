import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Mission, PullRequestContext, WorkspaceSnapshot } from '../../shared/types';
import { Workspace } from '../workspace/workspace';
import { ContentStore } from '../workspace/content';
import { seedWorkspace } from '../workspace/seed';
import type { Receipt } from '../http/operations';
import { changeHarness } from '../test/changes-harness';
import { storageFixture } from '../test/storage';
import { shardOf } from './names';
import { change, detectCollisions } from '../workspace/domain';
import { fileProvenance, parseNote, provenanceOf } from '../../shared/provenance';

type Internals = {
  data: WorkspaceSnapshot;
  submitTaskChange(mission: Mission): Promise<boolean>;
  submitCombined(mission: Mission): Promise<Agent['change']>;
  submitLocal(mission: string, agent: string, claimant: string, body: unknown, receipt: Receipt): Promise<unknown>;
  integrationFiles(): Promise<unknown>;
  executeAgent(mission: string, agent: string): Promise<unknown>;
  prepareAgentFork(): Promise<void>;
  stageProposal(): Promise<unknown>;
  publishProposal(mission: Mission, agent: Agent, plan: Record<string, unknown>): Promise<unknown>;
  reviewComments(agent: Agent): Promise<{ pullRequest?: PullRequestContext }>;
};
let h: Awaited<ReturnType<typeof changeHarness>>;
let db: ReturnType<typeof storageFixture>;
afterEach(async () => { if (h) { await h.settle(2); await h.close(); h = undefined!; } if (db) { await db.settled(); db.db.close(); db = undefined!; } vi.restoreAllMocks(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }): T => { if (!result.ok) throw new Error(result.error); return result.data; };
async function fixture() {
  h = await changeHarness(); db = storageFixture();
  const base = h.git.commitTree({ 'README.md': '# Task fixtures\n' });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  await h.trunk.configure(h.repository, { enabled: true, actor: 'owner' });
  const parent = ok(await h.submit('parent', { title: 'Prerequisite', summary: 'Prerequisite', baseCommit: h.head(), files: [{ path: 'parent.txt', content: 'Parent\n' }] }));
  const agent: Agent = { id: 'coder', name: 'GPT-6 Astra', model: 'gpt-6-astra', role: 'Coder', task: 'Implement child', scope: ['*'], status: 'review', color: '', summary: 'Child', rationale: 'Build on parent', revision: 1, checks: [], changes: [] };
  const mission: Mission = { id: 'mission-dependencies', title: 'Dependent task', intent: 'Build on the prerequisite', createdAt: new Date().toISOString(), status: 'review', source: 'live', execution: 'local', baseCommit: h.head(), agents: [agent], collisions: [] };
  const data = seedWorkspace('live', { mode: 'live', artifacts: true, ai: false, storage: 'durable-object', authenticated: true, model: '', namespace: 'test', canWrite: true });
  data.project = { id: 'repo', name: 'repo', head: h.head(), branch: 'main', remote: h.git.remote, description: '', stack: [] }; data.missions = [mission];
  await db.storage.put('workspace', data); await db.storage.put('repository-key', h.repository);
  const workspace = new Workspace(db.ctx, h.env); await db.ready();
  const internal = workspace as unknown as Internals, live = internal.data.missions[0], content = new ContentStore(db.storage);
  const plan = (agentId = 'coder', dependsOn?: (number | string)[]) => {
    content.put(`plan:proposal:${live.id}:${agentId}`, { files: { [`${agentId}.txt`]: 'Own change\n' }, summary: 'Child', rationale: 'Build on parent', checks: [], changes: [], ...(dependsOn === undefined ? {} : { dependsOn }) });
  };
  plan('coder', [parent.number]); return { workspace, internal, mission: live, agent: live.agents[0], parent, content, plan };
}

describe('dependencies through workspace task results', () => {
  it('lands each chosen proposal with its own model, owner, tool and session while keeping the combined commit author', async () => {
    const t = await fixture();
    const owner = { name: 'Maya', github: 'maya-chen' };
    Object.assign(t.agent, { name: 'Claude Opus 5.5', model: 'claude-opus-5-5', owner, changes: [change('limits.ts', '', 'export const limit = 10;\n'), change('delivery.ts', '', 'export const deliver = true;\n')] });
    const second = { ...t.agent, id: 'second', name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', changes: [change('limits.ts', '', 'export const limit = 5;\n'), t.agent.changes[1], change('docs.md', '', 'Receiver documentation\n')] };
    t.mission.agents.push(second);
    t.mission.collisions = detectCollisions(t.mission.agents);
    t.mission.collisions[0].resolution = { agentId: t.agent.id, reason: 'Use ten.', resolvedAt: new Date().toISOString() };
    for (const agent of t.mission.agents) t.content.put(`plan:proposal:${t.mission.id}:${agent.id}`, { files: Object.fromEntries(agent.changes.map(file => [file.path, file.after])), owner,
      run: agent.id === t.agent.id ? { tool: 'claude-code/2.4.1', session: 's_claude', parentSession: 's_parent' } : { tool: 'codex/1.8', session: 's_codex' } });
    const link = (await t.internal.submitCombined(t.mission))!;
    await h.settle();
    const landed = ok(await h.shard(shardOf(link.id)!).get(link.id));
    expect(landed.status).toBe('landed');
    for (const path of ['limits.ts', 'delivery.ts']) expect(ok(await h.trunk.blame(h.repository, path)).ranges[0].provenance).toMatchObject({ kind: 'agent', confidence: 'braid', agent: { name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.4.1', session: 's_claude', parentSession: 's_parent' }, owner });
    expect(ok(await h.trunk.blame(h.repository, 'docs.md')).ranges[0].provenance.agent).toMatchObject({ name: 'GPT-6.1 Sol', session: 's_codex' });
    const [record] = await h.trunk.provenance(h.repository, [landed.landedCommit!]);
    expect(record.agent?.name).toBe('Claude Opus 5.5 and GPT-6.1 Sol');
    const noteText = h.git.native(['notes', '--ref=braid', 'show', landed.landedCommit!]);
    const facts = (await h.git.repository.readCommit(landed.landedCommit!))!;
    const imported = provenanceOf({ id: facts.hash, at: record.at, author: facts.author, message: facts.message }, parseNote(noteText));
    expect(fileProvenance(imported, 'delivery.ts')).toMatchObject({ confidence: 'trailers', agent: { model: 'claude-opus-5-5', session: 's_claude' } });
    expect(facts.message.trimEnd()).toBe(`${landed.title}\n\n${landed.summary}`);
  }, 60_000);
  it('submits a result with dependencies, retains omission, clears explicitly, and exposes outdated context', async () => {
    const t = await fixture();
    expect(await t.internal.submitTaskChange(t.mission)).toBe(true);
    const store = h.shard(shardOf(t.agent.change!.id)!);
    const first = ok(await store.get(t.agent.change!.id));
    expect(first.dependsOn).toEqual([{ id: t.parent.id, number: t.parent.number, status: t.parent.status }]);
    const ps = h.shard(shardOf(t.parent.id)!);
    ok(await ps.revise(h.context('parent', shardOf(t.parent.id)!), t.parent.id, { summary: 'Changed', baseCommit: h.head(), files: [{ path: 'parent.txt', content: 'New parent\n' }], previousRevision: 1 }, 'task-parent-revision'));
    await vi.waitFor(async () => expect((await t.internal.reviewComments(t.agent)).pullRequest).toMatchObject({ outdated: [{ id: t.parent.id }], next: expect.stringContaining('changed since this was built') }));
    t.agent.revision = 2; t.plan('coder', undefined);
    expect(await t.internal.submitTaskChange(t.mission)).toBe(true);
    expect(ok(await store.get(first.id))).toMatchObject({ revision: 2, dependsOn: [{ id: t.parent.id }], outdated: [{ id: t.parent.id }] });
    t.agent.revision = 3; t.plan('coder', []);
    expect(await t.internal.submitTaskChange(t.mission)).toBe(true);
    expect(ok(await store.get(first.id))).toMatchObject({ revision: 3, dependsOn: [], outdated: [] });
  });
  it('retries a revision after a lost reply with the exact body and previous revision', async () => {
    const t = await fixture(); await t.internal.submitTaskChange(t.mission);
    t.agent.revision = 2;
    const store = h.shard(shardOf(t.agent.change!.id)!), revise = store.revise.bind(store);
    const spy = vi.spyOn(store, 'revise').mockImplementationOnce(async (...args) => { await revise(...args); throw new Error('Lost reply'); });
    expect(await t.internal.submitTaskChange(t.mission)).toBe(false);
    // Current server revision and the transient evidence have changed by retry time.
    t.content.put(`evidence:${t.mission.id}:coder:2`, [{ kind: 'command', command: 'new test', exitCode: 0, output: 'ok' }]);
    expect(await t.internal.submitTaskChange(t.mission)).toBe(true);
    expect(spy.mock.calls[1]).toEqual(spy.mock.calls[0]);
    expect(ok(await store.get(t.agent.change!.id)).revision).toBe(2);
  });
  it.each([404, 409])('returns dependency %s before publishing a local result', async status => {
    const t = await fixture(); t.mission.status = 'running'; t.agent.status = 'working'; t.agent.repo = 'fork'; t.agent.remote = h.git.remote;
    t.content.delete(`plan:proposal:${t.mission.id}:coder`);
    await db.storage.put(`local-claim:${t.mission.id}:coder`, { claimant: 'agent', expires: Date.now() + 60_000 });
    if (status === 409) ok(await h.shard(shardOf(t.parent.id)!).close(h.context('parent', shardOf(t.parent.id)!), t.parent.id, {}));
    const before = h.artifacts.get.mock.calls.length;
    await expect(t.internal.submitLocal(t.mission.id, 'coder', 'agent', { baseCommit: h.head(), summary: 'Child', rationale: 'Depends on parent', files: [{ path: 'child.txt', content: 'Child\n' }], dependsOn: [status === 404 ? 999999 : t.parent.number] }, { key: 'task-result-dependencies', signature: 'input' })).rejects.toMatchObject({ status });
    expect(h.artifacts.get.mock.calls.length).toBe(before);
    expect(t.agent.commit).toBeUndefined();
  });
  it('unions dependencies when workspace lanes become one pull request', async () => {
    const t = await fixture();
    const other = ok(await h.submit('other', { title: 'Other prerequisite', summary: 'Other prerequisite', baseCommit: h.head(), files: [{ path: 'other.txt', content: 'Other\n' }] }));
    t.mission.agents.push({ ...t.agent, id: 'second' }); t.plan('second', [t.parent.number, other.number]);
    vi.spyOn(t.internal, 'integrationFiles').mockResolvedValue({ files: { 'combined.txt': 'Combined\n' }, preview: { fingerprint: 'combined-fixture' } });
    const link = (await t.internal.submitCombined(t.mission))!;
    const change = ok(await h.shard(shardOf(link.id)!).get(link.id));
    expect(change.dependsOn?.map(item => item.id).sort()).toEqual([t.parent.id, other.id].sort());
    expect(t.mission.agents.every(agent => agent.change?.id === change.id)).toBe(true);
  });
});

it.each([true, false])('validates and forwards a hosted result before publication (valid=%s)', async valid => {
  const t = await fixture(); t.mission.execution = 'cloud'; t.mission.status = 'running'; t.agent.status = 'working'; t.agent.repo = 'fork';
  const get = h.artifacts.get.getMockImplementation()!;
  h.artifacts.get.mockImplementation(async () => Object.assign(await get(), { readFile: async ({ ref, path }: { ref: string; path: string }) => {
    const paths = h.git.native(['ls-tree', '-r', '--name-only', ref]).trim().split('\n');
    return paths.includes(path) ? new Blob([h.git.native(['show', `${ref}:${path}`])]) : null;
  } }));
  t.content.delete(`plan:proposal:${t.mission.id}:coder`);
  await db.storage.put(`input:${t.mission.id}`, { context: [] });
  Object.assign(db.ctx, { exports: { AgentSandbox: { getByName: () => ({ run: async () => ({ [Symbol.dispose]() {}, summary: 'Child', rationale: 'Build on parent', dependsOn: [valid ? t.parent.number : 999999], files: [{ path: 'coder.txt', content: 'Own change\n' }], checks: [] }) }) } } });
  vi.spyOn(t.internal, 'prepareAgentFork').mockResolvedValue();
  vi.spyOn(t.internal, 'stageProposal').mockResolvedValue({ files: { 'coder.txt': 'Own change\n' }, changes: [] });
  const publish = vi.spyOn(t.internal, 'publishProposal').mockResolvedValue({ commit: 'b'.repeat(40) });
  if (valid) {
    await t.internal.executeAgent(t.mission.id, t.agent.id);
    expect(publish.mock.calls[0][2]).toMatchObject({ dependsOn: [t.parent.number] });
  } else {
    await expect(t.internal.executeAgent(t.mission.id, t.agent.id)).rejects.toMatchObject({ status: 404 });
    expect(publish).not.toHaveBeenCalled();
  }
});
