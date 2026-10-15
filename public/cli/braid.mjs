#!/usr/bin/env node
import { constants, chmodSync, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { constants as system, homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const LIMIT = 3 * 1024 * 1024;
const FILE_LIMIT = 256;
// Receipts keep the exact payload, including up to 4 MB of screenshots as base64.
const RECEIPT_LIMIT = 48 * 1024 * 1024;
const NULL = process.platform === 'win32' ? 'NUL' : '/dev/null';
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const KEY = /^[a-zA-Z0-9_-]{16,128}$/;
const HELP = `Braid local coding agent · Node 22+ and Git

  node braid.mjs start TASK_URL [--dir DIRECTORY]
  node braid.mjs connect --url https://braid.example [--workspace ID | --repository OWNER/REPO] [--email ADDRESS [--code CODE] | --link]
  node braid.mjs checkout --url ORIGIN --mission ID --agent ID --dir NEW_DIRECTORY [--workspace ID]
  node braid.mjs progress --dir DIRECTORY --message TEXT
  node braid.mjs resume --dir DIRECTORY
  node braid.mjs update --dir DIRECTORY
  node braid.mjs submit --dir DIRECTORY --summary TEXT [--rationale TEXT] [--model TEXT] [--tests FILE] [--proof]
  node braid.mjs submit --dir DIRECTORY --retry
  node braid.mjs wait --dir DIRECTORY [--timeout SECONDS]

connect signs the agent in for the person, and signs them up when they are new to Braid: with the GitHub CLI when gh is
signed in, else with --email (Braid emails the person a code; ask them for it and run connect again with --code).
Use --link explicitly for a link the person opens to approve. Run connect in the checkout: its GitHub origin
or directory name selects an existing writable repository or creates a private one. --repository overrides the choice.
Start reuses the approved connection for the task's repository, or connects as above, then prepares the task.
Run start again to resume, including after a proposal is in review. Commits and local branches are allowed, and
checkouts prepared by start submit committed work only, so commit the integrated result before submitting.
Submit again after further commits to revise a proposal. Each revision replaces the previous proposal with the
complete change from the base. When main moves, update fetches it without changing your branch or files; merge or
rebase the fetched commit, rerun checks, and submit.
After credentials expire, connect again, then resume the original checkout to renew its claim.
Resume preserves your edits and any saved submission.
Run your own coding tools and tests. --tests accepts a JSON array of up to 10
{command, result: "passed" | "failed" | "not-run", detail?} records.
Tests are agent-reported and unverified. With the merge queue enabled, the result becomes a pull request;
wait reports when it merges, needs changes with the reason, or needs a person.
--retry resends the saved payload, its proof and idempotency key, even if local edits changed.

Pull requests merge into main under the repository's rules:
  node braid.mjs change start --url https://braid.example --dir NEW_DIRECTORY [--workspace ID]
  node braid.mjs change touching --dir DIRECTORY --paths src/a.ts,src/b.ts
  node braid.mjs restack NUMBER --dir DIRECTORY
  node braid.mjs change submit --dir DIRECTORY --title TEXT --summary TEXT [--depends-on 51] [--intent TEXT] [--rationale TEXT] [--model TEXT] [--tests FILE] [--proof]
  node braid.mjs change submit --dir DIRECTORY --retry
  node braid.mjs change status --dir DIRECTORY
  node braid.mjs change wait --dir DIRECTORY [--timeout SECONDS]
  node braid.mjs change sync --dir DIRECTORY
Commit before submitting; the pull request contains the difference from its base commit. Submitting again from the
same checkout sends the next revision. When changes are requested, run change status for the conflict or failure, change
sync to fetch current main, rebase onto it, rerun checks and submit again. Overlapping work is merged automatically
where possible; only real conflicts come back. --depends-on 51,52 declares prerequisites; none clears them.

--proof runs .braid/proof.json in the checkout and attaches what happened:
  {"checks": ["npm test", "npm run build"], "timeoutSeconds": 600,
   "preview": {"command": "npm run dev -- --port 4319", "url": "http://127.0.0.1:4319", "pages": ["/", "/settings"], "timeoutSeconds": 120}}
Up to 10 one-line checks (9 with a preview) of 300 characters run with CI=true and without BRAID_ variables. Each
check's exit code and the last 8,000 characters of its output are attached even when it fails, so Braid can send the
change back with them; output that looks like a credential stops the submission. The preview must answer at
http://127.0.0.1, localhost or [::1] with a port; up to 6 pages are captured at 1280×800 and 390×844 by a local
Playwright (npx playwright install chromium), then it is stopped.
To revise, omit --summary (and --title) to reuse the previous description. wait ends with the next command to run.

Credentials are saved per origin and repository in BRAID_CONFIG_HOME, XDG_CONFIG_HOME/braid, or ~/.config/braid.
Overrides: BRAID_ACCESS_TOKEN and BRAID_WORKSPACE_ID. Never put tokens in arguments.
`;

export class CliError extends Error {}
const fail = message => { throw new CliError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, limit) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /\0/.test(value)) fail(`Invalid ${label}.`);
  return value.trim();
};
const identifier = value => typeof value === 'string' && ID.test(value) ? value : fail('Invalid task, agent, or workspace ID.');
const optionalCommit = value => value === undefined || value === null || (typeof value === 'string' && COMMIT.test(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('Provide a valid Braid origin with --url.'); }
  if (typeof value !== 'string' || /[\x00-\x20\x7f\\]/.test(value) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Use an origin without credentials, path, query, or fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('Braid requires HTTPS; HTTP is allowed only for local development.');
  return url.origin;
}

export function validateRemote(value) {
  let url;
  try { url = new URL(value); } catch { fail('The checkout response has an invalid Git remote.'); }
  if (typeof value !== 'string' || /[\x00-\x20\x7f\\]/.test(value) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('The Git remote must use HTTPS without credentials, query, or fragment.');
  return url.href;
}

export function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 240 && !path.startsWith('/') && !path.includes('\\')
    && !/[\x00-\x1f\x7f]/.test(path) && !/[\uD800-\uDFFF]/u.test(path) && path.split('/').every(part => part && part !== '..' && part !== '.' && !['.git', '.braid'].includes(part.toLowerCase()))
    && !/(?:^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?)(?:$|\/)/i.test(path);
}

export function assertNoSecrets(content, secrets = []) {
  if (secrets.some(secret => typeof secret === 'string' && secret.length >= 4 && content.includes(secret))
    || /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\bbraid_agent_[a-zA-Z0-9_-]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}|\bgithub_pat_[a-zA-Z0-9_]{20,}|\bsk-(?:proj-|ant-)?[a-zA-Z0-9_-]{16,}|\bxox[baprs]-[a-zA-Z0-9-]{16,}/.test(content)
    || /https?:\/\/[^\s/:"'<>]+:[^\s/@"'<>]+@|\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_=.-]{12,}/i.test(content)
    || /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token|_authToken)\b["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i.test(content)
    || /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|_authToken)\s*=\s*[a-zA-Z0-9+/_=-]{12,}(?:\s|$)/i.test(content)) fail('Possible secret detected. Remove credentials from the files, summary, rationale, and test reports before submitting.');
}

export function decodeText(bytes) {
  let result;
  try { result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('Only UTF-8 text files can be submitted.'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) fail('Binary files cannot be submitted.');
  return result;
}

function directory(path, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Expected a real directory, not a symlink.');
  return path;
}

function privateDirectory(path) {
  directory(path, true);
  chmodSync(path, 0o700);
  return path;
}

function readJson(path, max = 1_048_576, { privateFile = false, readOnly = false } = {}) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max || lstatSync(path).isSymbolicLink()) fail('Invalid local metadata file.');
    if (privateFile) {
      if (process.getuid && stat.uid !== process.getuid()) fail('The private metadata file belongs to another user.');
      if (readOnly) {
        if (stat.mode & 0o077) fail('Local metadata must have owner-only permissions.');
      } else fchmodSync(fd, 0o600);
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Make a completed rename durable where the platform can sync directories. */
function syncDirectory(path) {
  if (process.platform === 'win32') return;
  let fd;
  try { fd = openSync(path, constants.O_RDONLY); fsyncSync(fd); } catch { /* Best effort. */ } finally { if (fd !== undefined) closeSync(fd); }
}

function writePrivate(path, content, exclusive = false) {
  if (exclusive) writeFileSync(path, content, { mode: 0o600, flag: 'wx', flush: true });
  else {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('Local metadata must not be a symlink.');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }
  syncDirectory(dirname(path));
}

const writeJson = (path, data, exclusive = false) => writePrivate(path, `${JSON.stringify(data, null, 2)}\n`, exclusive);

const configRoot = env => resolve(env.BRAID_CONFIG_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'braid'));

/** Approvals are saved per origin and repository. The origin-wide file of earlier releases is still read. */
export function credentialFile(origin, env = process.env, workspaceId) {
  const root = configRoot(env), originKey = sha256(normalizeOrigin(origin));
  return workspaceId === undefined ? join(root, `${originKey}.json`) : join(root, originKey, `${sha256(workspaceId === '*' ? '*' : identifier(workspaceId))}.json`);
}

function tokenValue(value) {
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\x00-\x20\x7f]/.test(value)) fail('Invalid access credentials. Reconnect to Braid.');
  return value;
}

export function saveCredentials(origin, grant, env = process.env) {
  origin = normalizeOrigin(origin);
  const accessToken = tokenValue(grant.accessToken), workspaceId = grant.workspaceId === '*' ? '*' : identifier(grant.workspaceId);
  if (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) fail('The approved credentials have expired. Reconnect to Braid.');
  const path = credentialFile(origin, env, workspaceId);
  privateDirectory(dirname(dirname(path)));
  privateDirectory(dirname(path));
  writeJson(path, { origin, accessToken, workspaceId, expiresAt: grant.expiresAt });
}

const unreadable = () => fail('Cannot read private Braid credentials. Check permissions and reconnect.');

function savedCredentials(origin, env, readOnly, workspaceId) {
  const legacy = credentialFile(origin, env), folder = legacy.slice(0, -'.json'.length), records = [];
  const present = path => {
    try {
      directory(path);
      if (!readOnly) chmodSync(path, 0o700);
      return true;
    } catch (error) { return error.code === 'ENOENT' ? false : unreadable(); }
  };
  const read = path => {
    let saved;
    try { saved = readJson(path, 32_768, { privateFile: true, readOnly }); } catch (error) { return error.code === 'ENOENT' ? undefined : unreadable(); }
    if (!object(saved) || saved.origin !== origin) fail('Stored credentials belong to a different Braid origin.');
    if (typeof saved.workspaceId !== 'string' || saved.workspaceId !== '*' && !ID.test(saved.workspaceId)) fail('Stored credentials do not match their repository. Run connect again.');
    return { accessToken: saved.accessToken, workspaceId: saved.workspaceId, expires: Date.parse(saved.expiresAt) };
  };
  if (!present(dirname(legacy))) return records;
  const earlier = read(legacy);
  if (earlier && (!workspaceId || earlier.workspaceId === workspaceId || earlier.workspaceId === '*')) records.push(earlier);
  if (!present(folder)) return records;
  const names = workspaceId ? [`${sha256(workspaceId)}.json`, `${sha256('*')}.json`] : readdirSync(folder).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  for (const name of names) {
    const record = read(join(folder, name));
    if (!record) continue;
    if (`${sha256(record.workspaceId)}.json` !== name) fail('Stored credentials do not match their repository. Run connect again.');
    records.push(record);
  }
  return records;
}

/**
 * The task's repository selects the credential. Without one, a single connected repository for the origin is used;
 * several are ambiguous rather than guessed.
 */
export function loadCredentials(origin, env = process.env, { readOnly = false, workspaceId } = {}) {
  origin = normalizeOrigin(origin);
  if (env.BRAID_ACCESS_TOKEN && env.BRAID_WORKSPACE_ID) return { accessToken: tokenValue(env.BRAID_ACCESS_TOKEN), workspaceId: identifier(env.BRAID_WORKSPACE_ID) };
  const wanted = env.BRAID_WORKSPACE_ID ? identifier(env.BRAID_WORKSPACE_ID) : workspaceId === undefined ? undefined : identifier(workspaceId);
  if (env.BRAID_ACCESS_TOKEN && wanted) return { accessToken: tokenValue(env.BRAID_ACCESS_TOKEN), workspaceId: wanted };
  const saved = savedCredentials(origin, env, readOnly, wanted);
  if (env.BRAID_ACCESS_TOKEN) {
    const workspaces = [...new Set(saved.map(record => record.workspaceId))];
    if (workspaces.length !== 1) fail('Set BRAID_WORKSPACE_ID together with BRAID_ACCESS_TOKEN.');
    return { accessToken: tokenValue(env.BRAID_ACCESS_TOKEN), workspaceId: workspaces[0] };
  }
  const current = new Map();
  for (const record of saved) if (record.expires > Date.now() && !(current.get(record.workspaceId)?.expires >= record.expires)) current.set(record.workspaceId, record);
  const account = current.get('*');
  current.delete('*');
  if (wanted && account && !current.size) return { accessToken: tokenValue(account.accessToken), workspaceId: wanted };
  if (!wanted && account && !current.size) fail('Account connected. Choose a repository with --workspace or BRAID_WORKSPACE_ID.');
  if (current.size > 1) fail('Several repositories are connected to this Braid origin. Use the task link from Braid, which names its repository, or set BRAID_WORKSPACE_ID.');
  const [record] = current.values();
  if (!record) fail(saved.length ? 'Braid credentials expired. Run connect again.' : `Run connect --url ${origin}${wanted ? ` --workspace ${wanted}` : ''}, or set BRAID_ACCESS_TOKEN and BRAID_WORKSPACE_ID.`);
  return { accessToken: tokenValue(record.accessToken), workspaceId: record.workspaceId };
}

const runtime = options => ({ env: process.env, agentName: () => agentName(), fetch: globalThis.fetch, sleep, now: Date.now, log: console.log, git: runGit, signals: process, githubToken: githubCliToken, ...options });

/** The GitHub CLI's token for github.com, or null when gh is missing or signed out. It goes once to Braid and is never saved. */
export function githubCliToken(env = process.env) {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
    return /^[\x21-\x7e]{20,255}$/.test(token) ? token : null;
  } catch { return null; }
}

async function post(rt, url, body, headers = {}, timeout = 30_000) {
  try {
    return await rt.fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(timeout) });
  } catch { fail('Braid could not be reached. Check the connection and retry.'); }
}

async function jsonResponse(response) {
  try {
    const data = await response.json();
    if (!object(data)) fail('Invalid response from Braid.');
    return data;
  } catch { fail('Braid returned an invalid response.'); }
}

export function retryDelay(value, interval, now = Date.now()) {
  const seconds = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value || '') - now;
  return Math.max(interval, Number.isFinite(seconds) ? seconds : 0);
}

