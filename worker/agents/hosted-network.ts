import * as v from 'valibot';
import type { CommandResult } from './container';
import { commandFailure, failure, HostedFailureError } from './hosted-failures';
import { hostedNetworkResult } from '../schemas';

/** Tests the exact Git host before a credential is issued; reports TLS/socket codes as data. */
export const networkProbe = String.raw`import tls from 'node:tls';
const host = process.argv[1];
const socket = tls.connect({host, port:443, servername:host, rejectUnauthorized:true});
const timer = setTimeout(() => { const error = new Error(); error.code = 'ETIMEDOUT'; socket.destroy(error); }, 15000);
socket.once('secureConnect', () => { clearTimeout(timer); process.stdout.write(JSON.stringify({ok:true})); socket.end(); });
socket.once('error', error => { clearTimeout(timer); process.stdout.write(JSON.stringify({ok:false,code:error.code})); });`;

const probeAnswer = v.pipe(v.string(), v.parseJson(), hostedNetworkResult);
export function networkProbeResult(result: CommandResult) {
  const problem = commandFailure(result, 'checkout', 'Git host TLS check');
  if (problem) throw new HostedFailureError(problem);
  const parsed = v.safeParse(probeAnswer, result.stdout);
  if (!parsed.success || result.truncated) throw new HostedFailureError(failure('command', 'checkout', { source: 'process', operation: 'Git host TLS check', exitCode: result.exitCode, truncated: result.truncated }));
  if (!parsed.output.ok) throw new HostedFailureError(failure('network', 'checkout', { source: 'process', operation: 'Git host TLS check', code: parsed.output.code }));
}
