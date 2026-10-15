import { buildChoiceParser, buildCommand } from '@stricli/core';
import { CliError, note, print, type BraidContext } from '../context';
import { ID, loadCredentials, originOf } from '../config';
import { findRepository } from '../repository';

/** Braid keeps its own approvals, so Git's `store` and `erase` change nothing. */
async function credential(this: BraidContext, _flags: Record<never, never>, operation: 'get' | 'store' | 'erase') {
  const fields = new Map((await this.input()).split('\n').flatMap(line => { const at = line.indexOf('='); return at > 0 ? [[line.slice(0, at), line.slice(at + 1).trim()] as const] : []; }));
  if (operation !== 'get' || !fields.get('protocol') || !fields.get('host')) return;
  const home = originOf(`${fields.get('protocol')}://${fields.get('host')}`);
  if (!home) return;
  const repository = findRepository(this);
  const linked = [this.env.BRAID_URL, repository?.link?.url].some(url => !!url && originOf(url) === home);
  // A token from the environment is not tied to an origin, so it goes only to the Braid this repository or BRAID_URL names.
  if (this.env.BRAID_ACCESS_TOKEN && !linked) return;
  const named = /^git\/(.+)\.git$/.exec(fields.get('path') ?? '')?.[1];
  if (fields.has('path') && !ID.test(named ?? '')) return;
  const workspace = named ?? (linked ? repository?.link?.workspaceId : undefined);
  if (!workspace || (this.env.BRAID_WORKSPACE_ID && this.env.BRAID_WORKSPACE_ID !== workspace)) return;
  try {
    const credentials = loadCredentials(this, home, workspace);
    print(this, `username=x\npassword=${credentials.accessToken}`);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    note(this, `braid: ${error.message}`);
  }
}

export const credentialCommand = buildCommand({
  func: credential,
  parameters: { positional: { kind: 'tuple', parameters: [{ brief: 'What Git asks: get, store or erase', parse: buildChoiceParser(['get', 'store', 'erase'] as const), placeholder: 'operation' }] } },
  docs: { brief: 'Git credential helper for the braid remote' },
});
