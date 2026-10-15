import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coAuthor, formatNote, NOTES_REF, type BraidNote } from '../../shared/provenance';
import { fail, type BraidContext } from './context';
import { git, gitPath, gitTry } from './git';
import type { Run } from './identity';

const MARKER = '# braid-hook v1';
const CHAINED = '.pre-braid';

export const HOOK = `#!/bin/sh
${MARKER}: under \`braid agent run\`, records the run in a refs/notes/braid note on the new commit.
# Installed by \`braid init\`; the hook that was here before runs first as post-commit${CHAINED}.
previous="$(dirname "$0")/post-commit${CHAINED}"
if [ -x "$previous" ]; then "$previous" "$@"; fi
if [ -n "$BRAID_MODEL$BRAID_TOOL$BRAID_SESSION" ] && command -v braid >/dev/null 2>&1; then braid hook post-commit >/dev/null 2>&1; fi
exit 0
`;

const present = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };
const ours = (path: string) => { try { return readFileSync(path, 'utf8').includes(MARKER); } catch { return false; } };

function retire(folder: string) {
  const path = join(folder, 'prepare-commit-msg'), previous = `${path}${CHAINED}`;
  const braids = present(path) && ours(path);
  if (present(path) && !braids) return present(previous) ? 'set aside' as const : undefined;
  if (braids) rmSync(path);
  if (present(previous)) { renameSync(previous, path); return 'restored' as const; }
  return braids ? 'removed' as const : undefined;
}

export function installHooks(context: BraidContext, root: string) {
  const folder = gitPath(context, root, 'hooks');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'post-commit'), previous = `${path}${CHAINED}`;
  if (present(path) && !ours(path)) {
    if (present(previous)) fail(`${path} replaced Braid's hook, and ${previous} is already chained. Merge the two hooks into ${previous}, then run braid init again.`);
    renameSync(path, previous);
  }
  writeFileSync(path, HOOK, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { folder, chained: present(previous), earlier: retire(folder) };
}

function replaying(context: BraidContext, root: string) {
  return ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some(name => existsSync(gitPath(context, root, name)));
}

function runNote(run: Run): BraidNote | undefined {
  if (!run.model && !run.tool && !run.session) return undefined;
  return { v: 1, agent: { name: coAuthor(run.model, run.tool).name, id: run.agentId, model: run.model, tool: run.tool, session: run.session, parentSession: run.parentSession } };
}

export function recordRun(context: BraidContext, root: string, run: Run, commit = 'HEAD') {
  const note = runNote(run);
  if (!note || replaying(context, root)) return false;
  git(context, ['notes', `--ref=${NOTES_REF}`, 'add', '--force', '--message', formatNote(note).trimEnd(), commit], { cwd: root });
  return true;
}

export const canCommit = (context: BraidContext, root: string) => gitTry(context, ['var', 'GIT_COMMITTER_IDENT'], { cwd: root }).status === 0;