/** Coding tools by the executable or package they run as, as the person knows them. */
const TOOLS = [
  ['Claude Code', /^claude$/, /@anthropic-ai\/claude-code\b/], ['Codex', /^codex(?:-[\w-]+)?$/, /@openai\/codex\b/],
  ['Cursor', /^cursor-agent$/, /\/cursor-agent\//], ['Gemini CLI', /^gemini$/, /@google\/gemini-cli\b/],
  ['opencode', /^opencode$/, /\bopencode-ai\b/], ['GitHub Copilot', /^copilot$/, /@github\/copilot\b/],
];

/** The coding tool that started this process: what it declares in the environment, else the nearest one among its ancestors. */
export function codingTool(env = process.env, start = process.ppid) {
  if (env.CLAUDECODE === '1') return 'Claude Code';
  if (!start || process.platform === 'win32') return undefined;
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 2000 });
  if (table.status !== 0) return undefined;
  const processes = new Map(table.stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(([, pid, parent, args]) => [Number(pid), { parent: Number(parent), args: args.split(/\s+/) }]));
  for (let pid = start, steps = 0; pid > 1 && steps < 16; steps++) {
    const entry = processes.get(pid);
    if (!entry) return undefined;
    for (const word of entry.args.slice(0, 2)) {
      const known = TOOLS.find(([, name, path]) => name.test(basename(word).replace(/\.(?:c?js|mjs|exe|cmd)$/, '')) || path.test(word));
      if (known) return known[0];
    }
    pid = entry.parent;
  }
  return undefined;
}

/** How the person tells this connection apart from their others: the tool and the machine it runs on. */
export function agentName(env = process.env, machine = hostname()) {
  const host = machine.replace(/\.local$/, '').slice(0, 30);
  return `${codingTool(env) || 'Coding agent'}${host ? ` on ${host}` : ''}`.slice(0, 60);
}
/** Where a code Braid emailed waits for the agent to be given it: beside the origin's credentials, never matched as one. */
const emailFlowFile = (origin, email, env) => join(dirname(credentialFile(origin, env)), sha256(normalizeOrigin(origin)), `email-${sha256(email.trim().toLowerCase())}.json`);

/**
 * Connects this agent for the person. With the GitHub CLI signed in, its token proves who they are and is discarded;
 * with an email address, Braid emails them a code to give the agent; otherwise the person approves a link. A new person
 * is signed up on the way. A required workspace is checked after the connection.
 */
export function checkoutTarget(options = {}) {
  const rt = runtime(options), cwd = options.cwd ?? process.cwd();
  let root;
  try { root = rt.git(['rev-parse', '--show-toplevel'], { cwd, env: rt.env }).toString().trim(); } catch { return undefined; }
  if (!root) return undefined;
  let origin = '';
  try { origin = rt.git(['remote', 'get-url', 'origin'], { cwd: root, env: rt.env }).toString().trim(); } catch { /* A local repository needs no upstream. */ }
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin);
  const name = (match?.[2] ?? basename(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 46);
  return { name: /^[a-z][a-z0-9-]+$/.test(name) ? name : `r-${name || 'repository'}`, ...(match ? { github: { owner: match[1], repo: match[2] } } : {}) };
}

export async function connect(origin, options = {}, workspace, { email, code, repository, link = false } = {}) {
  origin = normalizeOrigin(origin);
  if (workspace !== undefined) workspace = identifier(workspace);
  if (repository !== undefined && (typeof repository !== 'string' || repository.length > 141 || !/^[^/\s]+\/[^/\s]+$/.test(repository))) fail('Name the repository as OWNER/REPO.');
  const rt = runtime(options);
  const checkout = !workspace ? checkoutTarget(options) : undefined;
  const target = { name: rt.agentName(), ...(checkout ? { checkout } : {}), ...(repository ? { repository } : {}), ...(workspace ? { workspaceId: workspace } : {}) };
  if (email !== undefined) return code === undefined ? sendEmailCode(rt, origin, email) : emailConnect(rt, origin, email, code, target, workspace);
  if (!link) {
    const token = rt.githubToken(rt.env);
    if (token) {
      const connected = await selfConnected(rt, origin, await post(rt, `${origin}/api/agent/github`, JSON.stringify({ token, scope: 'work', ...target })), workspace);
      if (connected) return connected;
    } else fail('The GitHub CLI is not signed in here. Ask the person for their email address and run connect --email ADDRESS.');
  }
  return linkConnect(rt, origin, workspace);
}

/** A connection is for one repository. Without one, Braid lists the person's repositories or asks them to create one. */
function repositoryNeeded(data) {
  const repositories = Array.isArray(data.repositories) ? data.repositories.filter(value => typeof value === 'string').slice(0, 50) : [];
  fail(`${typeof data.error === 'string' ? data.error : 'Braid needs a repository to connect.'}${repositories.length ? ` Repositories: ${repositories.join(', ')}. Run connect again with --repository OWNER/REPO.` : ''}`);
}
const answerOf = response => response.json().then(data => object(data) ? data : {}, () => ({}));
/** A connection Braid gave for the person's own proof, saved like an approved one; null when the link should follow. */
async function selfConnected(rt, origin, response, workspace) {
  const data = await answerOf(response);
  if (response.status === 409) repositoryNeeded(data);
  if (response.status !== 201) {
    fail(`Braid did not connect with GitHub: ${typeof data.error === 'string' ? data.error : `HTTP ${response.status}`}`);
  }
  return connected(rt, origin, data, workspace);
}
function connected(rt, origin, grant, workspace) {
  if (grant.scope !== 'work' || grant.tokenType !== 'Bearer') fail('Work access is required. Run connect again.');
  saveCredentials(origin, grant, rt.env);
  const approved = grant.workspaceId === '*' ? '*' : identifier(grant.workspaceId);
  if (workspace && approved !== '*' && approved !== workspace) fail(`Braid connected repository ${approved}, but ${workspace} is required. That connection was saved for ${approved}; connect again for ${workspace}.`);
  const repository = typeof grant.repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(grant.repository) ? grant.repository : approved;
  if (grant.initialization) {
    const setup = grant.initialization;
    if (!object(setup) || typeof setup.accessToken !== 'string' || setup.branch !== 'main') fail('Braid returned invalid setup access.');
    const root = rt.git(['rev-parse', '--show-toplevel'], { cwd: rt.cwd ?? process.cwd(), env: rt.env }).toString().trim();
    let head;
    try { head = rt.git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, env: rt.env }).toString().trim(); } catch { /* An unborn checkout remains empty. */ }
    if (head) {
      if (!COMMIT.test(head)) fail('The checkout returned an invalid commit.');
      withAskpass(helper => rt.git(['push', '--porcelain', '--force-with-lease=refs/heads/main:', '--', `${origin}/git/${approved}.git`, `${head}:refs/heads/main`], { cwd: root, env: { ...rt.env, GIT_ASKPASS: helper }, token: setup.accessToken }));
    }
  }
  rt.log(`${grant.created ? 'Created private repository' : 'Connected to'} ${origin}/${repository}.`);
  return { workspaceId: approved === '*' && workspace ? workspace : approved };
}
async function sendEmailCode(rt, origin, email) {
  const response = await post(rt, `${origin}/api/agent/email/start`, JSON.stringify({ email, scope: 'work' }));
  const data = await answerOf(response);
  if (response.status !== 201) fail(`Braid could not email a code: ${typeof data.error === 'string' ? data.error : `HTTP ${response.status}`}`);
  if (typeof data.flowId !== 'string' || !/^[0-9a-f-]{36}$/.test(data.flowId) || !Number.isFinite(Date.parse(data.expiresAt))) fail('Braid returned an invalid answer.');
  const path = emailFlowFile(origin, email, rt.env);
  privateDirectory(dirname(dirname(path)));
  privateDirectory(dirname(path));
  writeJson(path, { origin, flowId: data.flowId, expiresAt: data.expiresAt });
  rt.log(`Braid emailed the person a code. Ask them for it, then run: node braid.mjs connect --url ${origin} --email ADDRESS --code CODE`);
  return { emailed: true };
}
async function emailConnect(rt, origin, email, code, target, workspace) {
  const path = emailFlowFile(origin, email, rt.env);
  let flow;
  try { flow = readJson(path, 4096, { privateFile: true }); } catch { fail('No code is waiting for this address. Run connect --email ADDRESS first.'); }
  if (!object(flow) || flow.origin !== origin || typeof flow.flowId !== 'string' || !(Date.parse(flow.expiresAt) > rt.now())) fail('The code for this address expired. Run connect --email ADDRESS for a new one.');
  const response = await post(rt, `${origin}/api/agent/email/verify`, JSON.stringify({ flowId: flow.flowId, code: text(code, 'code', 32), ...target }));
  if (response.status === 401) fail('That code is invalid or expired. Check it with the person, or run connect --email ADDRESS for a new one.');
  const data = await answerOf(response);
  if (response.status === 409) repositoryNeeded(data);
  if (response.status !== 201) fail(`Braid did not connect: ${typeof data.error === 'string' ? data.error : `HTTP ${response.status}`}`);
  const result = connected(rt, origin, data, workspace);
  rmSync(path, { force: true });
  return result;
}

/** The owner chooses the repository while approving the link. A required workspace is checked after approval. */
async function linkConnect(rt, origin, workspace) {
  const response = await post(rt, `${origin}/api/agent/requests`, JSON.stringify({ name: rt.agentName(), scope: 'work' }));
  if (!response.ok) fail(`Authorization request failed (HTTP ${response.status}). ${response.status === 404 || response.status === 503 ? 'Ask the owner to check public accounts, the HTTPS application origin and the session secret. ' : ''}See ${origin}/auth.md before retrying.`);
  const request = await jsonResponse(response);
  let verification;
  try { verification = new URL(request.verificationUri); } catch { fail('Braid returned an invalid approval URL.'); }
  if (verification.origin !== origin || verification.username || verification.password || !/^[A-Z0-9-]{4,32}$/.test(request.userCode)
    || typeof request.deviceCode !== 'string' || request.deviceCode.length < 16 || request.deviceCode.length > 200
    || verification.href.includes(request.deviceCode) || !Number.isFinite(request.expiresIn) || !(request.expiresIn > 0 && request.expiresIn <= 3600)
    || !Number.isFinite(request.interval) || !(request.interval >= 1 && request.interval <= request.expiresIn)) fail('Braid returned invalid device authorization details.');
  rt.log(`Approve this connection in Braid: ${verification.href}\nCode: ${request.userCode}\nWaiting for owner approval…`);
  const deadline = rt.now() + request.expiresIn * 1000;
  let interval = request.interval * 1000, delay = interval;
  while (rt.now() < deadline) {
    await rt.sleep(Math.min(delay, deadline - rt.now()));
    if (rt.now() >= deadline) break;
    const poll = await post(rt, `${origin}/api/agent/token`, JSON.stringify({ deviceCode: request.deviceCode }), {}, Math.max(1, Math.min(30_000, deadline - rt.now())));
    if (poll.status === 410) fail('The authorization request expired or was denied. Run connect to try again.');
    if (poll.status === 202 || poll.status === 429) {
      if (poll.status === 429) interval += 5000;
      delay = retryDelay(poll.headers.get('retry-after'), interval, rt.now());
      continue;
    }
    if (!poll.ok) fail(`Authorization polling failed (HTTP ${poll.status}).`);
    const grant = await jsonResponse(poll);
    if (grant.scope !== 'work' || grant.tokenType !== 'Bearer') fail('Owner-approved work access is required. Run connect again.');
    saveCredentials(origin, grant, rt.env);
    const approved = grant.workspaceId === '*' ? '*' : identifier(grant.workspaceId);
    if (workspace && approved !== '*' && approved !== workspace) fail(`The owner approved repository ${approved}, but ${workspace} is required. That approval was saved for ${approved}; connect again and choose ${workspace} when approving.`);
    rt.log(`Connected to ${origin} for ${approved === '*' ? 'your account' : `repository ${approved}`}.`);
    return { workspaceId: approved === '*' && workspace ? workspace : approved };
  }
  fail('The authorization request expired. Run connect to try again.');
}

