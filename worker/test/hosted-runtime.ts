import type { CommandResult } from '../agents/container';
import type { SandboxTask } from '../agents/loop';

export const hostedTask: SandboxTask = { workspaceId: 'fixture-workspace', missionId: 'fixture-task', agentId: 'fixture-agent', repo: 'fixture', remote: 'https://fixture.artifacts.cloudflare.net/git/braid/fixture.git', baseCommit: 'a'.repeat(40), model: 'fixture-model', title: 'Recover the cloud agent', intent: 'Exercise the sandbox using fake transports.', role: 'Coding agent', task: 'Update the fixture file.', scope: ['*'], context: [] };
export const commandResult = (over: Partial<CommandResult> = {}): CommandResult => ({ stdout: 'ok', stderr: '', exitCode: 0, truncated: false, ...over });
export const modelTool = (name: string, args: unknown, id = name) => ({ choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
export const workTurn = () => modelTool('exec', { command: 'edit-fixture', purpose: 'work', timeout: 60 });
export const finishTurn = () => modelTool('finish', { summary: 'Recovered the fixture', rationale: 'Verified the retry and saved result.' });

/** Fake only the Containers transport. The production bootstrap, supervisor protocol and loop still run. */
export class FakeHostedContainer {
  running = false;
  images = { agent: 'fixture-image' };
  starts = 0; destroys = 0;
  executions: string[][] = [];
  receipts = new Map<string, CommandResult>();
  startFailures: unknown[] = [];
  commandFailures: (CommandResult | Error)[] = [];
  collection: CommandResult = commandResult({ stdout: JSON.stringify([{ path: 'fixture.txt', content: 'recovered\n' }]) });
  onCommand?: (argv: string[]) => CommandResult | Error | undefined;
  start() { this.starts++; const error = this.startFailures.shift(); if (error) throw error; this.running = true; }
  async destroy() { this.running = false; this.destroys++; }
  async setInactivityTimeout() {}
  monitor() { return new Promise<void>(() => {}); }
  async exec(args: string[], _options?: ContainerExecOptions): Promise<ExecProcess> {
    const supervised = args[0] === 'node';
    const job = supervised ? JSON.parse(args.at(-1)!) as { id: string; argv: string[] } : null;
    const argv = job?.argv ?? args;
    let result = job ? this.receipts.get(job.id) : undefined;
    if (!result) {
      const supplied = this.onCommand?.(argv) ?? (argv.includes('bash') ? this.commandFailures.shift() : undefined);
      if (supplied instanceof Error) throw supplied;
      result = supplied ?? (argv.includes('/opt/braid/collect.mjs') ? this.collection : argv.some(arg => arg.includes("from 'node:tls'")) ? commandResult({ stdout: '{"ok":true}' }) : argv.includes('--input-type=module') ? commandResult({ stdout: hostedTask.baseCommit }) : commandResult());
      this.executions.push(argv);
      if (job) this.receipts.set(job.id, result);
    }
    return { stdout: new Blob([supervised ? JSON.stringify(result) : result.stdout]).stream(), stderr: new Blob([supervised ? '' : result.stderr]).stream(),
      exitCode: Promise.resolve(supervised ? 0 : result.exitCode), kill() {}, stdin: null, pid: 1, isPty: false } as unknown as ExecProcess;
  }
}
export class FakeHostedAi {
  calls = 0;
  answers: unknown[] = [workTurn(), finishTurn()];
  run() { this.calls++; const answer = this.answers.shift() ?? finishTurn(); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer); }
}
