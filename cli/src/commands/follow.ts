import { randomUUID } from 'node:crypto';
import { activityStatus, startActivityUpload } from '../activity';
import { buildCommand, numberParser } from '@stricli/core';
import { join } from 'node:path';
import { checkoutRoot } from '../checkout';
import { readPrivateJson, privateDirectory, writePrivateJson } from '../config';
import { ApiError, type Braid } from '../api';
import { command, describeChange, nextStep, poll, settled } from '../change';
import { fail, print, type BraidContext } from '../context';
import { fetchCommit, git, gitText } from '../git';
import { branchFiles, connect, openRepository, readState, writeState, withLock, type BranchFiles, type Repository } from '../repository';
import { isTaskCheckout, taskConnection } from '../task';
import { change as changeSchema, restackReceipt, trunk, type BranchState, type ChangeView } from '../schemas';

function target(context: BraidContext, flags: { change?: string }) {
  const repository = openRepository(context), braid = connect(context, repository);
  const files = branchFiles(context, repository.root), state = readState(repository.root, files);
  const id = flags.change ?? state?.change?.id ?? fail(isTaskCheckout(repository.root) ? `This checkout belongs to a Braid task; follow it with ${command(context, 'task', 'wait')}.` : `This branch has not submitted a change. Submit one with ${command(context, 'submit')}, or name one with --change.`);
  return { repository, braid, files, state, path: `/api/changes/${encodeURIComponent(id)}` };
}

function report(context: BraidContext, braid: Braid, change: ChangeView, { repository, files, state }: { repository: Repository; files: BranchFiles; state?: BranchState }) {
  if (state?.change?.id === change.id) writeState(files, { ...state, change: { ...state.change, revision: change.revision, status: change.status } });
  print(context, describeChange(change, braid.secrets) + nextStep(context, change, { root: repository.root, origin: braid.origin }));
}

async function status(this: BraidContext, flags: { change?: string }) {
  const repository = openRepository(this), activity = activityStatus(this, repository);
  print(this, `Connection: ${activity.connected ? 'connected' : 'disconnected'}${activity.origin ? ` · ${activity.origin}` : ''}${activity.workspaceId ? ` / ${activity.workspaceId}` : ''}\nToken expiry: ${activity.expiry ?? (this.env.BRAID_ACCESS_TOKEN ? 'provided by environment' : 'not signed in')}${activity.expiry && Date.parse(activity.expiry) <= this.now() ? ' · run braid login' : ''}\nQueued activity: ${activity.queued}\nLast activity error: ${activity.lastError ?? 'none'}`);
  startActivityUpload(this, repository.root);
  if (!flags.change && !readState(repository.root, branchFiles(this, repository.root))?.change) return;
  const found = target(this, flags);
  report(this, found.braid, await found.braid.get(found.path, changeSchema), found);
}

async function wait(this: BraidContext, flags: { change?: string; timeout: number }) {
  const found = target(this, flags);
  let waiting = '';
  await poll(this, flags.timeout, async late => {
    const change = await found.braid.get(found.path, changeSchema);
    if (settled(change.status) || late()) { report(this, found.braid, change, found); return true; }
    const next = change.waitingOn?.length ? change.next ?? `Waiting on ${change.waitingOn.map(item => `#${item.number}`).join(', ')}` : '';
    if (next && next !== waiting) print(this, next);
    waiting = next;
    return false;
  });
}

async function sync(this: BraidContext) {
  const repository = openRepository(this), { root } = repository, braid = connect(this, repository);
  const files = branchFiles(this, root), state = readState(root, files);
  const current = await braid.post('/api/changes/checkout', {}, trunk);
  fetchCommit(this, root, current.remote, current.head, current.token);
  const head = gitText(this, ['rev-parse', 'HEAD'], { cwd: root }), short = current.head.slice(0, 12);
  const clean = !git(this, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], { cwd: root }).length;
  if (head === current.head) { print(this, `Already at main ${short}.`); return; }
  if (clean && (head === state?.base || !state) && git(this, ['rev-list', '--count', `${current.head}..HEAD`], { cwd: root }).toString('utf8').trim() === '0') {
    git(this, ['merge', '--ff-only', '--quiet', current.head], { cwd: root });
    if (state) writeState(files, { ...state, base: current.head, nextBase: undefined });
    print(this, `Moved to main ${short}.`);
    return;
  }
  if (state) writeState(files, { ...state, nextBase: current.head });
  print(this, `Fetched main ${short}. Rebase onto it, resolve any conflicts and rerun the checks, then submit:\n  git rebase ${current.head}\n  ${command(this, 'submit')}`);
}

const change = { kind: 'parsed', parse: String, brief: 'A change id or number; this branch\'s change when not given', placeholder: 'change', optional: true } as const;

export const statusCommand = buildCommand({ func: status, parameters: { flags: { change } }, docs: { brief: 'Show where this branch\'s change stands and what to do next' } });
export const waitCommand = buildCommand({
  func: wait,
  parameters: { flags: { change, timeout: { kind: 'parsed', parse: numberParser, brief: 'Seconds to wait at most', placeholder: 'seconds', default: '1800' } } },
  docs: { brief: 'Wait until the pull request merges or needs changes, then say exactly what to fix' },
});
export const syncCommand = buildCommand({ func: sync, parameters: {}, docs: { brief: 'Fetch Braid\'s current main to rebase onto' } });

export const restackCommand = buildCommand({
  func: async function (this: BraidContext, _flags: Record<never, never>, number: number) {
    if (!Number.isSafeInteger(number) || number < 1) fail('Provide a positive pull request number.');
    const root = checkoutRoot(this, '.');
    const task = isTaskCheckout(root), found = task ? undefined : target(this, { change: String(number) });
    const braid = found?.braid ?? taskConnection(this, root), path = `/api/changes/${number}`;
    const file = join(found?.files.folder ?? privateDirectory(join(root, '.braid')), `restack-${number}.json`);
    await withLock(file + '.lock', async () => {
      let saved = readPrivateJson(file, restackReceipt, { max: 4096, label: 'The saved restack' });
      if (saved && (saved.origin !== braid.origin || saved.workspaceId !== braid.credentials.workspaceId)) fail('The saved restack belongs to another repository.');
      if (!saved?.pending) {
        const current = await braid.get(path, changeSchema);
        saved = { key: randomUUID(), previousRevision: current.revision, pending: true, origin: braid.origin, workspaceId: braid.credentials.workspaceId };
        writePrivateJson(file, saved);
      }
      try {
        const next = await braid.post(`${path}/restack`, { previousRevision: saved.previousRevision }, changeSchema, { key: saved.key });
        writePrivateJson(file, { ...saved, pending: false });
        if (found) report(this, braid, next, found); else print(this, describeChange(next, braid.secrets) + nextStep(this, next, { root, origin: braid.origin, task }));
        print(this, 'Local commits and files are unchanged.');
      } catch (error) {
        if (error instanceof ApiError && [400, 403, 404, 409].includes(error.status)) writePrivateJson(file, { ...saved, pending: false });
        throw error;
      }
    });
  },
  parameters: { positional: { kind: 'tuple', parameters: [{ brief: 'The pull request number', placeholder: 'number', parse: numberParser }] } },
  docs: { brief: 'Reapply a pull request onto its updated prerequisites' },
});
