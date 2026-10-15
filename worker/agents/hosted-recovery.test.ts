import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostedEnvironment } from '../../shared/types';
import type { BraidEnv } from '../env';
import { AgentSandbox } from './sandbox';
import { commandFailure, failure, retryDelay, runtimeFailure } from './hosted-failures';
import { hostedModelTurn, retryAfter } from './hosted-model';
import { hostedOutput, HostedOutputTail } from './hosted-output';
import { hostedPreflight } from './hosted-preflight';
import { runCommand } from './container';
import { networkProbeResult } from './hosted-network';
import { storageFixture } from '../test/storage';
import { commandResult, FakeHostedAi, FakeHostedContainer, finishTurn, hostedTask, workTurn } from './hosted-test-runtime';
import { modelTool } from '../test/hosted-runtime';

vi.mock('./provider-client', () => ({ providerAttempt: (env: BraidEnv, _provider: unknown, model: string, input: unknown, signal: AbortSignal) => env.AI.run(model as never, input as never, { signal }) }));

const stores: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const store of stores.splice(0)) store.db.close(); });
function setup() {
  const db = storageFixture(); stores.push(db);
  const container = new FakeHostedContainer(), ai = new FakeHostedAi();
  const updates: { message?: string; environment?: HostedEnvironment }[] = [];
  const checkpoint = vi.fn(async (_mission: string, _agent: string, message?: string, environment?: HostedEnvironment) => { updates.push({ message, environment }); return []; });
  const repo = { [Symbol.dispose]() {}, createToken: async () => ({ plaintext: 'fixture-bootstrap-secret' }), revokeToken: vi.fn(async () => {}) };
  const env = { AI: ai, WORKSPACES: { idFromString: (id: string) => id, get: () => ({ sandboxCheckpoint: checkpoint }) }, ARTIFACTS: { get: async () => repo } } as unknown as BraidEnv;
  Object.assign(db.ctx, { container });
  const sandbox = () => new AgentSandbox(db.ctx, env);
  return { db, container, ai, updates, checkpoint, repo, sandbox };
}
async function finishTimers<T>(promise: Promise<T>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  // WebCrypto completes outside fake timers. Let it settle before advancing retry sleeps.
  for (let i = 0; !settled && i < 500; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1000);
  }
  return promise;
}

