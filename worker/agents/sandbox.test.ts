import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSandbox } from './sandbox';
import { runAgentLoop, type SandboxTask } from './loop';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./provider-client', () => ({ providerAttempt: (env: BraidEnv, _provider: unknown, model: string, input: unknown, signal: AbortSignal) => env.AI.run(model as never, input as never, { signal }) }));

const task: SandboxTask = { provider: { id: 'openai', owner: 'fixture', version: 'v1' }, workspaceId: 'workspace', missionId: 'mission-1', agentId: 'atlas', repo: 'project', remote: 'https://account.artifacts.cloudflare.net/git/braid/project.git', baseCommit: 'a'.repeat(40), model: 'test', title: 'Fix a deep module', intent: 'Complete the change and run tests.', role: 'Coding agent', task: 'Complete the task.', scope: ['*'], context: ['Keep existing behavior.'] };
const tool = (name: string, args: unknown) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const exec = (purpose = 'work', command = 'rg -n bug packages/deep') => tool('exec', { command, purpose, timeout: 60 });
const finish = () => tool('finish', { summary: 'Fixed the module', rationale: 'Preserves existing behavior.' });
const files = [{ path: 'packages/deep/module.ts', content: 'export const fixed = true;\n' }];
const dbs: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.db.close(); vi.restoreAllMocks(); });

function fixture() {
  const db = storageFixture(); dbs.push(db);
  let cloneFailed = false;
  const collect = vi.fn((): { stdout: string; stderr: string; exitCode: number; timedOut?: boolean } => ({ stdout: JSON.stringify(files), stderr: '', exitCode: 0 }));
  const repo = { [Symbol.dispose]() {}, createToken: vi.fn(async () => ({ plaintext: 'read-only-secret?expires=123' })), revokeToken: vi.fn(async () => {}) };
  const container = { running: false, images: { agent: 'test-image' }, start: vi.fn(), monitor: vi.fn(() => new Promise<void>(() => {})), destroy: vi.fn(async () => {}), setInactivityTimeout: vi.fn(async () => {}), exec: vi.fn(async (args: string[], options: ContainerExecOptions) => {
    const supervised = args[0] === '/usr/local/bin/node' && args.includes('--input-type=module');
    const job = supervised ? JSON.parse(args.at(-1)!) as { argv: string[] } : null;
    const argv = job?.argv ?? args;
    const clone = argv.includes('clone');
    if (!clone && !argv.includes('true') && !argv.some(arg => arg.includes("from 'node:tls'"))) expect(repo.revokeToken).toHaveBeenCalledWith('read-only-secret?expires=123');
    const result = argv.includes('/usr/bin/python3') ? { stdout: JSON.stringify({ manifests: [], lockfiles: [], instructions: [] }), stderr: '', exitCode: 0 } : argv.includes('/opt/braid/collect.mjs') ? collect() : { stdout: argv.some(arg => arg.includes("from 'node:tls'")) ? '{"ok":true}' : argv.includes('--input-type=module') ? task.baseCommit : 'command output', stderr: '', exitCode: clone && cloneFailed ? 1 : 0 };
    return { stdout: new Blob([supervised ? JSON.stringify({ ...result, truncated: result.stdout.length > 24 * 1024 * 1024 || result.stderr.length > 16 * 1024 }) : result.stdout]).stream(), stderr: new Blob([supervised ? '' : result.stderr]).stream(), exitCode: Promise.resolve(supervised ? 0 : result.exitCode), kill: vi.fn(), stdin: null, pid: 1, isPty: false } as unknown as ExecProcess;
  }) };
  const checkpoint = vi.fn(async () => {});
  const ai = { run: vi.fn().mockResolvedValueOnce(exec()).mockResolvedValueOnce(exec('check', 'npm test')).mockResolvedValueOnce(finish()) };
  let prepared = false;
  const model = { run: (...args: unknown[]) => { if (!prepared) { prepared = true; return Promise.resolve(tool('prepare', { decision: 'Update the fixture without dependency installation and run its declared test command.', sources: ['package.json'], setup: [], checks: ['npm test'] })); } return ai.run(...args); } };
  const env = { WORKSPACES: { idFromString: (id: string) => id, get: () => ({ sandboxCheckpoint: checkpoint }) }, ARTIFACTS: { get: async () => repo }, AI: model } as unknown as BraidEnv;
  const ctx = Object.assign(db.ctx, { container: container as unknown as Container });
  return { db, ctx, env, container, repo, checkpoint, ai, collect, sandbox: new AgentSandbox(ctx, env), failClone: () => { cloneFailed = true; } };
}

