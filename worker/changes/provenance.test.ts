import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changeHarness } from '../test/changes-harness';
import { fakeGitHub } from '../test/fake-github';
import { agentRoster, listChanges } from './router';
import { parseNote, provenanceOf } from '../../shared/provenance';
import type { Actor } from './shard';
import type { Change, FileBlame } from '../../shared/types';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.unstubAllGlobals(); await harness?.close(); harness = undefined; });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};

const router = ['export const routes = [', "  '/health',", '];', '', 'export function handle(path: string) {', '  return routes.includes(path);', '}', ''].join('\n');
const ishaan = { id: 'user:u-ishaan', name: 'Ishaan', email: '12345+theg1239@users.noreply.github.com', github: 'theg1239' };
const maya = { id: 'user:u-maya', name: 'maya' };
const claude: Actor = { kind: 'agent', id: 'agent:conn-claude', name: 'Laptop agent', model: 'claude-opus-5-5', owner: ishaan };
const codex: Actor = { kind: 'agent', id: 'agent:conn-codex', name: 'CI agent', model: 'gpt-6.1-sol', owner: maya };
const person: Actor = { kind: 'owner', id: 'user:u-maya', name: 'maya@relay.dev', owner: maya };

async function setup(files: Record<string, string> = {}) {
  harness = await changeHarness();
  const root = harness.git.commitTree({ 'src/router.ts': router, 'README.md': '# Relay\n\nDelivers webhooks.\n', ...files }, undefined, 'Start Relay');
  harness.git.native(['update-ref', 'refs/heads/main', root]);
  await harness.trunk.configure(harness.repository, { enabled: true, actor: 'maya@relay.dev' });
  return { harness, root };
}
async function land(h: NonNullable<typeof harness>, actor: Actor, body: Record<string, unknown>): Promise<Change> {
  const submitted = ok(await h.submit(actor, { baseCommit: h.head(), ...body }));
  await h.settle();
  const landed = ok(await h.shard(parseInt(submitted.id[3], 16)).get(submitted.id));
  expect(landed.status).toBe('landed');
  return landed;
}
const lineOwners = (blame: FileBlame) => blame.ranges.map(range => [range.start, range.lines, range.provenance.kind === 'agent' ? range.provenance.agent!.name : range.provenance.subject, range.provenance.confidence]);