describe('real environment evidence', () => {
  it('returns the production lecrev command timeout to the model and permits a separate longer build', async () => {
    const command = 'cd /workspace/repository && mise use -g go@1.25.0 2>&1 | tail -3; go version && go mod download 2>&1 | tail -5; echo "download exit=$?"; go build -o /tmp/lecrev-bin ./cmd/lecrev && echo BUILD_OK; /tmp/lecrev-bin 2>&1; echo "exit=$?"';
    const f = setup();
    f.ai.answers = [modelTool('exec', { command, purpose: 'setup', timeout: 180 }), modelTool('exec', { command: 'go build -o /tmp/lecrev-bin ./cmd/lecrev', purpose: 'check', timeout: 600 }), workTurn(), finishTurn()];
    f.container.commandFailures = [commandResult({ exitCode: -1, signal: 15, timedOut: true, timeoutMs: 180_000, elapsedMs: 180_619, stdout: 'go version go1.25.0 linux/amd64\ndownload exit=0' })];
    const turns: unknown[] = [], run = f.ai.run.bind(f.ai);
    vi.spyOn(f.ai, 'run').mockImplementation((...args: unknown[]) => { turns.push(structuredClone(args)); return run(); });
    await expect(f.sandbox().run(hostedTask)).resolves.toHaveProperty('files');
    expect(f.container.executions.filter(argv => argv.includes(command))).toHaveLength(1);
    const request = (turns[2] as unknown[])[1] as { messages: { role: string; content?: string }[] };
    expect(request.messages).toContainEqual(expect.objectContaining({ role: 'tool', content: expect.stringContaining('"timeoutMs":180000') }));
    expect(f.updates.some(update => update.environment?.status === 'failed')).toBe(false);
    expect(f.container.executions.some(argv => argv.includes('go build -o /tmp/lecrev-bin ./cmd/lecrev'))).toBe(true);
  });
  it('bounds a stalled checkpoint by the persisted overall task limit', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = setup(); f.checkpoint.mockImplementationOnce(() => new Promise(() => {}));
    await expect(finishTimers(f.sandbox().run({ ...hostedTask, timeBudgetMinutes: 1 }))).rejects.toMatchObject({ failure: { cause: 'timeout', evidence: { limitKind: 'task', timeoutMs: 60_000, operation: 'preparing the repository' } } });
    expect(f.container.starts).toBe(0); expect(f.ai.calls).toBe(0);
    expect(f.updates.at(-1)?.environment?.status).toBe('failed');
  });
  it('runs keyless tasks through the Workers AI binding', async () => {
    const f = setup();
    await expect(f.sandbox().run({ ...hostedTask, provider: undefined })).resolves.toMatchObject({ files: [{ path: 'fixture.txt', content: 'recovered\n' }] });
    expect(f.container.starts).toBe(1); expect(f.ai.calls).toBeGreaterThan(0);
    expect(f.updates.at(-1)?.environment?.status).toBe('completed');
  });
  it('keeps trusted supervisors and collection on the fixed image runtime after a repository selects another Node version', async () => {
    const f = setup(), execute = f.container.exec.bind(f.container);
    const invocations = vi.spyOn(f.container, 'exec').mockImplementation(async (argv, options) => {
      if (argv[0] === 'node' || argv.includes('/opt/braid/collect.mjs') && !argv.includes('/usr/local/bin/node')) throw new Error('repository-selected Node is unavailable');
      return execute(argv, options);
    });
    await expect(f.sandbox().run(hostedTask)).resolves.toMatchObject({ files: [{ path: 'fixture.txt', content: 'recovered\n' }] });
    expect(invocations.mock.calls.some(([argv]) => argv[0] === '/usr/local/bin/node')).toBe(true);
  });
  it.each([
    ['container_start', 'start', new Error('any text')],
    ['image_pull', 'start', Object.assign(new Error('opaque'), { name: 'ImagePullError' })],
    ['out_of_memory', 'command', Object.assign(new Error('opaque'), { oomKilled: true, exitCode: 137 })],
    ['process_killed', 'command', Object.assign(new Error('opaque'), { signal: 9 })],
    ['disk_full', 'command', Object.assign(new Error('opaque'), { code: 'ENOSPC' })],
    ['network', 'command', Object.assign(new Error('opaque'), { code: 'ENETUNREACH' })],
    ['workflow_step', 'workflow', new Error('opaque')],
  ] as const)('classifies %s from the operation or structured runtime data', (cause, phase, error) => {
    expect(runtimeFailure(error, phase, 'fixture').cause).toBe(cause);
    expect(JSON.stringify(runtimeFailure(error, phase, 'fixture'))).not.toContain('opaque');
  });
  it('never invents a subtype from prose or exit 137', () => {
    expect(runtimeFailure(new Error('ImagePullError ENOSPC out of memory network blocked'), 'command', 'exec').cause).toBe('command');
    expect(commandFailure(commandResult({ exitCode: 137 }), 'command', 'test')?.cause).toBe('command');
    expect(commandFailure(commandResult({ exitCode: 137, signal: 9, timedOut: true }), 'command', 'test')?.cause).toBe('timeout');
  });
  it('retains the structured image-pull error name as evidence', () => {
    expect(runtimeFailure({ name: 'ImagePullError' }, 'start', 'container start')).toMatchObject({ cause: 'image_pull', evidence: { reason: 'ImagePullError' } });
  });
  it('records the actual deadline when an aborted native exec resolves its exit code', async () => {
    vi.useFakeTimers();
    const container = { exec: vi.fn(async (_argv: string[], options: { signal: AbortSignal }) => ({
      stdin: null, stdout: null, stderr: null, pid: 1, isPty: false, output: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      exitCode: new Promise<number>(resolve => options.signal.addEventListener('abort', () => resolve(137), { once: true })),
    })) };
    const pending = runCommand(container as unknown as Container, ['git', 'fetch'], 1000, {});
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toMatchObject({ exitCode: 137, timedOut: true });
    expect(commandFailure(result, 'checkout', 'git fetch')?.cause).toBe('timeout');
    expect(() => networkProbeResult(result)).toThrow(expect.objectContaining({ failure: expect.objectContaining({ cause: 'timeout' }) }));
  });
  it('keeps startup-probe deadlines terminal instead of relabelling them as start retries', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = setup();
    const execute = f.container.exec.bind(f.container);
    vi.spyOn(f.container, 'exec').mockImplementation(async (argv, options) => argv.includes('true') ? {
      stdin: null, stdout: null, stderr: null, pid: 1, isPty: false, output: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      exitCode: new Promise<number>(resolve => (options as { signal: AbortSignal }).signal.addEventListener('abort', () => resolve(137), { once: true })),
    } : execute(argv, options));
    await expect(finishTimers(f.sandbox().run(hostedTask))).rejects.toMatchObject({ failure: { cause: 'timeout', phase: 'start', evidence: { timedOut: true, exitCode: 137 } } });
    expect(f.container.starts).toBe(1); expect(f.ai.calls).toBe(0);
  });
  it.each([
    ['out_of_memory', { exitCode: 137, oomKilled: true }],
    ['process_killed', { exitCode: -1, signal: 9 }],
    ['disk_full', { exitCode: 1, diskFull: true }],
  ] as const)('persists terminal %s without another model request or container attempt', async (cause, result) => {
    const f = setup(); f.container.commandFailures = [commandResult(result)];
    await expect(f.sandbox().run(hostedTask)).rejects.toMatchObject({ failure: { cause } });
    await expect(f.sandbox().run(hostedTask)).rejects.toMatchObject({ failure: { cause } });
    expect(f.container.starts).toBe(1); expect(f.ai.calls).toBe(2);
    expect(f.updates.at(-1)?.environment).toMatchObject({ status: 'failed', failure: { cause } });
  });
  it('lets the model repair failed configured setup, retaining the failed command as evidence', async () => {
    const f = setup(); f.container.commandFailures = [commandResult({ exitCode: 17, stderr: 'TOKEN=never-print-this\ninstall failed' })];
    const result = await f.sandbox().run({ ...hostedTask, preflight: { commit: hostedTask.baseCommit, setup: 'npm ci', checks: ['npm test'], runtimes: [], lockfiles: [], missing: [] } });
    expect(result.checks).toContainEqual(expect.objectContaining({ label: 'npm test', status: 'passed' }));
    expect(f.updates.some(update => update.environment?.prepared?.some(step => step.command === 'npm ci' && step.status === 'failed'))).toBe(true);
    expect(f.ai.calls).toBe(3); expect(JSON.stringify(f.updates)).not.toContain('never-print-this');
  });
  it('reruns a previously passing check after edits and repairs the final tree before collection', async () => {
    const f = setup(); let dirty = false, checks = 0;
    f.ai.answers = [modelTool('prepare', { decision: 'Run the declared check on the final file.', sources: ['package.json'], setup: [], checks: ['verify-fixture'] }),
      modelTool('exec', { command: 'verify-fixture', purpose: 'check', timeout: 10 }), workTurn(), finishTurn(), modelTool('exec', { command: 'repair-fixture', purpose: 'work', timeout: 10 }), finishTurn()];
    f.container.onCommand = argv => {
      if (!argv.includes('bash')) return;
      const command = argv.at(-1);
      if (command === 'edit-fixture') dirty = true;
      if (command === 'repair-fixture') dirty = false;
      if (command === 'verify-fixture') { checks++; return commandResult({ exitCode: dirty ? 1 : 0, stdout: dirty ? 'broken final tree' : 'verified final tree' }); }
    };
    const result = await f.sandbox().run(hostedTask);
    expect(checks).toBe(3); expect(result.checks).toEqual([expect.objectContaining({ kind: 'runtime', label: 'verify-fixture', status: 'passed', detail: expect.stringContaining('verified final tree') })]);
    expect(f.container.executions.filter(argv => argv.includes('/opt/braid/collect.mjs'))).toHaveLength(1);
  });
  it('does not let a model plan omit configured checks, and bounds repair attempts', async () => {
    const f = setup(); f.ai.answers = [workTurn(), finishTurn(), workTurn(), finishTurn(), workTurn(), finishTurn()];
    f.container.onCommand = argv => argv.includes('bash') && argv.at(-1) === 'mandatory-check' ? commandResult({ exitCode: 1, stdout: 'failed' }) : undefined;
    await expect(f.sandbox().run({ ...hostedTask, preflight: { commit: hostedTask.baseCommit, checks: ['mandatory-check'], runtimes: [], lockfiles: [], missing: [] } }))
      .rejects.toMatchObject({ failure: { cause: 'command', evidence: { operation: 'mandatory-check', reason: 'check_failed', exitCode: 1 } } });
    expect(f.container.executions.filter(argv => argv.includes('mandatory-check'))).toHaveLength(3);
    expect(f.container.executions.filter(argv => argv.includes('/opt/braid/collect.mjs'))).toHaveLength(0);
  });
  it.each([
    ['collectionTimeout', commandResult({ exitCode: 124, timedOut: true })],
    ['collectionCommand', commandResult({ exitCode: 1, stderr: 'failed' })],
    ['collectionTruncated', commandResult({ truncated: true })],
    ['collectionInvalid', commandResult({ stdout: '{}' })],
  ])('records the collector result for %s', async (reason, result) => {
    const f = setup(); f.container.collection = result as ReturnType<typeof commandResult>;
    await expect(f.sandbox().run(hostedTask)).rejects.toMatchObject({ failure: { cause: 'collection', evidence: { reason } } });
    expect(f.container.starts).toBe(1);
  });
});

