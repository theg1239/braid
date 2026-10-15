import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import api from '../http/api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

const cli = await import(new URL('../../public/cli/braid.mjs', import.meta.url).href);
const origin = 'https://braid.example';
const githubToken = `gho_${'g'.repeat(36)}`;
const connection = `braid_agent_${'c'.repeat(64)}`;
const flowId = '0b5c6f0e-3c9a-4a8e-9b1d-2f6f1a0c4d21';
let root: string;
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'braid-connect-test-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

const granted = (extra: object = {}) => Response.json({ accessToken: connection, tokenType: 'Bearer', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), workspaceId: 'workspace-one', scope: 'work', repository: 'octo/web', ...extra }, { status: 201 });
const device = () => Response.json({ deviceCode: 'private-device-code-0123456789', userCode: 'ABCD2345', verificationUri: `${origin}/?connect=ABCD2345`, expiresIn: 120, interval: 1 }, { status: 201 });
function runtime(fetch: ReturnType<typeof vi.fn>, token: string | null = githubToken) {
  const log = vi.fn(), githubTokenRead = vi.fn(() => token);
  let now = Date.now();
  return { log, githubTokenRead, options: { cwd: root, env: { BRAID_CONFIG_HOME: join(root, 'config') }, agentName: () => 'Codex on laptop', fetch, log, githubToken: githubTokenRead, now: () => now, sleep: async (ms: number) => { now += ms; } } };
}
const sent = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined }));

describe('connect with the GitHub CLI', () => {
  it('signs in with the gh token once, saves the connection and prints neither secret', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(granted());
    const rt = runtime(fetch);
    await expect(cli.connect(origin, rt.options)).resolves.toEqual({ workspaceId: 'workspace-one' });
    expect(sent(fetch)).toEqual([{ url: `${origin}/api/agent/github`, body: { token: githubToken, scope: 'work', name: 'Codex on laptop' } }]);
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
    const output = rt.log.mock.calls.flat().join('\n');
    expect(output).toBe(`Connected to ${origin}/octo/web.`);
    expect(output).not.toContain(githubToken);
    expect(cli.loadCredentials(origin, rt.options.env).accessToken).toBe(connection);
    expect(JSON.stringify(readdirSync(join(root, 'config'), { recursive: true }))).not.toContain('gho_');
  });

  it('infers the checkout and initializes committed history with a setup token and zero lease', async () => {
    const setup = `braid_agent_${'s'.repeat(64)}`;
    const fetch = vi.fn().mockResolvedValueOnce(granted({ created: true, initialization: { accessToken: setup, branch: 'main' } }));
    const rt = runtime(fetch);
    const head = 'a'.repeat(40);
    const git = vi.fn((args: string[], _options?: unknown) => {
      if (args[0] === 'remote') return Buffer.from('git@github.com:acme/local-work.git');
      if (args.includes('--show-toplevel')) return Buffer.from('/checkout/local-work');
      if (args.includes('--verify')) return Buffer.from(head);
      return Buffer.from('');
    });
    await cli.connect(origin, { ...rt.options, git });
    expect(sent(fetch)[0].body.checkout).toEqual({ name: 'local-work', github: { owner: 'acme', repo: 'local-work' } });
    const push = git.mock.calls.find(([args]) => args[0] === 'push')!;
    expect(push[0]).toEqual(['push', '--porcelain', '--force-with-lease=refs/heads/main:', '--', `${origin}/git/workspace-one.git`, `${head}:refs/heads/main`]);
    expect(push[1]).toMatchObject({ token: setup });
    expect(rt.log.mock.calls.flat().join(' ')).toContain(`Created private repository ${origin}/octo/web.`);
    expect(rt.log.mock.calls.flat().join(' ')).not.toContain(setup);
  });

  it('names the repositories to choose from instead of guessing, and passes a named one', async () => {
    const choose = vi.fn().mockResolvedValueOnce(Response.json({ code: 'repository_required', error: 'Name one of these repositories with repository: "owner/repo".', repositories: ['octo/web', 'octo/docs'] }, { status: 409 }));
    await expect(cli.connect(origin, runtime(choose).options)).rejects.toThrow('Repositories: octo/web, octo/docs. Run connect again with --repository OWNER/REPO.');
    const named = vi.fn().mockResolvedValueOnce(granted({ repository: 'octo/docs' }));
    await cli.main(['connect', '--url', origin, '--repository', 'octo/docs'], runtime(named).options);
    expect(sent(named)[0].body).toMatchObject({ repository: 'octo/docs' });
    expect(existsSync(join(root, 'config'))).toBe(true);
  });

  it('asks for email when signed out, reports GitHub errors, and uses approval links only explicitly', async () => {
    for (const [token, first] of [[null, null], [githubToken, Response.json({ code: 'github_email', error: 'GitHub did not share a verified email address.' }, { status: 403 })]] as const) {
      const fetch = vi.fn();
      if (first) fetch.mockResolvedValueOnce(first);
      fetch.mockResolvedValueOnce(device()).mockResolvedValueOnce(Response.json({ accessToken: connection, tokenType: 'Bearer', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), workspaceId: 'workspace-one', scope: 'work' }));
      const rt = runtime(fetch, token);
      await expect(cli.connect(origin, rt.options)).rejects.toThrow(token ? 'Braid did not connect with GitHub: GitHub did not share a verified email address.' : 'run connect --email ADDRESS');
      expect(sent(fetch).some(item => item.url.endsWith('/api/agent/requests'))).toBe(false);
    }
    const fetch = vi.fn().mockResolvedValueOnce(device()).mockResolvedValueOnce(Response.json({ accessToken: connection, tokenType: 'Bearer', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), workspaceId: 'workspace-one', scope: 'work' }));
    const rt = runtime(fetch);
    await cli.main(['connect', '--url', origin, '--link'], rt.options);
    expect(rt.githubTokenRead).not.toHaveBeenCalled();
    expect(sent(fetch)[0].url).toBe(`${origin}/api/agent/requests`);
  });
});

