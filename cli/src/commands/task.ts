import { buildCommand, buildRouteMap, numberParser } from '@stricli/core';
import { normalizeOrigin } from '../config';
import type { BraidContext } from '../context';
import { checkoutTask, progressTask, resumeTask, startTask, submitTask, updateTask, waitTask, type SubmitInput } from '../task';
import { parseDependsOn } from './submit';
import { parseModel } from './agent';

const dir = { kind: 'parsed', parse: String, brief: 'The task checkout; the current directory when not given', placeholder: 'directory', optional: true } as const;
const required = (brief: string, placeholder: string) => ({ kind: 'parsed', parse: String, brief, placeholder }) as const;
const optional = (brief: string, placeholder = 'text') => ({ kind: 'parsed', parse: String, brief, placeholder, optional: true }) as const;

const start = buildCommand({
  func: async function (this: BraidContext, flags: { dir?: string }, link: string) { await startTask(this, { link, dir: flags.dir }); },
  parameters: {
    flags: { dir: optional('Where to check the task out: this checkout when it is one, else a new braid-<task> directory', 'directory') },
    positional: { kind: 'tuple', parameters: [{ brief: 'The task link from Braid', parse: String, placeholder: 'task-link' }] },
  },
  docs: {
    brief: 'Start or return to a task from its link',
    fullDescription: 'Reuses the approval for the task\'s repository, or shows its owner an approval link, then prepares a checkout pinned to the task\'s base: a clean clone at that base is bound to it, and otherwise a new directory is cloned. Run it again to resume, including after a proposal is in review. Checkouts it prepares submit committed work only.',
  },
});

const checkout = buildCommand({
  func: async function (this: BraidContext, flags: { url: string; mission: string; agent: string; dir: string; workspace?: string }) {
    await checkoutTask(this, { url: flags.url, mission: flags.mission, agent: flags.agent, dir: flags.dir, workspace: flags.workspace });
  },
  parameters: {
    flags: {
      url: { kind: 'parsed', parse: normalizeOrigin, brief: 'Braid address', placeholder: 'url' },
      mission: required('The task id', 'id'), agent: required('The agent id in the task', 'id'),
      dir: required('A new directory to clone into', 'directory'), workspace: optional('The task\'s repository id', 'id'),
    },
  },
  docs: { brief: 'Clone one agent\'s part of a task into a new directory', fullDescription: 'The older way to check out a task, for tasks with several proposals. Its checkouts submit their working tree, including uncommitted edits.' },
});

const resume = buildCommand({
  func: async function (this: BraidContext, flags: { dir?: string }) { await resumeTask(this, flags); },
  parameters: { flags: { dir } },
  docs: { brief: 'Renew this checkout\'s claim on its task, keeping local work' },
});

const update = buildCommand({
  func: async function (this: BraidContext, flags: { dir?: string }) { await updateTask(this, flags); },
  parameters: { flags: { dir } },
  docs: { brief: 'Fetch the newer main to integrate, without changing your branch or files' },
});

const progress = buildCommand({
  func: async function (this: BraidContext, flags: { dir?: string; message: string }) { await progressTask(this, flags); },
  parameters: { flags: { dir, message: required('A milestone or blocker to share, in one or two sentences', 'text') } },
  docs: { brief: 'Share a milestone or blocker on the task' },
});

const submit = buildCommand({
  func: async function (this: BraidContext, flags: SubmitInput) { await submitTask(this, flags); },
  parameters: {
    flags: {
      dir,
      dependsOn: { kind: 'parsed', parse: parseDependsOn, brief: 'Prerequisite pull requests, comma-separated; none clears them', placeholder: '51,52', optional: true },
      summary: optional('What changed; a revision reuses the last summary when left out'),
      rationale: optional('Why it was done this way'),
      model: { kind: 'parsed', parse: parseModel, brief: 'The model that did the work', placeholder: 'id', optional: true },
      tests: optional('JSON file of up to 10 agent-reported test results: [{command, result, detail?}]', 'file'),
      proof: { kind: 'boolean', brief: 'Run .braid/proof.json and attach its checks and screenshots', optional: true },
      retry: { kind: 'boolean', brief: 'Resend an unconfirmed submission exactly, with its key', optional: true },
    },
  },
  docs: {
    brief: 'Submit the task\'s result for review, or revise it',
    fullDescription: 'Sends the complete change from the task\'s base as its proposal; submitting again revises it. The submission is saved with its idempotency key before it is sent, so --retry can resend an unconfirmed one exactly, and identical work replays rather than becoming a new revision. braid submit --help describes .braid/proof.json.',
  },
});

const wait = buildCommand({
  func: async function (this: BraidContext, flags: { dir?: string; timeout: number }) { await waitTask(this, flags); },
  parameters: { flags: { dir, timeout: { kind: 'parsed', parse: numberParser, brief: 'Seconds to wait at most', placeholder: 'seconds', default: '1800' } } },
  docs: { brief: 'Wait until the task\'s change lands or comes back, then say exactly what to fix' },
});

export const taskRoutes = buildRouteMap({
  routes: { start, checkout, resume, update, progress, submit, wait },
  docs: { brief: 'Work on a task a person asked for in Braid' },
});
