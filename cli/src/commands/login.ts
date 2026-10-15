import { buildCommand } from '@stricli/core';
import { answer, ApiError, Braid, retryAfter, send } from '../api';
import { CliError, fail, print, type BraidContext } from '../context';
import { loadCredentials, normalizeOrigin, removeCredentials, resolveOrigin, saveCredentials, savedCredentials } from '../config';
import { findRepository } from '../repository';
import { deviceRequest, grant } from '../schemas';
import { columns, colours } from '../terminal';
import { startActivityUpload } from '../activity';

const url = { kind: 'parsed', parse: normalizeOrigin, brief: 'Braid address, such as https://braid.example', placeholder: 'url', optional: true } as const;

const day = (at: string) => new Date(at).toISOString().slice(0, 10);

export async function deviceLogin(context: BraidContext, origin: string, wanted?: string) {
  const started = await send(context, `${origin}/api/agent/requests`, { method: 'POST', body: { name: 'Braid CLI', scope: 'work' } });
  const request = await answer(started, deviceRequest, { path: '/api/agent/requests' });
  const page = new URL(request.verificationUri);
  if (page.origin !== origin || page.username || page.password || page.href.includes(request.deviceCode) || request.interval > request.expiresIn) fail('Braid returned sign-in details braid will not use.');
  print(context, `Approve this connection in Braid: ${page.href}\nCode: ${request.userCode}\nWaiting for approval…`);
  const deadline = context.now() + request.expiresIn * 1000;
  let interval = request.interval * 1000, delay = interval;
  while (context.now() < deadline) {
    await context.sleep(Math.min(delay, deadline - context.now()));
    if (context.now() >= deadline) break;
    const poll = await send(context, `${origin}/api/agent/token`, { method: 'POST', body: { deviceCode: request.deviceCode }, timeout: Math.max(1, Math.min(30_000, deadline - context.now())) });
    if (poll.status === 410) fail('The request expired or was denied. Run braid login to try again.');
    if (poll.status === 202 || poll.status === 429) {
      if (poll.status === 429) interval += 5000;
      delay = Math.max(interval, retryAfter(poll.headers.get('retry-after'), context.now()));
      await poll.body?.cancel();
      continue;
    }
    const approved = await answer(poll, grant, { path: '/api/agent/token' });
    if (approved.scope !== 'work') fail(`The owner approved ${approved.scope} access, and braid needs work access to submit changes. Run braid login again and approve it as asked.`);
    if (Date.parse(approved.expiresAt) <= context.now()) fail('The approval had already expired. Run braid login again.');
    saveCredentials(context.env, { origin, accessToken: approved.accessToken, workspaceId: approved.workspaceId, expiresAt: approved.expiresAt });
    if (wanted && approved.workspaceId !== wanted) fail(`The owner approved repository ${approved.workspaceId}, but ${wanted} is required. That approval was saved; run braid login again and choose ${wanted}.`);
    return approved;
  }
  return fail('The request expired before anyone approved it. Run braid login to try again.');
}

async function login(this: BraidContext, flags: { url?: string; workspace?: string }) {
  const here = findRepository(this);
  const origin = normalizeOrigin(flags.url ?? this.env.BRAID_URL ?? here?.link?.url ?? fail('Give your Braid address: braid login --url https://braid.example'));
  const approved = await deviceLogin(this, origin, flags.workspace ?? here?.link?.workspaceId);
  if (here) startActivityUpload(this, here.root);
  print(this, `Signed in to ${origin} for repository ${approved.workspaceId} until ${day(approved.expiresAt)}.${here && !here.link ? ' Run braid init to link this repository.' : ''}`);
}

async function logout(this: BraidContext, flags: { url?: string }) {
  const origin = resolveOrigin(this, findRepository(this)?.link, flags.url);
  const removed = removeCredentials(this.env, origin);
  print(this, removed ? `Signed out of ${origin}. The connection stays valid until it expires; revoke it in Braid's settings to end it now.` : `Not signed in to ${origin}.`);
  if (this.env.BRAID_ACCESS_TOKEN) print(this, 'BRAID_ACCESS_TOKEN is still set in this environment.');
}

async function whoami(this: BraidContext, flags: { url?: string }) {
  const link = findRepository(this)?.link;
  const named = flags.url ?? this.env.BRAID_URL ?? link?.url;
  const origin = named ? normalizeOrigin(named) : undefined;
  const approvals = this.env.BRAID_ACCESS_TOKEN && origin ? [loadCredentials(this, origin, link?.workspaceId)] : savedCredentials(this.env, origin);
  if (!approvals.length) fail(`Not signed in${origin ? ` to ${origin}` : ''}. Run braid login --url https://your-braid.example.`);
  const paint = colours(this);
  const rows = [['Braid', 'Repository', 'Connection', 'Approved by', 'Until']];
  for (const credentials of approvals) {
    const expired = !!credentials.expiresAt && Date.parse(credentials.expiresAt) <= this.now();
    let agent = expired ? 'expired' : '', owner = '';
    if (!expired) {
      try {
        const braid = new Braid(this, credentials), person = await braid.owner();
        agent = (await braid.session()).agent.name;
        owner = person?.name ?? '';
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        agent = error instanceof ApiError ? 'not accepted' : 'unreachable';
      }
    }
    rows.push([credentials.origin, credentials.workspaceId, agent, owner, credentials.expiresAt ? day(credentials.expiresAt) : 'from environment']);
  }
  for (const row of columns(rows, (cell, _column, index) => index === 0 ? paint.dim(cell) : cell)) print(this, row);
}

export const loginCommand = buildCommand({
  func: login,
  parameters: {
    flags: { url, workspace: { kind: 'parsed', parse: String, brief: 'Require this repository id when the owner approves', placeholder: 'id', optional: true } },
  },
  docs: { brief: 'Sign in with an owner-approved code', fullDescription: 'Shows a page and code for the repository owner to approve, then saves the approval with owner-only permissions where braid.mjs keeps its own, so both tools share it. Tokens never appear in arguments or output; BRAID_ACCESS_TOKEN and BRAID_WORKSPACE_ID override the saved approval.' },
});
export const logoutCommand = buildCommand({ func: logout, parameters: { flags: { url } }, docs: { brief: 'Forget the saved approval for a Braid' } });
export const whoamiCommand = buildCommand({ func: whoami, parameters: { flags: { url } }, docs: { brief: 'Show who braid acts as, and for which repository' } });