describe('connect with an emailed code', () => {
  it('asks Braid to email a code, keeps the flow privately, and connects with the code the person reads out', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ flowId, expiresAt: new Date(Date.now() + 600_000).toISOString(), scope: 'work' }, { status: 201 }));
    const rt = runtime(fetch, null);
    await cli.main(['connect', '--url', origin, '--email', 'maya@example.test'], rt.options);
    expect(sent(fetch)).toEqual([{ url: `${origin}/api/agent/email/start`, body: { email: 'maya@example.test', scope: 'work' } }]);
    expect(rt.githubTokenRead).not.toHaveBeenCalled();
    expect(rt.log.mock.calls.flat().join('\n')).toBe(`Braid emailed the person a code. Ask them for it, then run: node braid.mjs connect --url ${origin} --email ADDRESS --code CODE`);
    const [folder] = readdirSync(join(root, 'config'));
    const [file] = readdirSync(join(root, 'config', folder));
    expect(file).toMatch(/^email-[a-f0-9]{64}\.json$/);
    expect(statSync(join(root, 'config', folder, file)).mode & 0o777).toBe(0o600);

    fetch.mockResolvedValueOnce(Response.json({ error: 'That code is invalid or expired.' }, { status: 401 }));
    await expect(cli.main(['connect', '--url', origin, '--email', 'Maya@example.test', '--code', 'WRONG123'], rt.options)).rejects.toThrow('That code is invalid or expired.');
    fetch.mockResolvedValueOnce(Response.json({ code: 'no_repository', error: `Run connect inside the checkout to create a private repository.`, repositories: [] }, { status: 409 }));
    await expect(cli.main(['connect', '--url', origin, '--email', 'maya@example.test', '--code', 'ABCD2345'], rt.options)).rejects.toThrow('Run connect inside the checkout');
    fetch.mockResolvedValueOnce(granted());
    await cli.main(['connect', '--url', origin, '--email', 'maya@example.test', '--code', 'ABCD-2345'], rt.options);
    expect(sent(fetch).at(-1)).toEqual({ url: `${origin}/api/agent/email/verify`, body: { flowId, code: 'ABCD-2345', name: 'Codex on laptop' } });
    expect(cli.loadCredentials(origin, rt.options.env).accessToken).toBe(connection);
    expect(readdirSync(join(root, 'config', folder))).not.toContain(file);
    await expect(cli.main(['connect', '--url', origin, '--email', 'maya@example.test', '--code', 'ABCD2345'], rt.options)).rejects.toThrow('No code is waiting for this address.');
  });

  it.each([
    [['connect', '--url', origin, '--code', 'ABCD2345'], '--code goes with the --email'],
    [['connect', '--url', origin, '--email', 'maya@example.test', '--link'], 'Choose --email or --link'],
    [['connect', '--url', origin, '--repository', 'octo'], 'Name the repository as OWNER/REPO.'],
    [['connect', '--url', origin, '--repository', 'octo/web', '--workspace', 'workspace-one'], 'Choose --workspace or --repository'],
  ])('refuses %j before any request', async (argv, message) => {
    const fetch = vi.fn();
    await expect(cli.main(argv, runtime(fetch).options)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('connect against Braid itself', () => {
  it('signs a new person up with the gh token, and connects once they have a repository', async () => {
    const people = storageFixture(), secrets = storageFixture();
    const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', PUBLIC_ORIGIN: origin, SESSION_SECRET: 'connect-cli-session-secret-of-32-chars', GITHUB_CLIENT_ID: 'Iv1.braid' } as unknown as BraidEnv;
    const directory = new Directory(people.ctx, env), security = new Security(secrets.ctx, env);
    Object.assign(env, { DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
      WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://api.github.com/user') return Response.json({ id: 77, login: 'maya-chen', name: 'Maya Chen', email: null });
      if (String(input) === 'https://api.github.com/user/emails') return Response.json([{ email: 'maya@example.test', verified: true, primary: true }]);
      throw new Error(`Unexpected request to ${String(input)}`);
    }));
    const braid = vi.fn((url: string, init: RequestInit) => api.fetch(new Request(url, init), env));
    const rt = runtime(braid);
    try {
      await expect(cli.connect(origin, rt.options)).rejects.toThrow('Run connect inside the checkout');
      const person = await security.profile({ id: 'github:77', email: 'maya@example.test', name: 'Maya Chen' });
      const repository = directory.createWorkspace(person.id, directory.personalOwner(person.id)!.id, 'relay');
      await expect(cli.connect(origin, rt.options)).resolves.toEqual({ workspaceId: repository.id });
      expect(rt.log.mock.calls.flat().at(-1)).toBe(`Connected to ${origin}/maya-chen/relay.`);
      const saved = cli.loadCredentials(origin, rt.options.env);
      const session = await api.fetch(new Request(`${origin}/api/agent/session`, { method: 'POST', headers: { authorization: `Bearer ${saved.accessToken}`, 'content-type': 'application/json' }, body: '{}' }), env);
      expect(await session.json()).toMatchObject({ workspaceId: repository.id, agent: { name: 'Codex on laptop' } });
    } finally { people.db.close(); secrets.db.close(); }
  });
});