describe('sandbox collection failures', () => {
  it('bounds correction attempts and keeps the collector refusal as the final reason', async () => {
    const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.collect.mockReturnValue({ stdout: JSON.stringify({ collectionFailure: { reason: 'empty' } }), stderr: '', exitCode: 1 });
    f.ai.run.mockResolvedValue(finish());
    await expect(f.sandbox.run(task)).rejects.toThrow(/without changed files.*Start again/);
    expect(f.collect).toHaveBeenCalledTimes(3);
    expect(f.container.start).toHaveBeenCalledTimes(1);
    expect(f.container.destroy).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'timeout', stdout: '', stderr: 'Command timed out.', exitCode: 124, timedOut: true, expected: /collection timed out.*Start again/ },
    { name: 'command failure', stdout: '', stderr: 'private command diagnostic', exitCode: 1, expected: /collection command failed.*Start again/ },
    { name: 'stdout truncation', stdout: ' '.repeat(24 * 1024 * 1024 + 1), stderr: '', exitCode: 0, expected: /collection output was truncated.*Start again/ },
    { name: 'stderr truncation', stdout: JSON.stringify(files), stderr: 'x'.repeat(16 * 1024 + 1), exitCode: 0, expected: /collection output was truncated.*Start again/ },
    ...['', '{}', '[]', '[{"path":"../escape","content":"bad"}]'].map(stdout => ({ name: `invalid result ${stdout}`, stdout, stderr: '', exitCode: 0, expected: /collection returned an invalid result.*Start again/ })),
  ])('refuses $name with a safe reason and does not persist a result', async ({ expected, ...result }) => {
    const f = fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.collect.mockReturnValue(result);
    await expect(f.sandbox.run(task)).rejects.toThrow(expected);
    expect(f.collect).toHaveBeenCalledTimes(1);
    expect(f.container.destroy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private command diagnostic');
    // A permanent failure remains terminal under this task identity, including after eviction.
    await expect(new AgentSandbox(f.ctx, f.env).run(task)).rejects.toThrow(expected);
    expect(f.container.start).toHaveBeenCalledTimes(1);
  });

  it.each(['empty', 'binary', 'limit'] as const)('lets the model correct the real collector\'s %s refusal without restarting the checkout', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'braid-collector-'));
    const git = (args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    try {
      git(['init', '-q']); writeFileSync(join(root, 'README.md'), 'base\n'); git(['add', '.']); git(['commit', '-qm', 'Fixture base']);
      const base = git(['rev-parse', 'HEAD']).trim();
      if (kind === 'binary') writeFileSync(join(root, 'test-output.bin'), Buffer.from([0, 255, 1]));
      if (kind === 'limit') writeFileSync(join(root, 'large.txt'), 'x'.repeat(3 * 1024 * 1024 + 1));
      // Run the image's actual collector with only its two absolute paths relocated for the local fixture.
      const script = readFileSync(new URL('../../sandbox/collect.mjs', import.meta.url), 'utf8')
        .replace("'/opt/braid/braid.mjs'", JSON.stringify(new URL('../../public/cli/braid.mjs', import.meta.url).href))
        .replace("'/workspace/repository'", JSON.stringify(root));
      const refused = spawnSync(process.execPath, ['--input-type=module', '-e', script, 'collect', base], { encoding: 'utf8' });
      expect(refused.status).toBe(1); expect(JSON.parse(refused.stdout)).toMatchObject({ collectionFailure: { reason: kind } }); expect(refused.stderr).toBe('');
      const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
      f.collect.mockReturnValueOnce({ stdout: refused.stdout, stderr: refused.stderr, exitCode: refused.status! });
      f.ai.run.mockResolvedValueOnce(exec('check', 'npm test')).mockResolvedValueOnce(finish());
      await expect(f.sandbox.run(task)).resolves.toMatchObject({ files });
      expect(f.collect).toHaveBeenCalledTimes(2);
      expect(f.container.start).toHaveBeenCalledTimes(1);
      const retried = f.ai.run.mock.calls[3][1] as { messages: { role: string; content: string }[] };
      expect(retried.messages.some(message => message.role === 'tool' && /No proposal was published/.test(message.content))).toBe(true);
      expect(JSON.stringify(retried)).not.toContain(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('full-checkout Cloudflare sandbox boundary', () => {
  it('clones without file filters and revokes bootstrap credentials before executing repository commands', async () => {
    const f = fixture(), result = await f.sandbox.run(task);
    const [argv, opts] = f.container.exec.mock.calls.find(([args]) => args.includes('clone'))!;
    expect(argv).toEqual(expect.arrayContaining(['clone', '--no-checkout', '--no-local', '--template=', task.remote]));
    expect(argv.join(' ')).not.toMatch(/--depth|--filter|--sparse/);
    expect(opts.env?.BRAID_CLONE_TOKEN).toBe('read-only-secret');
    for (const [args, options] of f.container.exec.mock.calls) {
      expect(options.user).toBe('0:0');
      const child = args[0] === '/usr/local/bin/node' ? (JSON.parse(args.at(-1)!) as { argv: string[] }).argv : args;
      expect(child.slice(0, 9)).toEqual(['/usr/bin/setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--']);
      expect(options.env?.HOME).toBe('/home/node');
    }
    for (const [args, options] of f.container.exec.mock.calls.filter(([args]) => !args.includes('clone'))) {
      expect(JSON.stringify([args, options])).not.toContain('read-only-secret');
    }
    expect(f.container.start).toHaveBeenCalledExactlyOnceWith({ image: 'test-image', enableInternet: true, instance: 'standard-2' });
    expect(f.container.destroy).toHaveBeenCalledTimes(2);
    expect(f.container.destroy.mock.invocationCallOrder[0]).toBeLessThan(f.container.start.mock.invocationCallOrder[0]);
    expect(result.files).toEqual(files);
    expect(result.checks).toContainEqual(expect.objectContaining({ label: 'npm test', status: 'passed', detail: expect.stringContaining('exit 0') }));
    expect(JSON.stringify(f.ai.run.mock.calls)).not.toContain('read-only-secret');
  });
  it('recovers an identical completed result after eviction without repeating commands', async () => {
    const f = fixture(), first = await f.sandbox.run(task);
    const resumed = new AgentSandbox(f.ctx, f.env);
    expect(await resumed.run(task)).toEqual(first);
    expect(f.container.start).toHaveBeenCalledTimes(1);
    await expect(resumed.run({ ...task, baseCommit: 'b'.repeat(40) })).rejects.toThrow('identity changed');
  });
  it('destroys a failed checkout and revokes its read token without calling the model', async () => {
    const f = fixture(); f.failClone();
    await expect(f.sandbox.run(task)).rejects.toThrow('full repository checkout');
    expect(f.repo.revokeToken).toHaveBeenCalledTimes(1);
    expect(f.container.destroy).toHaveBeenCalledTimes(2);
    expect(f.ai.run).not.toHaveBeenCalled();
  });
  it('rechecks owner authorization and tears down when access is revoked', async () => {
    const f = fixture(); f.checkpoint.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Owner access revoked'));
    await expect(f.sandbox.run(task)).rejects.toThrow('Owner access revoked');
    expect(f.container.destroy).toHaveBeenCalledTimes(1);
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.ai.run).not.toHaveBeenCalled();
  });
  it.each(['http://account.artifacts.cloudflare.net/git/braid/project.git', 'https://evil.example/project.git', 'https://token@account.artifacts.cloudflare.net/git/braid/project.git', 'https://account.artifacts.cloudflare.net/git/braid/project.git?token=x'])('does not send read credentials to an untrusted remote %s', async remote => {
    const f = fixture(); await expect(f.sandbox.run({ ...task, remote })).rejects.toThrow('full repository checkout');
    expect(f.repo.createToken).not.toHaveBeenCalled(); expect(f.container.start).not.toHaveBeenCalled();
  });
});

describe('agent tool execution and evidence', () => {
  it('keeps actual failed checks and ignores test claims in the model finish response', async () => {
    const ai = { run: vi.fn().mockResolvedValueOnce(exec('check', 'npm test')).mockResolvedValueOnce(tool('finish', { summary: 'All tests pass', rationale: 'Model claim', checks: [{ status: 'passed' }], files: [{ path: 'invented.txt', content: 'wrong' }] })) };
    const result = await runAgentLoop(task, ai as unknown as Ai, { checkpoint: async () => {}, exec: async () => ({ stdout: '', stderr: '1 test failed', exitCode: 1, truncated: false }), collect: async () => files }, Date.now() + 60_000);
    expect(result.files).toEqual(files);
    expect(result.checks[0]).toMatchObject({ label: 'npm test', status: 'failed', detail: expect.stringContaining('1 test failed') });
  });
  it('allows a failed command to be corrected and actually rerun', async () => {
    const ai = { run: vi.fn().mockResolvedValueOnce(exec('check', 'npm test')).mockResolvedValueOnce(exec()).mockResolvedValueOnce(exec('check', 'npm test')).mockResolvedValueOnce(finish()) };
    const command = vi.fn().mockResolvedValueOnce({ stdout: '', stderr: 'failed', exitCode: 1, truncated: false }).mockResolvedValue({ stdout: 'passed', stderr: '', exitCode: 0, truncated: false });
    const result = await runAgentLoop(task, ai as unknown as Ai, { checkpoint: async () => {}, exec: command, collect: async () => files }, Date.now() + 60_000);
    expect(result.checks).toHaveLength(1); expect(result.checks[0].status).toBe('passed'); expect(command).toHaveBeenCalledTimes(3);
  });
  it('does not accept a prose-only or immediate finish as completed repository work', async () => {
    const ai = { run: vi.fn().mockResolvedValueOnce(finish()).mockResolvedValueOnce(exec()).mockResolvedValueOnce(finish()) };
    const command = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }));
    const result = await runAgentLoop(task, ai as unknown as Ai, { checkpoint: async () => {}, exec: command, collect: async () => files }, Date.now() + 60_000);
    expect(command).toHaveBeenCalledTimes(1); expect(result.checks[0].status).toBe('warning');
  });
});


