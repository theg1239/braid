import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { artifactsOf, type BraidEnv } from '../env';
import { digest } from '../http/auth';
import { ContentStore } from '../workspace/content';
import { runAgentLoop, type AgentLoopCheckpoint, type CommandResult, type SandboxResult, type SandboxTask } from './loop';
import { artifactsRemote, commandPassed, gitEnv, gitOptions, privilegeProbe, runCommand } from './container';
import { runVerification, type VerifyJob, type VerifyResult } from './runner';
import { collectSandboxResult } from './sandbox-collection';
import collectSource from '../../sandbox/collect.mjs?raw';
import type { HostedEnvironment, HostedFailure } from '../../shared/types';
import { failure, HostedFailureError, commandFailure, retryHosted, runtimeFailure } from './hosted-failures';
import { hostedCommand } from './hosted-command';
import { providerAttempt } from './provider-client';
import { networkProbe, networkProbeResult } from './hosted-network';
import { redactHostedText } from './hosted-output';
import inspectSource from '../../sandbox/inspect.py?raw';
import { repositoryInspection, SandboxCheckError, type RepositoryInspection } from './preparation';
import { logFailure } from '../errors';
import { COMMAND_TIMEOUT, TASK_MINUTES } from './hosted-limits';

const checkoutFailure = 'The full repository checkout could not be prepared in its sandbox. No proposal was published.';