describe('bounded automatic recovery and resume', () => {
  it.each([new Error('cold start failed'), Object.assign(new Error('opaque'), { name: 'ImagePullError' })])('recovers a transient start without repeating work', async error => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); const f = setup(); f.container.startFailures = [error];
    const result = await finishTimers(f.sandbox().run(hostedTask));
    expect(result.files).toHaveLength(1); expect(f.container.starts).toBe(2); expect(f.ai.calls).toBe(3);
    expect(f.updates.some(item => item.environment?.status === 'retrying')).toBe(true);
    expect(await f.sandbox().run(hostedTask)).toEqual(result);
    expect(f.container.starts).toBe(2);
  });
  it('bounds start retries across replays and eviction', async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); const f = setup(); f.container.startFailures = Array(8).fill(new Error('opaque'));
    await expect(finishTimers(f.sandbox().run(hostedTask))).rejects.toMatchObject({ failure: { cause: 'container_start' } });
    await expect(f.sandbox().run(hostedTask)).rejects.toMatchObject({ failure: { cause: 'container_start' } });
    expect(f.container.starts).toBe(4); expect(f.ai.calls).toBe(0);
    expect(f.updates.filter(item => item.environment?.status === 'retrying').map(item => item.environment?.retry?.attempt)).toEqual([1, 2, 3]);
  });
  it('recovers a real socket-code probe before issuing the checkout credential', async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); const f = setup(); let failed = false;
    f.container.onCommand = argv => { if (!failed && argv.some(value => value.includes("from 'node:tls'"))) { failed = true; return commandResult({ stdout: JSON.stringify({ ok: false, code: 'ENETUNREACH' }) }); } };
    await finishTimers(f.sandbox().run(hostedTask));
    expect(f.container.starts).toBe(1); expect(f.repo.revokeToken).toHaveBeenCalledTimes(1);
    expect(f.updates.find(item => item.environment?.status === 'retrying')?.environment?.failure).toMatchObject({ cause: 'network', evidence: { code: 'ENETUNREACH' } });
  });
  it('resumes the same model turn after HTTP 503 with the completed command intact', async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); const f = setup(); f.ai.answers = [workTurn(), new Response('{}', { status: 503 }), finishTurn()];
    await finishTimers(f.sandbox().run(hostedTask));
    expect(f.ai.calls).toBe(4); expect(f.container.executions.filter(argv => argv.includes('bash'))).toHaveLength(1);
    expect(f.updates.find(item => item.environment?.status === 'retrying')?.environment?.failure?.evidence.status).toBe(503);
  });
  it('replays the protected receipt when a command response is lost', async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); const f = setup(); const execute = f.container.exec.bind(f.container); let lost = false;
    vi.spyOn(f.container, 'exec').mockImplementation(async (argv, options) => { const result = await execute(argv, options); if (!lost && argv[0] === '/usr/local/bin/node' && argv.at(-1)?.includes('edit-fixture')) { lost = true; throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' }); } return result; });
    await finishTimers(f.sandbox().run(hostedTask));
    expect(f.container.executions.filter(argv => argv.includes('bash'))).toHaveLength(1);
  });
  it('resumes a persisted finish call after a checkpoint RPC interruption', async () => {
    const f = setup(); let interrupted = false;
    const inactivity = vi.spyOn(f.container, 'setInactivityTimeout');
    const checkpoint = f.checkpoint.getMockImplementation()!;
    f.checkpoint.mockImplementation(async (...args) => { if (!interrupted && args[2] === 'Preparing the completed changes') { interrupted = true; throw new Error('RPC disconnected'); } return checkpoint(...args); });
    await expect(f.sandbox().run(hostedTask)).rejects.toThrow('RPC disconnected');
    expect(f.container.running).toBe(true);
    await f.sandbox().run(hostedTask);
    expect(f.container.starts).toBe(1); expect(f.ai.calls).toBe(3);
    expect(inactivity).toHaveBeenCalledTimes(2);
    expect(f.container.executions.filter(argv => argv.includes('bash'))).toHaveLength(1);
    expect(f.container.executions.filter(argv => argv.includes('/opt/braid/collect.mjs'))).toHaveLength(1);
  });
  it('never restarts from an inapplicable checkpoint after the VM disappears', async () => {
    const f = setup(); f.checkpoint.mockImplementation(async (_m, _a, message) => { if (message === 'Preparing the completed changes') throw new Error('RPC disconnected'); return []; });
    await expect(f.sandbox().run(hostedTask)).rejects.toThrow(); f.container.running = false;
    await expect(f.sandbox().run(hostedTask)).rejects.toMatchObject({ failure: { cause: 'interrupted', evidence: { reason: 'checkpoint_container_stopped' } } });
    expect(f.container.starts).toBe(1);
  });
  it('runs configured checks before collection even when the model reports no checks', async () => {
    const f = setup();
    const result = await f.sandbox().run({ ...hostedTask, preflight: { commit: hostedTask.baseCommit, setup: 'setup-fixture', checks: ['check-fixture'], runtimes: [], lockfiles: [], missing: [] } });
    expect(result.checks).toContainEqual(expect.objectContaining({ label: 'check-fixture', status: 'passed' }));
    const executed = f.container.executions.map(argv => argv.join(' '));
    expect(executed.findIndex(value => value.includes('check-fixture'))).toBeLessThan(executed.findIndex(value => value.includes('/opt/braid/collect.mjs')));
  });
});

