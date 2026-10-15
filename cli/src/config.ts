import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import { CliError, fail, type BraidContext } from './context';

/*
 * Credentials live where the downloadable braid.mjs keeps them, in the same format, so the two tools share one
 * approval: BRAID_CONFIG_HOME, else XDG_CONFIG_HOME/braid, else ~/.config/braid, with one owner-only file per Braid
 * origin and repository. The repository's own .braid/config.json only names the origin and repository; it holds no
 * secret and may be committed.
 */

export const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const TOKEN = /^[^\x00-\x20\x7f]{1,16384}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function normalizeOrigin(value: string): string {
  if (!URL.canParse(value)) fail('Give the address of your Braid, such as --url https://braid.example.');
  const url = new URL(value);
  if (/[\x00-\x20\x7f\\]/.test(value) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Use the Braid address alone, without credentials, a path, a query or a fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('Braid needs HTTPS; plain HTTP is allowed only for local development.');
  return url.origin;
}
export function originOf(value: string) {
  try { return normalizeOrigin(value); } catch (error) { if (error instanceof CliError) return undefined; throw error; }
}

const configRoot = (env: BraidContext['env']) => resolve(env.BRAID_CONFIG_HOME || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'braid'));

/** The file for one origin and repository; without a repository, the origin-wide file earlier releases wrote. */
function credentialFile(env: BraidContext['env'], origin: string, workspaceId?: string) {
  const root = configRoot(env), key = sha256(normalizeOrigin(origin));
  return workspaceId === undefined ? join(root, `${key}.json`) : join(root, key, `${sha256(workspaceId)}.json`);
}

/* ---------- private files ---------- */

