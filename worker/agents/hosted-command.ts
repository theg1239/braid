import * as v from 'valibot';
import source from '../../sandbox/command.mjs?raw';
import { SECRET_RULES } from '../../shared/secrets';
import { BRAID_CREDENTIAL, CREDENTIAL_URL, EMAIL_PATTERN } from '../../shared/privacy';
import { digest } from '../http/auth';
import { dropPrivileges, readOutput, secretValues, type CommandResult } from './container';
import { hostedProcessResult } from '../schemas';
import { hostedOutput } from './hosted-output';
import { failure, HostedFailureError } from './hosted-failures';
import { hostedTiming } from './hosted-limits';

const receipt = v.pipe(v.string(), v.parseJson(), v.object({ ...hostedProcessResult.entries, ...hostedTiming.entries }));

/** Replays a completed command's receipt; an uncertain command never runs twice. */
export async function hostedCommand(container: Container, identity: string, argv: string[], timeout: number, env: Record<string, string>, cwd = '/workspace/repository', limit = 64 * 1024): Promise<CommandResult> {
  const started = Date.now();
  const id = await digest(identity);
  const secrets = secretValues(env);
  const redaction = [...SECRET_RULES.map(rule => rule.capturedPrefix ? /\bsk-(?:proj-|svcacct-|admin-)?[0-9A-Za-z_-]{20,400}/ : rule.pattern), BRAID_CREDENTIAL, CREDENTIAL_URL, EMAIL_PATTERN]
    .map(rule => [rule.source, rule.flags.replace('g', '') + 'g']);
  // The supervisor starts as root only to protect receipts. Every child uses setpriv before repository code runs.
  const abort = new AbortController();
  let command: ExecProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execution = (async () => {
    command = await container.exec(['/usr/local/bin/node', '--input-type=module', '-e', source, JSON.stringify({ id, argv: [...dropPrivileges, ...argv], cwd, timeout, limit, redaction, secrets })],
      { cwd: '/workspace', user: '0:0', env: { HOME: '/home/node', USER: 'node', LOGNAME: 'node', ...env }, signal: abort.signal, stdout: 'pipe', stderr: 'pipe' });
    return Promise.all([readOutput(command.stdout, (limit + 16384) * 6 + 20000), readOutput(command.stderr, 16384), command.exitCode]);
  })();
  // The child owns its deadline. This outer bound also handles an unresponsive exec transport.
  const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    abort.abort(); try { command?.kill(9); } catch { /* It may already have exited. */ }
    reject(new HostedFailureError(failure('timeout', 'command', { source: 'container', operation: argv[0] === 'bash' && argv[1] === '-c' ? argv[2] : argv[0], timedOut: true, limitKind: 'transport', timeoutMs: timeout + 10_000, elapsedMs: Date.now() - started })));
  }, timeout + 10_000); });
  let output: Awaited<typeof execution>;
  try { output = await Promise.race([execution, stalled]); } finally { clearTimeout(timer); }
  const [stdout, , exitCode] = output;
  const parsed = v.safeParse(receipt, stdout.text);
  if (exitCode !== 0 || stdout.truncated || !parsed.success) throw new HostedFailureError(failure('interrupted', 'command', { source: 'container', operation: argv[0], exitCode, truncated: stdout.truncated }));
  const result = parsed.output;
  if (result.code === 'BRAID_COMMAND_INCOMPLETE') throw new HostedFailureError(failure('interrupted', 'command', { source: 'process', operation: argv[0], code: result.code }));
  return { ...result, outputTail: hostedOutput(result.outputTail ?? `${result.stdout}\n${result.stderr}`, secrets) };
}