describe('provenance in landed commits', () => {
  it('reads an imported Braid note for both provenance and blame without upgrading it to witnessed', async () => {
    const { harness, root } = await setup();
    harness.git.native(['notes', '--ref=braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8.0', session: 's_imported' }, owner: { name: 'Ishaan', github: 'theg1239' } }), root]);
    expect(await harness.trunk.provenance(harness.repository, [root])).toMatchObject([{ kind: 'agent', confidence: 'trailers', agent: { model: 'gpt-6.1-sol', session: 's_imported' } }]);
    expect(ok(await harness.trunk.blame(harness.repository, 'src/router.ts')).ranges).toMatchObject([{ provenance: { kind: 'agent', confidence: 'trailers', agent: { model: 'gpt-6.1-sol' } } }]);
  }, 60_000);

  it.each([0, 2, 6])('seeds blame directly from an imported note with %i fan-out characters', async (fanout) => {
    const { harness, root } = await setup();
    const path = [...(root.slice(0, fanout).match(/../g) ?? []), root.slice(fanout)].join('/');
    const notes = harness.git.commitTree({ [path]: JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', session: 's_imported' }, owner: { name: 'Ishaan', github: 'theg1239' } }) }, undefined, 'Imported notes');
    harness.git.native(['update-ref', 'refs/notes/braid', notes]);
    // Blame must read the note itself, without a provenance request having populated its cache first.
    expect(ok(await harness.trunk.blame(harness.repository, 'src/router.ts')).ranges).toMatchObject([{ provenance: { kind: 'agent', confidence: 'trailers', agent: { model: 'gpt-6.1-sol', session: 's_imported' } } }]);
    expect(await harness.trunk.provenance(harness.repository, [root])).toMatchObject([{ kind: 'agent', confidence: 'trailers', agent: { session: 's_imported' } }]);
  }, 60_000);

  it('ignores invalid imported notes and keeps witnessed attribution authoritative over a replaced note', async () => {
    const { harness, root } = await setup();
    harness.git.native(['notes', '--ref=braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 42 } }), root]);
    expect(await harness.trunk.provenance(harness.repository, [root])).toMatchObject([{ kind: 'human', confidence: 'inferred' }]);
    const landed = await land(harness, claude, { title: 'Add metrics', summary: 'Adds /metrics.', files: [{ path: 'src/router.ts', content: router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n") }] });
    harness.git.native(['notes', '--ref=braid', 'add', '--force', '-m', JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' } }), landed.landedCommit!]);
    expect(await harness.trunk.provenance(harness.repository, [landed.landedCommit!])).toMatchObject([{ kind: 'agent', confidence: 'braid', agent: { model: 'claude-opus-5-5' } }]);
    expect(ok(await harness.trunk.blame(harness.repository, 'src/router.ts')).ranges.find(range => range.start === 3)?.provenance).toMatchObject({ confidence: 'braid', agent: { model: 'claude-opus-5-5' } });
  }, 60_000);

  it("lands an agent's change as its owner's commit with the change's own message, and everything else in a note", async () => {
    const { harness } = await setup();
    const submitted = ok(await harness.submit(claude, { title: 'Add a metrics route', summary: 'Adds GET /metrics for load balancers.', baseCommit: harness.head(),
      files: [{ path: 'src/router.ts', content: router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n") }], agent: { tool: 'claude-code/2.4.1', session: 's_42', parentSession: 's_1' } }));
    // The agent goes by its model; its connection's label is not a name.
    expect(submitted.author).toEqual({ kind: 'agent', id: 'agent:conn-claude', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', owner: ishaan, tool: 'claude-code/2.4.1', session: 's_42', parentSession: 's_1' });
    await harness.settle();
    const landed = ok(await harness.shard(parseInt(submitted.id[3], 16)).get(submitted.id));
    const commit = landed.landedCommit!;
    // Braid adds nothing to the message: no co-author, no trailers.
    expect(harness.git.native(['log', '-1', '--format=%B', commit]).trimEnd()).toBe('Add a metrics route\n\nAdds GET /metrics for load balancers.');
    expect(harness.git.native(['show', '-s', '--format=%an <%ae>|%cn <%ce>', commit]).trim()).toBe('Ishaan <12345+theg1239@users.noreply.github.com>|Braid <agents@braid.local>');
    const noteText = harness.git.native(['notes', '--ref=braid', 'show', commit]);
    expect(JSON.parse(noteText)).toEqual({
      v: 1, agent: { id: 'agent:conn-claude', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.4.1', session: 's_42', parentSession: 's_1' },
      owner: { name: 'Ishaan', github: 'theg1239' }, change: { id: submitted.id, number: submitted.number, revision: 1 }, approvedBy: 'braid-reviewer:@cf/test/reviewer',
    });
    // Read back from Git alone, the commit and its note give the same answer at confidence trailers.
    const facts = (await harness.git.repository.readCommit(commit))!;
    const fromGit = provenanceOf({ id: facts.hash, at: new Date(facts.authoredAt * 1000).toISOString(), author: facts.author, message: facts.message }, parseNote(noteText));
    expect(fromGit).toEqual({ commit, at: expect.any(String), subject: 'Add a metrics route', kind: 'agent', confidence: 'trailers',
      agent: { id: 'agent:conn-claude', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.4.1', session: 's_42', parentSession: 's_1' },
      owner: { name: 'Ishaan', github: 'theg1239', email: ishaan.email }, change: { id: submitted.id, number: submitted.number } });
    // Braid's own record outranks what the commit says.
    expect(await harness.trunk.provenance(harness.repository, [commit])).toEqual([{ commit, at: expect.any(String), subject: 'Add a metrics route', kind: 'agent', confidence: 'braid',
      agent: { id: 'agent:conn-claude', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.4.1', session: 's_42', parentSession: 's_1' }, owner: ishaan, change: { id: submitted.id, number: submitted.number } }]);
  }, 60_000);

  it("authors a person's own change by their stable Braid address, and keeps the co-author lines a change's commits carried, once each", async () => {
    const { harness, root } = await setup();
    const docs = await land(harness, person, { title: 'Describe retries', summary: 'Explains how Relay retries.', files: [{ path: 'README.md', content: '# Relay\n\nDelivers webhooks, retrying 5xx.\n' }] });
    expect(harness.git.native(['show', '-s', '--format=%an <%ae>%n%B', docs.landedCommit!]).trim()).toMatch(/^maya <[a-f0-9]{32}@people\.braid\.local>\nDescribe retries\n\nExplains how Relay retries\.$/);
    expect(JSON.parse(harness.git.native(['notes', '--ref=braid', 'show', docs.landedCommit!]))).toEqual({ v: 1, owner: { name: 'maya' }, change: { id: docs.id, number: docs.number, revision: 1 }, approvedBy: 'braid-reviewer:@cf/test/reviewer' });
    // Co-author lines the agent's commits carried pass through verbatim, without repeating an address.
    const credited = await land(harness, claude, { title: 'Trim paths', summary: 'Trims paths.', files: [{ path: 'src/router.ts', content: router.replace('includes(path)', 'includes(path.trim())') }],
      coAuthors: ['Claude Opus 4.7 <noreply@anthropic.com>', 'Claude <NOREPLY@anthropic.com>', 'Alice Doe <alice@example.com>'] });
    expect(harness.git.native(['log', '-1', '--format=%B', credited.landedCommit!]).trimEnd()).toBe('Trim paths\n\nTrims paths.\n\nCo-authored-by: Claude Opus 4.7 <noreply@anthropic.com>\nCo-authored-by: Alice Doe <alice@example.com>');
    // A summary that already ends with one keeps it as written, and an equivalent line is not added again.
    const tagged = await land(harness, claude, { title: 'Trim more', summary: 'Trims more.\n\nCo-Authored-By: Claude <noreply@anthropic.com>', files: [{ path: 'src/router.ts', content: router.replace('includes(path)', 'includes(path.trimEnd())') }],
      coAuthors: ['Claude Opus 5.5 <noreply@anthropic.com>', 'Alice Doe <alice@example.com>'] });
    expect(harness.git.native(['log', '-1', '--format=%B', tagged.landedCommit!]).trimEnd()).toBe('Trim more\n\nTrims more.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: Alice Doe <alice@example.com>');
    // Commits Braid did not land are read from Git; unknown ones are left out.
    expect(await harness.trunk.provenance(harness.repository, [root, 'f'.repeat(40)])).toEqual([{ commit: root, at: expect.any(String), subject: 'Start Relay', kind: 'human', owner: { name: 'Test', email: 'test@example.test' }, confidence: 'inferred' }]);
  }, 60_000);
});

describe('provenance across revisions', () => {
  it('serializes pushes to one topic and recognises an older push retry after another revision', async () => {
    const { harness, root } = await setup();
    const context = harness.context(claude, 0);
    const body = (content: string) => ({ title: 'Trim paths', summary: 'Trims.', baseCommit: root, files: [{ path: 'src/router.ts', content }] });
    const firstBody = body(router.replace('includes(path)', 'includes(path.trim())'));
    const secondBody = body(router.replace('includes(path)', 'includes(path.trimEnd())'));
    const firstCommit = harness.git.commitTree({ 'src/router.ts': firstBody.files[0].content }, root, 'Trim paths');
    const secondCommit = harness.git.commitTree({ 'src/router.ts': secondBody.files[0].content }, root, 'Trim trailing whitespace');
    const [first, second] = (await Promise.all([
      harness.shard(0).push(context, { topic: 'paths', commit: firstCommit }, firstBody),
      harness.shard(0).push(context, { topic: 'paths', commit: secondCommit }, secondBody),
    ])).map(ok);
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    const retried = ok(await harness.shard(0).push(context, { topic: 'paths', commit: firstCommit }, firstBody));
    expect(retried.id).toBe(first.id);
    expect(retried.revision).toBe(2);
    expect(retried.summary).toBe(second.summary);
  }, 60_000);

  it('takes the new run of each revision its agent sends, keeps the last one otherwise, and keeps the owner', async () => {
    const { harness } = await setup();
    // This agent's token names no model; each revision says which one it ran.
    const codex: Actor = { kind: 'agent', id: 'agent:conn-runner', name: 'Runner', owner: maya };
    const first = ok(await harness.submit(codex, { title: 'Trim paths', model: 'gpt-6.1-sol', summary: 'Trims.', baseCommit: harness.head(), files: [{ path: 'src/router.ts', content: router.replace('includes(path)', 'includes(path.trim())') }], agent: { tool: 'codex/1.8.0', session: 's_1' } }));
    const index = parseInt(first.id[3], 16);
    const revise = (actor: Actor, revision: number, extra: Record<string, unknown>) => harness.shard(index).revise(harness.context(actor, index), first.id,
      { summary: 'Trims again.', baseCommit: harness.head(), previousRevision: revision, files: [{ path: 'src/router.ts', content: router.replace('includes(path)', `includes(path.trim()) /* ${revision} */`) }], ...extra }, `revise-provenance-${revision}-padding`);
    expect(ok(await revise(codex, 1, { model: 'gpt-6-astra', agent: { tool: 'codex/1.9.0', session: 's_2', parentSession: 's_1' } })).author)
      .toEqual({ kind: 'agent', id: codex.id, name: 'GPT-6 Astra', model: 'gpt-6-astra', owner: maya, tool: 'codex/1.9.0', session: 's_2', parentSession: 's_1' });
    expect(ok(await revise(codex, 2, {})).author).toMatchObject({ model: 'gpt-6-astra', tool: 'codex/1.9.0', session: 's_2', parentSession: 's_1', owner: maya });
    // A person revising someone's change does not become its author.
    expect(ok(await revise(person, 3, { agent: { session: 's_9' } })).author).toMatchObject({ id: codex.id, session: 's_2', owner: maya });
  }, 60_000);
});

describe('notes Braid could not write yet', () => {
  it('keeps them pending without holding up the landing, and writes them on a later alarm', async () => {
    const { harness } = await setup();
    const hook = join(harness.git.root, 'repo.git', 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/notes/braid" ]; then echo "notes refused"; exit 1; fi; done\n');
    chmodSync(hook, 0o755);
    const landed = await land(harness, claude, { title: 'Add a metrics route', summary: 'Adds /metrics.', files: [{ path: 'src/router.ts', content: router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n") }] });
    expect(() => harness.git.native(['notes', '--ref=braid', 'show', landed.landedCommit!])).toThrow();
    rmSync(hook);
    await harness.trunk.alarm();
    expect(JSON.parse(harness.git.native(['notes', '--ref=braid', 'show', landed.landedCommit!]))).toMatchObject({ change: { id: landed.id, number: landed.number } });
  }, 60_000);
});

describe('blame and the fleet roster', () => {
  it('restarts a blame read when a landing moves its map while history is being read', async () => {
    const { harness, root } = await setup();
    let resume!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const original = harness.git.repository.log.bind(harness.git.repository);
    let paused = false;
    vi.spyOn(harness.git.repository, 'log').mockImplementation(async options => {
      if (options.ref === root && !paused) { paused = true; entered(); await waiting; }
      return original(options);
    });
    const pending = harness.trunk.blame(harness.repository, 'src/router.ts');
    await reading;
    const metrics = await land(harness, claude, { title: 'Add metrics', summary: 'Adds /metrics.', files: [{ path: 'src/router.ts', content: router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n") }] });
    resume();
    const result = ok(await pending);
    expect(result.ref).toBe(harness.head());
    expect(result.lines).toBe(8);
    expect(result.ranges.find(range => range.start === 3)?.provenance.commit).toBe(metrics.landedCommit);
    expect(ok(await harness.trunk.blame(harness.repository, 'src/router.ts')).ranges).toEqual(result.ranges);
    expect(await harness.trunk.agentLines(harness.repository)).toEqual({ [JSON.stringify(['claude-opus-5-5', 'user:u-ishaan', ''])]: { added: 1, alive: 1 } });
  }, 60_000);

  it('moves each file\'s lines as changes land, attributes older lines from history, and counts what each agent still has on main', async () => {
    const { harness, root } = await setup({ 'src/old.ts': 'export const old = 1;\n' });
    // A person's commit outside Braid changes one line before Braid lands anything.
    const outside = harness.git.commitTree({ 'src/router.ts': router.replace('routes.includes(path)', 'routes.includes(path) || path === "/"') }, root, 'Allow the root path');
    harness.git.native(['update-ref', 'refs/heads/main', outside]);
    const metrics = await land(harness, claude, { title: 'Add a metrics route', summary: 'Adds /metrics.', files: [{ path: 'src/router.ts', content: router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n").replace('routes.includes(path)', 'routes.includes(path) || path === "/"') }] });
    const readme = await land(harness, codex, { title: 'Document metrics', summary: 'Documents /metrics.', agent: { tool: 'codex/1.8.0' },
      files: [{ path: 'README.md', content: '# Relay\n\nDelivers webhooks.\n\nScrape /metrics for delivery counts.\n' }, { path: 'src/old.ts', content: null }] });

    const routerBlame = ok(await harness.trunk.blame(harness.repository, 'src/router.ts'));
    expect(routerBlame).toMatchObject({ path: 'src/router.ts', ref: harness.head(), lines: 8 });
    expect(lineOwners(routerBlame)).toEqual([[1, 2, 'Start Relay', 'inferred'], [3, 1, 'Claude Opus 5.5', 'braid'], [4, 3, 'Start Relay', 'inferred'], [7, 1, 'Allow the root path', 'inferred'], [8, 1, 'Start Relay', 'inferred']]);
    expect(routerBlame.note).toBeUndefined();
    expect(routerBlame.ranges[1].provenance).toMatchObject({ commit: metrics.landedCommit, change: { number: metrics.number }, owner: { github: 'theg1239' } });
    const readmeBlame = ok(await harness.trunk.blame(harness.repository, 'README.md'));
    expect(lineOwners(readmeBlame)).toEqual([[1, 3, 'Start Relay', 'inferred'], [4, 2, 'GPT-6.1 Sol', 'braid']]);
    expect(readmeBlame.note).toBeUndefined();
    expect(await harness.trunk.blame(harness.repository, 'src/old.ts')).toMatchObject({ ok: false, status: 404 });

    // A later change rewrites the line the first agent added.
    await land(harness, codex, { title: 'Rename metrics', summary: 'Serves /stats.', agent: { tool: 'codex/1.8.0' }, files: [{ path: 'src/router.ts', content: harness.git.native(['show', 'main:src/router.ts']).replace("'/metrics'", "'/stats'") }] });
    expect(lineOwners(ok(await harness.trunk.blame(harness.repository, 'src/router.ts')))).toEqual([[1, 2, 'Start Relay', 'inferred'], [3, 1, 'GPT-6.1 Sol', 'braid'], [4, 3, 'Start Relay', 'inferred'], [7, 1, 'Allow the root path', 'inferred'], [8, 1, 'Start Relay', 'inferred']]);
    const roster = await agentRoster(harness.env, harness.repository);
    expect(roster.map(record => [record.name, record.owner?.name, record.changes.landed, record.lines])).toEqual([
      ['GPT-6.1 Sol', 'maya', 2, { added: 3, alive: 3 }],
      ['Claude Opus 5.5', 'Ishaan', 1, { added: 1, alive: 0 }],
    ]);
    expect(roster[0]).toMatchObject({ id: JSON.stringify(['gpt-6.1-sol', 'user:u-maya', 'codex']), models: ['gpt-6.1-sol'], tools: ['codex/1.8.0'], authors: ['agent:conn-codex'], changes: { sentBack: 0, reverted: 0, open: 0 } });
    // The list filters by the same record on the server, paging and counting as other filters do.
    const mine = await listChanges(harness.env, harness.repository, { agent: roster[1].id, limit: 10 });
    expect(mine).toMatchObject({ items: [{ title: 'Add a metrics route', author: { id: claude.id } }], nextCursor: null, counts: { landed: 3 } });
    expect((await listChanges(harness.env, harness.repository, { agent: roster[0].id, limit: 1 })).nextCursor).not.toBeNull();
    expect(readme.landedCommit).toBeTruthy();
  }, 90_000);

  it('says so when a file is over the line cap', async () => {
    const big = Array.from({ length: 20_001 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const { harness, root } = await setup({ 'data/big.txt': big });
    expect(ok(await harness.trunk.blame(harness.repository, 'data/big.txt'))).toMatchObject({ lines: 20_001, ranges: [{ start: 1, lines: 20_001, provenance: { commit: root } }],
      note: 'Braid blames files of up to 20,000 lines line by line. This one has 20,001, so it is attributed to the last commit that changed it.' });
  }, 60_000);

  it('answers a big file whose history could not be read with a retry, never with a later commit', async () => {
    const big = Array.from({ length: 20_001 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const { harness, root } = await setup({ 'data/big.txt': big });
    const head = harness.git.commitTree({ 'README.md': '# Relay\n\nDelivers webhooks quickly.\n' }, root, 'Reword the readme');
    harness.git.native(['update-ref', 'refs/heads/main', head]);
    const readCommit = harness.git.repository.readCommit.bind(harness.git.repository);
    const failing = vi.spyOn(harness.git.repository, 'readCommit').mockImplementation(async hash => {
      if (hash === root) throw new Error('Artifacts is unavailable.');
      return readCommit(hash);
    });
    expect(await harness.trunk.blame(harness.repository, 'data/big.txt')).toMatchObject({ ok: false, status: 503 });
    failing.mockRestore();
    expect(ok(await harness.trunk.blame(harness.repository, 'data/big.txt')).ranges).toMatchObject([{ start: 1, lines: 20_001, provenance: { commit: root } }]);
  }, 60_000);
});

describe('provenance on GitHub', () => {
  async function linked(mode: 'pull-requests' | 'mirror') {
    harness = await changeHarness();
    const github = fakeGitHub({ root: harness.git.root, gitOrigin: harness.git.remote.replace(/\/repo\.git$/, '') });
    Object.assign(harness.env, github.env);
    // History Braid never saw: a person's first commit, then one Claude Code co-authored.
    const root = harness.git.commitTree({ 'src/router.ts': router, 'README.md': '# Relay\n' }, undefined, 'Start Relay');
    const assisted = harness.git.commitTree({ 'src/router.ts': router.replace('routes.includes(path)', "routes.includes(path.replace(/\\/$/, ''))") }, root,
      'Accept trailing slashes\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>');
    harness.git.native(['update-ref', 'refs/heads/main', assisted]);
    execFileSync('git', ['--git-dir', github.path, 'fetch', '--quiet', `${harness.git.root}/repo.git`, 'main:main']);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'maya@relay.dev' });
    expect(await harness.trunk.linkGitHub(harness.repository, github.link(mode))).toMatchObject({ ok: true });
    return { harness, github };
  }
  /** Reads the landing pull request's gate again at once, as a webhook would. */
  async function wake(h: NonNullable<typeof harness>, rounds = 3) {
    for (let round = 0; round < rounds; round++) {
      await h.trunk.githubEvent(h.repository, { name: 'check_suite', sha: (await h.trunk.status(h.repository)).landing?.head });
      await h.settle(1);
    }
  }

  it('reads imported notes while seeding ranges from GitHub blame', async () => {
    const { harness, github } = await linked('pull-requests');
    const assisted = harness.head();
    harness.git.native(['notes', '--ref=braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', session: 's_imported' }, owner: { name: 'Ishaan', github: 'theg1239' } }), assisted]);
    const blame = ok(await harness.trunk.blame(harness.repository, 'src/router.ts'));
    expect(github.state.graphql).toBeGreaterThan(0);
    expect(blame.ranges.find(range => range.start === 6)?.provenance).toMatchObject({ kind: 'agent', confidence: 'trailers', agent: { model: 'gpt-6.1-sol', session: 's_imported' } });
  }, 60_000);

  it('pushes the notes to GitHub with the commits and attributes older lines from GitHub\'s blame', async () => {
    const { harness, github } = await linked('pull-requests');
    const submitted = ok(await harness.submit(claude, { title: 'Add a metrics route', summary: 'Adds /metrics.', baseCommit: harness.head(), coAuthors: ['Claude Opus 5.5 <noreply@anthropic.com>'],
      files: [{ path: 'src/router.ts', content: harness.git.native(['show', 'main:src/router.ts']).replace("  '/health',\n", "  '/health',\n  '/metrics',\n") }] }));
    const docs = ok(await harness.submit(person, { title: 'Describe metrics', summary: 'Documents /metrics.', baseCommit: harness.head(), files: [{ path: 'README.md', content: '# Relay\n\nScrape /metrics.\n' }] }));
    await harness.settle(2);
    await wake(harness);
    // The landing pull request says who made each change and links it to Braid; the commits stay as they were.
    const described = github.pulls.map(pull => pull.body).join('\n');
    expect(described).toContain(`| [#${submitted.number}](https://braid.example/pull/${submitted.number}) Add a metrics route | Claude Opus 5.5 for [theg1239](https://github.com/theg1239) |`);
    // A profile link, not an @mention, so owners are not notified on every merge-queue pull request.
    expect(described).not.toContain('@theg1239');
    expect(described).toContain(`| [#${docs.number}](https://braid.example/pull/${docs.number}) Describe metrics | maya |`);
    const landed = ok(await harness.shard(parseInt(submitted.id[3], 16)).get(submitted.id));
    expect(landed.status).toBe('landed');
    expect(github.git(['rev-parse', 'main']).trim()).toBe(harness.head());
    expect(JSON.parse(github.git(['notes', '--ref=braid', 'show', landed.landedCommit!]))).toMatchObject({ v: 1, agent: { model: 'claude-opus-5-5' }, change: { number: submitted.number } });
    // The co-author line the agent's commit carried reaches GitHub as it was.
    expect(github.git(['log', '-1', '--format=%an|%(trailers:key=Co-authored-by,valueonly)', landed.landedCommit!]).trim()).toBe('Ishaan|Claude Opus 5.5 <noreply@anthropic.com>');
    const blame = ok(await harness.trunk.blame(harness.repository, 'src/router.ts'));
    expect(github.state.graphql).toBeGreaterThan(0);
    expect(lineOwners(blame)).toEqual([[1, 2, 'Start Relay', 'inferred'], [3, 1, 'Claude Opus 5.5', 'braid'], [4, 3, 'Start Relay', 'inferred'], [7, 1, 'Claude Opus 4.7', 'inferred'], [8, 1, 'Start Relay', 'inferred']]);
    expect(blame.ranges[3].provenance).toMatchObject({ kind: 'agent', agent: { name: 'Claude Opus 4.7' }, owner: { name: 'Test' } });
    expect(blame.note).toBeUndefined();
  }, 90_000);

  it('keeps line-level Git history when GitHub cannot be asked', async () => {
    const { harness, github } = await linked('pull-requests');
    github.state.graphqlDown = true;
    const history = ok(await harness.trunk.blame(harness.repository, 'src/router.ts'));
    expect(lineOwners(history)).toEqual([[1, 5, 'Start Relay', 'inferred'], [6, 1, 'Claude Opus 4.7', 'inferred'], [7, 1, 'Start Relay', 'inferred']]);
    expect(history.note).toBeUndefined();
    const calls = github.state.graphql;
    github.state.graphqlDown = false;
    expect(lineOwners(ok(await harness.trunk.blame(harness.repository, 'src/router.ts')))).toEqual([[1, 5, 'Start Relay', 'inferred'], [6, 1, 'Claude Opus 4.7', 'inferred'], [7, 1, 'Start Relay', 'inferred']]);
    expect(github.state.graphql).toBe(calls);
  }, 60_000);

  it('mirrors the notes as a fast-forward of what it mirrored before', async () => {
    const { harness, github } = await linked('mirror');
    const first = await land(harness, codex, { title: 'Docs', summary: 'Docs.', files: [{ path: 'docs/guide.md', content: '# Guide\n' }] });
    const second = await land(harness, codex, { title: 'More docs', summary: 'More docs.', files: [{ path: 'docs/more.md', content: '# More\n' }] });
    expect(github.git(['rev-parse', 'main']).trim()).toBe(second.landedCommit);
    for (const change of [first, second]) expect(JSON.parse(github.git(['notes', '--ref=braid', 'show', change.landedCommit!]))).toMatchObject({ change: { id: change.id } });
    expect(github.git(['rev-parse', 'refs/notes/braid']).trim()).toBe(harness.git.native(['rev-parse', 'refs/notes/braid']).trim());
  }, 90_000);
});