/** One VM per task and agent. Only the trusted bootstrap ever receives a read token. */
export class AgentSandbox extends DurableObject<BraidEnv> {
  private active?: { signature: string; promise: Promise<SandboxResult> };
  private content: ContentStore;
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env); this.content = new ContentStore(ctx.storage);
  }
  async run(task: SandboxTask): Promise<SandboxResult> {
    const signature = await digest(JSON.stringify(task));
    const saved = this.content.get<{ signature: string; result: SandboxResult }>('sandbox-result');
    if (saved) {
      if (saved.signature !== signature) throw new Error('Sandbox task identity changed.');
      return saved.result;
    }
    const terminal = this.content.get<{ signature: string; failure: HostedFailure }>('sandbox-failure');
    if (terminal) {
      if (terminal.signature !== signature) throw new Error('Sandbox task identity changed.');
      throw new HostedFailureError(terminal.failure);
    }
    if (this.active) {
      if (this.active.signature !== signature) throw new Error('Sandbox task identity changed.');
      return this.active.promise;
    }
    const promise = this.execute(task, signature);
    this.active = { signature, promise };
    try { return await promise; }
    finally { if (this.active?.promise === promise) this.active = undefined; }
  }
  /** Runs a repository's checks on a composed landing batch; used by the verification workflow. */
  private verifying?: Promise<VerifyResult>;
  async verify(job: VerifyJob): Promise<VerifyResult> {
    this.verifying ??= runVerification(this.ctx, this.env, this.content, job).finally(() => { this.verifying = undefined; });
    return this.verifying;
  }
  async alarm() { await this.ctx.container?.destroy(); }

  private async execute(task: SandboxTask, signature: string): Promise<SandboxResult> {
    const container = this.ctx.container;
    const workspace = this.env.WORKSPACES.get(this.env.WORKSPACES.idFromString(task.workspaceId));
    const checkpoint = (message?: string) => workspace.sandboxCheckpoint(task.missionId, task.agentId, message);
    const report = (message: string, environment: HostedEnvironment) => workspace.sandboxCheckpoint(task.missionId, task.agentId, message, environment);
    const rejectConfiguration = async (reason: HostedFailure): Promise<never> => {
      reason.retryable = false;
      this.content.put('sandbox-failure', { signature, failure: reason });
      await report(reason.message, { status: 'failed', failure: reason });
      throw new HostedFailureError(reason);
    };
    if (!container || !container.images.agent) return rejectConfiguration(failure('container_start', 'start', { source: 'container', operation: 'container configuration', reason: 'missing_binding_or_image' }, '', 'Cloudflare sandbox execution is not configured.'));
    if (!task.provider && !this.env.AI) return rejectConfiguration(failure('provider', 'preflight', { source: 'workers_ai', operation: 'model configuration', code: 'missing_binding' }, '', 'Workers AI is not configured. Choose a connected provider or connect a local agent.'));
    if (!artifactsRemote(task.remote) || !/^[a-f0-9]{40}$/.test(task.baseCommit)) return rejectConfiguration(failure('command', 'checkout', { source: 'repository', operation: 'checkout configuration', reason: 'invalid_remote_or_commit' }, '', checkoutFailure));
    const saved = this.content.get<{ signature: string; deadline: number; ready: boolean }>('sandbox-session');
    if (saved && saved.signature !== signature) throw new Error('Sandbox task identity changed.');
    const taskLimit = (task.timeBudgetMinutes ?? TASK_MINUTES) * 60_000;
    const session = saved ?? { signature, deadline: Date.now() + taskLimit, ready: false };
    const deadline = session.deadline;
    let operation = 'preparing the repository';
    const taskTimeout = () => new HostedFailureError(failure('timeout', 'command', { source: 'process', operation, timedOut: true, limitKind: 'task', timeoutMs: taskLimit, elapsedMs: Math.max(0, taskLimit + Date.now() - deadline) }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const taskExpired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(taskTimeout()), Math.max(1, deadline - Date.now())); });
    void taskExpired.catch(() => {});
    const boundedTimeout = (milliseconds: number) => Math.max(1, Math.min(milliseconds * Math.max(1, Math.min(2, (task.timeBudgetMinutes ?? 27) / 27)), deadline - Date.now()));
    this.content.put('sandbox-session', session);
    const attempts = (key: string) => ({ read: () => this.content.get<number>(`retries:${key}`) ?? 0, write: (value: number) => this.content.put(`retries:${key}`, value) });
    // Every invocation keeps the original deadline, including after DO eviction.
    await this.ctx.storage.setAlarm(deadline + 60_000);
    let monitor: Promise<never> | undefined;
    let destroy = true;
    const observe = () => {
      monitor = container.monitor().then(() => { throw new HostedFailureError(failure('interrupted', 'command', { source: 'container', operation: 'monitor', exitCode: 0 })); }, error => { throw new HostedFailureError(runtimeFailure(error, session.ready ? 'command' : 'start', 'monitor')); });
      // Each awaited command races the same monitor. Keep cleanup from causing an unhandled rejection.
      void monitor.catch(() => {});
    };
    const observed = <T>(value: Promise<T>): Promise<T> => Promise.race([value, taskExpired, ...(monitor ? [monitor] : [])]);
    try {
      return await observed((async () => {
      await observed(checkpoint(session.ready ? 'Resuming the saved command checkpoint' : 'Preparing the full repository'));
      if (Date.now() >= deadline) throw taskTimeout();
      if (session.ready) {
        if (!container.running) throw new HostedFailureError(failure('interrupted', 'command', { source: 'container', operation: 'resume', reason: 'checkpoint_container_stopped' }));
        await observed(container.setInactivityTimeout(5 * 60_000));
        observe();
      } else {
        await retryHosted(async () => {
          await container.destroy();
          container.start({ image: container.images.agent, enableInternet: true, instance: 'standard-2' });
          observe();
          await observed(container.setInactivityTimeout(5 * 60_000));
          // start() is fire-and-forget; an actual exec establishes that the VM and image started.
          const ready = await observed(this.command(container, ['true'], boundedTimeout(60_000), gitEnv, '/workspace'));
          const problem = commandFailure(ready, 'start', 'startup probe');
          if (problem && problem.cause !== 'command') throw new HostedFailureError(problem);
          if (ready.exitCode !== 0) throw new HostedFailureError(failure('container_start', 'start', { source: 'container', operation: 'startup probe', exitCode: ready.exitCode }, ready.outputTail));
        }, { deadline, phase: 'start', operation: 'container start', authorize: checkpoint, report, attempts: attempts('start') });
        await retryHosted(async () => {
          const result = await observed(this.command(container, ['/usr/local/bin/node', '--input-type=module', '-e', networkProbe, new URL(task.remote).hostname], boundedTimeout(20_000), gitEnv, '/workspace'));
          networkProbeResult(result);
        }, { deadline, phase: 'checkout', operation: 'Git host TLS check', authorize: checkpoint, report, attempts: attempts('network') });
        operation = 'repository checkout';
        using repo = await artifactsOf(this.env).get(task.repo);
        if (Date.now() >= deadline) throw taskTimeout();
        const token = await repo.createToken('read', 600);
        try {
          if (Date.now() >= deadline) throw taskTimeout();
          // No repository code runs while the credential is present. Hooks, helpers and redirects are disabled.
          const clone = await observed(this.command(container, ['git', ...gitOptions, 'clone', '--no-checkout', '--no-local', '--template=', '--', task.remote, '/workspace/repository'], boundedTimeout(5 * 60_000), {
            ...gitEnv, GIT_ASKPASS: '/opt/braid/askpass.sh', BRAID_CLONE_TOKEN: token.plaintext.split('?expires=')[0],
          }, '/workspace'));
          const problem = commandFailure(clone, 'checkout', 'git clone');
          if (problem) throw new HostedFailureError({ ...problem, message: checkoutFailure });
        } finally { operation = 'revoking the checkout token'; await repo.revokeToken(token.plaintext).catch(error => logFailure('hosted_clone_token_revoke_failed', error)); }
        if (Date.now() >= deadline) throw taskTimeout();
        operation = 'git checkout';
        const checkout = await observed(this.command(container, ['git', ...gitOptions, 'checkout', '--detach', '--no-recurse-submodules', task.baseCommit, '--'], boundedTimeout(180_000), gitEnv));
        const problem = commandFailure(checkout, 'checkout', 'git checkout');
        if (problem) throw new HostedFailureError({ ...problem, message: checkoutFailure });
        const verify = await observed(this.command(container, ['/usr/local/bin/node', '--input-type=module', '-e', privilegeProbe], boundedTimeout(60_000), gitEnv));
        const verificationProblem = commandFailure(verify, 'checkout', 'checkout verification');
        if (verificationProblem) throw new HostedFailureError(verificationProblem);
        if (verify.exitCode || verify.stdout.trim() !== task.baseCommit) throw new HostedFailureError(failure('command', 'checkout', { source: 'process', operation: 'checkout verification', exitCode: verify.exitCode }, verify.outputTail, checkoutFailure));
        session.ready = true; this.content.put('sandbox-session', session);
      }
      await report('Repository ready', { status: 'running' });
      const execute = (command: string, timeout: number, id: string, phase: HostedFailure['phase'] = 'command') => retryHosted(async () => {
        operation = command;
        if (Date.now() >= deadline) throw taskTimeout();
        // Transport retries reuse this receipt. Only a confirmed failed command may get a new receipt.
        const generation = this.content.get<number>(`command-generation:${id}`) ?? 0;
        const result = await observed(hostedCommand(container, `${signature}:${id}:${generation}`, ['bash', '-c', command], Math.max(1, Math.min(timeout, deadline - Date.now())),
          { ...gitEnv, CI: 'true', PIP_DISABLE_PIP_VERSION_CHECK: '1', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Braid', GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: 'agents@braid.local' }));
        const problem = commandFailure(result, phase, command);
        if (Date.now() >= deadline) throw taskTimeout();
        if (problem && !['command', 'install_failed'].includes(problem.cause) && !(problem.cause === 'timeout' && Date.now() < deadline)) {
          if (problem.retryable) this.content.put(`command-generation:${id}`, generation + 1);
          throw new HostedFailureError(problem);
        }
        return result;
      }, { deadline, phase, operation: command, authorize: checkpoint, report, attempts: attempts(`command:${id}`) });
      let repository = this.content.get<RepositoryInspection>('sandbox-repository');
      if (!repository) {
        await checkpoint('Reading repository manifests');
        const inspected = await observed(this.command(container, ['/usr/bin/python3', '-I', '-c', inspectSource], boundedTimeout(60_000), gitEnv, '/workspace/repository', 128 * 1024));
        const problem = commandFailure(inspected, 'preflight', 'manifest inspection');
        if (problem) throw new HostedFailureError(problem);
        const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), repositoryInspection), inspected.stdout);
        if (inspected.truncated || !parsed.success) throw new HostedFailureError(failure('preflight', 'preflight', { source: 'repository', operation: 'manifest inspection', reason: 'invalid_inspection', truncated: inspected.truncated }));
        repository = parsed.output; this.content.put('sandbox-repository', repository);
      }
      let setupResult = this.content.get<CommandResult>('sandbox-setup-result');
      if (task.preflight?.setup && !setupResult && !this.content.get<boolean>('sandbox-setup-complete')) {
        await checkpoint('Running setup commands');
        // Leave time for the agent to repair an ordinary failed installation.
        setupResult = await execute(task.preflight.setup, Math.min(COMMAND_TIMEOUT, Math.max(1, (deadline - Date.now()) / 2)), 'setup', 'setup');
        this.content.put('sandbox-setup-result', setupResult);
        await report('Configured setup finished', { status: 'running', prepared: [{ command: redactHostedText(task.preflight.setup), status: commandPassed(setupResult) ? 'passed' : 'failed' }] });
      }
      const configuredChecks: SandboxResult['checks'] = [];
      const ai = task.provider ? { run: (_model: string, input: unknown, options: { signal: AbortSignal }) => providerAttempt(this.env, task.provider!, task.model, input, options.signal) } as unknown as Ai : this.env.AI;
      const result = await observed(runAgentLoop({ ...task, repository, setupResult }, ai, {
        checkpoint: message => { operation = message ?? 'model request'; return observed(checkpoint(message)); }, report, attempts,
        load: () => this.content.get<AgentLoopCheckpoint>('sandbox-loop'),
        save: state => this.content.put('sandbox-loop', state),
        exec: (command, timeout, id) => execute(command, timeout, `exec:${id}`),
        collect: async (id, checks) => {
          configuredChecks.length = 0;
          // The checks run on exactly the tree the collector is about to read.
          for (const [index, command] of [...new Set([...(task.preflight?.checks ?? []), ...(checks ?? [])])].entries()) {
            await checkpoint('Running configured checks');
            const check = await execute(command, boundedTimeout(COMMAND_TIMEOUT), `check:${id}:${index}`);
            configuredChecks.push({ kind: 'runtime', label: redactHostedText(command).slice(0, 400), status: commandPassed(check) ? 'passed' : 'failed', detail: `Executed in the Cloudflare sandbox; exit ${check.exitCode}.\n${check.outputTail ?? ''}` });
            if (!commandPassed(check)) throw new SandboxCheckError(configuredChecks, command, check.exitCode, check.outputTail ?? '', check);
          }
          const collected = await observed(hostedCommand(container, `${signature}:collect:${id}`, ['/usr/local/bin/node', '--input-type=module', '-e', collectSource, '/opt/braid/collect.mjs', task.baseCommit], Math.min(120_000 * Math.max(1, Math.min(2, (task.timeBudgetMinutes ?? 27) / 27)), deadline - Date.now()), gitEnv, '/workspace/repository', 24 * 1024 * 1024));
          return collectSandboxResult(collected);
        },
      }, deadline));
      result.checks = [...result.checks.filter(check => !configuredChecks.some(value => value.label === check.label) && !(configuredChecks.length && check.kind === 'runtime' && check.status === 'warning')), ...configuredChecks];
      await checkpoint();
      if (Date.now() >= deadline) throw taskTimeout();
      this.content.put('sandbox-result', { signature, result });
      await report('Changes ready for review', { status: 'completed' });
      return result;
      })());
    } catch (error) {
      if (error instanceof HostedFailureError) {
        this.content.put('sandbox-failure', { signature, failure: error.failure });
        await report(error.failure.message, { status: 'failed', failure: error.failure });
      } else if (session.ready && container.running) destroy = false;
      throw error;
    } finally { clearTimeout(timer); if (destroy) await container.destroy().catch(error => logFailure('hosted_container_destroy_failed', error)); }
  }

  private command(container: Container, argv: string[], timeout: number, env: Record<string, string>, cwd = '/workspace/repository', limit = 64 * 1024): Promise<CommandResult> {
    return runCommand(container, argv, timeout, env, cwd, limit);
  }
}
