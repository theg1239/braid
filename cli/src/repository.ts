import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { Braid } from './api';
import { CliError, fail, type BraidContext } from './context';
import { loadCredentials, privateDirectory, readLink, readPrivateJson, resolveOrigin, writePrivateJson, type RepositoryLink } from './config';
import { currentBranch, findRoot, gitPath, gitTry, repositoryRoot } from './git';
import { branchState, commit, journal, type BranchState, type Journal } from './schemas';

/** The repository braid runs in and the Braid it is linked to, if any. */
export interface Repository { root: string; link?: RepositoryLink }

export function openRepository(context: BraidContext): Repository {
  const root = repositoryRoot(context);
  return { root, link: readLink(root) };
}

export function findRepository(context: BraidContext): Repository | undefined {
  const root = findRoot(context);
  return root === undefined ? undefined : { root, link: readLink(root) };
}

export const braidRemote = (origin: string, workspaceId: string) => `${origin}/git/${workspaceId}.git`;
export function currentRemote(context: BraidContext, root: string) {
  const result = gitTry(context, ['remote', 'get-url', 'braid'], { cwd: root });
  return result.status === 0 ? result.stdout.toString('utf8').trim() : undefined;
}

/** A signed-in connection to the repository's Braid. */
export function connect(context: BraidContext, repository?: Repository, url?: string) {
  const origin = resolveOrigin(context, repository?.link, url);
  const credentials = loadCredentials(context, origin, repository?.link?.workspaceId);
  if (repository?.link?.workspaceId && credentials.workspaceId !== repository.link.workspaceId) fail(`This repository is linked to ${repository.link.workspaceId}, but BRAID_WORKSPACE_ID names ${credentials.workspaceId}.`);
  return new Braid(context, credentials);
}

/** The connection when one is set up, for commands that work offline and only get better online. */
export function maybeConnect(context: BraidContext, repository?: Repository) {
  try { return connect(context, repository); } catch (error) { if (error instanceof CliError) return undefined; throw error; }
}

/* ---------- the change a branch is working on ---------- */

/**
 * Where braid keeps a branch's change: the change and its base, the last submission (kept until it is confirmed, so
 * an uncertain one can be resent exactly) and a lock. They live in the Git directory, per worktree, so they never
 * appear as files to commit.
 */
export function branchFiles(context: BraidContext, root: string) {
  const folder = privateDirectory(gitPath(context, root, 'braid'));
  const branch = currentBranch(context, root);
  const key = encodeURIComponent(branch ?? 'HEAD');
  return { folder, branch, state: join(folder, `${key}.json`), journal: join(folder, `${key}.submission.json`), lock: join(folder, `${key}.lock`) };
}
export type BranchFiles = ReturnType<typeof branchFiles>;

/** braid.mjs's `change start` checkouts keep their change in .braid/change.json; it carries over the first time. */
const legacyChange = v.object({
  origin: v.string(), workspaceId: v.string(), base: commit, nextBase: v.optional(commit),
  changeId: v.optional(v.string()), number: v.optional(v.number()), revision: v.optional(v.number()),
});

export function readState(root: string, files: BranchFiles): BranchState | undefined {
  const saved = readPrivateJson(files.state, branchState, { label: 'Braid change state' });
  if (saved) return saved;
  const legacy = join(root, '.braid', 'change.json');
  if (!existsSync(legacy)) return undefined;
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), legacyChange), readFileSync(legacy, 'utf8'));
  if (!parsed.success) return undefined;
  const { origin, workspaceId, base, nextBase, changeId, number, revision } = parsed.output;
  return { origin, workspaceId, base, nextBase, ...(changeId && number && revision ? { change: { id: changeId, number, revision, status: 'open' as const } } : {}) };
}
export const writeState = (files: BranchFiles, state: BranchState) => writePrivateJson(files.state, state);

export const readJournal = (files: BranchFiles): Journal | undefined => readPrivateJson(files.journal, journal, { max: 48 * 1024 * 1024, label: 'The saved submission' });
export const writeJournal = (files: BranchFiles, saved: Journal) => writePrivateJson(files.journal, saved);

/** Whether a process is running; one this user may not signal still is. */
export function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Holds a lock file while `work` runs, so two submissions from one branch or checkout never interleave. A lock left by a process that is gone is taken over. */
export async function withLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
  const owner = v.object({ pid: v.pipe(v.number(), v.safeInteger(), v.minValue(1)) });
  try { writePrivateJson(lock, { pid: process.pid }, { exclusive: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const held = readPrivateJson(lock, owner, { max: 1024, label: 'The submission lock' });
    if (held && processAlive(held.pid)) fail(`Another braid command (process ${held.pid}) is submitting from here. Wait for it to finish.`);
    unlinkSync(lock);
    writePrivateJson(lock, { pid: process.pid }, { exclusive: true });
  }
  try { return await work(); } finally { unlinkSync(lock); }
}
