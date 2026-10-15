import { expect, it } from 'vitest';
import type { HostedEnvironment } from '../../shared/types';
import { hostedCommand } from './hosted-command';
import { retryHosted } from './hosted-failures';
import { FakeHostedAi, FakeHostedContainer, finishTurn, hostedTask, prepareTurn, workTurn } from './hosted-test-runtime';
import { runAgentLoop, type AgentLoopCheckpoint } from './loop';
import { collectSandboxResult } from './sandbox-collection';

it('recovers the browser fixture after preparation and an edit without repeating that edit', async () => {
  const first = prepareTurn();
  first.choices[0].message.tool_calls.push(...workTurn().choices[0].message.tool_calls);
  const runtime = new FakeHostedContainer(), ai = new FakeHostedAi(first);
  runtime.startFailures = [new Error('injected container start rejection')];
  ai.answers = [new Response('{}', { status: 503 }), finishTurn()];
  const task = { ...hostedTask, provider: undefined, repository: { manifests: [], lockfiles: [], instructions: [], omitted: 0 } };
  const updates: HostedEnvironment[] = [];
  const report = async (_message: string, environment?: HostedEnvironment) => { if (environment) updates.push(environment); };
  const counts = new Map<string, number>();
  const attempts = (key: string) => ({ read: () => counts.get(key) ?? 0, write: (value: number) => { counts.set(key, value); } });
  let saved: AgentLoopCheckpoint | undefined;
  const deadline = Date.now() + 60_000;
  const run = async () => {
    await retryHosted(async () => { runtime.start(); }, { deadline, phase: 'start', operation: 'container start', report, authorize: async () => {}, attempts: attempts('start') });
    return runAgentLoop(task, ai as unknown as Ai, { report, attempts,
      checkpoint: async () => {}, load: () => saved, save: value => { saved = structuredClone(value); },
      exec: (command, timeout, id) => hostedCommand(runtime as unknown as Container, `fixture:${id}`, ['bash', '-c', command], timeout, {}),
      collect: async id => collectSandboxResult(await hostedCommand(runtime as unknown as Container, `fixture:collect:${id}`, ['/usr/local/bin/node', '/opt/braid/collect.mjs', task.baseCommit], 10_000, {})),
    }, deadline);
  };
  await expect(run()).resolves.toMatchObject({ files: [{ path: 'fixture.txt', content: 'recovered\n' }] });
  expect(runtime.starts).toBe(2);
  expect(ai.calls).toBe(3);
  expect(runtime.executions.filter(argv => argv.includes('bash')).map(argv => argv.slice(-3))).toEqual([['bash', '-c', 'edit-fixture']]);
  expect(saved?.preparation?.noTestsReason).toBe('The fixture has no test suite.');
  expect(saved?.commands).toBe(1);
  expect(updates.filter(update => update.status === 'retrying').map(update => update.failure?.phase)).toEqual(['start', 'model']);
  expect(updates.find(update => update.failure?.phase === 'model')?.failure?.evidence.status).toBe(503);
});