describe('provider status and Retry-After', () => {
  it.each([400, 401, 403, 404, 429])('does not guess that HTTP %s without Retry-After is transient', async status => {
    const ai = { run: vi.fn(async () => new Response('{}', { status })) };
    await expect(hostedModelTurn(ai as unknown as Ai, 'fixture', {}, Date.now() + 30_000, async () => {})).rejects.toMatchObject({ failure: { cause: 'provider', evidence: { status }, retryable: false } });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });
  it('honors Retry-After and keeps its exact status', async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); const ai = { run: vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '5' } })).mockResolvedValueOnce({ response: 'done' }) };
    const result = hostedModelTurn(ai as unknown as Ai, 'fixture', {}, Date.now() + 30_000, async () => {});
    await vi.advanceTimersByTimeAsync(4999); expect(ai.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await result; expect(ai.run).toHaveBeenCalledTimes(2);
  });
  it('does not shorten Retry-After to fit its cap or task deadline', () => {
    const reason = failure('provider', 'model', { source: 'workers_ai', operation: 'request', status: 429, retryAfterMs: 90_000 }); reason.retryable = true;
    expect(retryDelay(reason, 0, Date.now() + 120_000)).toBeNull();
    reason.evidence.retryAfterMs = 5000;
    expect(retryDelay(reason, 0, Date.now() + 1000)).toBeNull();
    expect(retryDelay(reason, 3, Date.now() + 120_000)).toBeNull();
    expect(retryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:50Z'))).toBe(10_000);
  });
});

