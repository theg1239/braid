import { HostedOutputTail, hostedOutput } from './hosted-output';
/** Shared sandbox plumbing for agent containers and verification runners. */
export interface CommandResult { stdout: string; stderr: string; exitCode: number; truncated: boolean; outputTail?: string; signal?: number; timedOut?: boolean; timeoutMs?: number; elapsedMs?: number; code?: string; oomKilled?: boolean; diskFull?: boolean }
export const commandPassed = (result: CommandResult) => result.exitCode === 0 && !result.timedOut && !result.signal && !result.code;
export const gitEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' };
export const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
// Durable Object containers grant root capabilities even to another uid. Drop
// those capabilities and prevent privilege gains before running any command.
export const dropPrivileges = ['/usr/bin/setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--'];
/** Verifies the checkout as the unprivileged user before any repository code runs. */
export const privilegeProbe = 'import {readFileSync} from "node:fs";import {assertFullCheckout,runGit} from "/opt/braid/braid.mjs";const status=readFileSync("/proc/self/status","utf8");if(process.getuid()!==1000||process.getgid()!==1000||!/^NoNewPrivs:\\s+1$/m.test(status)||/^Cap\\w+:\\s+0*[1-9a-f]/mi.test(status))throw Error("Sandbox privileges were not dropped.");assertFullCheckout(process.cwd());process.stdout.write(runGit(["rev-parse","HEAD"],{cwd:process.cwd()}));';

export const secretValues = (env: Record<string, string>) => Object.entries(env).filter(([key]) => /TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)).map(([, value]) => value);

export async function readOutput(stream: ReadableStream | null, limit: number, tail = new HostedOutputTail()) {
  if (!stream) return { text: '', truncated: false, tail: '' };
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = '', used = 0, truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      const chunk = value as Uint8Array;
      const keep = Math.min(chunk.byteLength, Math.max(0, limit - used));
      const decoded = decoder.decode(chunk, { stream: true });
      tail.write(decoded);
      if (keep) text += keep === chunk.byteLength ? decoded : new TextDecoder().decode(chunk.subarray(0, keep));
      used += keep; truncated ||= keep < chunk.byteLength;
    }
    const rest = decoder.decode(); if (!truncated) text += rest; tail.write(rest);
    return { text, truncated, tail: tail.finish() };
  } finally { reader.releaseLock(); }
}

/** Runs one command without root capabilities; a timeout kills it and reports exit 124. */
export async function runCommand(container: Container, argv: string[], timeout: number, env: Record<string, string>, cwd = '/workspace/repository', limit = 64 * 1024): Promise<CommandResult> {
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(1, timeout));
  let process: ExecProcess | undefined;
  const secrets = secretValues(env), stdoutTail = new HostedOutputTail(secrets), stderrTail = new HostedOutputTail(secrets);
  try {
    process = await container.exec([...dropPrivileges, ...argv], { cwd, user: '0:0', env: { HOME: '/home/node', USER: 'node', LOGNAME: 'node', ...env }, signal: abort.signal, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([readOutput(process.stdout, limit, stdoutTail), readOutput(process.stderr, 16 * 1024, stderrTail), process.exitCode]);
    return { stdout: stdout.text, stderr: stderr.text, exitCode, timeoutMs: timeout, elapsedMs: Date.now() - started, truncated: stdout.truncated || stderr.truncated,
      outputTail: hostedOutput([stdout.tail, stderr.tail].filter(Boolean).join('\n')), ...(abort.signal.aborted || argv[0] === 'timeout' && exitCode === 124 ? { timedOut: true } : {}) };
  } catch (error) {
    try { process?.kill(9); } catch { /* It may already have exited. */ }
    if (abort.signal.aborted) return { stdout: '', stderr: 'Command timed out.', exitCode: 124, truncated: false, timedOut: true, timeoutMs: timeout, elapsedMs: Date.now() - started, outputTail: hostedOutput(`${stdoutTail.finish()}\n${stderrTail.finish()}`) };
    throw error;
  } finally { clearTimeout(timer); }
}

/** Accepts only Artifacts Git remotes, so a sandbox never receives credentials for another host. */
export function artifactsRemote(remote: string) {
  const url = new URL(remote);
  return url.protocol === 'https:' && url.hostname.endsWith('.artifacts.cloudflare.net') && !url.username && !url.password && !url.search && !url.hash && !url.port
    && /^\/git\/[a-z0-9_-]+\/[a-z0-9._-]+\.git$/.test(url.pathname);
}
