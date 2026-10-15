import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeStatus } from '../../shared/types';
import { fail, type BraidContext } from './context';
import type { ChangeView } from './schemas';
import { redact } from './secrets';
import { personHandle, personLabel } from './present';
import { plain, shellCommand } from './terminal';

/** A change that will not move again: it landed or was closed. */
export const finished = (status: ChangeStatus) => status === 'landed' || status === 'closed';
/** A change that waits on someone: it landed, was closed, came back to its author or needs a person. */
export const settled = (status: ChangeStatus) => finished(status) || status === 'revise' || status === 'attention';

type CommandRun = Extract<ChangeView['evidence'][number], { kind: 'command' }>;

/** The last lines of a command's output, indented under it. */
function tail(output: string) {
  const lines = output.slice(-4000).trimEnd().split('\n').slice(-40);
  return lines.some(line => line.trim()) ? `\n${lines.map(line => `  ${line}`).join('\n')}` : '';
}

/** A thread remains actionable until a person resolves it, even after its line becomes outdated. */
export function describeComments(comments: ChangeView['comments']) {
  const roots = new Set(comments.filter(comment => !comment.inReplyTo && !comment.resolved).map(comment => comment.id));
  return comments.filter(comment => roots.has(comment.inReplyTo ?? comment.id)).map(comment => {
    const anchor = comment.anchor, owner = comment.author.owner;
    const by = `${comment.author.kind === 'agent' ? comment.author.name : personHandle(comment.author.name)}${comment.author.kind === 'agent' && owner ? ` for ${personLabel(owner)}` : ''}`;
    return `${comment.inReplyTo ? `Reply to ${comment.inReplyTo}` : `Comment ${comment.id}`}${anchor ? ` at ${anchor.path}:${anchor.position ?? anchor.line} (${anchor.side}${anchor.outdated ? ', Outdated' : ''}; revision ${anchor.revision})` : ''} by ${by}:\n${comment.body}`;
  }).join('\n\n');
}

/**
 * Everything that sent a change back, in terms an agent can act on: failing commands with the end of their output,
 * broken instructions, conflicts and reviews. Text from Braid reaches the terminal without escape sequences and
 * with anything shaped like a credential replaced.
 */
