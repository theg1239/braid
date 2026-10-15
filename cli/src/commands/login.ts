import { basename } from 'node:path';
import { strictGit, strict } from '../git';
import { execFileSync } from 'node:child_process';
import { buildCommand } from '@stricli/core';
import * as v from 'valibot';
import { answer, ApiError, Braid, retryAfter, send } from '../api';
import { CliError, fail, print, type BraidContext } from '../context';
import { loadCredentials, normalizeOrigin, readEmailFlow, removeCredentials, removeEmailFlow, resolveOrigin, saveCredentials, saveEmailFlow, savedCredentials } from '../config';
import { findRepository } from '../repository';
import { deviceRequest, emailStarted, errorBody, grant, repositoryChoice, selfGrant } from '../schemas';
import { columns, colours } from '../terminal';
import { startActivityUpload } from '../activity';

const url = { kind: 'parsed', parse: normalizeOrigin, brief: 'Braid address, such as https://braid.example', placeholder: 'url', optional: true } as const;
const AGENT = 'Braid CLI';

const day = (at: string) => new Date(at).toISOString().slice(0, 10);

/** Saves an approval with owner-only permissions where braid.mjs keeps its own. Work access is required. */
function keep(context: BraidContext, origin: string, approved: v.InferOutput<typeof grant>, wanted?: string) {
  if (approved.scope !== 'work') fail(`The owner approved ${approved.scope} access, and braid needs work access to submit changes. Run braid login again and approve it as asked.`);
  if (Date.parse(approved.expiresAt) <= context.now()) fail('The approval had already expired. Run braid login again.');
  saveCredentials(context.env, { origin, accessToken: approved.accessToken, workspaceId: approved.workspaceId, expiresAt: approved.expiresAt });
  if (wanted && approved.workspaceId !== wanted) fail(`The owner approved repository ${approved.workspaceId}, but ${wanted} is required. That approval was saved; run braid login again and choose ${wanted}.`);
  return approved;
}

async function deviceLogin(context: BraidContext, origin: string, wanted?: string) {
  const started = await send(context, `${origin}/api/agent/requests`, { method: 'POST', body: { name: AGENT, scope: 'work' } });
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
    return keep(context, origin, await answer(poll, grant, { path: '/api/agent/token' }), wanted);
  }
  return fail('The request expired before anyone approved it. Run braid login to try again.');
}

/** The GitHub CLI's token for github.com, or undefined when gh is missing or signed out. It goes once to Braid and is never saved. */
export function githubCliToken(env: BraidContext['env']): string | undefined {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
    return /^[\x21-\x7e]{20,255}$/.test(token) ? token : undefined;
  } catch { return undefined; }
}

