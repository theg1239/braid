import { afterEach, expect, it, vi } from 'vitest';
import { runAgentLoop, type SandboxTask } from './loop';

const task: SandboxTask = { workspaceId: 'workspace', missionId: 'mission', agentId: 'coder', repo: 'project', remote: 'https://git.example/repo', baseCommit: 'a'.repeat(40), model: 'test', title: 'Complete the dependent task', intent: 'Build the feature', role: 'Coder', task: 'Implement', scope: ['*'], context: [] };
const call = (name: string, args: unknown) => ({ choices: [{ message: { content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const tools = { exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, truncated: false }), collect: vi.fn(async () => [{ path: 'child.ts', content: 'child\n' }]), checkpoint: async () => {} };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); tools.collect.mockClear(); });
function agent(dependsOn: unknown) { return { run: vi.fn().mockResolvedValueOnce(call('exec', { command: 'npm test', purpose: 'check', timeout: 30 })).mockResolvedValueOnce(call('finish', { summary: 'Done', rationale: 'Builds on the prerequisite', dependsOn })) }; }

it('passes dependencies through hosted finish and includes stale prerequisites in task context', async () => {
  const dependency = { id: 'ch_1123456789abc', number: 51, status: 'open' as const };
  const ai = agent([51]);
  const result = await runAgentLoop({ ...task, pullRequest: { id: 'ch_0123456789abc', number: 73, status: 'revise', next: 'Restack this pull request.', dependsOn: [dependency], outdated: [dependency] } }, ai as unknown as Ai, tools, Date.now() + 60_000);
  expect(result).toMatchObject({ dependsOn: [51], files: [{ path: 'child.ts' }], checks: [{ status: 'passed' }] });
  const input = ai.run.mock.calls[0][1];
  expect(input.messages[1].content).toContain('#51 changed since this was built');
  expect(input.messages[1].content).toContain('Depends on #51');
  expect(input.messages[1].content).toContain('Restack this pull request.');
  expect(input.tools.find((item: { function: { name: string } }) => item.function.name === 'finish').function.parameters.properties.dependsOn.maxItems).toBe(16);
});
it.each([[0], ['missing'], Array(17).fill(1)])('rejects invalid hosted dependencies before collecting files: %j', async dependsOn => {
  tools.collect.mockClear();
  await expect(runAgentLoop(task, agent(dependsOn) as unknown as Ai, tools, Date.now() + 60_000)).rejects.toMatchObject({ failure: { cause: 'provider', evidence: { reason: 'invalid_tool' } } });
  expect(tools.collect).not.toHaveBeenCalled();
});

it('retries a capacity refusal on the same model turn without repeating completed commands', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ai = { run: vi.fn()
    .mockResolvedValueOnce(call('exec', { command: 'npm test', purpose: 'check', timeout: 30 }))
    .mockRejectedValueOnce(new Error('3040: private upstream diagnostic'))
    .mockResolvedValueOnce(call('finish', { summary: 'Done', rationale: 'Verified' })) };
  const exec = vi.fn(tools.exec), checkpoint = vi.fn(tools.checkpoint);
  const result = runAgentLoop(task, ai as unknown as Ai, { ...tools, exec, checkpoint }, Date.now() + 60_000);
  const assertion = expect(result).resolves.toMatchObject({ checks: [{ status: 'passed' }] });
  void assertion.catch(() => {});
  await vi.runAllTimersAsync(); await assertion;
  expect(exec).toHaveBeenCalledTimes(1);
  expect(ai.run).toHaveBeenCalledTimes(3);
  expect(ai.run.mock.calls[2][0]).toBe(task.model);
  expect(ai.run.mock.calls[2][1]).toEqual(ai.run.mock.calls[1][1]);
  expect(checkpoint).toHaveBeenCalledWith(expect.stringContaining('Retrying'));
});

it('bounds a hung Workers AI call by the task deadline and aborts it', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ai = { run: vi.fn((_model: unknown, _input: unknown, _options: { signal: AbortSignal }) => new Promise(() => {})) };
  const result = runAgentLoop(task, ai as unknown as Ai, tools, Date.now() + 1000);
  let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
  const assertion = expect(result).rejects.toMatchObject({ failure: { cause: 'timeout', evidence: { limitKind: 'task', timeoutMs: 27 * 60_000 } } });
  await vi.advanceTimersByTimeAsync(1001);
  expect(settled).toBe(true);
  await assertion;
  expect(ai.run.mock.calls[0][2].signal.aborted).toBe(true);
  expect(tools.collect).not.toHaveBeenCalled();
});

it.each([{}, { choices: [] }, { error: 'private provider diagnostic' }, { choices: [{ message: {} }] }, { response: '', tool_calls: [] }])('rejects an empty or error-shaped model answer immediately: %j', async answer => {
  const ai = { run: vi.fn().mockResolvedValue(answer) };
  await expect(runAgentLoop(task, ai as unknown as Ai, tools, Date.now() + 60_000)).rejects.toThrow(/invalid response.*Start again/);
  expect(ai.run).toHaveBeenCalledTimes(1);
  expect(tools.collect).not.toHaveBeenCalled();
});