describe('redacted evidence', () => {
  it('retains the last 40 lines and removes credentials before cutting lines', () => {
    const text = [...Array.from({ length: 80 }, (_, i) => `line ${i}`), 'Authorization: Bearer private-secret', 'TOKEN=another-secret', 'https://user:secret@host.test/path', 'person@example.com'].join('\n');
    const output = hostedOutput(text);
    expect(output.split('\n')).toHaveLength(40); expect(output).toContain('line 79'); expect(output).not.toContain('line 43\n');
    for (const value of ['private-secret', 'another-secret', 'user:secret', 'person@example.com']) expect(output).not.toContain(value);
  });
  it('redacts split credentials and entire private keys across the tail boundary', () => {
    const tail = new HostedOutputTail(['bootstrap-credential']);
    // Assembled at runtime: the source archive refuses files that carry a private key marker.
    const [begin, end] = ['BEGIN', 'END'].map(edge => ['-----' + edge, 'PRIVATE KEY-----'].join(' '));
    tail.write(begin + '\n' + Array(90).fill('secret key body').join('\n'));
    tail.write(`\n${end}\nTOKEN=sec`); tail.write('ret\nbootstrap-'); tail.write('credential\n');
    const output = tail.finish(); expect(output).not.toContain('secret'); expect(output).not.toContain('bootstrap'); expect(output.split('\n').length).toBeLessThanOrEqual(40);
  });
});