export function runGit(args, { cwd, env = process.env, token } = {}) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:GIT_|BRAID_)/i.test(key)));
  Object.assign(childEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL, GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
  if (token) Object.assign(childEnv, { BRAID_GIT_TOKEN: token, GIT_ASKPASS: env.GIT_ASKPASS });
  try {
    return execFileSync('git', ['-c', `core.hooksPath=${NULL}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...args], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  } catch { fail('Git could not complete the operation. Check Git installation, repository access, and the pinned base. Git output is withheld to protect credentials.'); }
}

function repositoryRoot(dir) {
  directory(resolve(dir));
  const root = realpathSync(resolve(dir));
  const gitEntry = lstatSync(join(root, '.git'));
  if (gitEntry.isSymbolicLink() || (!gitEntry.isDirectory() && !gitEntry.isFile())) fail('Invalid Git checkout metadata.');
  if (realpathSync(runGit(['rev-parse', '--show-toplevel'], { cwd: root }).toString().trim()) !== root) fail('Use the root of the Braid checkout.');
  assertFullCheckout(root);
  return root;
}

/** An existing sparse checkout must never silently become an agent's whole repository. */
export function assertFullCheckout(root) {
  const config = runGit(['config', '--local', '--list', '--null'], { cwd: root }).toString();
  if (/(?:^|\0)core\.sparsecheckout\n(?:true|1|yes|on)(?:\0|$)/i.test(config)
    || /(?:^|\0)(?:extensions\.partialclone|remote\.[^\n]+\.promisor)\n/i.test(config)
    || runGit(['ls-files', '-t', '-z'], { cwd: root }).toString().split('\0').some(entry => entry.startsWith('S ')))
    fail('Agents require a full repository checkout. Disable sparse checkout and materialize all files, or use start --dir NEW_DIRECTORY.');
}

function descends(root, commit) {
  try { runGit(['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root }); return true; } catch { return false; }
}

/** HEAD must keep at least one of the given task bases in its history. */
function pinnedBase(root, ...commits) {
  const bases = commits.filter(commit => commit !== undefined);
  if (!bases.length || bases.some(commit => !COMMIT.test(commit ?? ''))) fail('Invalid pinned base commit.');
  if (!bases.some(commit => descends(root, commit))) fail('HEAD must descend from the pinned base. Preserve the task history before submitting.');
}

const validScope = scope => Array.isArray(scope) && scope.every(path => typeof path === 'string' && (path === '*' || validPath(path.replace(/\/$/, ''))));
const sameScope = (left, right) => left.length === right.length && left.every((path, index) => path === right[index]);
const taskPath = root => join(root, '.braid', 'task.json');

/**
 * baseCommit is the base for the next submission. After update, acceptedBase keeps the base Braid still reports
 * until a submission against the fetched main commit is accepted.
 */
function checkTask(task) {
  if (!object(task) || !validScope(task.scope) || !COMMIT.test(task.baseCommit ?? '')
    || (task.acceptedBase !== undefined && (!COMMIT.test(task.acceptedBase) || task.acceptedBase === task.baseCommit))
    || !optionalCommit(task.previousCommit) || ![undefined, 'commits'].includes(task.submissionMode)
    || [task.missionId, task.agentId, task.workspaceId].some(value => typeof value !== 'string' || !ID.test(value))) fail('Invalid pinned task metadata.');
  let origin;
  try { origin = normalizeOrigin(task.url); } catch { fail('Invalid pinned task metadata.'); }
  if (origin !== task.url) fail('Invalid pinned task metadata.');
  return task;
}

function readTask(root) {
  directory(join(root, '.braid'));
  return checkTask(readJson(taskPath(root), 32_768, { privateFile: true, readOnly: true }));
}

/** Writes only real changes, re-reading first so a concurrent command's fields are kept. */
function saveTask(root, before, next) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(next)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(next[key]));
  if (!changed.length) return before;
  const current = readTask(root), result = { ...current };
  for (const key of changed) {
    if (next[key] === undefined) delete result[key];
    else result[key] = next[key];
  }
  try { checkTask(result); } catch { fail('The task metadata changed while this command ran. Run it again.'); }
  writeJson(taskPath(root), result);
  return result;
}

function withPrevious(task, previousCommit) {
  const next = { ...task };
  if (previousCommit) next.previousCommit = previousCommit;
  else delete next.previousCommit;
  return next;
}

function checkoutDetails(response, origin, missionId, agentId, credentials) {
  if (!object(response) || response.missionId !== missionId || response.agentId !== agentId || !COMMIT.test(response.baseCommit ?? '')
    || !validScope(response.scope) || !optionalCommit(response.previousCommit)) fail('Braid returned invalid checkout details.');
  const details = {
    html_url: htmlUrl(response.html_url),
    remote: validateRemote(response.remote), token: tokenValue(response.token),
    title: text(response.title, 'task title', 1200), intent: text(response.intent, 'task intent', 12_000),
    context: typeof response.context === 'string' ? response.context : JSON.stringify(response.context ?? {}, null, 2),
    reviewComments: reviewComments(response.reviewComments ?? []), pullRequest: pullRequestContext(response.pullRequest),
    baseCommit: response.baseCommit, previousCommit: response.previousCommit, scope: response.scope,
  };
  const metadata = { url: origin, workspaceId: credentials.workspaceId, missionId, agentId, baseCommit: details.baseCommit, previousCommit: details.previousCommit, scope: details.scope };
  assertNoSecrets(JSON.stringify(metadata) + taskBrief(details, { origin }), [credentials.accessToken, details.token]);
  return details;
}

function taskBrief(details, { origin, acceptedBase, committed = false, single = false }) {
  const base = acceptedBase
    ? `Base commit: ${details.baseCommit}\n\nMain moved after the accepted base ${acceptedBase}. Merge or rebase ${details.baseCommit} into your work, resolve any conflicts and rerun the checks before submitting.`
    : `Base commit: ${details.baseCommit}`;
  const history = committed
    ? 'Commit the result you want reviewed: submit sends committed work and refuses uncommitted files. Local branches and merges are fine while the base stays in history.'
    : 'Commit and integrate work locally as needed, preserving the pinned base in history.';
  return `# ${details.title}\n\n${details.intent}\n\n${base}\n\nScope:\n${details.scope.map(path => `- ${path}`).join('\n')}\n\n## Task context\n\n${details.context}\n\n`
    + (details.pullRequest ? `## Pull request #${details.pullRequest.number}\n\n${details.pullRequest.outdated?.length ? `${details.pullRequest.outdated.map(item => `#${item.number}`).join(', ')} changed since this was built. Run braid.mjs restack ${details.pullRequest.number} --dir DIRECTORY.` : details.pullRequest.next ?? details.pullRequest.status}${details.pullRequest.dependsOn?.length ? `\nDepends on ${details.pullRequest.dependsOn.map(item => `#${item.number}`).join(', ')}` : ''}\n\n` : '')
    + (details.reviewComments.length ? `## Unresolved review comments\n\n${describeComments(details.reviewComments)}\n\n` : '')
    + `Complete the requested result. Choose your own plan, coding tools, subagents and isolation. Worktrees are optional. ${history} Run the repository checks yourself.\n`
    + 'Submit with braid.mjs for review. Test reports are agent-reported and unverified. To revise a proposal, submit again from this checkout; the revision replaces the previous proposal with the complete change from the base.\n'
    + (single ? 'If main moves, braid.mjs update --dir DIRECTORY fetches it without changing your branch or files.\n' : '')
    + 'Add .braid/proof.json if the repository has none, and submit with --proof to attach the checks and screenshots it describes (see braid.mjs --help). After submitting, run braid.mjs wait --dir DIRECTORY; when the result comes back, fix exactly what it names and submit again. Keep going until it lands or Braid says a person must decide.\n'
    + `After your connection expires, run braid.mjs connect --url ${origin}, then braid.mjs resume --dir DIRECTORY to renew this checkout.\n`
    + 'Run braid.mjs resume --dir DIRECTORY to refresh the latest owner instructions in .braid/TASK.md before continuing.\n'
    + 'If a submission is unconfirmed, use braid.mjs submit --dir DIRECTORY --retry to resend its saved payload and key.\n';
}

const ASKPASS = '#!/usr/bin/env node\nconst prompt = process.argv[2] || "";\nif (prompt.startsWith("Username")) process.stdout.write("x\\n");\nelse if (prompt.startsWith("Password")) process.stdout.write(process.env.BRAID_GIT_TOKEN + "\\n");\nelse process.exitCode = 1;\n';

/** Git reads the short-lived token from the environment through this helper; it is never written to disk or arguments. */
function withAskpass(run) {
  const folder = mkdtempSync(join(tmpdir(), 'braid-askpass-'));
  chmodSync(folder, 0o700);
  try {
    const helper = join(folder, 'askpass.cjs');
    writeFileSync(helper, ASKPASS, { mode: 0o700, flag: 'wx' });
    return run(helper);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

function hasCommit(rt, root, commit) {
  try { rt.git(['cat-file', '-e', `${commit}^{commit}`], { cwd: root, env: rt.env }); return true; } catch { return false; }
}

/** Adds objects only. Branches, the index and working files are untouched. */
function fetchCommit(rt, root, remote, commit, token) {
  if (hasCommit(rt, root, commit)) return;
  withAskpass(helper => rt.git(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--', remote, commit], { cwd: root, env: { ...rt.env, GIT_ASKPASS: helper }, token }));
}

/** Older servers may omit browser links. Never print credential-bearing or non-HTTP links. */
function htmlUrl(value) {
  if (value === undefined) return undefined;
  let url;
  try { url = new URL(value); } catch { fail('Braid returned an invalid browser link.'); }
  if (typeof value !== 'string' || !/^https?:\/\//.test(value) || /[\x00-\x20\x7f]/.test(value) || url.username || url.password) fail('Braid returned an invalid browser link.');
  return value;
}
const linkLine = value => value === undefined ? '' : `\n${htmlUrl(value)}`;

export function taskLink(value) {
  let url;
  try { url = new URL(value); } catch { fail('Provide the task URL from Braid.'); }
  const origin = normalizeOrigin(url.origin);
  if (url.username || url.password || url.hash || /[\x00-\x20\x7f\\]/.test(value)) fail('Invalid task URL.');
  const match = url.pathname.match(/^\/(?:([^/]+)\/([^/]+)\/)?tasks\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/?$/);
  const slug = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
  if (!match || (match[1] && (!slug.test(match[1]) || !slug.test(match[2]))) || [...url.searchParams.keys()].some(key => !['workspace', 'agent'].includes(key))
    || ['workspace', 'agent'].some(key => url.searchParams.getAll(key).length > 1)) fail('Use a Braid task URL.');
  return { origin, missionId: identifier(match[3]), workspaceId: url.searchParams.has('workspace') ? identifier(url.searchParams.get('workspace')) : undefined,
    agentId: url.searchParams.has('agent') ? identifier(url.searchParams.get('agent')) : undefined, ...(match[1] ? { repository: `${match[1]}/${match[2]}` } : {}) };
}

async function approvedCredentials(origin, rt, workspaceId) {
  try { return loadCredentials(origin, rt.env, { workspaceId }); } catch (error) {
    if (!(error instanceof CliError) || !/Run connect|credentials expired/.test(error.message)) throw error;
  }
  await connect(origin, rt, workspaceId);
  return loadCredentials(origin, rt.env, { workspaceId });
}

/** One entry point for first use and returning to a task. Never adopts an unrelated checkout. */
export async function start(input, options = {}) {
  const rt = runtime(options), link = taskLink(input.task);
  const dir = resolve(input.dir || (existsSync(join(process.cwd(), '.git')) ? process.cwd() : `braid-${link.missionId}`));
  let existing, bind = false;
  if (existsSync(dir)) {
    repositoryRoot(dir);
    if (existsSync(join(dir, '.braid'))) directory(join(dir, '.braid'));
    if (!existsSync(taskPath(dir))) bind = true;
    else existing = readTask(dir);
    if (existing && (existing.url !== link.origin || existing.missionId !== link.missionId
      || (link.workspaceId && existing.workspaceId !== link.workspaceId) || (link.agentId && existing.agentId !== link.agentId))) fail('This directory belongs to a different task. Choose a new --dir.');
    if (existing) pinnedBase(dir, existing.acceptedBase, existing.baseCommit);
  }
  const workspace = link.workspaceId || existing?.workspaceId;
  let credentials = await approvedCredentials(link.origin, rt, workspace);
  if (workspace && workspace !== credentials.workspaceId) fail('This task belongs to another repository. Connect to that repository, then run start again.');
  if (link.repository) {
    const address = await getJson(rt, `${link.origin}/api/repos/${link.repository}`, credentials);
    if (!object(address) || !ID.test(address.workspaceId ?? '')) fail('Braid returned an invalid repository address.');
    if (address.workspaceId !== credentials.workspaceId) fail('This task belongs to another repository. Connect to that repository, then run start again.');
  }
  const readState = async () => {
    try { return await rt.fetch(`${link.origin}/api/state`, { redirect: 'error', headers: authHeaders(credentials), signal: AbortSignal.timeout(30_000) }); }
    catch { fail('Braid could not be reached. Run start again.'); }
  };
  let response = await readState();
  if (response.status === 401 && !rt.env.BRAID_ACCESS_TOKEN) {
    await connect(link.origin, rt, credentials.workspaceId);
    credentials = loadCredentials(link.origin, rt.env, { workspaceId: credentials.workspaceId });
    response = await readState();
  }
  if (!response.ok) fail(`Cannot read the task (HTTP ${response.status}). Check your approved connection.`);
  const snapshot = await jsonResponse(response);
  const task = Array.isArray(snapshot.missions) && snapshot.missions.find(item => item.id === link.missionId);
  if (!task || task.execution !== 'local' || task.source !== 'live' || !Array.isArray(task.agents)) fail('No local task was found at this link in the approved repository.');
  const agentId = existing?.agentId || link.agentId || (task.agents.length === 1 ? task.agents[0].id : undefined);
  if (!agentId) fail('This older task has multiple proposals. Use the agent-specific link from Braid.');
  const agent = task.agents.find(item => item.id === agentId);
  if (!agent) fail('The requested agent was not found in this task.');
  const page = htmlUrl(task.html_url) ?? `${link.origin}/${link.repository ? `${link.repository}/` : ''}tasks/${link.missionId}${link.repository ? '' : `?workspace=${encodeURIComponent(credentials.workspaceId)}`}`, state = { missionId: link.missionId, agentId, commit: agent.commit };
  if (task.status === 'merged' || agent.status === 'merged') {
    rt.log(`This task was merged into main, so there is nothing left to submit. Local files were not changed. ${page}`);
    return { ...state, status: 'merged' };
  }
  if (!['running', 'review'].includes(task.status) || agent.status === 'skipped') {
    rt.log(`This task is no longer accepting work. Local files were not changed. ${page}`);
    return { ...state, status: agent.status === 'skipped' ? 'skipped' : task.status };
  }
  if (agent.status === 'review' && !existing) {
    // A revision replaces the reviewed proposal, so it must come from the checkout that holds that work.
    rt.log(`Proposal ${agent.commit ?? ''} is in review at ${page}. To revise it, run start again from the checkout that submitted it. Nothing was changed here.`);
    return { ...state, status: 'review' };
  }
  if (bind) {
    const current = runGit(['rev-parse', '--verify', 'HEAD'], { cwd: dir }).toString().trim();
    if (current !== task.baseCommit || runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dir }).length) fail('Use a clean checkout at the task base, or --dir NEW_DIRECTORY. Existing commits and edits must not become part of a new task.');
  }
  return existing ? resume({ dir }, rt) : checkout({ url: link.origin, mission: link.missionId, agent: identifier(agentId), dir, workspace: credentials.workspaceId, existing: bind, committed: true, single: task.agents.length === 1 }, rt);
}

export async function checkout(input, options = {}) {
  const rt = runtime(options), origin = normalizeOrigin(input.url);
  const missionId = identifier(input.mission), agentId = identifier(input.agent);
  const workspace = input.workspace === undefined ? undefined : identifier(input.workspace);
  const requested = resolve(text(input.dir, 'checkout directory', 4096));
  const dir = join(realpathSync(dirname(requested)), basename(requested));
  const credentials = loadCredentials(origin, rt.env, { workspaceId: workspace });
  if (workspace && credentials.workspaceId !== workspace) fail('The approved workspace does not match this task. Connect to its repository first.');
  if (input.existing) repositoryRoot(dir);
  else try { mkdirSync(dir, { mode: 0o700 }); } catch { fail('Checkout requires a NEW directory with an existing parent. No existing directory will be changed.'); }
  const response = await post(rt, `${origin}/api/missions/${missionId}/agents/${agentId}/checkout`, '{}', authHeaders(credentials));
  if (!response.ok) fail(`Checkout request failed (HTTP ${response.status}). The new directory can be inspected or removed before retrying.`);
  const details = checkoutDetails(await jsonResponse(response), origin, missionId, agentId, credentials);
  const metadata = { url: origin, workspaceId: credentials.workspaceId, missionId, agentId, baseCommit: details.baseCommit, scope: details.scope };
  if (details.html_url) metadata.html_url = details.html_url;
  if (input.committed) metadata.submissionMode = 'commits';
  if (details.previousCommit) metadata.previousCommit = details.previousCommit;
  if (input.existing) fetchCommit(rt, dir, details.remote, details.baseCommit, details.token);
  else {
    withAskpass(helper => rt.git(['clone', '--no-checkout', '--no-local', '--template=', '--', details.remote, dir], { env: { ...rt.env, GIT_ASKPASS: helper }, token: details.token }));
    rt.git(['checkout', '--detach', '--no-recurse-submodules', metadata.baseCommit, '--'], { cwd: dir, env: rt.env });
  }
  pinnedBase(repositoryRoot(dir), metadata.baseCommit);
  const exclude = resolve(dir, rt.git(['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, env: rt.env }).toString().trim());
  directory(dirname(exclude), true);
  if (existsSync(exclude) && !lstatSync(exclude).isFile()) fail('Git exclude must be a regular file.');
  const fd = openSync(exclude, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, '\n.braid/\n'); } finally { closeSync(fd); }
  privateDirectory(join(dir, '.braid'));
  if (existsSync(join(dir, '.braid', 'TASK.md'))) fail('An existing .braid/TASK.md would be overwritten. Preserve it before binding this task.');
  writeJson(taskPath(dir), metadata, true);
  writePrivate(join(dir, '.braid', 'TASK.md'), taskBrief(details, { origin, committed: input.committed, single: input.single }), true);
  const revision = details.previousCommit ? ` Proposal ${details.previousCommit} was already submitted; a submission from this checkout replaces it.` : '';
  rt.log(`Checkout ready at ${dir}${linkLine(details.html_url)}\nRead .braid/TASK.md and AGENTS.md. Complete the task, run checks, and submit the integrated result.${revision}`);
  return metadata;
}

function journalStatus(root) {
  try { return readJson(join(root, '.braid', 'submission.json'), RECEIPT_LIMIT, { privateFile: true, readOnly: true }).status; } catch { return undefined; }
}

export async function resume(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const task = readTask(root);
  pinnedBase(root, task.acceptedBase, task.baseCommit);
  const credentials = loadCredentials(task.url, rt.env, { readOnly: true, workspaceId: task.workspaceId });
  if (credentials.workspaceId !== task.workspaceId) fail('The approved workspace does not match this checkout. Reconnect to the correct workspace.');
  const response = await post(rt, `${task.url}/api/missions/${task.missionId}/agents/${task.agentId}/checkout`, '{}', authHeaders(credentials));
  if (!response.ok) fail(`Resume request failed (HTTP ${response.status}). Check your connection and retry resume for this checkout.`);
  const details = checkoutDetails(await jsonResponse(response), task.url, task.missionId, task.agentId, credentials);
  // Until a submission against a fetched main commit is accepted, Braid still reports the earlier base.
  if (!sameScope(details.scope, task.scope) || ![task.baseCommit, task.acceptedBase].includes(details.baseCommit)) fail('The checkout response does not match the pinned task base or scope.');
  let next = details.previousCommit === undefined ? { ...task } : withPrevious(task, details.previousCommit);
  if (details.html_url) next.html_url = details.html_url;
  if (details.baseCommit === task.baseCommit) delete next.acceptedBase;
  next = saveTask(root, task, next);
  writePrivate(join(root, '.braid', 'TASK.md'), taskBrief({ ...details, baseCommit: next.baseCommit }, { origin: task.url, acceptedBase: next.acceptedBase, committed: task.submissionMode === 'commits' }));
  const pending = journalStatus(root) === 'pending';
  const guidance = pending ? 'A saved submission is unconfirmed; run submit --dir DIRECTORY --retry to resend it before submitting anything else.'
    : next.acceptedBase ? `Merge or rebase the fetched main commit ${next.baseCommit} into your work, rerun checks, then submit.`
    : next.previousCommit ? `Proposal ${next.previousCommit} is the latest result; submit again from this checkout to revise it.`
    : 'Continue the task, run checks, and submit the result.';
  rt.log(`Renewed checkout for task ${task.missionId}, agent ${task.agentId}. ${guidance}${linkLine(next.html_url)}`);
  return next;
}

/** Fetches current main for a single-agent task and records it as the next submission base. */
export async function update(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const task = readTask(root);
  pinnedBase(root, task.acceptedBase, task.baseCommit);
  const credentials = loadCredentials(task.url, rt.env, { workspaceId: task.workspaceId });
  if (credentials.workspaceId !== task.workspaceId) fail('The approved workspace does not match this checkout. Reconnect to the correct workspace.');
  privateDirectory(join(root, '.braid'));
  const lockPath = join(root, '.braid', 'submission.lock');
  acquireLock(lockPath);
  try {
    const journal = readJournal(root, task);
    if (journal?.status === 'pending') fail('An earlier submission has no confirmed result. Run submit --dir DIRECTORY --retry before updating; its saved payload is unchanged.');
    const response = await post(rt, `${task.url}/api/missions/${task.missionId}/agents/${task.agentId}/update`, '{}', authHeaders(credentials));
    if (!response.ok) fail(`Update was not accepted (HTTP ${response.status}). Retry any unconfirmed submission first; only single-agent tasks can move to a newer main. Local files were not changed.`);
    const details = checkoutDetails(await jsonResponse(response), task.url, task.missionId, task.agentId, credentials);
    if (!sameScope(details.scope, task.scope)) fail('The update response does not match the pinned task scope.');
    fetchCommit(rt, root, details.remote, details.baseCommit, details.token);
    if (!hasCommit(rt, root, details.baseCommit)) fail('The current main commit could not be fetched. Local files were not changed.');
    const accepted = task.acceptedBase ?? task.baseCommit;
    let next = details.previousCommit === undefined ? { ...task } : withPrevious(task, details.previousCommit);
    if (details.html_url) next.html_url = details.html_url;
    next.baseCommit = details.baseCommit;
    if (details.baseCommit === accepted) delete next.acceptedBase;
    else next.acceptedBase = accepted;
    next = saveTask(root, task, next);
    writePrivate(join(root, '.braid', 'TASK.md'), taskBrief(details, { origin: task.url, acceptedBase: next.acceptedBase, committed: task.submissionMode === 'commits', single: true }));
    if (!next.acceptedBase) rt.log(`Main is at the accepted base ${next.baseCommit}, so this checkout is current. Local files were not changed.`);
    else {
      const fetched = details.baseCommit === task.baseCommit ? `Main is still at ${next.baseCommit}, which this checkout fetched earlier.` : `Fetched main at ${next.baseCommit} without changing your branch or files.`;
      rt.log(`${fetched} Merge or rebase it into this checkout (for example, git merge ${next.baseCommit}), resolve any conflicts, and rerun the repository checks before submitting. Earlier test reports describe the previous base and are not carried over.`);
    }
    if (next.html_url) rt.log(next.html_url);
    return next;
  } finally { unlinkSync(lockPath); }
}

export async function progress(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const task = readTask(root);
  const credentials = loadCredentials(task.url, rt.env, { workspaceId: task.workspaceId });
  if (credentials.workspaceId !== task.workspaceId) fail('The approved workspace does not match this checkout.');
  const body = JSON.stringify({ message: text(input.message, 'progress message', 1200) });
  assertNoSecrets(body, [credentials.accessToken]);
  const path = join(root, '.braid', 'progress.json');
  let saved;
  try { saved = readJson(path, 8192, { privateFile: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const target = `${task.url}/api/missions/${task.missionId}/agents/${task.agentId}/progress`;
  if (!saved || saved.body !== body || saved.target !== target || !KEY.test(saved.key ?? '')) saved = { target, body, key: randomUUID() };
  writeJson(path, saved);
  const response = await post(rt, target, body, { ...authHeaders(credentials), 'Idempotency-Key': saved.key });
  if (!response.ok) fail(`Progress was not confirmed (HTTP ${response.status}). Repeat the same command to retry.`);
  const result = await jsonResponse(response);
  rt.log(`Progress shared.${linkLine(result.html_url)}`);
}

function authHeaders(credentials) {
  return { Authorization: `Bearer ${credentials.accessToken}`, 'X-Braid-Workspace': credentials.workspaceId };
}

function checkedFile(root, path, mode = '100644', allowMissing = false) {
  const parts = path.split('/'), full = resolve(root, path), fromRoot = relative(root, full);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || parts.some(part => !part || part === '.' || part === '..') || path.includes('\\')) fail('Repository paths must remain inside the checkout.');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; fail('Deleted or missing files cannot be submitted.'); }
    const leaf = index === parts.length - 1;
    if (stat.isSymbolicLink() && !(leaf && mode === '120000')) fail('Symlinks cannot be submitted or followed.');
    const supported = !leaf || mode === '160000' ? stat.isDirectory() : mode === '120000' ? stat.isSymbolicLink() : stat.isFile();
    if (!supported) fail('Only regular files can be submitted; changes to symlinks, submodules and special files are unsupported.');
  }
  return full;
}

function readBlob(path, algorithm) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) fail('Only regular files can be submitted.');
    const hash = createHash(algorithm).update(`blob ${before.size}\0`), chunk = Buffer.alloc(65_536), kept = [];
    let size = 0, count;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, count));
      if (size + count <= LIMIT) kept.push(Buffer.from(chunk.subarray(0, count)));
      size += count;
    }
    const after = fstatSync(fd);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('A file changed while preparing the proposal. Retry when edits are finished.');
    return { hash: hash.digest('hex'), size, bytes: size <= LIMIT ? Buffer.concat(kept) : null };
  } finally { closeSync(fd); }
}

function unchangedSpecialEntry(root, path, prior, staged, algorithm) {
  if (!prior || !staged || prior.mode !== staged.mode || prior.hash !== staged.hash) return false;
  const full = checkedFile(root, path, prior.mode);
  if (prior.mode === '120000') {
    // Hash the link itself; never read its target, even outside the checkout.
    const target = readlinkSync(full, { encoding: 'buffer' });
    return createHash(algorithm).update(`blob ${target.length}\0`).update(target).digest('hex') === prior.hash;
  }
  if (prior.mode === '160000') {
    // A fresh --no-recurse-submodules checkout leaves an empty directory.
    if (!existsSync(join(full, '.git'))) return readdirSync(full).length === 0;
    return runGit(['rev-parse', '--verify', 'HEAD'], { cwd: full }).toString().trim() === prior.hash
      && runGit(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], { cwd: full }).length === 0;
  }
  return false;
}

const LIMIT_MESSAGE = 'A proposal is limited to 256 UTF-8 text files and 3 MiB of content.';
const REGULAR = ['100644', '100755'];

function treeEntries(list, commit) {
  const entries = new Map();
  for (const entry of list(['ls-tree', '-r', '-z', '-l', '--full-tree', commit])) {
    const match = /^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (!match) fail('Invalid Git tree entry.');
    entries.set(match[5], { mode: match[1], hash: match[3], size: match[4] === '-' ? 0 : Number(match[4]) });
  }
  return entries;
}

/** Committed submissions read Git objects, so later edits to working files cannot enter the proposal. */
function committedFiles(list, read, base, head, secrets) {
  const current = treeEntries(list, head), files = [];
  let total = 0;
  for (const path of [...new Set([...base.keys(), ...current.keys()])].sort()) {
    const prior = base.get(path), next = current.get(path);
    if (prior && next && prior.mode === next.mode && prior.hash === next.hash) continue;
    if ([prior, next].some(entry => entry && !REGULAR.includes(entry.mode))) fail('Symlinks and submodules cannot be submitted.');
    if (!validPath(path)) fail('The patch contains a protected or invalid repository path.');
    if (files.length >= FILE_LIMIT || total + (next?.size ?? 0) > LIMIT) fail(LIMIT_MESSAGE);
    if (!next) { files.push({ path, content: null }); continue; }
    const content = decodeText(read(next.hash));
    assertNoSecrets(content, secrets);
    files.push({ path, content, ...(next.mode !== (prior?.mode ?? '100644') ? { mode: next.mode } : {}) });
    total += next.size;
  }
  return files;
}

/** Earlier checkouts may submit uncommitted edits, so the working tree is read without Git filters. */
function workingFiles(root, list, staged, base, baseCommit, secrets) {
  const index = new Map();
  for (const entry of staged) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== '0') fail('Resolve the Git index before submitting.');
    index.set(match[4], { mode: match[1], hash: match[2] });
  }
  const paths = new Set([...base.keys(), ...index.keys(), ...list(['ls-files', '--others', '--exclude-standard', '-z'])]);
  const files = [], algorithm = baseCommit.length === 64 ? 'sha256' : 'sha1';
  let total = 0;
  for (const path of [...paths].sort()) {
    const prior = base.get(path), stagedEntry = index.get(path);
    if ([prior, stagedEntry].some(entry => entry && !REGULAR.includes(entry.mode))) {
      if (unchangedSpecialEntry(root, path, prior, stagedEntry, algorithm)) continue;
      fail('Symlinks and submodules cannot be submitted.');
    }
    const full = checkedFile(root, path, '100644', true);
    if (!full) {
      if (prior) {
        if (!validPath(path)) fail('The patch contains a protected or invalid repository path.');
        if (files.length >= FILE_LIMIT) fail(LIMIT_MESSAGE);
        files.push({ path, content: null });
      }
      continue;
    }
    const blob = readBlob(full, algorithm);
    const mode = (lstatSync(full).mode & 0o111) ? '100755' : '100644';
    checkedFile(root, path);
    if (blob.hash === prior?.hash && mode === prior?.mode) continue;
    if (!validPath(path)) fail('The patch contains a protected or invalid repository path.');
    if (files.length >= FILE_LIMIT || total + blob.size > LIMIT) fail(LIMIT_MESSAGE);
    const content = decodeText(blob.bytes);
    assertNoSecrets(content, secrets);
    files.push({ path, content, ...(mode !== (prior?.mode ?? '100644') ? { mode } : {}) });
    total += blob.size;
  }
  return files;
}