export function realDirectory(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${path} must be a real directory, not a symlink.`);
  return path;
}

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(realDirectory(path), 0o700);
  return path;
}

export function readRegularFile(path: string, max: number, check?: (stat: Stats, fd: number) => void): Buffer | undefined {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return undefined;
    check?.(stat, fd);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Makes a completed rename durable where the platform can sync directories. */
function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try { fd = openSync(path, constants.O_RDONLY); fsyncSync(fd); } catch { /* Some file systems cannot sync a directory; the rename has happened either way. */ } finally { if (fd !== undefined) closeSync(fd); }
}

/** Replaces a file atomically with owner-only permissions, never writing through a symlink. */
export function writePrivate(path: string, content: string, { exclusive = false } = {}) {
  if (exclusive) writeFileSync(path, content, { mode: 0o600, flag: 'wx', flush: true });
  else {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(`${path} must not be a symlink.`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }
  syncDirectory(dirname(path));
}
export const writePrivateJson = (path: string, data: unknown, options?: { exclusive?: boolean }) => writePrivate(path, `${JSON.stringify(data, null, 2)}\n`, options);

/**
 * A JSON file only this user may read, parsed with `schema`. It must be a regular file of at most `max` bytes owned
 * by this user; it is tightened to 0600, or with `readOnly` refused when others can read it. A missing file is
 * undefined.
 */
export function readPrivateJson<const S extends v.GenericSchema>(path: string, schema: S, { max = 1_048_576, readOnly = false, label = 'Local Braid data' } = {}): v.InferOutput<S> | undefined {
  let bytes: Buffer | undefined;
  try {
    bytes = readRegularFile(path, max, (stat, fd) => {
      if (process.getuid && stat.uid !== process.getuid()) fail(`${label} at ${path} belongs to another user.`);
      if (readOnly && stat.mode & 0o077) fail(`${label} at ${path} must be readable only by you (chmod 600).`);
      if (!readOnly) fchmodSync(fd, 0o600);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof CliError) throw error;
    return fail(`Cannot read ${label.toLowerCase()} at ${path}. Check its permissions.`);
  }
  if (!bytes) fail(`${label} at ${path} is not a regular file of at most ${max} bytes.`);
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), schema), bytes.toString('utf8'));
  return parsed.success ? parsed.output : fail(`${label} at ${path} is damaged: ${parsed.issues[0].message}`);
}

/* ---------- credentials ---------- */

const stored = v.object({
  origin: v.string(),
  accessToken: v.pipe(v.string(), v.regex(TOKEN)),
  workspaceId: v.pipe(v.string(), v.regex(ID)),
  expiresAt: v.pipe(v.string(), v.check(value => Number.isFinite(Date.parse(value)))),
});
type StoredCredentials = v.InferOutput<typeof stored>;
/** An approval to use: saved on disk, or given in BRAID_ACCESS_TOKEN. */
export interface Credentials { origin: string; accessToken: string; workspaceId: string; expiresAt?: string; path?: string }

export function saveCredentials(env: BraidContext['env'], grant: StoredCredentials) {
  const path = credentialFile(env, grant.origin, grant.workspaceId);
  privateDirectory(dirname(dirname(path)));
  privateDirectory(dirname(path));
  writePrivateJson(path, { origin: grant.origin, accessToken: grant.accessToken, workspaceId: grant.workspaceId, expiresAt: grant.expiresAt });
  return path;
}

/** One saved file, which must name the origin and, in a repository folder, the repository its name is derived from. */
function readCredential(env: BraidContext['env'], path: string, origin?: string): Credentials | undefined {
  const saved = readPrivateJson(path, stored, { max: 32_768, label: 'Saved Braid credentials' });
  if (!saved) return undefined;
  const folder = dirname(path) !== configRoot(env);
  if ((origin && saved.origin !== origin) || credentialFile(env, saved.origin, folder ? saved.workspaceId : undefined) !== path) fail(`Saved Braid credentials at ${path} do not match their location. Run braid login again.`);
  return { ...saved, path };
}

/**
 * Every saved approval, for one origin or all of them, newest expiry first. Earlier releases wrote one origin-wide
 * file next to the per-repository folders; it is still read.
 */
export function savedCredentials(env: BraidContext['env'], origin?: string): Credentials[] {
  const root = configRoot(env);
  if (!existsSync(root)) return [];
  const keys = origin ? [sha256(origin)] : readdirSync(root).flatMap(name => /^[a-f0-9]{64}(?:\.json)?$/.test(name) ? [name.slice(0, 64)] : []);
  const records: Credentials[] = [];
  for (const key of new Set(keys)) {
    const legacy = readCredential(env, join(root, `${key}.json`), origin);
    if (legacy) records.push(legacy);
    const folder = join(root, key);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(realDirectory(folder)).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort()) {
      const record = readCredential(env, join(folder, name), origin);
      if (record) records.push(record);
    }
  }
  return records.sort((a, b) => Date.parse(b.expiresAt ?? '') - Date.parse(a.expiresAt ?? ''));
}

/**
 * The approval for an origin. BRAID_ACCESS_TOKEN with BRAID_WORKSPACE_ID overrides the saved files; otherwise the
 * repository's own link chooses among them, and a single unexpired approval is used. Several are ambiguous rather
 * than guessed.
 */
export function loadCredentials(context: BraidContext, origin: string, workspaceId?: string): Credentials {
  const { env } = context, wanted = env.BRAID_WORKSPACE_ID || workspaceId;
  if (wanted !== undefined && !ID.test(wanted)) fail('BRAID_WORKSPACE_ID is not a Braid repository id.');
  if (env.BRAID_ACCESS_TOKEN) {
    if (!TOKEN.test(env.BRAID_ACCESS_TOKEN)) fail('BRAID_ACCESS_TOKEN is not a Braid token.');
    const workspaces = wanted ? [wanted] : [...new Set(savedCredentials(env, origin).map(record => record.workspaceId))];
    if (workspaces.length !== 1) fail('Set BRAID_WORKSPACE_ID together with BRAID_ACCESS_TOKEN.');
    return { origin, accessToken: env.BRAID_ACCESS_TOKEN, workspaceId: workspaces[0] };
  }
  const saved = savedCredentials(env, origin).filter(record => !wanted || record.workspaceId === wanted);
  const current = saved.filter(record => Date.parse(record.expiresAt ?? '') > context.now());
  const repositories = new Set(current.map(record => record.workspaceId));
  if (repositories.size > 1) fail(`Several repositories are signed in at ${origin}. Run braid init in the repository, or set BRAID_WORKSPACE_ID.`);
  if (current[0]) return current[0];
  return fail(saved.length ? `Your Braid approval for ${origin} expired. Run braid login again.` : `Not signed in to ${origin}. Run braid login${wanted ? '' : ` --url ${origin}`}.`);
}

/** Deletes saved approvals for an origin, or one repository at it, and returns how many were removed. */
export function removeCredentials(env: BraidContext['env'], origin: string, workspaceId?: string) {
  const records = savedCredentials(env, origin).filter(record => !workspaceId || record.workspaceId === workspaceId);
  for (const record of records) if (record.path) rmSync(record.path, { force: true });
  return records.length;
}

/* ---------- the repository's link ---------- */

const REPOSITORY_CONFIG = '.braid/config.json';
const linked = v.looseObject({ url: v.optional(v.string()), workspaceId: v.optional(v.pipe(v.string(), v.regex(ID))) });
export type RepositoryLink = v.InferOutput<typeof linked>;

export function readLink(root: string): RepositoryLink | undefined {
  const path = join(root, REPOSITORY_CONFIG);
  if (!existsSync(path)) return undefined;
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), linked), readFileSync(path, 'utf8'));
  return parsed.success ? parsed.output : fail(`${REPOSITORY_CONFIG} is not valid: ${parsed.issues[0].message}`);
}

/** Writes the link, keeping any other settings already in the file. It holds no secret, so it may be committed. */
export function writeLink(root: string, link: { url: string; workspaceId: string }) {
  const path = join(root, REPOSITORY_CONFIG);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...readLink(root), url: link.url, workspaceId: link.workspaceId }, null, 2)}\n`);
  return path;
}

/**
 * The Braid a command talks to: --url, then BRAID_URL, then the repository's link, then the only origin with saved
 * credentials.
 */
export function resolveOrigin(context: BraidContext, link?: RepositoryLink, flag?: string): string {
  const named = flag ?? context.env.BRAID_URL ?? link?.url;
  if (named) return normalizeOrigin(named);
  const origins = [...new Set(savedCredentials(context.env).map(record => record.origin))];
  if (origins.length === 1) return origins[0];
  return fail(origins.length ? 'Several Braid addresses are signed in. Pass --url, or run braid init in the repository.' : 'Not signed in. Run braid login --url https://your-braid.example.');
}
