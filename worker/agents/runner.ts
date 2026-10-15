import { artifactsOf, type BraidEnv } from '../env';
import { ContentStore } from '../workspace/content';
import { artifactsRemote, gitEnv, gitOptions, privilegeProbe, runCommand } from './container';
import { now } from '../workspace/domain';
import { logFailure } from '../errors';

export interface VerifyJob {
  id: string; repo: string; remote: string; commit: string;
  /** Prepares dependencies; its failure is reported separately from check failures. */
  install?: string;
  checks: string[];
  timeoutMs: number;
  /** Main without this batch. When checks fail, the failing ones run again here to tell a broken main from a broken change. */
  baseline?: string;
}
export interface VerifiedCheck { command: string; exitCode: number; durationMs: number; output: string; truncated: boolean; phase: 'install' | 'check' }
export interface VerifyResult {
  id: string; commit: string;
  /** `error` means Braid could not run the checks, which never blames a change. */
  status: 'passed' | 'failed' | 'error';
  checks: VerifiedCheck[]; startedAt: string; finishedAt: string; error?: string;
  /** The failing commands that also fail on the baseline commit, so the batch did not cause them. */
  baseline?: { commit: string; failing: string[] };
}

const OUTPUT_TAIL = 4000;

/**
 * Runs a repository's own install and check commands against one composed
 * commit in a fresh, unprivileged container. Each job gets its own sandbox
 * object; retries reuse the stored result instead of running the commands twice.
 */
export async function runVerification(ctx: DurableObjectState, env: BraidEnv, content: ContentStore, job: VerifyJob): Promise<VerifyResult> {
  const saved = content.get<VerifyResult>(`verify:${job.id}`);
  if (saved) return saved;
  const startedAt = now();
  const failure = (error: string): VerifyResult => ({ id: job.id, commit: job.commit, status: 'error', checks: [], startedAt, finishedAt: now(), error });
  const container = ctx.container;
  if (!container?.images.agent) return failure('Cloudflare sandbox execution is not configured for this deployment.');
  if (!artifactsRemote(job.remote) || !/^[a-f0-9]{40}$/.test(job.commit) || !job.checks.length) return failure('The verification job is invalid.');
  const deadline = Date.now() + job.timeoutMs;
  // An interrupted call must not leave compute running.
  await ctx.storage.setAlarm(deadline + 120_000);
  await container.destroy();
  const checks: VerifiedCheck[] = [];
  const finish = (result: VerifyResult) => { content.put(`verify:${job.id}`, result); return result; };
  try {
    container.start({ image: container.images.agent, enableInternet: true, instance: 'standard-2' });
    await container.setInactivityTimeout(5 * 60_000);
    using repo = await artifactsOf(env).get(job.repo);
    const token = await repo.createToken('read', 600);
    try {
      // No repository code runs while the credential exists; hooks and redirects are disabled.
      const clone = await runCommand(container, ['git', ...gitOptions, 'clone', '--no-checkout', '--no-local', '--template=', '--', job.remote, '/workspace/repository'], 5 * 60_000,
        { ...gitEnv, GIT_ASKPASS: '/opt/braid/askpass.sh', BRAID_CLONE_TOKEN: token.plaintext.split('?expires=')[0] }, '/workspace');
      if (clone.exitCode !== 0) return failure('The repository could not be cloned for verification.');
    } finally { await repo.revokeToken(token.plaintext).catch(() => { /* It lapses in ten minutes anyway. */ }); }
    const checkout = await runCommand(container, ['git', ...gitOptions, 'checkout', '--detach', '--no-recurse-submodules', job.commit, '--'], 180_000, gitEnv);
    if (checkout.exitCode !== 0) return failure('The composed commit could not be checked out.');
    const probe = await runCommand(container, ['node', '--input-type=module', '-e', privilegeProbe], 60_000, gitEnv);
    if (probe.exitCode || probe.stdout.trim() !== job.commit) return failure('The verification sandbox could not be secured.');
    const run = async (command: string, phase: VerifiedCheck['phase']) => {
      const started = Date.now();
      const result = await runCommand(container, ['timeout', '--signal=TERM', '--kill-after=5s', `${Math.max(1, Math.floor((deadline - Date.now()) / 1000))}s`, 'bash', '-lc', command],
        Math.max(1000, deadline - Date.now()) + 6000, { ...gitEnv, CI: 'true', BRAID_VERIFY: '1' });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      const check = { command, exitCode: result.exitCode, durationMs: Date.now() - started, output: output.slice(-OUTPUT_TAIL), truncated: result.truncated || output.length > OUTPUT_TAIL, phase };
      checks.push(check);
      return check;
    };
    if (job.install) {
      const install = await run(job.install, 'install');
      // A failed install is reported like a failed check: narrowing finds whether one change caused it.
      if (install.exitCode !== 0) return finish({ id: job.id, commit: job.commit, status: 'failed', checks, startedAt, finishedAt: now() });
    }
    for (const command of job.checks) {
      if (Date.now() >= deadline) { checks.push({ command, exitCode: 124, durationMs: 0, output: 'Not run: the verification time budget was exhausted.', truncated: false, phase: 'check' }); continue; }
      await run(command, 'check');
    }
    const failed = checks.filter(check => check.phase === 'check' && check.exitCode !== 0 && check.exitCode !== 124).map(check => check.command);
    const result: VerifyResult = { id: job.id, commit: job.commit, status: checks.every(check => check.exitCode === 0) ? 'passed' : 'failed', checks, startedAt, finishedAt: now() };
    // Repository checks can leave untracked files, dependencies and background processes.
    // Main's evidence must come from a fresh container, never a checkout in that environment.
    if (failed.length && job.baseline && Date.now() < deadline) {
      const { baseline, ...candidate } = job;
      const again = await runVerification(ctx, env, content, { ...candidate, id: `${job.id}:baseline`, commit: baseline, checks: failed, timeoutMs: deadline - Date.now() });
      if (again.status !== 'error') result.baseline = { commit: baseline,
        failing: again.checks.filter(check => check.phase === 'check' && check.exitCode !== 0 && check.exitCode !== 124).map(check => check.command) };
    }
    return finish({ ...result, finishedAt: now() });
  } catch (error) {
    logFailure('verification_failed', error, { job: job.id });
    return failure('The verification sandbox stopped unexpectedly.');
  } finally { await container.destroy().catch(() => { /* The alarm set before the run stops it. */ }); }
}
