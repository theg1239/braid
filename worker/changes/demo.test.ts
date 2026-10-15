import { afterEach, describe, expect, it, vi } from 'vitest';
import { changesRoute } from './router';
import { Workspace } from '../workspace/workspace';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';
import { HttpError } from '../errors';
import type { AgentRecord, Change, ChangePage, FileBlame, Instruction, Provenance, TrunkStatus, WorkspaceSnapshot } from '../../shared/types';
import { exampleMain, recordedExample } from './demo';
import { ChangeShard } from './shard';
import { isStale } from '../../src/lib/derive';

afterEach(() => { vi.useRealTimers(); });

function exampleEnv(workspace: Workspace) {
  const shards = new Map<string, ChangeShard>();
  const env = { WORKSPACES: { idFromName: (name: string) => name, get: () => workspace }, CHANGES: { getByName(name: string) {
    if (!shards.has(name)) shards.set(name, new ChangeShard(storageFixture().ctx, env));
    return shards.get(name)!;
  } } } as unknown as BraidEnv;
  return env;
}

async function example(repository = 'demo:visitor-one') {
  const db = storageFixture();
  const workspace = new Workspace(db.ctx, {} as BraidEnv);
  await db.ready();
  const env = exampleEnv(workspace);
  // The gateway turns thrown HTTP errors into responses; do the same here.
  const raw = async (path: string, init: RequestInit = {}) => (await changesRoute(new Request(`https://braid.example${path}`, init), env, { repository, mode: 'demo', role: 'demo' }))!;
  const call = async <T>(path: string, body?: unknown) => {
    try {
      const response = await raw(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
      return { status: response.status, data: await response.json() as T };
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, data: { error: error.message } as T };
      throw error;
    }
  };
  return { call, raw };
}

describe('the recorded example compares revisions', () => {
  it('shows only the fix an agent made after its first revision was sent back', async () => {
    const { call } = await example();
    const revised = (await call<ChangePage>('/api/changes?status=done&limit=100')).data.items.find(item => item.title === 'Parse Retry-After before retrying')!;
    expect(revised).toMatchObject({ title: 'Parse Retry-After before retrying', revision: 2 });
    const path = encodeURIComponent('src/delivery.ts');
    const whole = (await call<{ before: string; after: string }>(`/api/changes/${revised.id}/diff?path=${path}`)).data;
    const since = (await call<{ since: number; before: string; after: string }>(`/api/changes/${revised.id}/diff?path=${path}&since=1`)).data;
    expect(whole.before).not.toContain('retry-after');
    expect(since).toMatchObject({ since: 1, before: expect.stringContaining('Number(retryAfter) * 1000 * 1000'), after: expect.stringContaining('Math.min(Number(retryAfter), 60) * 1000') });
    expect((await call(`/api/changes/${revised.id}/diff?path=${path}&since=2`)).status).toBe(400);
    expect((await call(`/api/changes/${revised.id}/compare?since=1`)).data).toEqual({ revision: 2, since: 1, files: [{ path: 'src/delivery.ts', additions: 1, deletions: 1 }] });
  });
});

