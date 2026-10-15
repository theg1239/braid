import { expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { BraidEnv, RunParams } from '../env';
import { MissionWorkflow } from '../workspace/workflow';
import { failure } from './hosted-failures';

function fixture() {
  const workspace = { runAgent: vi.fn(), hostedWorkflowFailure: vi.fn(), failAgent: vi.fn(), finishMission: vi.fn() };
  const env = { WORKSPACES: { idFromString: (id: string) => id, get: () => workspace } } as unknown as BraidEnv;
  const steps: { name: string; options: unknown }[] = [];
  const sleep = vi.fn(async () => {});
  const step = { do: async (name: string, options: unknown, run?: () => Promise<unknown>) => {
    steps.push({ name, options }); return typeof options === 'function' ? options() : run!();
  }, sleep } as unknown as WorkflowStep;
  const run = () => new MissionWorkflow({} as ExecutionContext, env).run({ payload: { workspaceId: 'w', missionId: 'm', action: 'run', agentIds: ['a'], operationId: 'stable-operation' } } as WorkflowEvent<RunParams>, step);
  return { workspace, run, steps, sleep };
}
it('bounds real rejected Workflow steps to the initial attempt and three durable backoffs', async () => {
  const f = fixture(); f.workspace.runAgent.mockRejectedValue(new Error('opaque runtime rejection'));
  await f.run();
  expect(f.workspace.runAgent).toHaveBeenCalledTimes(4);
  expect(f.sleep.mock.calls).toEqual([['backoff a 1', '1 seconds'], ['backoff a 2', '2 seconds'], ['backoff a 3', '4 seconds']]);
  expect(f.workspace.hostedWorkflowFailure.mock.calls.map(call => call[3])).toEqual([1, 2, 3, 0]);
  expect(f.workspace.hostedWorkflowFailure.mock.calls.at(-1)?.[2]).toMatchObject({ cause: 'workflow_step', evidence: { source: 'workflow', step: 'run a retry 3' } });
  expect(f.steps.filter(step => step.name.startsWith('run ')).every(step => (step.options as { retries: { limit: number } }).retries.limit === 0)).toBe(true);
  expect(f.workspace.failAgent).toHaveBeenCalledTimes(1); expect(f.workspace.finishMission).toHaveBeenCalledTimes(1);
  for (const args of f.workspace.runAgent.mock.calls) expect(args).toEqual(['m', 'a', 'stable-operation']);
});
it('never retries a terminal environment result through Workflow', async () => {
  const f = fixture(); const reason = failure('install_failed', 'setup', { source: 'process', operation: 'npm ci', exitCode: 17 });
  f.workspace.runAgent.mockResolvedValue({ [Symbol.dispose]() {}, commit: null, failure: reason });
  await f.run(); expect(f.workspace.runAgent).toHaveBeenCalledTimes(1); expect(f.sleep).not.toHaveBeenCalled();
  expect(f.workspace.failAgent).toHaveBeenCalledExactlyOnceWith('m', 'a', reason.message, 'stable-operation');
});