describe('owner instructions during a cloud task', () => {
  const instruction = { id: 'note-1', title: 'Task instruction', body: 'Keep the public API unchanged.', kind: 'constraint' as const, author: 'Maya', createdAt: new Date().toISOString(), missionId: task.missionId };
  const command = async () => ({ stdout: 'checked', stderr: '', exitCode: 0, truncated: false });

  it('delivers each instruction once on the next context read', async () => {
    const messages: { role: string; content?: string }[][] = [];
    const replies = [exec(), exec('check'), finish()];
    let checkpointCount = 0;
    const ai = { run: vi.fn(async (_model: unknown, input: { messages: { role: string; content?: string }[] }) => { messages.push(structuredClone(input.messages)); return replies.shift(); }) };
    await runAgentLoop(task, ai as unknown as Ai, {
      checkpoint: async () => ++checkpointCount >= 3 ? [instruction] : [],
      exec: command, collect: async () => files,
    }, Date.now() + 60_000);
    expect(messages[0][1].content).not.toContain(instruction.body);
    for (const turn of messages.slice(1)) expect(turn[1].content?.split(instruction.body)).toHaveLength(2);
  });

  it('defers finish when steering arrives after the last model turn', async () => {
    const messages: { role: string; content?: string }[][] = [];
    const replies = [exec(), finish(), exec('check'), finish()];
    let delivered = false;
    const collect = vi.fn(async () => files);
    const ai = { run: vi.fn(async (_model: unknown, input: { messages: { role: string; content?: string }[] }) => { messages.push(structuredClone(input.messages)); return replies.shift(); }) };
    await runAgentLoop(task, ai as unknown as Ai, {
      checkpoint: async message => { if (message === 'Preparing the completed changes') delivered = true; return delivered ? [instruction] : []; },
      exec: command, collect,
    }, Date.now() + 60_000);
    expect(ai.run).toHaveBeenCalledTimes(4);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(messages[2].at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('Address it before finishing') });
    expect(messages[2][1].content).toContain(instruction.body);
  });

  it('retains steering when the tool transcript is trimmed', async () => {
    const messages: { role: string; content?: string }[][] = [];
    const replies = [exec(), exec(), finish()];
    const ai = { run: vi.fn(async (_model: unknown, input: { messages: { role: string; content?: string }[] }) => { messages.push(structuredClone(input.messages)); return replies.shift(); }) };
    await runAgentLoop(task, ai as unknown as Ai, {
      checkpoint: async () => [instruction],
      exec: async () => ({ stdout: 'x'.repeat(250_000), stderr: '', exitCode: 0, truncated: false }), collect: async () => files,
    }, Date.now() + 60_000);
    expect(messages[2][1].content).toContain(instruction.body);
    expect(messages[2][1].content?.split(instruction.body)).toHaveLength(2);
  });
});