/**
 * Collects the complete change from the base. With committed set, HEAD must be clean and the proposal is HEAD's
 * tree. Either way, a change to HEAD, the index or (when committed) the working tree during collection is rejected.
 */
export function collectChanges(dir, baseCommit, secrets = [], { committed = false, git = runGit } = {}) {
  const root = repositoryRoot(dir);
  pinnedBase(root, baseCommit);
  const run = args => git(args, { cwd: root });
  const split = output => new TextDecoder('utf-8', { fatal: true }).decode(output).split('\0').filter(Boolean);
  const list = args => split(run(args));
  const state = () => ({
    head: run(['rev-parse', '--verify', 'HEAD']).toString().trim(),
    index: Buffer.from(run(['ls-files', '--stage', '-z'])),
    dirty: committed && run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).length > 0,
  });
  const before = state();
  if (before.dirty) fail('Commit the work you want reviewed before submitting. Keep unrelated files out of this checkout.');
  const base = treeEntries(list, baseCommit);
  const files = committed
    ? committedFiles(list, hash => run(['cat-file', 'blob', hash]), base, before.head, secrets)
    : workingFiles(root, list, split(before.index), base, baseCommit, secrets);
  pinnedBase(root, baseCommit);
  const after = state();
  if (after.head !== before.head || !after.index.equals(before.index) || after.dirty) fail('The checkout changed while preparing the proposal. Retry when edits are finished.');
  if (!files.length) fail('No changed files to submit.');
  return files;
}