export function describeChange(change: ChangeView, secrets: readonly string[] = []) {
  const current = (item: { revision: number }) => item.revision === change.revision;
  const failing = change.evidence.filter((item): item is CommandRun => item.kind === 'command' && current(item) && item.exitCode !== 0);
  const state = change.status === 'landed' ? 'merged' : change.status === 'revise' ? 'changes requested' : change.status === 'attention' ? 'review required' : change.status;
  const lines = [`Pull request #${change.number} · ${change.title} · ${state}${change.closeReason ? ` (${change.closeReason})` : ''} · revision ${change.revision}`];
  if (change.html_url) lines.push(change.html_url);
  if (change.next) lines.push(`Next: ${change.next}`);
  if (change.dependsOn?.length) lines.push(`Depends on ${change.dependsOn.map(item => `#${item.number}`).join(', ')}`);
  if (change.outdated?.length && !change.next?.includes('changed since this was built')) lines.push(`${change.outdated.map(item => `#${item.number}`).join(', ')} changed since this was built`);
  if (change.requiredBy?.length) lines.push(`Required by ${change.requiredBy.map(item => `#${item.number}`).join(', ')}`);
  const comments = describeComments(change.comments);
  if (comments) lines.push(`Unresolved review comments:\n${comments}`);
  for (const conflict of change.conflicts) lines.push(`Conflict (${conflict.kind}) in ${conflict.path}${conflict.regions?.length ? ` at line ${conflict.regions[0].baseStart + 1}` : ''}`);
  for (const item of failing) lines.push(`Failed${item.source === 'braid' ? ' in Braid' : ''}: ${item.command} (exit ${item.exitCode})${tail(item.output)}`);
  for (const check of change.checks.filter(check => current(check) && check.status === 'failed' && !failing.some(item => item.command === check.label))) lines.push(`Failed check (${check.source}): ${check.label}\n${check.detail}`);
  for (const guard of change.guards) lines.push(guard.kind === 'instructions' ? `Instruction broken in ${guard.path}: ${guard.detail}` : `Guard: ${guard.detail}`);
  for (const review of change.reviews.filter(review => current(review) && review.verdict !== 'approve')) {
    lines.push(`Review (${review.reviewer}): ${review.verdict}: ${review.summary}${review.findings.map(finding => `\n  ${finding.path ?? ''}${finding.line ? `:${finding.line}` : ''} ${finding.message}`).join('')}`);
  }
  if (change.overlaps.length) lines.push(`Also active on the same files: ${change.overlaps.map(overlap => `#${overlap.number}`).join(', ')}`);
  if (change.landedCommit) lines.push(`Merged as ${change.landedCommit}.`);
  return redact(plain(lines.join('\n')), secrets);
}

export async function poll(context: BraidContext, timeout: number, check: (late: () => boolean) => Promise<boolean>) {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86_400) fail('Use --timeout with a whole number of seconds from 1 to 86400.');
  const deadline = context.now() + timeout * 1000, late = () => context.now() >= deadline;
  for (let delay = 5000; !await check(late); delay = Math.min(30_000, delay * 1.5)) await context.sleep(Math.min(delay, Math.max(0, deadline - context.now())));
}

/** This CLI's command line for `args`, run the way braid itself was started, quoted to paste. */
export const command = (context: BraidContext, ...args: string[]) => shellCommand([...context.self, ...args]);

/** The arguments that point a task command at its checkout, needed only when it is not the current directory. */
export const checkoutArgs = (context: BraidContext, root: string) => {
  try { return realpathSync(context.cwd) === root ? [] : ['--dir', root]; } catch { /* A working directory that no longer exists is not the checkout. */ return ['--dir', root]; }
};

/**
 * What to do next, ending with the exact command. A change that came back is fixed and resubmitted, with proof when
 * the repository has a proof file; one that needs a person stops the agent; one still moving is waited for. Nothing
 * follows a landed or closed change. A task's result is resubmitted and waited for as a task, and brought up to date
 * with `task update` rather than `sync`.
 */
export function nextStep(context: BraidContext, change: ChangeView, { root, origin, task = false }: { root: string; origin: string; task?: boolean }) {
  const scoped = (...args: string[]) => task ? command(context, 'task', ...args, ...checkoutArgs(context, root)) : command(context, ...args);
  if (change.outdated?.length && !change.conflicts.length) return `\nRestack this pull request:\n  ${command(context, 'restack', String(change.number))}`;
  if (change.status === 'revise') {
    const resubmit = scoped('submit', ...(existsSync(join(root, '.braid', 'proof.json')) ? ['--proof'] : []));
    if (change.outdated?.length && change.conflicts.length) return `\nResolve the conflicts with the updated prerequisites, commit, then resubmit:\n  ${resubmit}`;
    if (!change.conflicts.length) return `\nFix exactly what is listed above, commit, then resubmit:\n  ${resubmit}`;
    return task
      ? `\nFetch main, merge it and resolve the conflicts, fix anything else listed, commit, then resubmit:\n  ${scoped('update')}\n  ${resubmit}`
      : `\nFetch main, rebase onto it and resolve the conflicts, fix anything else listed, commit, then resubmit:\n  ${scoped('sync')}\n  ${resubmit}`;
  }
  if (change.status === 'attention') return `\nA person must decide. Ask the owner to open pull request #${change.number}${change.html_url ? `: ${change.html_url}` : ` in this repository at ${origin}`}.`;
  if (finished(change.status)) return '';
  return `\nNext, wait until it merges or needs changes:\n  ${scoped('wait')}`;
}