type Wanted = { workspace?: string; repository?: string; checkout?: { name: string; github?: { owner: string; repo: string } } };
function checkoutTarget(context: BraidContext): Wanted['checkout'] {
  const root = strictGit(context, ['rev-parse', '--show-toplevel']);
  if (root.status !== 0) return undefined;
  const path = root.stdout.toString().trim();
  const origin = strictGit(context, ['remote', 'get-url', 'origin'], { cwd: path }).stdout.toString().trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin);
  const name = (match?.[2] ?? basename(path)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 46);
  return { name: /^[a-z][a-z0-9-]+$/.test(name) ? name : `r-${name || 'repository'}`, ...(match ? { github: { owner: match[1], repo: match[2] } } : {}) };
}
const naming = ({ workspace, repository, checkout }: Wanted) => ({ ...(checkout ? { checkout } : {}), ...(workspace ? { workspaceId: workspace } : {}), ...(repository ? { repository } : {}) });
/** A connection for the person's own proof. Without one repository to connect, Braid's answer names the choices. */
async function selfLogin(context: BraidContext, origin: string, response: Response, path: string, wanted: Wanted) {
  if (response.status === 409) {
    const choice = v.safeParse(repositoryChoice, await response.json().catch(() => undefined));
    fail(choice.success ? `${choice.output.error}${choice.output.repositories.length ? ` Repositories: ${choice.output.repositories.join(', ')}. Run braid login again with --repository OWNER/REPO.` : ''}` : 'Braid needs a repository to connect.');
  }
  const approved = await answer(response, selfGrant, { path });
  keep(context, origin, approved, wanted.workspace);
  if (approved.initialization) {
    const head = strictGit(context, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (head.status === 0) strict(context, ['push', '--porcelain', '--force-with-lease=refs/heads/main:', '--', `${origin}/git/${approved.workspaceId}.git`, `${head.stdout.toString().trim()}:refs/heads/main`], { token: approved.initialization.accessToken });
  }
  print(context, `${approved.created ? 'Created private repository' : 'Connected to'} ${origin}/${approved.repository}.`);
  return approved;
}

/**
 * Signs braid in for the person, and signs them up when they are new to Braid: the GitHub CLI's account when gh is
 * signed in; otherwise asks for email. Browser approval is available only through an explicit --link.
 */
export async function agentLogin(context: BraidContext, origin: string, wanted: Wanted = {}, link = false) {
  if (!wanted.workspace && !wanted.checkout) wanted = { ...wanted, checkout: checkoutTarget(context) };
  if (!link) {
    const token = githubCliToken(context.env);
    if (token) {
      const response = await send(context, `${origin}/api/agent/github`, { method: 'POST', body: { token, name: AGENT, scope: 'work', ...naming(wanted) } });
      if (response.status === 201 || response.status === 409) return selfLogin(context, origin, response, '/api/agent/github', wanted);
      const reason = v.safeParse(errorBody, await response.json().catch(() => undefined));
      fail(`Braid did not connect with GitHub: ${reason.success ? reason.output.error : `HTTP ${response.status}`}`);
    } else fail('The GitHub CLI is not signed in here. Ask the person for their email address and run braid login --email ADDRESS.');
  }
  return deviceLogin(context, origin, wanted.workspace);
}

async function emailLogin(context: BraidContext, origin: string, email: string, code: string | undefined, wanted: Wanted) {
  if (!wanted.workspace && !wanted.checkout) wanted = { ...wanted, checkout: checkoutTarget(context) };
  if (code === undefined) {
    const started = await answer(await send(context, `${origin}/api/agent/email/start`, { method: 'POST', body: { email, scope: 'work' } }), emailStarted, { path: '/api/agent/email/start' });
    saveEmailFlow(context.env, email, { origin, ...started });
    print(context, `Braid emailed the person a code. Ask them for it, then run: braid login --url ${origin} --email ADDRESS --code CODE`);
    return undefined;
  }
  const flow = readEmailFlow(context.env, origin, email) ?? fail('No code is waiting for this address. Run braid login --email ADDRESS first.');
  if (Date.parse(flow.expiresAt) <= context.now()) fail('The code for this address expired. Run braid login --email ADDRESS for a new one.');
  const response = await send(context, `${origin}/api/agent/email/verify`, { method: 'POST', body: { flowId: flow.flowId, code, name: AGENT, ...naming(wanted) } });
  if (response.status === 401) fail('That code is invalid or expired. Check it with the person, or run braid login --email ADDRESS for a new one.');
  const approved = await selfLogin(context, origin, response, '/api/agent/email/verify', wanted);
  removeEmailFlow(context.env, origin, email);
  return approved;
}

async function login(this: BraidContext, flags: { url?: string; workspace?: string; repository?: string; email?: string; code?: string; link?: boolean }) {
  const here = findRepository(this);
  const origin = normalizeOrigin(flags.url ?? this.env.BRAID_URL ?? here?.link?.url ?? fail('Give your Braid address: braid login --url https://braid.example'));
  if (flags.code !== undefined && flags.email === undefined) fail('--code goes with the --email the code was sent to.');
  if (flags.link && flags.email !== undefined) fail('Choose --email or --link, not both.');
  if (flags.repository !== undefined && flags.workspace !== undefined) fail('Choose --workspace or --repository, not both.');
  if (flags.repository !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(flags.repository)) fail('Name the repository as OWNER/REPO.');
  const wanted = { workspace: flags.workspace ?? (flags.repository ? undefined : here?.link?.workspaceId), repository: flags.repository };
  const approved = flags.email !== undefined ? await emailLogin(this, origin, flags.email, flags.code, wanted) : await agentLogin(this, origin, wanted, flags.link);
  if (!approved) return;
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

const text = (brief: string, placeholder: string) => ({ kind: 'parsed', parse: String, brief, placeholder, optional: true }) as const;
export const loginCommand = buildCommand({
  func: login,
  parameters: {
    flags: {
      url,
      workspace: text('Require this repository id', 'id'),
      repository: text('Connect this repository, by its OWNER/REPO address', 'owner/repo'),
      email: text('Sign in with a code Braid emails to this address; run again with --code', 'address'),
      code: text('The code from the email, as the person reads it out', 'code'),
      link: { kind: 'boolean', brief: 'Skip the GitHub CLI and show a link for the owner to approve', optional: true },
    },
  },
  docs: { brief: 'Sign in for the person, and sign them up when they are new', fullDescription: 'Signs in with the GitHub CLI\'s account when gh is signed in, with a code Braid emails the person (--email, then --code), or with a page and code the person approves. The approval is saved with owner-only permissions where braid.mjs keeps its own, so both tools share it. Tokens never appear in arguments or output; BRAID_ACCESS_TOKEN and BRAID_WORKSPACE_ID override the saved approval.' },
});
export const logoutCommand = buildCommand({ func: logout, parameters: { flags: { url } }, docs: { brief: 'Forget the saved approval for a Braid' } });
export const whoamiCommand = buildCommand({ func: whoami, parameters: { flags: { url } }, docs: { brief: 'Show who braid acts as, and for which repository' } });