describe('the recorded example shows evidence and instructions', () => {
  it('serves the screenshots a recorded change shows, as recorded', async () => {
    const { call, raw } = await example();
    const landed = (await call<ChangePage>('/api/changes?status=done&limit=100')).data.items;
    const page = (await call<Change>(`/api/changes/${landed.find(item => item.title === 'Add a delivery status page')!.id}`)).data;
    const shots = page.evidence!.filter(item => item.kind === 'screenshot');
    expect(shots.map(shot => [shot.viewport, shot.page, shot.source])).toEqual([['desktop', '/status.html', 'agent'], ['mobile', '/status.html', 'agent']]);
    const response = await raw(`/api/changes/${page.id}/evidence/${shots[0].image}`);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect([...new Uint8Array(await response.arrayBuffer()).slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const other = landed.find(item => item.title === 'Add a health route')!;
    expect((await call(`/api/changes/${other.id}/evidence/${shots[0].image}`)).status).toBe(404);
    // A failing run the agent reported sent its change back, and the fix landed with a passing one that Braid's own run confirmed.
    const validation = (await call<Change>(`/api/changes/${landed.find(item => item.title === 'Validate endpoint URLs before delivering')!.id}`)).data;
    expect(validation.evidence!.map(item => item.kind === 'command' && [item.revision, item.source, item.command, item.exitCode])).toEqual([
      [1, 'agent', 'npm test', 1], [2, 'agent', 'npm test', 0], [2, 'braid', 'npm ci', 0], [2, 'braid', 'npm run typecheck', 0], [2, 'braid', 'npm test', 0]]);
    // An agent that ran only some tests reported a pass; Braid's run of all of them on the combined result failed.
    const retryAfter = (await call<Change>(`/api/changes/${landed.find(item => item.title === 'Parse Retry-After before retrying')!.id}`)).data;
    expect(retryAfter.evidence!.filter(item => item.revision === 1 && item.kind === 'command' && item.command.startsWith('npm test')).map(item => item.kind === 'command' && [item.source, item.command, item.exitCode]))
      .toEqual([['agent', 'npm test -- -t retries', 0], ['braid', 'npm test', 1]]);
    expect(validation.checks.find(check => check.revision === 1 && check.status === 'failed')).toMatchObject({ label: 'npm test', source: 'agent', detail: expect.stringContaining('accepts https endpoints') });
  });

  it('reads the instructions on main, checks changes against them, and keeps them as recorded', async () => {
    const { call } = await example();
    const { data } = await call<{ instructions: Instruction[]; errors: string[]; head: string }>('/api/instructions');
    expect(data.instructions.map(item => item.id)).toEqual(['no-secret-logs', 'no-em-dashes', 'retries-back-off-never-retry-4xx']);
    expect(data.errors).toEqual([]);
    expect(exampleMain().files['AGENTS.md']).toContain('- Never log webhook secrets. Blocked in `src/**`: `console.log(secret`.');
    const leak = (await call<ChangePage>('/api/changes?status=revise')).data.items.find(item => item.title === 'Log signature mismatches')!;
    expect(leak.label).toBe('Breaks an instruction');
    expect((await call<Change>(`/api/changes/${leak.id}`)).data.guards).toEqual([{ kind: 'instructions', path: 'src/verify.ts', detail: 'Adds "console.log(secret" to src/verify.ts at line 6, against "Never log webhook secrets".' }]);
    expect(await call('/api/instructions', { text: 'Less text' })).toEqual({ status: 409, data: { error: 'The recorded example keeps its instructions as recorded. Add instructions on your own repositories.' } });
  });
});

describe('the recorded example answers decisions', () => {
  it('lets a visitor approve a change that waits for them and watch it land without claiming checks ran', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { call } = await example();
    const waiting = (await call<ChangePage>('/api/changes?status=attention')).data;
    expect(waiting.items.length).toBeGreaterThan(0);
    const target = waiting.items[0];
    const before = (await call<TrunkStatus>('/api/queue')).data;

    const approved = await call<Change>(`/api/changes/${target.id}/approve`, { revision: target.revision });
    expect(approved).toMatchObject({ status: 200, data: { status: 'queued' } });
    expect((await call<ChangePage>('/api/changes?status=attention')).data.counts.attention).toBe(waiting.counts.attention - 1);

    vi.setSystemTime(Date.now() + 11_000);
    const landed = (await call<Change>(`/api/changes/${target.id}`)).data;
    expect(landed.status).toBe('landed');
    expect(landed.landedCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(landed.events.at(-1)!.message).toContain('No checks ran');
    const after = (await call<TrunkStatus>('/api/queue')).data;
    expect(after.stats.landed).toBe(before.stats.landed + 1);
    expect(after.recent[0]).toMatchObject({ status: 'landed', landed: [{ changeId: target.id }], note: expect.stringContaining('No checks ran') });
    expect(after.head).toBe(landed.landedCommit);
    // Landed work cannot be approved again.
    expect((await call(`/api/changes/${target.id}/approve`, { revision: target.revision })).status).toBe(409);
  });

  it('sends a change back with the visitor’s note, closes another, and keeps visitors apart', async () => {
    const { call } = await example();
    const waiting = (await call<ChangePage>('/api/changes?status=attention')).data.items;
    const target = waiting[0];
    expect((await call(`/api/changes/${target.id}/reviews`, { verdict: 'revise', revision: target.revision, summary: '' })).status).toBe(400);
    const sentBack = (await call<Change>(`/api/changes/${target.id}/reviews`, { verdict: 'revise', revision: target.revision, summary: 'Round half to even instead.' })).data;
    expect(sentBack).toMatchObject({ status: 'revise', sentBack: 'review', next: 'Sent back by you: Round half to even instead.' });
    expect(sentBack.reviews.at(-1)).toMatchObject({ kind: 'human', verdict: 'revise', summary: 'Round half to even instead.' });

    const open = (await call<ChangePage>('/api/changes?status=attention')).data.items[0];
    expect((await call<Change>(`/api/changes/${open.id}/close`, { reason: 'abandoned' })).data).toMatchObject({ status: 'closed', closeReason: 'abandoned' });

    // Submitting, revising and other writes stay unavailable in the example.
    expect((await call('/api/changes', { title: 'x' })).status).toBe(409);
    expect((await call(`/api/changes/${target.id}/reviews`, { verdict: 'approve', revision: target.revision, summary: 'ok' })).status).toBe(409);

    const other = await example('demo:visitor-two');
    expect((await other.call<Change>(`/api/changes/${target.id}`)).data.status).toBe('attention');
  });
});

describe('the completed recording', () => {
  it('keeps the final merges and their sandbox and GitHub evidence as recorded', async () => {
    const { call } = await example();
    const queue = (await call<TrunkStatus>('/api/queue')).data;
    expect(queue.landing).toBeUndefined();
    expect(queue).toMatchObject({ head: exampleMain().head, merging: [], queued: 0 });
    expect(queue.recent[0]).toMatchObject({ status: 'landed', head: queue.head });
    expect(queue.recent[0].landed.map(item => item.number).sort()).toEqual([36, 51]);
    for (const number of [36, 51]) {
      const change = (await call<Change>(`/api/changes/${number}`)).data;
      expect(change.status).toBe('landed');
      expect(change.policy!.requirements.every(requirement => requirement.satisfied)).toBe(true);
      expect(change.evidence).toEqual(expect.arrayContaining(['npm ci', 'npm run typecheck', 'npm test'].map(command =>
        expect.objectContaining({ kind: 'command', command, source: 'braid', exitCode: 0 }))));
      expect(change.checks).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'github', status: 'passed' })]));
      expect(change.reviews.map(review => review.reviewer)).toEqual(expect.arrayContaining(['github:coderabbitai[bot]', 'github:copilot-pull-request-reviewer[bot]']));
      expect(change.events.some(event => event.message.includes('No checks ran'))).toBe(false);
    }
    expect(JSON.stringify(queue)).not.toContain('No checks ran');
    expect((await call<ChangePage>('/api/changes?status=queued,landing')).data.items).toEqual([]);
  });

  it('holds the duplicate for a person, who closes it in favour of #51', async () => {
    const { call } = await example();
    const duplicate = (await call<Change>('/api/changes/73')).data;
    expect(duplicate).toMatchObject({ status: 'closed', closeReason: 'superseded', duplicates: [{ number: 51 }],
      policy: { requirements: expect.arrayContaining([expect.objectContaining({ id: 'duplicate', satisfied: false })]) } });
    expect(duplicate.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'overlap', message: 'Possible duplicate of #51 Add structured delivery logging.' })]));
    expect(duplicate.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'closed', message: '@maya-chen closed this pull request (superseded).', actor: '@maya-chen' })]));
    expect(duplicate.policy!.requirements.find(requirement => requirement.id === 'duplicate')!.detail).toBe("This pull request's intent closely matches open pull request #51; a person should decide whether both are needed.");
    expect(duplicate.comments).toEqual(expect.arrayContaining([expect.objectContaining({ body: expect.stringContaining('Duplicate of #51.'), author: expect.objectContaining({ kind: 'human' }) })]));
    expect(duplicate.landedCommit).toBeUndefined();
    expect(exampleMain().files['src/log.ts']).toContain('logAttempt');
    expect(exampleMain().files['src/logging.ts']).toBeUndefined();
    expect((await call<Change>('/api/changes/6')).data.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'overlap', message: expect.stringContaining('1 other active change touches') })]));
  });

  it('never advances an untouched copy as time passes, including across its cache hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const recording = await recordedExample(), state = { since: Date.now(), decisions: {}, changes: [] };
    const snapshot = () => ({ queue: recording.queue(state), changes: recording.changes({ limit: 100 }, state), branches: recording.branches(state), landings: recording.landings(state) });
    const before = snapshot();
    expect(before.landings).toEqual([]);
    for (const elapsed of [11_000, 60 * 60_000, 24 * 60 * 60_000]) {
      vi.setSystemTime(state.since + elapsed);
      expect(snapshot()).toEqual(before);
    }
  });
});

