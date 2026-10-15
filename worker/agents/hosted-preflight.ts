import * as v from 'valibot';
import type { HostedPreflight } from '../../shared/types';
import { parsePolicy } from '../../shared/policy-file';
import { hostedPackage } from '../schemas';
import { redactHostedText } from './hosted-output';

export const hostedLockfiles = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'go.sum', 'Cargo.lock'];
const paths = ['.braid/policy.json', 'package.json', '.node-version', '.nvmrc', '.python-version', ...hostedLockfiles];
/**
 * What a hosted run starts from, read at the task's commit. Only a broken `.braid/policy.json` stops it: setup and check
 * commands are optional, since the agent installs and checks what it needs itself, and the sandbox's runtimes stand in
 * for undeclared versions. File existence is independent of whether it is empty.
 */
export async function hostedPreflight(commit: string, read: (path: string) => Promise<string | null>): Promise<HostedPreflight> {
  const files = new Map(await Promise.all(paths.map(async path => [path, await read(path)] as const)));
  const configured = files.get('.braid/policy.json');
  const { policy, errors } = parsePolicy(configured);
  const result: HostedPreflight = { commit, ...(policy.install ? { setup: policy.install } : {}), checks: policy.checks,
    runtimes: [], lockfiles: hostedLockfiles.filter(path => files.get(path) !== null), missing: [] };
  if (configured !== null && errors.length) result.missing.push('Fix .braid/policy.json before starting an agent.');
  const declared = (name: 'Node' | 'Python' | 'Go', version: string | null | undefined, path: string) => {
    if (version?.trim()) result.runtimes.push({ name, version: redactHostedText(version.trim()).slice(0, 120), path });
  };
  const nodeFile = files.get('.node-version') !== null ? '.node-version' : '.nvmrc';
  declared('Node', files.get(nodeFile), nodeFile);
  declared('Python', files.get('.python-version'), '.python-version');
  const pkg = files.get('package.json');
  if (pkg !== null && !result.runtimes.some(runtime => runtime.name === 'Node')) {
    let json: unknown; try { json = JSON.parse(pkg!); } catch { json = null; }
    const parsed = v.safeParse(hostedPackage, json);
    if (parsed.success) declared('Node', parsed.output.volta?.node ?? parsed.output.engines?.node, 'package.json');
  }
  // TOML and Go manifests are parsed by tomllib and go mod edit in the checkout.
  return result;
}
