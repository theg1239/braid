import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { changesRoute, type ChangeGateway } from './router';
import { reviewPrompt } from './review';
import { submissionShard } from './names';
import { SUBMISSION_BYTES } from '../schemas';
import { HttpError } from '../errors';
import type { Change } from '../../shared/types';

const router = ['export const routes = [', "  '/health',", '];', '', 'export function handle(path: string) {', '  return routes.includes(path);', '}', ''].join('\n');
const agents = '# Agents\n\nRun npm test before submitting.\n';
/** A one-pixel PNG. */
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.useRealTimers(); await harness?.close(); harness = undefined; });

async function setup(policy: unknown = { autonomy: 'review', reviewers: 1 }) {
  harness = await changeHarness();
  const base = harness.git.commitTree({ 'src/router.ts': router, 'docs/guide.md': '# Guide\n', 'AGENTS.md': agents, '.braid/policy.json': JSON.stringify(policy, null, 2) + '\n' });
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
  const owner: ChangeGateway = { repository: harness.repository, mode: 'live', role: 'owner', person: { id: 'owner', name: 'owner@example.test' } };
  /** A request through the router, answered as the gateway answers thrown HTTP errors. */
  const call = async <T>(method: string, path: string, options: { body?: unknown; key?: string; gateway?: ChangeGateway } = {}) => {
    const headers: Record<string, string> = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}) };
    try {
      const response = (await changesRoute(new Request(`https://braid.example${path}`, { method, headers, ...(options.body ? { body: JSON.stringify(options.body) } : {}) }), harness!.env, options.gateway ?? owner))!;
      return { status: response.status, headers: response.headers, data: (response.headers.get('content-type')?.startsWith('image/') ? new Uint8Array(await response.arrayBuffer()) : await response.json()) as T };
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, headers: new Headers(), data: { error: error.message } as T };
      throw error;
    }
  };
  return { harness, base, call };
}
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};
const shardOf = (change: { id: string }) => parseInt(change.id[3], 16);

