import { vi } from 'vitest';
import { storageFixture } from './storage';
import { startGitServer } from './git-server';
import { ChangeShard, type ChangeContext } from '../changes/shard';
import { Directory } from '../accounts/directory';
import { Trunk } from '../changes/trunk';
import { VerifyWorkflow } from '../changes/verify';
import { PathIndex } from '../changes/paths';
import { Swarm } from '../changes/swarm';
import { changeShardName, submissionShard, swarmName, trunkName } from '../changes/names';
import type { BraidEnv } from '../env';

/**
 * Wires the change store, landing queue and path index together in-process,
 * with a real Git server standing in for Artifacts. Alarms run only when a
 * test calls `settle()`, so every step is deterministic.
 */
import type { VerifyJob, VerifyResult } from '../agents/runner';

type Verifier = (job: VerifyJob, read: (path: string) => string | null) => Pick<VerifyResult, 'status' | 'checks'> | Promise<Pick<VerifyResult, 'status' | 'checks'>>;
export async function changeHarness(options: { review?: (input: unknown) => unknown; verify?: Verifier; env?: Record<string, string> } = {}) {
  const git = await startGitServer();
  const fixtures: ReturnType<typeof storageFixture>[] = [];
  const objects = new Map<string, ChangeShard | Trunk | PathIndex | Swarm>();
  const repository = 'team:t:repository:w';
  const workspace = {
    repository: vi.fn(async () => ({ id: 'repo', branch: 'main', remote: git.remote, head: git.native(['rev-parse', 'main']).trim() })),
    trunkAdvanced: vi.fn(async () => {}),
    taskChange: vi.fn(async (_task: string, _update: { id: string; status: string; commit?: string }) => {}),
  };
  let staleHead: string | undefined;
  const artifacts = {
    get: vi.fn(async () => ({
      [Symbol.dispose]() {},
      readCommit: (hash: string) => git.repository.readCommit(hash),
      readTree: (hash: string) => git.repository.readTree(hash),
      readBlob: (hash: string) => git.repository.readBlob(hash),
      log: vi.fn(async (options: { ref: string; limit?: number; offset?: number }) => {
        if (staleHead) { const head = staleHead; staleHead = undefined; return [{ hash: head }]; }
        return git.repository.log(options);
      }),
      createToken: vi.fn(async () => ({ plaintext: 'fixture-token' })),
      revokeToken: vi.fn(async () => true),
    })),
  };
  // Embeddings: a deterministic bag of words, so equal wording means high similarity.
  const embed = (text: string) => {
    const vector = new Array(128).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) { let hash = 0; for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; vector[hash % 128] += 1; }
    return vector;
  };
  const ai = { run: vi.fn(async (model: string, input: unknown) => model.includes('bge') ? { data: (input as { text: string[] }).text.map(embed) }
    : options.review ? options.review(input) : { choices: [{ message: { content: JSON.stringify({ verdict: 'approve', risk: 'low', summary: 'The change matches its intent.', findings: [] }) } }] }) };
  const namespace = <T>(create: (ctx: DurableObjectState) => T) => ({
    getByName(name: string) {
      if (!objects.has(name)) {
        const fixture = storageFixture();
        fixtures.push(fixture);
        objects.set(name, create(fixture.ctx) as ChangeShard);
      }
      return objects.get(name) as T;
    },
  });
  const verifications: { repository: string; batchId: string; job: VerifyJob }[] = [];
  const verifiedJobs: VerifyJob[] = [];
  const env = {
    AUTH_MODE: 'owner-key', LIVE_ENABLED: 'true', AI_MODEL: '@cf/test/model', REVIEW_MODEL: '@cf/test/reviewer', ...options.env,
    ARTIFACTS: artifacts, AI: ai,
    WORKSPACES: { getByName: () => workspace },
    VERIFICATIONS: { create: vi.fn(async ({ params }: { params: { repository: string; batchId: string; job: VerifyJob } }) => { verifications.push(params); return { id: params.batchId }; }) },
  } as unknown as BraidEnv;
  const peopleStore = storageFixture(); fixtures.push(peopleStore);
  const directory = new Directory(peopleStore.ctx, env);
  Object.assign(env, {
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory },
    CHANGES: namespace(ctx => new ChangeShard(ctx, env)),
    TRUNKS: namespace(ctx => new Trunk(ctx, env)),
    PATHS: namespace(ctx => new PathIndex(ctx, env)),
    SWARMS: namespace(ctx => new Swarm(ctx, env)),
  });
  const trunk = (env.TRUNKS as unknown as { getByName(name: string): Trunk }).getByName(trunkName(repository));
  const shard = (index: number) => (env.CHANGES as unknown as { getByName(name: string): ChangeShard }).getByName(changeShardName(repository, index));
  const swarm = (env.SWARMS as unknown as { getByName(name: string): Swarm }).getByName(swarmName(repository));
  const agent = (name: string) => ({ kind: 'agent' as const, id: `agent:${name}`, name });
  let keys = 0;
  return {
    git, env, ai, workspace, artifacts, repository, trunk, shard, swarm, verifications, verifiedJobs,
    staleHeadOnce(head: string) { staleHead = head; },
    head: () => git.native(['rev-parse', 'main']).trim(),
    /** Submits through the same shard selection the router uses. */
    async submit(author: string | ChangeContext['actor'], body: Record<string, unknown>) {
      const actor = typeof author === 'string' ? agent(author) : author;
      const key = `test-request-key-${++keys}-padding`;
      const index = submissionShard(`${actor.id}:${key}`);
      return shard(index).submit({ repository, shard: index, actor }, body, key);
    },
    context(author: string | ChangeContext['actor'], index: number): ChangeContext {
      return { repository, shard: index, actor: typeof author === 'string' ? agent(author) : author };
    },
    /** Runs every pending alarm until the system is idle. */
    async settle(rounds = 6) {
      for (let round = 0; round < rounds; round++) {
        // Stand-in for the verification workflow: run the verifier on the composed commit, then report.
        for (const pending of verifications.splice(0)) {
          verifiedJobs.push(pending.job);
          const read = (path: string) => { try { return git.native(['show', `${pending.job.commit}:${path}`]); } catch { return null; } };
          const verifier = options.verify ?? ((job: VerifyJob) => ({ status: 'passed' as const, checks: [
            ...(job.install ? [{ command: job.install, phase: 'install' as const }] : []),
            ...job.checks.map(command => ({ command, phase: 'check' as const })),
          ].map(check => ({ ...check, exitCode: 0, durationMs: 10, output: 'ok', truncated: false })) }));
          const outcome = await verifier(pending.job, read);
          // Like the runner: failing checks run again on main without the batch.
          let baseline: { commit: string; failing: string[] } | undefined;
          const failing = outcome.checks.filter(check => check.phase === 'check' && check.exitCode !== 0).map(check => check.command);
          if (outcome.status === 'failed' && failing.length && pending.job.baseline) {
            const readBase = (path: string) => { try { return git.native(['show', `${pending.job.baseline}:${path}`]); } catch { return null; } };
            const again = await verifier({ ...pending.job, commit: pending.job.baseline }, readBase);
            baseline = { commit: pending.job.baseline, failing: again.checks.filter(check => failing.includes(check.command) && check.exitCode !== 0).map(check => check.command) };
          }
          // Exercise the real Workflow result copy and reporting path; only the sandbox runner is a stand-in.
          const workflowEnv = { ...env, TRUNKS: { getByName: () => ({
            runVerification: async () => ({ id: pending.job.id, commit: pending.job.commit, startedAt: '', finishedAt: '', ...outcome, ...(baseline ? { baseline } : {}), [Symbol.dispose]() {} }),
            verified: (repository: string, batchId: string, result: VerifyResult) => trunk.verified(repository, batchId, result),
          }) } } as unknown as BraidEnv;
          const step = { do: async (_name: string, config: unknown, callback: (ctx: unknown) => Promise<unknown>) => structuredClone(await callback({ attempt: 1, config })) };
          await new VerifyWorkflow({} as never, workflowEnv).run({ payload: pending } as never, step as never);
        }
        await swarm.alarm();
        for (const object of [...objects.values()]) if (object instanceof ChangeShard) await object.alarm();
        await trunk.alarm();
      }
    },
    async close() { for (const fixture of fixtures) fixture.db.close(); await git.close(); },
  };
}