describe('one repository across the example', () => {
  it('lands the sample task as a change and keeps code, changes and landing on the same main', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = storageFixture();
    const workspace = new Workspace(db.ctx, {} as BraidEnv);
    await db.ready();
    const env = exampleEnv(workspace);
    const headers = { 'x-braid-mode': 'demo', 'x-braid-role': 'demo', 'x-braid-actor': 'Demo visitor', 'x-braid-repository': 'demo:visitor', 'content-type': 'application/json' };
    const visit = async <T>(path: string, body?: unknown) => {
      const response = await workspace.fetch(new Request(`https://braid.example${path}`, { method: body ? 'POST' : 'GET', headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined }));
      return { status: response.status, data: await response.json() as T };
    };
    const api = async <T>(path: string, body?: unknown) => {
      const response = (await changesRoute(new Request(`https://braid.example${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), env, { repository: 'demo:visitor', mode: 'demo', role: 'demo' }))!;
      return await response.json() as T;
    };
    let state = (await visit<WorkspaceSnapshot>('/api/state')).data;
    expect(state.project.head).toBe((await api<TrunkStatus>('/api/queue')).head);
    // Files that recorded changes landed are on the example's main, the merge group's too.
    expect(Object.keys(state.files)).toEqual(expect.arrayContaining(['src/billing/ledger.ts', 'swarm/registry.json', 'docs/receivers.md', 'src/log.ts']));
    expect(state.files['README.md']).toContain('## Retries');
    const [task] = state.missions;
    expect(task.collisions.map(collision => collision.path)).toEqual(['src/limits.ts']);

    expect((await visit(`/api/missions/${task.id}/resolve`, { collisionId: task.collisions[0].id, agentId: 'sable' })).status).toBe(200);
    const landing = await visit<{ change: { id: string; number: number } }>(`/api/missions/${task.id}/merge`, {});
    expect(landing.status).toBe(202);
    const { number } = landing.data.change;
    expect(number).toBeGreaterThan(Math.max(...(await api<ChangePage>('/api/changes?status=landed&limit=100')).items.filter(item => item.number !== number).map(item => item.number)));
    expect(await api<Change>(`/api/changes/${number}`)).toMatchObject({ status: 'queued', taskId: task.id, author: { name: 'Claude Opus 5.5, GPT-6.1 Sol and Gemini 3 Pro', owner: { name: 'Maya Chen', github: 'maya-chen' } } });
    expect((await api<{ after: string }>(`/api/changes/${number}/diff?path=src/limits.ts`)).after).toContain('class RateLimited');

    vi.setSystemTime(Date.now() + 11_000);
    expect((await api<Change>(`/api/changes/${number}`)).status).toBe('landed');
    state = (await visit<WorkspaceSnapshot>('/api/state')).data;
    expect(state.missions[0]).toMatchObject({ status: 'merged' });
    expect(state.files['src/limits.ts']).toContain('class RateLimited');
    expect(state.files['src/delivery.ts']).toContain('await acquire(url);');
    const contextDir = `.braid/missions/${task.id}/`;
    expect(Object.keys(state.files).filter(path => path.startsWith(contextDir)).sort()).toEqual([
      'claude-opus-5-5.md', 'decision.json', 'gemini-3-pro.md', 'gpt-6-1-sol.md', 'handoff.md',
    ].map(file => contextDir + file));
    expect(state.files[`${contextDir}gpt-6-1-sol.md`]).toMatch(/^# GPT-6.1 Sol\n/);
    expect(state.project.head).toBe((await api<TrunkStatus>('/api/queue')).head);

    // Answering a recorded change lands it on the same main.
    const refund = (await api<ChangePage>('/api/changes?status=attention')).items.find(item => item.title === 'Round refund amounts in the ledger')!;
    await api(`/api/changes/${refund.id}/approve`, { revision: refund.revision });
    vi.setSystemTime(Date.now() + 11_000);
    state = (await visit<WorkspaceSnapshot>('/api/state')).data;
    expect(state.files['src/billing/ledger.ts']).toContain('Math.round');
    expect(state.files['src/limits.ts']).toContain('class RateLimited');
    expect(state.project.head).toBe((await api<TrunkStatus>('/api/queue')).head);

    // Blame follows what landed: the lines each landing changed are its pull request's, on the same main.
    const queue = await api<TrunkStatus>('/api/queue');
    const ledger = await api<FileBlame>('/api/blame?path=src/billing/ledger.ts');
    expect(ledger).toMatchObject({ ref: queue.head, lines: state.files['src/billing/ledger.ts'].trimEnd().split('\n').length });
    expect(ledger.ranges.reduce((sum, range) => sum + range.lines, 0)).toBe(ledger.lines);
    expect(ledger.ranges.find(range => range.provenance.change?.number === refund.number)!.provenance).toMatchObject({ kind: 'agent', agent: { name: 'GPT-6 Astra' }, owner: { github: 'lena-park' }, confidence: 'braid' });
    const limits = await api<FileBlame>('/api/blame?path=src/limits.ts');
    expect(limits.ranges).toEqual([expect.objectContaining({ start: 1, lines: limits.lines, provenance: expect.objectContaining({ change: expect.objectContaining({ number }) }) })]);
    expect(limits.ranges[0].provenance).toMatchObject({ agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' }, owner: { github: 'maya-chen' }, confidence: 'braid' });
    expect(limits.ranges[0].provenance.agent?.session).toBeUndefined();
    const delivery = await api<FileBlame>('/api/blame?path=src/delivery.ts');
    const added = delivery.ranges.filter(range => range.provenance.change?.number === number);
    expect(added.reduce((sum, range) => sum + range.lines, 0)).toBe(2);
    expect(added.every(range => range.provenance.agent?.model === 'gpt-6.1-sol')).toBe(true);
    const docs = await api<FileBlame>('/api/blame?path=docs/receivers.md');
    expect(docs.ranges.filter(range => range.provenance.change?.number === number).every(range => range.provenance.agent?.model === 'gemini-3-pro')).toBe(true);
    const [commit] = await api<Provenance[]>(`/api/provenance?commits=${limits.ranges[0].provenance.commit}`);
    expect(commit).toMatchObject({ subject: 'Limit deliveries per endpoint', agent: { name: 'Claude Opus 5.5, GPT-6.1 Sol and Gemini 3 Pro' }, owner: { name: 'Maya Chen', github: 'maya-chen' } });
  });
});

describe('the example task after main moved', () => {
  it('still merges onto main as it is now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = storageFixture();
    const workspace = new Workspace(db.ctx, {} as BraidEnv);
    await db.ready();
    const env = exampleEnv(workspace);
    const headers = { 'x-braid-mode': 'demo', 'x-braid-role': 'demo', 'x-braid-actor': 'Demo visitor', 'x-braid-repository': 'demo:visitor-moved', 'content-type': 'application/json' };
    const visit = async <T>(path: string, body?: unknown) => {
      const response = await workspace.fetch(new Request(`https://braid.example${path}`, { method: body ? 'POST' : 'GET', headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined }));
      return { status: response.status, data: await response.json() as T };
    };
    const api = async <T>(path: string, body?: unknown) => (await (await changesRoute(new Request(`https://braid.example${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), env, { repository: 'demo:visitor-moved', mode: 'demo', role: 'demo' }))!.json()) as T;
    const refund = (await api<ChangePage>('/api/changes?status=attention')).items.find(item => item.title === 'Round refund amounts in the ledger')!;
    await api(`/api/changes/${refund.id}/approve`, { revision: refund.revision });
    vi.setSystemTime(Date.now() + 11_000);
    const state = (await visit<WorkspaceSnapshot>('/api/state')).data;
    const [task] = state.missions;
    expect(state.project.head).not.toBe(task.baseCommit);
    expect(isStale(task, state.project.head)).toBe(false);
    expect((await visit(`/api/missions/${task.id}/resolve`, { collisionId: task.collisions[0].id, agentId: 'sable' })).status).toBe(200);
    const preview = (await visit<{ ready: boolean; blocker: string | null; fingerprint: string }>(`/api/missions/${task.id}/integration`)).data;
    expect(preview).toMatchObject({ ready: true, blocker: null });
    expect((await visit(`/api/missions/${task.id}/merge`, { reviewed: preview.fingerprint })).status).toBe(202);
  });
});

describe('the recorded example says who wrote each line', () => {
  it('serves blame, provenance and the fleet roster as the landing queue recorded them', async () => {
    const { call } = await example();
    const blame = (await call<FileBlame>(`/api/blame?path=${encodeURIComponent('src/delivery.ts')}`)).data;
    expect(blame).toMatchObject({ path: 'src/delivery.ts', ref: (await call<TrunkStatus>('/api/queue')).data.head, lines: exampleMain().files['src/delivery.ts'].trimEnd().split('\n').length });
    expect(blame.ranges.reduce((sum, range) => sum + range.lines, 0)).toBe(blame.lines);
    // Several agents wrote it, each by its model with the person who owns it; Braid's records say so with confidence braid.
    const agents = blame.ranges.filter(range => range.provenance.kind === 'agent').map(range => range.provenance);
    expect(new Set(agents.map(item => item.agent!.name))).toEqual(new Set(['Claude Opus 5.5', 'GPT-6.1 Sol']));
    expect(agents.every(item => item.confidence === 'braid' && item.owner && item.agent!.tool && item.agent!.session && item.change)).toBe(true);
    const readme = (await call<FileBlame>('/api/blame?path=README.md')).data;
    expect(readme.ranges.find(range => range.provenance.kind === 'agent')!.provenance).toMatchObject({ agent: { name: 'Claude Fable 5.1', model: 'claude-fable-5-1' }, owner: { name: 'Lena Park' } });
    expect((await call('/api/blame?path=missing.ts')).status).toBe(404);
    const commits = [...new Set(blame.ranges.map(range => range.provenance.commit))];
    expect((await call<Provenance[]>(`/api/provenance?commits=${commits.join(',')}`)).data.map(item => item.commit)).toEqual(commits);
    const roster = (await call<AgentRecord[]>('/api/agents')).data;
    expect(roster.filter(record => !record.simulated).map(record => record.name).sort()).toEqual(['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-6 Astra', 'GPT-6.1 Sol', 'Gemini 3 Pro']);
    // Simulated agents stay labelled, as one row for their run's owner.
    expect(roster.filter(record => record.simulated)).toEqual([expect.objectContaining({ name: 'Simulated', models: ['simulated'], owner: expect.objectContaining({ name: 'Maya Chen' }) })]);
    // A record's pull requests come from the server, by the same grouping.
    const opus = roster.find(record => record.name === 'Claude Opus 5.5')!;
    expect(opus.authors).toEqual(['agent:maya-claude-code']);
    const mine = (await call<ChangePage>(`/api/changes?agent=${encodeURIComponent(opus.id)}&limit=100`)).data;
    expect(mine.items.map(item => item.title).sort()).toEqual(['Parse Retry-After before retrying', 'Retry network errors and 5xx responses']);
    const simulated = roster.find(record => record.simulated)!, swarm = (await call<ChangePage>(`/api/changes?agent=${encodeURIComponent(simulated.id)}&limit=100`)).data;
    expect(swarm.items.every(item => item.author.kind === 'simulated')).toBe(true);
    expect(new Set(swarm.items.map(item => item.author.id))).toEqual(new Set(simulated.authors));
    for (const record of roster) expect(record.lines.alive).toBeLessThanOrEqual(record.lines.added);
  });
});

describe('recorded stack overlay', () => {
  it('preserves the recorded numbers and updates the reverse link after a visitor closes the dependent', async () => {
    const { call } = await example();
    const parent = (await call<Change>('/api/changes/5')).data;
    const child = (await call<Change>('/api/changes/12')).data;
    expect(parent).toMatchObject({ number: 5, status: 'landed', requiredBy: [{ id: child.id, number: 12, status: child.status }], stack: { position: 1, total: 2 } });
    expect(child).toMatchObject({ number: 12, dependsOn: [{ id: parent.id, number: 5, status: 'landed' }], stack: { position: 2, total: 2 } });
    expect((await call<ChangePage>('/api/changes?status=revise&limit=100')).data.items.find(item => item.id === child.id)?.stack).toEqual({ position: 2, total: 2 });
    await call('/api/changes/12/close', { reason: 'abandoned' });
    expect((await call<Change>('/api/changes/5')).data.requiredBy?.[0].status).toBe('closed');
    expect((await call<TrunkStatus>('/api/queue')).data.stacks?.[0].map(item => item.number)).toEqual([5, 12]);
  });
});