describe('evidence on changes', () => {
  it('keeps screenshots and command runs per revision, serves screenshots by hash, and sends back a failing command with its output', async () => {
    const { harness, base, call } = await setup();
    const edit = (content: string) => [{ path: 'src/router.ts', content: router.replace("  '/health',\n", `  '/health',\n  '${content}',\n`) }];
    const first = ok(await harness.submit('atlas', { title: 'Add a status route', summary: 'Adds /status.', baseCommit: base, files: edit('/status'), evidence: [
      { kind: 'screenshot', page: '/status', viewport: 'desktop', width: 1, height: 1, contentType: 'image/png', data: png },
      { kind: 'command', command: 'npm test', exitCode: 1, durationMs: 4200, output: '\x1b[31mFAIL\x1b[0m test/status.test.ts\nprogress 10%\rprogress 100%\nTests: 1 failed, 23 passed' },
    ] }));
    expect(first).toMatchObject({ status: 'revise', next: 'Failed: npm test', label: 'Checks failed' });
    expect(first.checks).toContainEqual({ revision: 1, label: 'npm test', status: 'failed', source: 'agent',
      detail: "Exited with 1 on the agent's machine; not executed by Braid.\nFAIL test/status.test.ts\nprogress 100%\nTests: 1 failed, 23 passed" });
    const [shot, run] = first.evidence!;
    expect(shot).toEqual({ kind: 'screenshot', page: '/status', viewport: 'desktop', width: 1, height: 1, image: expect.stringMatching(/^[a-f0-9]{64}\.png$/), revision: 1, source: 'agent', at: expect.any(String) });
    expect(run).toMatchObject({ kind: 'command', command: 'npm test', exitCode: 1, durationMs: 4200, output: 'FAIL test/status.test.ts\nprogress 100%\nTests: 1 failed, 23 passed', revision: 1, source: 'agent' });
    if (shot.kind !== 'screenshot') throw new Error('Expected a screenshot.');

    const served = await call<Uint8Array>('GET', `/api/changes/${first.id}/evidence/${shot.image}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(served.data).toEqual(Uint8Array.from(atob(png), char => char.charCodeAt(0)));
    expect((await call('GET', `/api/changes/${first.number}/evidence/${shot.image}`)).status).toBe(200);
    expect((await call('GET', `/api/changes/${first.id}/evidence/${'0'.repeat(64)}.png`)).status).toBe(404);

    // The fix comes with a passing run; both revisions keep what they showed.
    const second = ok(await harness.shard(shardOf(first)).revise(harness.context('atlas', shardOf(first)), first.id, { summary: 'Adds /status with its test passing.', baseCommit: base, previousRevision: 1,
      files: edit('/status'), evidence: [{ kind: 'command', command: 'npm test', exitCode: 0, output: 'Tests: 24 passed' }] }, 'evidence-revision-key-0002'));
    expect(second).toMatchObject({ status: 'open', revision: 2 });
    expect(second.evidence!.map(item => [item.revision, item.kind])).toEqual([[1, 'screenshot'], [1, 'command'], [2, 'command']]);
    expect(second.checks.filter(check => check.revision === 2 && check.status === 'failed')).toEqual([]);
    // A retry with the same key and screenshot is the same change.
    const retry = { title: 'Add a ready route', summary: 'Adds /ready.', baseCommit: base, files: edit('/ready'), evidence: [{ kind: 'screenshot', page: '/ready', viewport: 'mobile', width: 1, height: 1, contentType: 'image/png', data: png }] };
    const key = 'evidence-retry-key-0001', index = submissionShard(`agent:atlas:${key}`);
    const once = ok(await harness.shard(index).submit(harness.context('atlas', index), retry, key));
    expect(ok(await harness.shard(index).submit(harness.context('atlas', index), retry, key)).id).toBe(once.id);
    expect(once.evidence).toEqual([expect.objectContaining({ image: shot.image, viewport: 'mobile' })]);
  }, 30_000);

  it('takes files and screenshots up to their limits in one request, and says what is too large above them', async () => {
    const { base, call } = await setup();
    const image = Buffer.concat([Buffer.from(atob(png).slice(0, 8), 'latin1'), Buffer.alloc(599_992)]).toString('base64');
    const files = [{ path: 'src/large.ts', content: `${'// filler line of sixty-four characters to reach the file limit\n'.repeat(49_000)}` }];
    const evidence = [...Array.from({ length: 6 }, (_, index) => ({ kind: 'screenshot', page: `/page/${index}`, viewport: 'desktop', width: 1280, height: 800, contentType: 'image/png', data: image })),
      ...Array.from({ length: 10 }, (_, index) => ({ kind: 'command', command: `npm run check:${index}`, exitCode: 0, output: '\u001b[32mok\u001b[0m\n'.repeat(666) }))];
    const accepted = await call<Change>('POST', '/api/changes', { body: { title: 'A large change', summary: 'Files and evidence at their limits.', baseCommit: base, files, evidence }, key: 'evidence-large-key-0001' });
    expect(accepted.status).toBe(201);
    expect(accepted.data.evidence).toHaveLength(16);
    expect(await call('POST', '/api/changes', { body: { padding: 'x'.repeat(SUBMISSION_BYTES) }, key: 'evidence-large-key-0002' }))
      .toMatchObject({ status: 413, data: { error: 'Cloudflare Workers limits serialized RPC messages to 32 MiB. Keep JSON submissions below 31 MiB; use Git uploads and blob hashes for larger pull requests.' } });
  }, 60_000);

  it('rejects evidence that is not what it claims, beyond the limits, or for no page', async () => {
    const { harness, base } = await setup();
    const submit = async (evidence: unknown[]) => harness.submit('atlas', { title: 'Add a route', summary: 'Adds a route.', baseCommit: base, files: [{ path: 'src/a.ts', content: 'export {};\n' }], evidence });
    const screenshot = { kind: 'screenshot', page: '/', viewport: 'mobile', width: 390, height: 844, contentType: 'image/png', data: png };
    expect(await submit([{ ...screenshot, contentType: 'image/jpeg' }])).toMatchObject({ ok: false, status: 400, error: "A screenshot's data is not the image type it declares." });
    expect(await submit([{ ...screenshot, data: `${png.slice(0, -2)}!=` }])).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('base64') });
    expect(await submit([{ ...screenshot, data: 'A'.repeat(800_004) }])).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('600 KB') });
    // Each image within 600 KB, but seven of them past 4 MB together.
    const large = Buffer.concat([Buffer.from(atob(png).slice(0, 8), 'latin1'), Buffer.alloc(589_992)]).toString('base64');
    expect(await submit(Array.from({ length: 7 }, () => ({ ...screenshot, data: large })))).toMatchObject({ ok: false, status: 400, error: 'Include at most 4 MB of screenshots in one submission.' });
    expect(await submit([{ ...screenshot, page: '//evil.example/x' }])).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('path starting with /') });
    expect(await submit([{ ...screenshot, width: 4001 }])).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('4,000') });
    expect(await submit(Array.from({ length: 13 }, () => screenshot))).toMatchObject({ ok: false, status: 400, error: 'Include at most 12 screenshots.' });
    expect(await submit(Array.from({ length: 11 }, () => ({ kind: 'command', command: 'npm test', exitCode: 0, output: '' })))).toMatchObject({ ok: false, status: 400, error: 'Include at most 10 command runs.' });
    expect(await submit([{ kind: 'command', command: 'npm test', exitCode: 1.5, output: '' }])).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('exit code') });
    expect(await submit([{ kind: 'command', command: 'npm test', exitCode: 0, output: 'x'.repeat(8001) }])).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('8,000') });
    expect(await submit([{ kind: 'video' }])).toMatchObject({ ok: false, status: 400, error: 'Send each piece of evidence as a screenshot or a command run.' });
    expect(ok(await submit([{ ...screenshot, page: 'https://relay.example/status?x=1' }])).evidence).toHaveLength(1);
  }, 30_000);
});

describe('instructions every agent follows', () => {
  it('adds an instruction through a change its person approved, checks later changes against it and removes it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { harness, base, call } = await setup();
    const add = { text: 'Never log webhook secrets', block: ['console.log(secret'], paths: ['src/**'] };
    const created = await call<Change>('POST', '/api/instructions', { body: add, key: 'instruction-add-key-0001' });
    expect(created).toMatchObject({ status: 201, data: { title: 'Add instruction: Never log webhook secrets', status: 'queued', author: { kind: 'human', name: 'owner@example.test' } } });
    expect(created.data.files.map(file => file.path).sort()).toEqual(['.braid/instructions.json', 'AGENTS.md']);
    expect((await call<Change>('POST', '/api/instructions', { body: add, key: 'instruction-add-key-0001' })).data.id).toBe(created.data.id);
    expect((await call('POST', '/api/instructions', { body: add })).status).toBe(400);
    expect((await call('POST', '/api/instructions', { body: { ...add, block: ['x'.repeat(61)] }, key: 'instruction-add-key-0002' })).data).toEqual({ error: 'Block up to 8 strings of 1–60 characters, each on one line.' });
    const agent: ChangeGateway = { repository: harness.repository, mode: 'live', role: 'owner', agent: { id: 'atlas', label: 'Atlas', scope: 'work' } };
    expect((await call('POST', '/api/instructions', { body: add, key: 'instruction-add-key-0003', gateway: agent })).status).toBe(403);

    await harness.settle();
    expect(ok(await harness.shard(shardOf(created.data)).get(created.data.id)).status).toBe('landed');
    const instruction = { id: 'never-log-webhook-secrets', text: 'Never log webhook secrets', block: ['console.log(secret'], paths: ['src/**'] };
    expect(JSON.parse(harness.git.native(['show', 'main:.braid/instructions.json']))).toEqual({ instructions: [instruction] });
    expect(harness.git.native(['show', 'main:AGENTS.md'])).toBe(`${agents}\n<!-- braid:instructions:start -->\n## Instructions from Braid\n\n- Never log webhook secrets. Blocked in \`src/**\`: \`console.log(secret\`.\n<!-- braid:instructions:end -->\n`);
    expect((await call('GET', '/api/instructions')).data).toEqual({ instructions: [instruction], errors: [], head: harness.head() });
    expect((await call<{ instructions: unknown[] }>('GET', '/api/policy')).data.instructions).toEqual([instruction]);

    // Every change is checked against it on arrival, once the shards read main again.
    vi.setSystemTime(Date.now() + 20_000);
    const leak = ok(await harness.submit('atlas', { title: 'Log route lookups', summary: 'Logs lookups.', baseCommit: harness.head(), files: [
      { path: 'src/router.ts', content: router.replace('  return routes.includes(path);', '  console.log(secret, path);\n  return routes.includes(path);') },
      { path: 'docs/guide.md', content: '# Guide\n\nNever call console.log(secret) in src.\n' },
    ] }));
    expect(leak).toMatchObject({ status: 'revise', label: 'Breaks an instruction', next: 'Adds "console.log(secret" to src/router.ts at line 6, against "Never log webhook secrets".',
      guards: [{ kind: 'instructions', path: 'src/router.ts', detail: 'Adds "console.log(secret" to src/router.ts at line 6, against "Never log webhook secrets".' }] });

    const removed = await call<Change>('DELETE', '/api/instructions/never-log-webhook-secrets', { key: 'instruction-remove-key-0001' });
    expect(removed).toMatchObject({ status: 201, data: { title: 'Remove instruction: Never log webhook secrets', status: 'queued' } });
    expect((await call('DELETE', '/api/instructions/missing', { key: 'instruction-remove-key-0002' })).status).toBe(404);
    await harness.settle();
    expect(harness.git.native(['show', 'main:AGENTS.md'])).toBe(agents);
    expect(JSON.parse(harness.git.native(['show', 'main:.braid/instructions.json']))).toEqual({ instructions: [] });
    expect(base).not.toBe(harness.head());
  }, 60_000);

  it('asks the reviewer to hold a change to the instructions for its files', () => {
    const prompt = reviewPrompt({ title: 'Shorten the status page', intent: 'Less copy.', summary: 'Trims copy.', rationale: '', notes: [],
      files: [{ path: 'public/status.html', before: '<p>Old</p>\n', after: '<p>New</p>\n' }], instructions: [{ id: 'less-text', text: 'Less text', paths: ['public/**'] }] });
    expect(prompt[0].content).toContain('When this change goes against one, reply revise with a finding that names the instruction');
    expect(prompt[1].content).toContain("Instructions from the repository's owners:\n- Less text. Applies to `public/**`.");
  });
});