it('stops after three capacity retries and records only safe diagnostic fields', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ai = { run: vi.fn().mockRejectedValue(new Error('3040: private provider diagnostic')) };
  const result = expect(runAgentLoop(task, ai as unknown as Ai, tools, Date.now() + 60_000)).rejects.toThrow(/temporarily at capacity.*Start again/);
  void result.catch(() => {});
  await vi.runAllTimersAsync(); await result;
  expect(ai.run).toHaveBeenCalledTimes(4);
  expect(warning).toHaveBeenCalledTimes(4);
  expect(JSON.parse(warning.mock.calls[3][0])).toMatchObject({ event: 'hosted_operation_failed', cause: 'provider', phase: 'model', retries: 3 });
  expect(JSON.stringify(warning.mock.calls)).not.toContain('private provider diagnostic');
  expect(vi.getTimerCount()).toBe(0);
});

it('rechecks authorization during inference backoff before sending another request', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ai = { run: vi.fn().mockRejectedValue(new Error('3040: capacity')) };
  const checkpoint = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValue(new Error('Owner access revoked'));
  const result = expect(runAgentLoop(task, ai as unknown as Ai, { ...tools, checkpoint }, Date.now() + 60_000)).rejects.toThrow('Owner access revoked');
  void result.catch(() => {});
  await vi.runAllTimersAsync(); await result;
  expect(ai.run).toHaveBeenCalledTimes(1);
});

it('does not retry an exhausted Workers AI daily allowance within the model turn', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ai = { run: vi.fn().mockRejectedValue(new Error('3036: private provider diagnostic')) };
  await expect(runAgentLoop(task, ai as unknown as Ai, tools, Date.now() + 60_000)).rejects.toThrow(/usage limit.*Start again.*another agent/);
  expect(ai.run).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warning.mock.calls)).not.toContain('private provider diagnostic');
});
it('records an observed turn limit without inventing a timeout', async () => {
  const ai = { run: vi.fn(async () => ({ choices: [{ message: { content: 'Continue reading.' } }] })) };
  await expect(runAgentLoop(task, ai as unknown as Ai, tools, Date.now() + 60_000)).rejects.toMatchObject({ failure: { cause: 'command', evidence: { reason: 'turn_limit' } } });
  expect(ai.run).toHaveBeenCalledTimes(96);
});

it('prepares a repository from what it declares, and reports each setup command as it ran', async () => {
  const ai = { run: vi.fn()
    .mockResolvedValueOnce(call('exec', { command: 'mise use -g go@1.24', purpose: 'setup', timeout: 120 }))
    .mockResolvedValueOnce(call('exec', { command: 'go mod download', purpose: 'setup', timeout: 120 }))
    .mockResolvedValueOnce(call('finish', { summary: 'Done', rationale: 'Documented' })) };
  const exec = vi.fn(async (command: string) => ({ stdout: '', stderr: '', exitCode: command.startsWith('go mod') ? 1 : 0, truncated: false }));
  const report = vi.fn(async () => {}), save = vi.fn();
  const preflight = { commit: task.baseCommit, checks: [], runtimes: [{ name: 'Go' as const, version: '1.24', path: 'go.mod' }], lockfiles: ['go.sum'], missing: [] };
  await runAgentLoop({ ...task, preflight }, ai as unknown as Ai, { ...tools, exec, report, save }, Date.now() + 60_000);
  // The repository's own declarations reach the agent as facts.
  expect(ai.run.mock.calls[0][1].messages[1].content).toContain('No setup commands are configured: prepare the repository yourself.\nDeclared runtimes: Go 1.24 (go.mod)\nLockfiles: go.sum');
  expect(report).toHaveBeenLastCalledWith('Preparing the repository', { status: 'running', prepared: [{ command: 'mise use -g go@1.24', status: 'passed' }, { command: 'go mod download', status: 'failed' }] });
  // A restarted run keeps what was prepared.
  expect(save.mock.lastCall![0].prepared).toEqual([['mise use -g go@1.24', 'passed'], ['go mod download', 'failed']]);
});

it('sends every reply back as the model gave it, prose included, so Anthropic keeps its thinking', async () => {
  const thinking = [{ type: 'thinking', thinking: '', signature: 'signed' }, { type: 'text', text: 'Looking first.' }];
  const ai = { run: vi.fn()
    .mockResolvedValueOnce({ choices: [{ message: { content: 'Looking first.', anthropic_content: thinking, reasoning_content: 'why' } }] })
    .mockResolvedValueOnce(call('exec', { command: 'ls', purpose: 'work', timeout: 10 }))
    .mockResolvedValueOnce(call('finish', { summary: 'Done', rationale: 'Checked' })) };
  await runAgentLoop(task, ai as unknown as Ai, tools, Date.now() + 60_000);
  expect(ai.run.mock.calls[1][1].messages[2]).toEqual({ role: 'assistant', content: 'Looking first.', anthropic_content: thinking, reasoning_content: 'why' });
  // A tool call goes back the same way, with no empty fields left over.
  expect(ai.run.mock.calls[2][1].messages[4]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'exec' }] });
});