describe('preflight from the pinned repository', () => {
  it('uses configured commands, declared versions and existing lockfiles', async () => {
    const files: Record<string, string> = { '.braid/policy.json': JSON.stringify({ version: 1, verify: { install: 'npm ci', checks: ['npm test'] } }), 'package.json': JSON.stringify({ engines: { node: '>=24' } }), 'package-lock.json': '', '.python-version': '3.13', 'go.mod': 'module fixture\n\ngo 1.24\n' };
    const result = await hostedPreflight('pinned', async path => files[path] ?? null);
    expect(result).toMatchObject({ commit: 'pinned', setup: 'npm ci', checks: ['npm test'], lockfiles: ['package-lock.json'], missing: [] });
    expect(result.runtimes.map(item => [item.name, item.version])).toEqual([['Python', '3.13'], ['Node', '>=24']]);
  });
  it('starts a repository that declares nothing, without inventing commands or a runtime version', async () => {
    const result = await hostedPreflight('pinned', async path => ({ 'package.json': '{}', 'go.mod': 'module fixture\n' } as Record<string, string>)[path] ?? null);
    expect(result.setup).toBeUndefined(); expect(result.checks).toEqual([]); expect(result.runtimes).toEqual([]);
    expect(result.missing).toEqual([]);
  });
  it('stops only at a broken Braid policy', async () => {
    const result = await hostedPreflight('pinned', async path => ({ '.braid/policy.json': '{', 'package.json': 'not json' } as Record<string, string>)[path] ?? null);
    expect(result.missing).toEqual(['Fix .braid/policy.json before starting an agent.']);
  });
});

it('extends actual command deadlines when the person chooses more time', async () => {
  const f = setup();
  const execute = vi.spyOn(f.container, 'exec');
  await f.sandbox().run({ ...hostedTask, timeBudgetMinutes: 54 });
  const job = execute.mock.calls.find(([argv]) => argv[0] === '/usr/local/bin/node' && argv.at(-1)?.includes('edit-fixture'))!;
  expect(JSON.parse(job[0].at(-1)!).timeout).toBe(120_000); // The model requested 60 seconds; this run has twice the time.
});
it('records missing container configuration as a terminal start failure', async () => {
  const f = setup(); f.container.images.agent = '';
  await expect(f.sandbox().run(hostedTask)).rejects.toMatchObject({ failure: { cause: 'container_start', retryable: false, evidence: { reason: 'missing_binding_or_image' } } });
  expect(f.ai.calls).toBe(0); expect(f.container.starts).toBe(0);
  expect(f.updates.at(-1)?.environment?.status).toBe('failed');
});

it('keeps a timed-out final check failed even when its signal handler exits zero', async () => {
  const f = setup(); f.ai.answers = [workTurn(), finishTurn(), workTurn(), finishTurn(), workTurn(), finishTurn()];
  f.container.onCommand = argv => argv.includes('bash') && argv.at(-1) === 'mandatory-check'
    ? commandResult({ exitCode: 0, timedOut: true, timeoutMs: 600_000, elapsedMs: 600_001 }) : undefined;
  await expect(f.sandbox().run({ ...hostedTask, preflight: { commit: hostedTask.baseCommit, checks: ['mandatory-check'], runtimes: [], lockfiles: [], missing: [] } }))
    .rejects.toMatchObject({ failure: { cause: 'timeout', evidence: { operation: 'mandatory-check', limitKind: 'command', timeoutMs: 600_000 } }, checks: [expect.objectContaining({ status: 'failed' })] });
  expect(f.container.executions.filter(argv => argv.includes('/opt/braid/collect.mjs'))).toHaveLength(0);
});

it('applies the overall deadline while checkout-token revocation is stalled', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const f = setup(); f.repo.revokeToken.mockImplementationOnce(() => new Promise(() => {}));
  await expect(finishTimers(f.sandbox().run({ ...hostedTask, timeBudgetMinutes: 1 }))).rejects.toMatchObject({ failure: { cause: 'timeout', evidence: { limitKind: 'task', timeoutMs: 60_000, operation: 'revoking the checkout token' } } });
  expect(f.ai.calls).toBe(0); expect(f.container.running).toBe(false);
});