export function validateTests(value) {
  if (!Array.isArray(value) || value.length > 10) fail('The tests file must contain a JSON array of at most 10 agent-reported tests.');
  return value.map(test => {
    if (!object(test) || !['passed', 'failed', 'not-run'].includes(test.result)) fail('Each test needs a command and a passed, failed, or not-run result.');
    const result = { command: text(test.command, 'test command', 400), result: test.result };
    if (test.detail !== undefined) result.detail = text(test.detail, 'test detail', 2000);
    return result;
  });
}

/* ---------- Proof: checks, a preview and screenshots attached to a submission ---------- */

const OUTPUT_LIMIT = 8000;
const IMAGE_LIMIT = 600_000;
const IMAGES_LIMIT = 4_000_000;
const RETAINED = 65_536;
const VIEWPORTS = [{ viewport: 'desktop', width: 1280, height: 800 }, { viewport: 'mobile', width: 390, height: 844 }];
const LOCAL_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})\/?$/;
const PAGE = /^\/(?!\/)[^\s\\\x00-\x1f\x7f]{0,199}$/;
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const NO_PLAYWRIGHT = /Executable doesn't exist|playwright install|npx canceled|missing packages/i;
const SCREENSHOTS_SKIPPED = 'Screenshots skipped: Playwright or its browser is not installed here. Enable them with: npx playwright install chromium';
const proofPath = root => join(root, '.braid', 'proof.json');
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const proofLine = (value, label) => typeof value === 'string' && value.trim() && value.length <= 300 && !/[\x00-\x1f\x7f]/.test(value)
  ? value.trim() : fail(`${label} in .braid/proof.json is one line of at most 300 characters.`);
const proofSeconds = (value, fallback, max, label) => value === undefined ? fallback
  : Number.isInteger(value) && value >= 1 && value <= max ? value : fail(`${label} in .braid/proof.json is a whole number of seconds from 1 to ${max}.`);

/**
 * Validates .braid/proof.json: one-line shell checks, and optionally a preview served on a local port with the pages
 * to screenshot. Unknown fields, other hosts and anything that looks like a credential are refused.
 */
export function validateProof(value, secrets = []) {
  if (!only(value, ['checks', 'timeoutSeconds', 'preview'])) fail('.braid/proof.json is an object with checks, timeoutSeconds and preview.');
  if (value.checks !== undefined && (!Array.isArray(value.checks) || value.checks.length > 10)) fail('List at most 10 checks in .braid/proof.json.');
  const proof = { checks: (value.checks ?? []).map(check => proofLine(check, 'Each check')), timeoutSeconds: proofSeconds(value.timeoutSeconds, 600, 3600, 'timeoutSeconds') };
  if (value.preview !== undefined) {
    const { preview } = value;
    if (!only(preview, ['command', 'url', 'pages', 'timeoutSeconds'])) fail('preview in .braid/proof.json is an object with command, url, pages and timeoutSeconds.');
    const port = typeof preview.url === 'string' ? LOCAL_URL.exec(preview.url)?.[1] : undefined;
    if (!port || Number(port) > 65_535) fail('preview.url must be http://127.0.0.1, http://localhost or http://[::1] with a port, such as http://127.0.0.1:4319.');
    const { origin } = new URL(preview.url), pages = preview.pages ?? ['/'];
    if (!Array.isArray(pages) || !pages.length || pages.length > 6) fail('List 1 to 6 preview pages in .braid/proof.json.');
    if (pages.some(page => typeof page !== 'string' || !PAGE.test(page) || new URL(page, origin).origin !== origin)) fail('Each preview page is a path such as /settings, starting with a single slash.');
    if (proof.checks.length > 9) fail('List at most 9 checks with a preview in .braid/proof.json; a preview that does not start is reported as the tenth.');
    proof.preview = { command: proofLine(preview.command, 'The preview command'), url: origin, pages, timeoutSeconds: proofSeconds(preview.timeoutSeconds, 120, 600, 'preview.timeoutSeconds') };
  }
  if (!proof.checks.length && !proof.preview) fail('List checks or a preview in .braid/proof.json.');
  try { assertNoSecrets(JSON.stringify(value), secrets); } catch { fail('.braid/proof.json looks like it contains a credential. Keep secrets out of it; checks can read them from the environment.'); }
  return proof;
}

