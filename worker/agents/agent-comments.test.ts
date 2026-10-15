import { expect, it, vi } from 'vitest';
import { runAgentLoop, type SandboxTask } from './loop';
import { reviewComments } from '../test/review-comments';

it('gives a cloud agent unresolved review conversations, replies and outdated locations when it revises', async () => {
  const task: SandboxTask = { workspaceId: 'workspace', missionId: 'mission', agentId: 'agent', repo: 'relay', remote: 'https://git.example/relay',
    baseCommit: 'a'.repeat(40), model: 'test', title: 'Fix the parser', intent: 'Handle empty input.', role: 'Coding agent', task: 'Revise the pull request.', scope: ['src/'], context: [], reviewComments };
  const tool = (name: string, args: unknown) => ({ response: '', tool_calls: [{ id: name, function: { name, arguments: JSON.stringify(args) } }] });
  const ai = { run: vi.fn().mockResolvedValueOnce(tool('exec', { command: 'npm test', purpose: 'check', timeout: 30 }))
    .mockResolvedValueOnce(tool('finish', { summary: 'Fixed empty input.', rationale: 'Addresses the review.' })) };
  await runAgentLoop(task, ai as unknown as Ai, { exec: async () => ({ stdout: 'Passed', stderr: '', exitCode: 0, truncated: false }), collect: async () => [], checkpoint: async () => {} }, Date.now() + 60_000);
  const input = JSON.stringify(ai.run.mock.calls[0][1]);
  expect(input).toContain('Unresolved review comments to address:');
  expect(input).toContain('src/parser.ts:14 (RIGHT; revision 1)');
  expect(input).toContain('Handle **empty input** before parsing.');
  expect(input).toContain('Reply to rc_open by GPT-6 Astra for @maya');
  expect(input).toContain('src/retry.ts:6 (LEFT, Outdated; revision 1)');
  expect(input).not.toContain('Already addressed.');
});