function readProof(root, secrets) {
  let value;
  try { value = readJson(proofPath(root), 16_384); } catch (error) {
    if (error.code === 'ENOENT') fail('Add .braid/proof.json to the checkout to use --proof; braid.mjs --help shows its format.');
    if (error instanceof SyntaxError) fail('.braid/proof.json is not valid JSON.');
    if (error instanceof CliError || error.code === 'ELOOP') fail('.braid/proof.json must be a regular file of at most 16 KB.');
    throw error;
  }
  return validateProof(value, secrets);
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const evidencePage = page => typeof page === 'string' && page.length <= 300 && !/[\s\x00-\x1f\x7f]/.test(page) && (/^\/(?!\/)/.test(page) || (/^https?:\/\//i.test(page) && URL.canParse(page)));
const base64Size = data => typeof data === 'string' && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data) ? data.length / 4 * 3 - /=*$/.exec(data)[0].length : 0;

/** Checks evidence against Braid's limits: 12 screenshots of at most 600 KB and 4 MB together, and 10 commands with 8,000 characters of output. */
export function validateEvidence(evidence, secrets = []) {
  if (!Array.isArray(evidence)) fail('Evidence must be a list.');
  let screenshots = 0, commands = 0, bytes = 0;
  for (const item of evidence) {
    if (item?.kind === 'screenshot' && only(item, ['kind', 'page', 'viewport', 'width', 'height', 'contentType', 'data'])) {
      if (++screenshots > 12) fail('Attach at most 12 screenshots.');
      const size = base64Size(item.data);
      if (!evidencePage(item.page) || !['desktop', 'mobile'].includes(item.viewport) || ![item.width, item.height].every(side => Number.isInteger(side) && side > 0 && side <= 4000)
        || !IMAGE_TYPES.includes(item.contentType) || !(size > 0 && size <= IMAGE_LIMIT)) fail('Each screenshot needs a page, a desktop or mobile viewport, its size, and a PNG, JPEG or WebP image of at most 600 KB.');
      if ((bytes += size) > IMAGES_LIMIT) fail('Screenshots may total at most 4 MB.');
    } else if (item?.kind === 'command' && only(item, ['kind', 'command', 'exitCode', 'output', 'durationMs'])) {
      if (++commands > 10) fail('Attach at most 10 commands.');
      if (typeof item.command !== 'string' || !item.command.trim() || item.command.length > 300 || /[\x00-\x1f\x7f]/.test(item.command) || !Number.isInteger(item.exitCode)
        || typeof item.output !== 'string' || item.output.length > OUTPUT_LIMIT || (item.durationMs !== undefined && !(Number.isInteger(item.durationMs) && item.durationMs >= 0))) fail('Each command needs the one-line command of at most 300 characters, its exit code and at most 8,000 characters of output.');
      assertNoSecrets(`${item.command}\n${item.output}`, secrets);
    } else fail('Evidence is a list of screenshots and commands.');
  }
  return evidence;
}

/** A payload as text to scan for credentials; base64 image data is not text. */
const scannable = payload => JSON.stringify(Array.isArray(payload.evidence) ? { ...payload, evidence: payload.evidence.map(item => item?.kind === 'screenshot' ? { ...item, data: '' } : item) } : payload);

/** The type and size of a PNG or JPEG from its header, or null for anything else. */
export function imageInfo(bytes) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a && bytes.toString('latin1', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width && height ? { contentType: 'image/png', width, height } : null;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let offset = 2; offset + 9 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    // Start-of-frame segments carry the size; 0xc4, 0xc8 and 0xcc share the range but are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7);
      return width && height ? { contentType: 'image/jpeg', width, height } : null;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

/** A regular file the screenshot tool wrote, never followed through a symlink. */
function readImage(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= 64 * 1024 * 1024 ? readFileSync(fd) : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

const withNote = (output, note) => !note ? output : !output ? note : `${output}${output.endsWith('\n') ? '' : '\n'}${note}`;
const plainText = value => value.replace(ANSI, '').replace(/\r\n/g, '\n').split('\n').map(line => line.split('\r').findLast(Boolean) ?? '').join('\n').replace(CONTROL, '');
const exitStatus = ({ code, signal, error }) => error ? 127 : code ?? 128 + (system.signals[signal] ?? 0);
const lastLine = value => plainText(value).split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? 'the screenshot tool failed.';

/** The end of what a command printed, as plain text. Output that looks like a credential stops the submission. */
function proofOutput(raw, command, secrets) {
  const plain = plainText(raw);
  try { assertNoSecrets(plain.slice(-(OUTPUT_LIMIT + 512)), secrets); } catch { fail(`The output of ${command} looks like it contains a credential, so nothing was submitted. Stop it printing secrets, then submit again.`); }
  const output = plain.slice(-OUTPUT_LIMIT);
  return /^[\uDC00-\uDFFF]/.test(output) ? output.slice(1) : output;
}

/**
 * The processes one proof starts. Each runs in its own process group (its process tree on Windows), so stopping it
 * stops everything it started. A signal to the CLI stops them all, and close stops whatever is left.
 */
function processSession(rt) {
  const running = new Set(), windows = process.platform === 'win32';
  let stopped;
  const send = (run, signal) => {
    try {
      if (windows) execFileSync('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-run.child.pid, signal);
    } catch { /* Already gone. */ }
  };
  const alive = run => {
    if (!run.child.pid) return false;
    if (windows) return !run.ended;
    try { process.kill(-run.child.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  const stop = async run => {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (!alive(run)) return;
      send(run, signal);
      for (let waited = 0; waited < 2000 && alive(run); waited += 50) await sleep(50);
    }
  };
  const listeners = SIGNALS.map(signal => [signal, () => { stopped ??= signal; for (const run of running) stop(run); }]);
  for (const [signal, listener] of listeners) rt.signals.on(signal, listener);
  const session = {
    check() { if (stopped) fail(`Stopped by ${stopped}. The checks and preview were stopped and nothing was submitted.`); },
    start(file, args, options) {
      session.check();
      const child = spawn(file, args, { ...options, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const kept = [];
      let size = 0;
      const keep = chunk => {
        kept.push(chunk);
        size += chunk.length;
        if (size > 2 * RETAINED) { const recent = Buffer.concat(kept).subarray(-RETAINED); kept.splice(0, kept.length, recent); size = recent.length; }
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const run = { child, ended: false, text: () => Buffer.concat(kept).subarray(-RETAINED).toString('utf8'), closed: new Promise(resolve => child.once('close', resolve)) };
      run.exited = new Promise(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', error => resolve({ code: null, signal: null, error }));
      }).then(result => { run.ended = true; return result; });
      running.add(run);
      return run;
    },
    halt(run) { stop(run); },
    stop,
    /** Waits for the process, stops anything it left behind in its group and collects the rest of its output. */
    async finish(run) {
      const result = await run.exited;
      await stop(run);
      await Promise.race([run.closed, sleep(2000, undefined, { ref: false })]);
      run.child.stdout?.destroy();
      run.child.stderr?.destroy();
      running.delete(run);
      return result;
    },
    async close() {
      for (const [signal, listener] of listeners) rt.signals.off(signal, listener);
      await Promise.all([...running].map(stop));
    },
  };
  return session;
}

async function runCheck(rt, session, root, env, command, timeout, secrets) {
  const started = performance.now(), run = session.start(command, [], { cwd: root, env, shell: true });
  let late = false;
  const timer = setTimeout(() => { late = true; session.halt(run); }, timeout * 1000);
  const result = await session.finish(run);
  clearTimeout(timer);
  session.check();
  const exitCode = late ? 124 : exitStatus(result), durationMs = Math.round(performance.now() - started);
  const output = proofOutput(withNote(run.text(), late ? `Stopped after ${timeout} s.` : result.error?.message), command, secrets);
  rt.log(`Proof: ${command} ${late ? `timed out after ${timeout} s` : `exited ${exitCode} after ${Math.round(durationMs / 1000)} s`}.`);
  return { kind: 'command', command, exitCode, output, durationMs };
}

/** Whether anything answers HTTP at the url, whatever the status. */
async function answering(rt, url) {
  try {
    const response = await rt.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return true;
  } catch { return false; }
}

/** The local Playwright command line, which npx finds without installing anything: playwright, or else playwright-core. */
async function playwright(session, root, env) {
  // On Windows npx is a .cmd script that only a shell runs; its JavaScript entry point runs without one.
  const npx = process.platform === 'win32' ? [process.execPath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')] : ['npx'];
  if (npx.length > 1 && !existsSync(npx[1])) return undefined;
  for (const name of ['playwright', 'playwright-core']) {
    const [file, ...prefix] = npx, args = [...prefix, '--no-install', name];
    const run = session.start(file, [...args, '--version'], { cwd: root, env });
    const timer = setTimeout(() => session.halt(run), 60_000);
    const result = await session.finish(run);
    clearTimeout(timer);
    session.check();
    if (result.code === 0) return { file, args };
  }
  return undefined;
}

/** Screenshots every page at desktop and phone size; without Playwright or its browser they are skipped with one line on enabling them. */
async function screenshots(rt, session, root, env, preview, folder) {
  const tool = await playwright(session, root, env), shots = [];
  let total = 0;
  if (!tool) { rt.log(SCREENSHOTS_SKIPPED); return shots; }
  for (const [index, page] of preview.pages.entries()) for (const view of VIEWPORTS) {
    // A .jpg name makes Playwright write a JPEG, which keeps each image far below the 600 KB limit.
    const file = join(folder, `${index}-${view.viewport}.jpg`);
    const run = session.start(tool.file, [...tool.args, 'screenshot', `--viewport-size=${view.width},${view.height}`, '--wait-for-timeout=1000', new URL(page, preview.url).href, file], { cwd: root, env });
    const timer = setTimeout(() => session.halt(run), 90_000);
    const result = await session.finish(run);
    clearTimeout(timer);
    session.check();
    const image = result.code === 0 ? readImage(file) : undefined, info = image && imageInfo(image);
    if (!info && NO_PLAYWRIGHT.test(run.text())) { rt.log(SCREENSHOTS_SKIPPED); return shots; }
    if (!info) rt.log(`Proof: no ${view.viewport} screenshot of ${page}: ${lastLine(run.text())}`);
    else if (image.length > IMAGE_LIMIT) rt.log(`Proof: the ${view.viewport} screenshot of ${page} is over 600 KB, so it is not attached.`);
    else if ((total += image.length) > IMAGES_LIMIT) rt.log(`Proof: the ${view.viewport} screenshot of ${page} would take the screenshots past 4 MB, so it is not attached.`);
    else shots.push({ kind: 'screenshot', page, viewport: view.viewport, width: info.width, height: info.height, contentType: info.contentType, data: image.toString('base64') });
  }
  rt.log(`Proof: ${shots.length} screenshot${shots.length === 1 ? '' : 's'} of ${preview.url}.`);
  return shots;
}

/** Starts the preview, waits for it to answer and screenshots its pages. A preview that never answers is reported as a failed command. */
async function previewEvidence(rt, session, root, env, preview, folder, secrets) {
  if (await answering(rt, preview.url)) fail(`Something already answers at ${preview.url}. Stop it so the screenshots show this checkout, then submit again.`);
  const started = performance.now(), run = session.start(preview.command, [], { cwd: root, env: { BROWSER: 'none', ...env }, shell: true });
  try {
    const deadline = rt.now() + preview.timeoutSeconds * 1000;
    let ready = false;
    while (!ready && !run.ended && rt.now() < deadline) {
      ready = await answering(rt, preview.url);
      session.check();
      if (!ready) await Promise.race([rt.sleep(250), run.exited]);
    }
    session.check();
    if (ready) return await screenshots(rt, session, root, env, preview, folder);
    const early = run.ended;
    await session.stop(run);
    const result = await session.finish(run);
    const how = result.error ? result.error.message : result.code !== null ? `code ${result.code}` : result.signal;
    const note = early ? `It exited with ${how} before ${preview.url} answered.` : `${preview.url} did not answer within ${preview.timeoutSeconds} s.`;
    rt.log(`Proof: the preview did not start. ${note}`);
    return [{ kind: 'command', command: preview.command, exitCode: early ? exitStatus(result) || 1 : 124, output: proofOutput(withNote(run.text(), note), preview.command, secrets), durationMs: Math.round(performance.now() - started) }];
  } finally { await session.stop(run); }
}

/**
 * Runs a validated .braid/proof.json in the checkout and returns the evidence to attach; a failing check is evidence
 * too. Checks and the preview run without BRAID_ variables and must leave HEAD and tracked files as they were.
 */
async function runProof(rt, root, proof, secrets) {
  const env = { CI: 'true', ...Object.fromEntries(Object.entries(rt.env).filter(([key]) => !/^BRAID_/i.test(key))) };
  const state = () => [['rev-parse', '--verify', 'HEAD'], ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none']].map(args => rt.git(args, { cwd: root, env: rt.env }).toString()).join('\0');
  const before = state(), folder = mkdtempSync(join(tmpdir(), 'braid-proof-')), session = processSession(rt);
  try {
    chmodSync(folder, 0o700);
    const evidence = [];
    for (const command of proof.checks) evidence.push(await runCheck(rt, session, root, env, command, proof.timeoutSeconds, secrets));
    if (proof.preview) evidence.push(...await previewEvidence(rt, session, root, env, proof.preview, folder, secrets));
    if (state() !== before) fail('A check changed HEAD or tracked files, so its proof would not describe this submission. Undo or commit those changes, keep checks from editing tracked files, and submit again.');
    return validateEvidence(evidence, secrets);
  } finally {
    await session.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

function validatePayload(payload, bases, secrets) {
  if (!object(payload) || !COMMIT.test(payload.baseCommit ?? '') || !bases.includes(payload.baseCommit)) fail('The saved submission does not match this pinned task.');
  if (payload.dependsOn !== undefined && (!Array.isArray(payload.dependsOn) || payload.dependsOn.length > 16 || payload.dependsOn.some(item => typeof item === 'number' ? !Number.isSafeInteger(item) || item < 1 : typeof item !== 'string' || !/^ch_[0-9a-f]{13}$/.test(item)))) fail('Invalid pull request dependencies in the saved submission.');
  if (!optionalCommit(payload.previousCommit)) fail('The saved submission names an invalid previous proposal.');
  text(payload.summary, 'summary', 1200);
  text(payload.rationale, 'rationale', 6000);
  if (payload.model !== undefined) text(payload.model, 'model', 120);
  if (payload.tests !== undefined) validateTests(payload.tests);
  if (!Array.isArray(payload.files) || !payload.files.length || payload.files.length > FILE_LIMIT) fail('A proposal requires 1–256 files.');
  let bytes = 0;
  const seen = new Set();
  for (const file of payload.files) {
    if (!object(file) || !validPath(file.path) || seen.has(file.path) || (file.content !== null && typeof file.content !== 'string')) fail('Invalid or protected file in the saved submission.');
    seen.add(file.path);
    if (file.mode !== undefined && (file.content === null || !REGULAR.includes(file.mode))) fail('Invalid file mode in the saved submission.');
    if (file.content === null) continue;
    const encoded = Buffer.from(file.content, 'utf8');
    if (decodeText(encoded) !== file.content) fail('Only UTF-8 text files can be submitted.');
    assertNoSecrets(file.path + '\n' + file.content, secrets);
    bytes += encoded.length;
  }
  if (bytes > LIMIT) fail('A proposal exceeds the 3 MiB change limit.');
  if (payload.evidence !== undefined) validateEvidence(payload.evidence, secrets);
  for (const value of [payload.summary, payload.rationale, payload.model, ...(payload.tests ?? []).flatMap(test => [test.command, test.detail])]) if (value !== undefined) assertNoSecrets(value, secrets);
  assertNoSecrets(scannable(payload), secrets);
}

function acquireLock(path) {
  try { writeJson(path, { pid: process.pid }, true); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lock = readJson(path, 1024, { privateFile: true });
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) fail('Invalid submission lock. Inspect .braid/submission.lock before removing it.');
    try { process.kill(lock.pid, 0); } catch (error) {
      if (error.code === 'ESRCH') { unlinkSync(path); writeJson(path, { pid: process.pid }, true); return; }
    }
    fail('Another submit or update process is active for this checkout. Wait for it to finish.');
  }
}

function readJournal(root, task) {
  let journal;
  try { journal = readJson(join(root, '.braid', 'submission.json'), RECEIPT_LIMIT, { privateFile: true }); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const target = { url: task.url, workspaceId: task.workspaceId, missionId: task.missionId, agentId: task.agentId };
  if (!object(journal) || Object.keys(target).some(key => journal[key] !== target[key]) || !KEY.test(journal.key ?? '') || typeof journal.body !== 'string'
    || !['pending', 'complete', 'rejected'].includes(journal.status) || (journal.status === 'complete' && !COMMIT.test(journal.commit ?? ''))) fail('Invalid submission receipt for this task. Do not discard an uncertain submission.');
  return journal;
}

/** Keeps every replaced receipt, so earlier accepted proposals stay recoverable under .braid/submissions. */
function archiveReceipt(root, journal) {
  const path = join(privateDirectory(join(root, '.braid', 'submissions')), `${journal.key}.json`);
  let saved;
  try { saved = readJson(path, RECEIPT_LIMIT, { privateFile: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved && (!object(saved) || saved.key !== journal.key || saved.body !== journal.body)) fail('An archived receipt conflicts with this submission. Inspect .braid/submissions before submitting again.');
  writeJson(path, journal);
}

const parsed = body => { try { return JSON.parse(body); } catch { return undefined; } };
/** The latest saved description, which a revision reuses when it omits --summary. */
function savedDescription(journal) {
  const body = journal && parsed(journal.body);
  if (!object(body) || typeof body.summary !== 'string') fail('Describe the result with --summary.');
  return { summary: body.summary, rationale: body.rationale, model: body.model };
}

/** Identical work, summary, tests and proof, ignoring the previous-proposal check. */
function sameWork(left, right) {
  const strip = body => { const { previousCommit: _, ...rest } = parsed(body) ?? {}; return JSON.stringify(rest); };
  return strip(left) === strip(right);
}

/** The latest proposal to compare against: a newer confirmed receipt wins over metadata from before it. */
function expectedPrevious(task, journal) {
  const recorded = task.previousCommit ?? null;
  if (journal?.status !== 'complete') return recorded;
  const sent = parsed(journal.body)?.previousCommit ?? null;
  return recorded === sent || recorded === journal.commit ? journal.commit : recorded;
}

function rejection(status, payload, task) {
  const advice = status === 409
    ? payload.baseCommit === (task.acceptedBase ?? task.baseCommit)
      ? 'The task or its latest proposal changed: run resume for this checkout, then submit again.'
      : 'Main or the latest proposal changed: run update, integrate the fetched main commit, rerun checks and submit again.'
    : status === 413 ? 'The proposal exceeds a size limit.'
    : [401, 403].includes(status) ? 'Check access, then run start for this task.'
    : 'Check the patch requirements.';
  return `Submission rejected (HTTP ${status}). No confirmed proposal was returned. ${advice}`;
}

export async function submit(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  privateDirectory(join(root, '.braid'));
  const task = readTask(root);
  pinnedBase(root, task.acceptedBase, task.baseCommit);
  const credentials = loadCredentials(task.url, rt.env, { workspaceId: task.workspaceId });
  if (credentials.workspaceId !== task.workspaceId) fail('The approved workspace does not match this checkout. Reconnect to the correct workspace.');
  const journalPath = join(root, '.braid', 'submission.json'), lockPath = join(root, '.braid', 'submission.lock');
  const endpoint = `${task.url}/api/missions/${task.missionId}/agents/${task.agentId}/submit`;
  acquireLock(lockPath);
  try {
    let journal = readJournal(root, task), body;
    if (input.retry) {
      if (!journal) fail('There is no saved submission to retry.');
      body = journal.body;
    } else {
      // New proof never replaces an unconfirmed submission; that one is resent exactly, with its own proof.
      if (input.proof && journal?.status === 'pending') fail('An earlier submission has no confirmed result. Run submit --dir DIRECTORY --retry to resend it with its saved proof, then submit again.');
      const proof = input.proof ? readProof(root, [credentials.accessToken]) : undefined;
      if (!descends(root, task.baseCommit)) fail(task.acceptedBase ? `Merge or rebase the fetched main commit ${task.baseCommit} into this checkout, rerun the checks, then submit.` : 'HEAD must descend from the pinned base. Preserve the task history before submitting.');
      const previousCommit = expectedPrevious(task, journal);
      const saved = input.summary === undefined ? savedDescription(journal) : {}, summary = input.summary ?? saved.summary, model = input.model ?? saved.model;
      const payload = { ...(input['depends-on'] !== undefined ? { dependsOn: parseDependsOn(input['depends-on']) } : {}), baseCommit: task.baseCommit, previousCommit, summary: text(summary, 'summary', 1200), rationale: text(input.rationale ?? saved.rationale ?? summary, 'rationale', 6000) };
      if (model !== undefined) payload.model = text(model, 'model', 120);
      payload.files = collectChanges(root, task.baseCommit, [credentials.accessToken], { committed: task.submissionMode === 'commits', git: rt.git });
      if (input.tests !== undefined) payload.tests = validateTests(readJson(resolve(input.tests), 128_000));
      if (proof) {
        const evidence = await runProof(rt, root, proof, [credentials.accessToken]);
        if (evidence.length) payload.evidence = evidence;
      }
      body = JSON.stringify(payload);
      // Identical work resends or replays the saved request instead of becoming a new revision.
      if (journal && journal.body !== body && sameWork(journal.body, body)
        && (journal.status === 'pending' || (journal.status === 'complete' && journal.commit === previousCommit))) body = journal.body;
      if (journal?.status === 'pending' && journal.body !== body) fail('An earlier submission has no confirmed result. Use --retry to resend its exact saved payload; current edits will not be sent.');
    }
    const payload = parsed(body);
    if (!payload) fail('The saved submission payload is invalid. Do not discard an uncertain submission.');
    validatePayload(payload, [task.baseCommit, task.acceptedBase], [credentials.accessToken]);
    if (journal?.status === 'complete' && journal.body === body) {
      rt.log(`Previously submitted proposal ${journal.commit} for review. Tests are agent-reported and unverified.${linkLine(journal.html_url)}${followTask(root)}`);
      return { commit: journal.commit };
    }
    const wasUncertain = journal?.status === 'pending';
    if (!journal || journal.body !== body) {
      if (journal) archiveReceipt(root, journal);
      journal = { url: task.url, workspaceId: task.workspaceId, missionId: task.missionId, agentId: task.agentId, key: randomUUID(), body, status: 'pending' };
    }
    journal.status = 'pending';
    writeJson(journalPath, journal);
    const send = () => post(rt, endpoint, journal.body, { ...authHeaders(credentials), 'Idempotency-Key': journal.key }, 180_000);
    let response;
    try { response = await send(); } catch { fail('Submission outcome is uncertain. Run submit --dir DIRECTORY --retry to resend the saved payload and key.'); }
    if (response.status === 403) {
      // A valid week-long connection can renew its shorter task claim. A foreign
      // active claimant still prevents checkout, and no proposal body/key changes.
      try {
        await resume({ dir: root }, rt);
        response = await send();
      } catch { fail('Task access could not be renewed. Run start for this task, then submit --retry. The saved submission is preserved.'); }
    }
    if (!response.ok) {
      // A first attempt that Braid refused was never applied; an earlier uncertain attempt still might have been.
      if (!wasUncertain && [400, 401, 403, 404, 405, 409, 413, 415, 422].includes(response.status)) {
        journal.status = 'rejected';
        writeJson(journalPath, journal);
        fail(rejection(response.status, payload, task));
      }
      fail(`Submission is unconfirmed (HTTP ${response.status}). Use --retry with the saved payload and key.`);
    }
    let result;
    try { result = await jsonResponse(response); } catch { fail('Submission outcome is uncertain. Use --retry with the saved payload and key.'); }
    if (!COMMIT.test(result.commit ?? '')) fail('Submission returned no valid commit receipt. Use --retry with the saved payload and key.');
    // Record the accepted proposal before its receipt; an interrupted run still holds a pending receipt to retry.
    const current = readTask(root), accepted = withPrevious(current, result.commit);
    if (payload.baseCommit === current.baseCommit) delete accepted.acceptedBase;
    saveTask(root, current, accepted);
    writeJson(journalPath, { ...journal, status: 'complete', commit: result.commit, html_url: htmlUrl(result.html_url) });
    const replaced = payload.previousCommit ? `, replacing ${payload.previousCommit}` : '';
    rt.log(`Submitted proposal ${result.commit} for review${replaced}. Tests are agent-reported and unverified.${linkLine(result.html_url)}${followTask(root)}`);
    return { commit: result.commit };
  } finally { unlinkSync(lockPath); }
}

/* ---------- Changes: work on trunk and land through Braid's queue ---------- */

const CHANGE_ID = /^ch_[0-9a-f]{13}$/;
const changePath = root => join(root, '.braid', 'change.json');
const FINAL = ['landed', 'closed'];

function readChange(root) {
  directory(join(root, '.braid'));
  const meta = readJson(changePath(root), 65_536, { privateFile: true });
  let origin;
  try { origin = normalizeOrigin(meta.origin); } catch { fail('Invalid change checkout metadata.'); }
  if (origin !== meta.origin || !ID.test(meta.workspaceId ?? '') || !COMMIT.test(meta.base ?? '') || (meta.nextBase !== undefined && !COMMIT.test(meta.nextBase))
    || (meta.changeId !== undefined && !CHANGE_ID.test(meta.changeId)) || (meta.revision !== undefined && !Number.isInteger(meta.revision))) fail('Invalid change checkout metadata.');
  return meta;
}

function excludeBraid(rt, dir) {
  const exclude = resolve(dir, rt.git(['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, env: rt.env }).toString().trim());
  directory(dirname(exclude), true);
  if (existsSync(exclude) && !lstatSync(exclude).isFile()) fail('Git exclude must be a regular file.');
  const fd = openSync(exclude, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, '\n.braid/\n'); } finally { closeSync(fd); }
}

/** Exchanges the approved connection for a five-minute access token, so each request is checked without a lookup. */
async function accessFor(rt, origin, credentials) {
  const response = await post(rt, `${origin}/api/agent/session`, '{}', authHeaders(credentials));
  if (response.status === 401) fail('The Braid connection expired or was revoked. Run connect again.');
  if (!response.ok) fail(`Braid did not issue an access token (HTTP ${response.status}).`);
  const data = await jsonResponse(response);
  if (typeof data.accessToken !== 'string' || !data.accessToken.startsWith('braid_at_')) fail('Braid returned an invalid access token.');
  return { accessToken: tokenValue(data.accessToken), workspaceId: credentials.workspaceId };
}

async function trunkCheckout(rt, origin, access) {
  const response = await post(rt, `${origin}/api/changes/checkout`, '{}', authHeaders(access));
  if (!response.ok) fail(`Braid did not provide repository access (HTTP ${response.status}).`);
  const details = await jsonResponse(response);
  if (!COMMIT.test(details.head ?? '') || typeof details.token !== 'string' || typeof details.branch !== 'string') fail('Braid returned invalid repository details.');
  return { remote: validateRemote(details.remote), token: tokenValue(details.token), head: details.head, branch: details.branch };
}

async function getJson(rt, url, credentials) {
  let response;
  try { response = await rt.fetch(url, { redirect: 'error', headers: authHeaders(credentials), signal: AbortSignal.timeout(30_000) }); }
  catch { fail('Braid could not be reached. Check the connection and retry.'); }
  if (!response.ok) fail(`Braid answered HTTP ${response.status}.`);
  return jsonResponse(response);
}

/** The last lines of a command's output, indented under it. */
const outputTail = output => {
  const lines = String(output ?? '').slice(-4000).trimEnd().split('\n').slice(-40);
  return lines.some(line => line.trim()) ? `\n${lines.map(line => `  ${line}`).join('\n')}` : '';
};

/** Comment data at the dependency-free helper's API boundary. */
function reviewComments(value) {
  if (!Array.isArray(value) || value.some(comment => !object(comment) || typeof comment.id !== 'string' || typeof comment.body !== 'string'
    || !object(comment.author) || typeof comment.author.name !== 'string' || typeof comment.author.kind !== 'string'
    || comment.inReplyTo !== undefined && typeof comment.inReplyTo !== 'string'
    || comment.resolved !== undefined && typeof comment.resolved !== 'boolean'
    || comment.author.owner !== undefined && (!object(comment.author.owner) || typeof comment.author.owner.name !== 'string' || comment.author.owner.github !== undefined && typeof comment.author.owner.github !== 'string' || comment.author.owner.email !== undefined && typeof comment.author.owner.email !== 'string')
    || comment.anchor !== undefined && (!object(comment.anchor) || typeof comment.anchor.path !== 'string' || !Number.isInteger(comment.anchor.line)
      || !['LEFT', 'RIGHT'].includes(comment.anchor.side) || !Number.isInteger(comment.anchor.revision) || typeof comment.anchor.outdated !== 'boolean'
      || comment.anchor.position !== null && !Number.isInteger(comment.anchor.position)))) fail('Braid returned invalid review comments.');
  return value;
}
export function personHandle(value) {
  const login = /^(?:[0-9]+\+)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)@users\.noreply\.github\.com$/i.exec(value)?.[1];
  return login ? `@${login}` : value;
}
const personLabel = person => {
  if (person.github) return `@${person.github}`;
  const email = personHandle(person.email ?? '');
  return email.startsWith('@') ? email : personHandle(person.name);
};
function describeComments(comments) {
  const roots = new Set(comments.filter(comment => !comment.inReplyTo && !comment.resolved).map(comment => comment.id));
  return comments.filter(comment => roots.has(comment.inReplyTo ?? comment.id)).map(comment => {
    const anchor = comment.anchor, owner = comment.author.owner;
    const by = `${comment.author.kind === 'agent' ? comment.author.name : personHandle(comment.author.name)}${comment.author.kind === 'agent' && owner ? ` for ${personLabel(owner)}` : ''}`;
    return `${comment.inReplyTo ? `Reply to ${comment.inReplyTo}` : `Comment ${comment.id}`}${anchor ? ` at ${anchor.path}:${anchor.position ?? anchor.line} (${anchor.side}${anchor.outdated ? ', Outdated' : ''}; revision ${anchor.revision})` : ''} by ${by}:\n${comment.body}`;
  }).join('\n\n');
}

/** Everything that sent a change back, in terms an agent can act on: failing commands with their output, broken instructions, conflicts and reviews. */
function describeChange(change) {
  const current = item => item?.revision === change.revision;
  const failing = (change.evidence ?? []).filter(item => item?.kind === 'command' && current(item) && item.exitCode !== 0);
  const lines = [`Pull request #${change.number} · ${change.title} · ${{ landed: 'merged', revise: 'changes requested', attention: 'review required' }[change.status] ?? change.status}${change.closeReason ? ` (${change.closeReason})` : ''} · revision ${change.revision}`];
  if (change.html_url) lines.push(htmlUrl(change.html_url));
  if (change.next) lines.push(`Next: ${change.next}`);
  if (change.dependsOn?.length) lines.push(`Depends on ${change.dependsOn.map(item => `#${item.number}`).join(', ')}`);
  if (change.outdated?.length && !change.next?.includes('changed since this was built')) lines.push(`${change.outdated.map(item => `#${item.number}`).join(', ')} changed since this was built`);
  if (change.requiredBy?.length) lines.push(`Required by ${change.requiredBy.map(item => `#${item.number}`).join(', ')}`);
  const comments = describeComments(reviewComments(change.comments ?? []));
  if (comments) lines.push(`Unresolved review comments:\n${comments}`);
  for (const conflict of change.conflicts ?? []) lines.push(`Conflict (${conflict.kind}) in ${conflict.path}${conflict.regions?.length ? ` at line ${conflict.regions[0].baseStart + 1}` : ''}`);
  for (const item of failing) lines.push(`Failed${item.source === 'braid' ? ' in Braid' : ''}: ${item.command} (exit ${item.exitCode})${outputTail(item.output)}`);
  for (const check of (change.checks ?? []).filter(check => current(check) && check.status === 'failed' && !failing.some(item => item.command === check.label))) lines.push(`Failed check (${check.source}): ${check.label}\n${check.detail}`);
  for (const guard of change.guards ?? []) lines.push(guard.kind === 'instructions' ? `Instruction broken in ${guard.path}: ${guard.detail}` : `Guard: ${guard.detail}`);
  for (const review of (change.reviews ?? []).filter(review => current(review) && review.verdict !== 'approve')) lines.push(`Review (${review.reviewer}): ${review.verdict} — ${review.summary}${(review.findings ?? []).map(finding => `\n  ${finding.path ?? ''}${finding.line ? `:${finding.line}` : ''} ${finding.message}`).join('')}`);
  if (change.overlaps?.length) lines.push(`Also active on the same files: ${change.overlaps.map(overlap => `#${overlap.number}`).join(', ')}`);
  if (change.landedCommit) lines.push(`Merged as ${change.landedCommit}.`);
  // Server and command text reaches a terminal: drop escape sequences and control characters.
  return lines.join('\n').replace(ANSI, '').replace(CONTROL, '');
}

const CLI_PATH = fileURLToPath(import.meta.url);
const shellWord = value => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
/** The exact command to run this CLI again, quoted for a POSIX shell. */
const cliCommand = (...args) => ['node', CLI_PATH, ...args].map(shellWord).join(' ');
const followTask = root => `\nNext, wait until it merges or needs changes:\n  ${cliCommand('wait', '--dir', root)}`;

/**
 * What to do next, ending with the exact command. A change that came back is fixed and resubmitted with proof; one
 * that needs a person stops the agent; one still moving is waited for. Nothing follows a landed or closed change.
 */
function nextStep(change, { root, origin, task = false }) {
  const dir = ['--dir', root];
  if (change.outdated?.length && !change.conflicts?.length) return `\nRestack this pull request:\n  ${cliCommand('restack', String(change.number), ...dir)}`;
  if (change.status === 'revise') {
    const resubmit = cliCommand(...(task ? ['submit'] : ['change', 'submit']), ...dir, ...(existsSync(proofPath(root)) ? ['--proof'] : []));
    if (change.outdated?.length && change.conflicts?.length) return `\nResolve the conflicts with the updated prerequisites, commit, then resubmit:\n  ${resubmit}`;
    if (!change.conflicts?.length) return `\nFix exactly what is listed above, commit, then resubmit:\n  ${resubmit}`;
    return task
      ? `\nFetch main, merge it and resolve the conflicts, fix anything else listed, commit, then resubmit:\n  ${cliCommand('update', ...dir)}\n  ${resubmit}`
      : `\nFetch main, rebase onto it and resolve the conflicts, fix anything else listed, commit, then resubmit:\n  ${cliCommand('change', 'sync', ...dir)}\n  ${resubmit}`;
  }
  if (change.status === 'attention') return `\nA person must decide. Ask the owner to open pull request #${change.number}${change.html_url ? `: ${htmlUrl(change.html_url)}` : ` in this repository at ${origin}`}.`;
  if (FINAL.includes(change.status)) return '';
  return `\nNext, wait until it merges or needs changes:\n  ${cliCommand(...(task ? ['wait'] : ['change', 'wait']), ...dir)}`;
}

/** Clones trunk into a new directory for one change. */
export async function changeStart(input, options = {}) {
  const rt = runtime(options), origin = normalizeOrigin(input.url);
  const dir = resolve(text(input.dir, 'checkout directory', 4096));
  if (existsSync(dir)) fail('Choose a new --dir; change start clones main into it.');
  const credentials = loadCredentials(origin, rt.env, { workspaceId: input.workspace });
  const access = await accessFor(rt, origin, credentials);
  const trunk = await trunkCheckout(rt, origin, access);
  withAskpass(helper => rt.git(['clone', '--no-checkout', '--no-local', '--template=', '--', trunk.remote, dir], { env: { ...rt.env, GIT_ASKPASS: helper }, token: trunk.token }));
  rt.git(['checkout', '-B', 'braid/change', '--no-recurse-submodules', trunk.head, '--'], { cwd: dir, env: rt.env });
  excludeBraid(rt, dir);
  privateDirectory(join(dir, '.braid'));
  writeJson(changePath(dir), { origin, workspaceId: credentials.workspaceId, base: trunk.head }, true);
  rt.log(`Main ${trunk.head} is checked out at ${dir}. Commit your work, run checks, then submit it with change submit. Others may be editing the same files; change touching shows who.`);
  return { dir, base: trunk.head };
}

/** Fetches current trunk. Without local commits the checkout moves to it; otherwise rebase or merge, then submit. */
export async function changeSync(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const meta = readChange(root);
  const credentials = loadCredentials(meta.origin, rt.env, { workspaceId: meta.workspaceId });
  const trunk = await trunkCheckout(rt, meta.origin, await accessFor(rt, meta.origin, credentials));
  fetchCommit(rt, root, trunk.remote, trunk.head, trunk.token);
  const head = rt.git(['rev-parse', 'HEAD'], { cwd: root, env: rt.env }).toString().trim();
  if (head === meta.base && !rt.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, env: rt.env }).length) {
    rt.git(['merge', '--ff-only', '--no-edit', trunk.head], { cwd: root, env: rt.env });
    writeJson(changePath(root), { ...meta, base: trunk.head, nextBase: undefined });
    rt.log(`Moved to main ${trunk.head}.`);
  } else {
    writeJson(changePath(root), { ...meta, nextBase: trunk.head });
    rt.log(`Fetched main ${trunk.head}. Rebase or merge it into your work (git rebase ${trunk.head}), resolve any conflicts, rerun checks, then change submit.`);
  }
  return { head: trunk.head };
}

/** Submits the committed work since its trunk base as a new change, or as the next revision of this checkout's change. */
export function parseDependsOn(value) {
  if (typeof value !== 'string') fail('Use pull request numbers or change ids separated by commas.');
  const values = value === 'none' ? [] : value.split(',').map(part => /^[1-9]\d*$/.test(part.trim()) ? Number(part.trim()) : part.trim());
  if (values.length > 16 || values.some(item => typeof item === 'number' ? !Number.isSafeInteger(item) || item < 1 : !/^ch_[0-9a-f]{13}$/.test(item))) fail('Use up to 16 pull request numbers or change ids; none clears dependencies.');
  return values;
}

function pullRequestContext(value) {
  if (value === undefined) return undefined;
  const states = ['open', 'revise', 'attention', 'queued', 'landing', 'landed', 'closed'];
  const valid = item => object(item) && CHANGE_ID.test(item.id) && Number.isSafeInteger(item.number) && item.number > 0 && states.includes(item.status);
  if (!valid(value) || value.next !== undefined && typeof value.next !== 'string') fail('Braid returned invalid pull request context.');
  for (const key of ['dependsOn', 'waitingOn', 'outdated']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 16 || !value[key].every(valid))) fail('Braid returned invalid pull request dependencies.');
  return value;
}

export async function changeSubmit(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const meta = readChange(root);
  const credentials = loadCredentials(meta.origin, rt.env, { workspaceId: meta.workspaceId });
  const journalPath = join(root, '.braid', 'change-submission.json'), lockPath = join(root, '.braid', 'change.lock');
  acquireLock(lockPath);
  try {
    let journal;
    try { journal = readJson(journalPath, RECEIPT_LIMIT, { privateFile: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (input.retry) {
      if (journal?.status !== 'pending') fail('There is no unconfirmed change submission to retry.');
      if (journal.payload?.evidence !== undefined) validateEvidence(journal.payload.evidence, [credentials.accessToken]);
    } else {
      if (journal?.status === 'pending') fail('An earlier change submission is unconfirmed. Run change submit --dir DIRECTORY --retry first.');
      if (!meta.changeId && (input.title === undefined || input.summary === undefined)) fail('A new change needs --title and --summary.');
      const proof = input.proof ? readProof(root, [credentials.accessToken]) : undefined;
      // A revision reuses the previous description for whatever it leaves out.
      const previous = meta.changeId && object(journal?.payload) ? journal.payload : {};
      const [title, summary, intent, rationale, model] = ['title', 'summary', 'intent', 'rationale', 'model'].map(name => input[name] ?? (typeof previous[name] === 'string' ? previous[name] : undefined));
      if (summary === undefined) fail('Describe the change with --summary.');
      // The next base applies once the work has been rebased or merged onto it.
      const base = meta.nextBase && descends(root, meta.nextBase) ? meta.nextBase : meta.base;
      const files = collectChanges(root, base, [credentials.accessToken], { committed: true, git: rt.git });
      const dependsOn = input['depends-on'] === undefined ? undefined : parseDependsOn(input['depends-on']);
      const payload = { ...(dependsOn !== undefined ? { dependsOn } : {}), title: text(title ?? 'Agent change', 'title', 120), summary: text(summary, 'summary', 1200), baseCommit: base, files,
        ...(intent ? { intent: text(intent, 'intent', 4000) } : {}), ...(rationale ? { rationale: text(rationale, 'rationale', 6000) } : {}),
        ...(model ? { model: text(model, 'model', 120) } : {}), ...(input.tests ? { tests: validateTests(readJson(resolve(input.tests), 65_536)) } : {}),
        ...(meta.changeId ? { previousRevision: meta.revision } : {}) };
      if (proof) {
        const evidence = await runProof(rt, root, proof, [credentials.accessToken]);
        if (evidence.length) payload.evidence = evidence;
      }
      assertNoSecrets(scannable(payload), [credentials.accessToken]);
      journal = { status: 'pending', key: randomUUID(), target: meta.changeId ? `/api/changes/${meta.changeId}/revisions` : '/api/changes', payload };
      writeJson(journalPath, journal);
    }
    const access = await accessFor(rt, meta.origin, credentials);
    const response = await post(rt, `${meta.origin}${journal.target}`, JSON.stringify(journal.payload), { ...authHeaders(access), 'Idempotency-Key': journal.key }, 120_000);
    if (!response.ok) {
      if ([400, 403, 404, 409, 413, 422].includes(response.status)) {
        writeJson(journalPath, { ...journal, status: 'rejected' });
        const reason = await response.json().then(data => data.error).catch(() => undefined);
        fail(`Braid did not accept the change (HTTP ${response.status})${reason ? `: ${reason}` : '.'}`);
      }
      fail(`The submission is unconfirmed (HTTP ${response.status}). Run change submit --dir DIRECTORY --retry.`);
    }
    const change = await jsonResponse(response);
    if (!CHANGE_ID.test(change.id ?? '')) fail('Braid returned an invalid change. Run change submit --retry.');
    writeJson(changePath(root), { ...meta, base: journal.payload.baseCommit, nextBase: meta.nextBase === journal.payload.baseCommit ? undefined : meta.nextBase, changeId: change.id, number: change.number, revision: change.revision });
    writeJson(journalPath, { ...journal, status: 'complete', changeId: change.id, revision: change.revision });
    rt.log(describeChange(change) + nextStep(change, { root, origin: meta.origin }));
    return change;
  } finally { unlinkSync(lockPath); }
}

/** Restacks the pull request in Braid; local commits and files are left as they are. */
export async function restack(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const number = Number(input.number);
  if (!Number.isSafeInteger(number) || number < 1) fail('Provide a positive pull request number.');
  const task = existsSync(taskPath(root)) ? readTask(root) : null;
  const meta = task ? { origin: task.url, workspaceId: task.workspaceId } : readChange(root);
  const credentials = loadCredentials(meta.origin, rt.env, { workspaceId: meta.workspaceId });
  const access = await accessFor(rt, meta.origin, credentials), path = `${meta.origin}/api/changes/${number}`;
  const journal = join(root, '.braid', `restack-${number}.json`), lock = journal + '.lock';
  acquireLock(lock);
  try {
    let saved = existsSync(journal) ? readJson(journal, 4096, { privateFile: true }) : undefined;
    if (saved && (!object(saved) || !KEY.test(saved.key ?? '') || typeof saved.pending !== 'boolean' || saved.origin !== meta.origin || saved.workspaceId !== meta.workspaceId
      || !object(saved.body) || !Number.isSafeInteger(saved.body.previousRevision) || saved.body.previousRevision < 1)) fail('Invalid saved restack for this repository.');
    if (!saved?.pending) {
      const current = pullRequestContext(await getJson(rt, path, access));
      if (!Number.isSafeInteger(current.revision) || current.revision < 1) fail('Braid returned an invalid revision.');
      saved = { key: randomUUID(), body: { previousRevision: current.revision }, pending: true, origin: meta.origin, workspaceId: meta.workspaceId };
      writeJson(journal, saved);
    }
    const response = await post(rt, `${path}/restack`, JSON.stringify(saved.body), { ...authHeaders(access), 'idempotency-key': saved.key });
    const result = await jsonResponse(response);
    if (!response.ok) {
      if ([400, 403, 404, 409].includes(response.status)) writeJson(journal, { ...saved, pending: false });
      fail(result.error ?? `Restack is unconfirmed (HTTP ${response.status}). Retry the same command.`);
    }
    const change = pullRequestContext(result);
    if (!Number.isSafeInteger(change.revision) || change.revision < 1) fail('Braid returned an invalid revision. Retry the same command.');
    writeJson(journal, { ...saved, pending: false });
    rt.log(describeChange(change, [credentials.accessToken]) + nextStep(change, { root, origin: meta.origin, task: !!task }) + '\nLocal commits and files are unchanged.');
    return change;
  } finally { unlinkSync(lock); }
}

export async function changeStatus(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const meta = readChange(root);
  if (!meta.changeId) fail('This checkout has not submitted a change yet.');
  const credentials = loadCredentials(meta.origin, rt.env, { workspaceId: meta.workspaceId });
  const change = await getJson(rt, `${meta.origin}/api/changes/${meta.changeId}`, await accessFor(rt, meta.origin, credentials));
  writeJson(changePath(root), { ...meta, revision: change.revision });
  rt.log(describeChange(change) + nextStep(change, { root, origin: meta.origin }));
  return change;
}

/** Waits until the change lands, is sent back, needs a person, or is closed. */
export async function changeWait(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const meta = readChange(root);
  if (!meta.changeId) fail('This checkout has not submitted a change yet.');
  const credentials = loadCredentials(meta.origin, rt.env, { workspaceId: meta.workspaceId });
  const timeout = input.timeout === undefined ? 1800 : Number(input.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86_400) fail('Use --timeout SECONDS between 1 and 86400.');
  const deadline = rt.now() + timeout * 1000;
  let waiting = '';
  let delay = 5000, access = await accessFor(rt, meta.origin, credentials), minted = rt.now();
  for (;;) {
    if (rt.now() - minted > 4 * 60_000) { access = await accessFor(rt, meta.origin, credentials); minted = rt.now(); }
    const change = await getJson(rt, `${meta.origin}/api/changes/${meta.changeId}`, access);
    if (FINAL.includes(change.status) || change.status === 'revise' || change.status === 'attention' || rt.now() >= deadline) {
      writeJson(changePath(root), { ...meta, revision: change.revision });
      rt.log(describeChange(change) + nextStep(change, { root, origin: meta.origin }));
      return change;
    }
    const next = change.waitingOn?.length ? change.next ?? `Waiting on ${change.waitingOn.map(item => `#${item.number}`).join(', ')}` : '';
    if (next && next !== waiting) rt.log(next.replace(ANSI, '').replace(CONTROL, ''));
    waiting = next;
    await rt.sleep(Math.min(delay, Math.max(0, deadline - rt.now())));
    delay = Math.min(30_000, delay * 1.5);
  }
}

/**
 * Waits for what this checkout submitted: its change, or the change a task's
 * result became once the repository lands it through the queue.
 */
export async function wait(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  if (existsSync(changePath(root))) return changeWait(input, rt);
  const task = readTask(root), origin = task.url;
  const credentials = loadCredentials(origin, rt.env, { workspaceId: task.workspaceId });
  const timeout = input.timeout === undefined ? 1800 : Number(input.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86_400) fail('Use --timeout SECONDS between 1 and 86400.');
  const deadline = rt.now() + timeout * 1000;
  let delay = 5000, access = await accessFor(rt, origin, credentials), minted = rt.now();
  for (;;) {
    if (rt.now() - minted > 4 * 60_000) { access = await accessFor(rt, origin, credentials); minted = rt.now(); }
    const page = await getJson(rt, `${origin}/api/changes?task=${encodeURIComponent(task.missionId)}&limit=5`, access);
    const latest = Array.isArray(page.items) ? page.items[0] : undefined;
    if (latest && CHANGE_ID.test(latest.id ?? '')) {
      const change = await getJson(rt, `${origin}/api/changes/${latest.id}`, access);
      if (FINAL.includes(change.status) || change.status === 'revise' || change.status === 'attention' || rt.now() >= deadline) {
        rt.log(describeChange(change) + nextStep(change, { root, origin, task: true }));
        return change;
      }
    } else if (rt.now() >= deadline) {
      rt.log(`No pull request yet. Submit the task result with the merge queue enabled; otherwise the owner merges the task in Braid.${linkLine(task.html_url)}`);
      return null;
    }
    await rt.sleep(Math.min(delay, Math.max(0, deadline - rt.now())));
    delay = Math.min(30_000, delay * 1.5);
  }
}

export async function changeTouching(input, options = {}) {
  const rt = runtime(options), root = repositoryRoot(text(input.dir, 'checkout directory', 4096));
  const meta = readChange(root);
  const paths = text(input.paths, 'paths', 8000).split(',').map(path => path.trim()).filter(Boolean);
  if (!paths.length || paths.length > 200 || paths.some(path => !validPath(path))) fail('List up to 200 repository paths separated by commas.');
  const credentials = loadCredentials(meta.origin, rt.env, { workspaceId: meta.workspaceId });
  const touching = await getJson(rt, `${meta.origin}/api/coordination?paths=${encodeURIComponent(paths.join(','))}`, await accessFor(rt, meta.origin, credentials));
  for (const path of paths) {
    const others = (touching[path] ?? []).filter(other => other.changeId !== meta.changeId);
    rt.log(others.length ? `${path}: ${others.map(other => `#${other.number} ${other.title} (${other.author}, ${other.status})`).join('; ')}` : `${path}: no other active changes`);
  }
  return touching;
}

const COMMANDS = {
  restack: { options: ['dir'], required: ['dir', 'number'] },
  start: { options: ['dir'], required: ['task'] },
  connect: { options: ['url', 'workspace', 'repository', 'email', 'code', 'link'], required: ['url'] },
  checkout: { options: ['url', 'mission', 'agent', 'dir', 'workspace'], required: ['url', 'mission', 'agent', 'dir'] },
  progress: { options: ['dir', 'message'], required: ['dir', 'message'] },
  resume: { options: ['dir'], required: ['dir'] },
  update: { options: ['dir'], required: ['dir'] },
  // A revision may omit --summary (and --title for a change) to reuse the previous description.
  submit: { options: ['depends-on', 'dir', 'summary', 'rationale', 'model', 'tests', 'retry', 'proof'], required: ['dir'] },
  wait: { options: ['dir', 'timeout'], required: ['dir'] },
  'change start': { options: ['url', 'dir', 'workspace'], required: ['url', 'dir'] },
  'change sync': { options: ['dir'], required: ['dir'] },
  'change submit': { options: ['depends-on', 'dir', 'title', 'summary', 'intent', 'rationale', 'model', 'tests', 'retry', 'proof'], required: ['dir'] },
  'change status': { options: ['dir'], required: ['dir'] },
  'change wait': { options: ['dir', 'timeout'], required: ['dir'] },
  'change touching': { options: ['dir', 'paths'], required: ['dir', 'paths'] },
};

export async function main(argv = process.argv.slice(2), options = {}) {
  const rt = runtime(options);
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Braid requires Node.js 22 or newer.');
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { rt.log(HELP); return; }
  let [command, ...args] = argv;
  if (command === 'change') command = `change ${args.shift() ?? ''}`;
  if (!Object.hasOwn(COMMANDS, command)) fail('Unknown command. Run braid.mjs --help.');
  const allowed = COMMANDS[command].options;
  const input = {};
  if (command === 'restack') {
    input.number = args.shift();
    if (!/^[1-9]\d*$/.test(input.number ?? '') || !Number.isSafeInteger(Number(input.number))) fail('Provide a positive pull request number.');
  }
  if (command === 'start') {
    if (!args.length || args[0].startsWith('--')) fail('Provide the task URL from Braid.');
    input.task = args.shift();
    taskLink(input.task);
  }
  for (let index = 0; index < args.length; index++) {
    const name = args[index].startsWith('--') ? args[index].slice(2) : '';
    if (!allowed.includes(name) || name in input) fail('Unknown or duplicate option. Run braid.mjs --help.');
    if (name === 'retry' || name === 'proof' || name === 'link') input[name] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) fail('An option is missing its value. Run braid.mjs --help.');
      input[name] = args[++index];
    }
  }
  const required = input.retry ? ['dir'] : COMMANDS[command].required;
  if (required.some(name => !input[name])) fail('Missing required options. Run braid.mjs --help.');
  if (input.retry && ['title', 'summary', 'intent', 'rationale', 'model', 'tests', 'proof', 'depends-on'].some(name => name in input)) fail('--retry uses the saved payload; omit the description, model, tests, and proof.');
  if (input.workspace !== undefined) identifier(input.workspace);
  if (command === 'start') return start(input, rt);
  if (command === 'connect') {
    if (input.code !== undefined && input.email === undefined) fail('--code goes with the --email the code was sent to.');
    if (input.link && input.email !== undefined) fail('Choose --email or --link, not both.');
    if (input.repository !== undefined && input.workspace !== undefined) fail('Choose --workspace or --repository, not both.');
    return connect(input.url, rt, input.workspace, { email: input.email, code: input.code, repository: input.repository, link: input.link });
  }
  if (command === 'checkout') return checkout(input, rt);
  if (command === 'resume') return resume(input, rt);
  if (command === 'update') return update(input, rt);
  if (command === 'progress') return progress(input, rt);
  if (command === 'wait') return wait(input, rt);
  if (command === 'restack') return restack(input, rt);
  if (command === 'change start') return changeStart(input, rt);
  if (command === 'change sync') return changeSync(input, rt);
  if (command === 'change submit') return changeSubmit(input, rt);
  if (command === 'change status') return changeStatus(input, rt);
  if (command === 'change wait') return changeWait(input, rt);
  if (command === 'change touching') return changeTouching(input, rt);
  return submit(input, rt);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error instanceof CliError ? error.message : 'Braid could not complete the operation. Check local paths, file permissions, and configuration.');
    process.exitCode = 1;
  });
}
