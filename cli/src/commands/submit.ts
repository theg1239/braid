import * as v from 'valibot';
import { buildCommand } from '@stricli/core';
import { randomUUID } from 'node:crypto';
import { attachActivity } from '../activity';
import { coAuthor, generatedFooter, modelName, NOTES_REF, parseNote, parsePerson, parseTrailers, type CommitFacts } from '../../../shared/provenance';
import { ApiError, type Braid } from '../api';
import { command, describeChange, finished, nextStep } from '../change';
import { collectChanges, readTests, validatePush } from '../collect';
import { CliError, fail, note, print, type BraidContext } from '../context';
import { canCommit, recordRun } from '../hooks';
import { fetchCommit, gitText, gitTry, isAncestor, noteIndex, readCommits, readNotes, strictGit } from '../git';
import { detectRun, resolveRun, type Run } from '../identity';
import { readProof, runProof } from '../proof';
import { braidRemote, branchFiles, connect, currentRemote, openRepository, readJournal, readState, withLock, writeJournal, writeState, type BranchFiles } from '../repository';
import { isTaskCheckout } from '../task';
import { change as changeSchema, dependencyFlag, trunk, type Payload } from '../schemas';
import { assertSubmittable } from '../secrets';
import { parseModel, parseSession, parseTool } from './agent';

interface Flags {
  dependsOn?: (number | string)[];
  title?: string; summary?: string; intent?: string; rationale?: string;
  model?: string; tool?: string; session?: string; parentSession?: string;
  tests?: string; proof?: boolean; retry?: boolean; push?: boolean;
}

const clip = (text: string, max: number) => [...text.trim()].slice(0, max).join('').trim();

async function trunkBase(context: BraidContext, braid: Braid, root: string) {
  const head = await braid.post('/api/changes/checkout', {}, trunk);
  fetchCommit(context, root, head.remote, head.head, head.token);
  if (isAncestor(context, root, head.head)) return { base: head.head, branch: head.branch };
  const shared = gitTry(context, ['merge-base', 'HEAD', head.head], { cwd: root });
  return { base: shared.status === 0 ? shared.stdout.toString('utf8').trim() : fail(`This branch shares no history with Braid's main (${head.branch} at ${head.head.slice(0, 12)}).`), branch: head.branch };
}

function commitsSince(context: BraidContext, root: string, base: string) {
  const ids = gitText(context, ['rev-list', '--reverse', `${base}..HEAD`], { cwd: root }).split('\n').filter(Boolean);
  const found = readCommits(context, root, ids);
  return ids.flatMap(id => found.get(id) ?? []);
}

function describe(commits: readonly CommitFacts[]) {
  const subject = (message: string) => message.split('\n', 1)[0].trim();
  const body = (message: string) => {
    const paragraphs = message.split(/\n\s*\n/).slice(1);
    while (paragraphs.length && (parseTrailers(`x\n\n${paragraphs.at(-1)}`).size || generatedFooter(paragraphs.at(-1)!))) paragraphs.pop();
    return paragraphs.join('\n\n').trim();
  };
  const [first] = commits;
  if (!first) return { title: 'Agent change', summary: 'Agent change' };
  return commits.length === 1
    ? { title: subject(first.message), summary: body(first.message) || subject(first.message) }
    : { title: subject(first.message), summary: commits.map(commit => `- ${subject(commit.message)}`).join('\n') };
}

const PERSON = /^[^<>\x00-\x1f\x7f]*[^<>\s\x00-\x1f\x7f][^<>\x00-\x1f\x7f]* <[^<>\s@]+@[^<>\s]+>$/;

function coAuthors(commits: readonly CommitFacts[]) {
  const lines = commits.flatMap(commit => parseTrailers(commit.message).get('co-authored-by') ?? []).filter(line => line.length <= 200 && PERSON.test(line));
  return [...new Map(lines.map(line => [line.toLowerCase(), line])).values()].slice(0, 5);
}

function committedRun(context: BraidContext, root: string, commits: readonly CommitFacts[], flags: Run): Run {
  const notes = readNotes(context, root, NOTES_REF, commits.map(commit => commit.id));
  const latest = [...commits].reverse().map(commit => parseNote(notes.get(commit.id) ?? '')?.agent).find(Boolean);
  return resolveRun(flags, context.env, { ...detectRun(context, flags), ...latest });
}

function noteCommits(context: BraidContext, root: string, commits: readonly CommitFacts[], run: Run) {
  if (!run.model || !canCommit(context, root)) return;
  try {
    const noted = noteIndex(context, root, NOTES_REF), model = coAuthor(run.model);
    const named = (commit: CommitFacts) => (parseTrailers(commit.message).get('co-authored-by') ?? []).map(parsePerson)
      .some(person => person.email?.toLowerCase() === model.email.toLowerCase() && modelName(person.name).toLowerCase() === model.name.toLowerCase());
    for (const commit of commits) if (!noted.has(commit.id) && named(commit)) recordRun(context, root, run, commit.id);
  } catch (error) { if (!(error instanceof CliError)) throw error; /* Notes are extra: one Git refuses leaves the submission alone. */ }
}

async function pushChange(context: BraidContext, braid: Braid, root: string, files: BranchFiles, flags: Flags) {
  const url = braidRemote(braid.origin, braid.credentials.workspaceId);
  if (currentRemote(context, root) !== url) fail(`Add the braid remote with ${command(context, 'init')} first.`);
  const { base, branch } = await trunkBase(context, braid, root);
  if (!/^(?!.*\.\.)[\w./-]{1,200}$/.test(branch)) fail('Braid returned a default branch name Git cannot push to.');
  validatePush(context, root, base, braid.secrets);
  noteCommits(context, root, commitsSince(context, root, base), detectRun(context, flags));
  const token = braid.credentials.accessToken;
  const notes = noteIndex(context, root, NOTES_REF).size ? [`${NOTES_REF}:${NOTES_REF}`] : [];
  const pushed = strictGit(context, ['push', url, `HEAD:refs/for/${branch}`, ...notes], { cwd: root, token, quiet: false });
  const remote = pushed.stderr.split('\n').flatMap(line => { const said = /^remote:\s*(.*)$/.exec(line)?.[1]?.trim(); return said ? [said] : []; });
  if (pushed.status !== 0) fail(`Braid did not take the push${remote.length ? `:\n${remote.join('\n')}` : '.'}`);
  for (const line of remote) note(context, `remote: ${line}`);
  const number = /\/pull\/(\d+)/.exec(remote.join('\n'))?.[1];
  if (!number) { print(context, `Pushed ${gitText(context, ['rev-parse', '--short=12', 'HEAD'], { cwd: root })} to the braid remote as refs/for/${branch}.`); return; }
  const change = await braid.get(`/api/changes/${number}`, changeSchema);
  writeState(files, { origin: braid.origin, workspaceId: braid.credentials.workspaceId, base, change: { id: change.id, number: change.number, revision: change.revision, status: change.status, html_url: change.html_url } });
  attachActivity(context, root, braid.origin, braid.credentials.workspaceId, change);
  print(context, describeChange(change, braid.secrets) + nextStep(context, change, { root, origin: braid.origin }));
}

async function submit(this: BraidContext, flags: Flags) {
  if (flags.retry && [flags.title, flags.summary, flags.intent, flags.rationale, flags.model, flags.tool, flags.session, flags.parentSession, flags.tests, flags.proof, flags.push, flags.dependsOn].some(value => value !== undefined)) fail('--retry resends the saved submission exactly; leave out the other flags.');
  if (flags.push && [flags.title, flags.summary, flags.intent, flags.rationale, flags.tests, flags.proof, flags.dependsOn].some(value => value !== undefined)) fail('--push sends the commits over Git, so their messages describe the change; leave out the description, --tests, --proof and --depends-on.');
  const repository = openRepository(this), { root } = repository;
  if (isTaskCheckout(root)) fail(`This checkout belongs to a Braid task; submit its result with ${command(this, 'task', 'submit')}.`);
  const braid = connect(this, repository);
  const files = branchFiles(this, root);
  if (flags.push) return withLock(files.lock, () => pushChange(this, braid, root, files, flags));
  await withLock(files.lock, async () => {
    let saved = readJournal(files);
    const state = readState(root, files);
    if (state && (state.origin !== braid.origin || state.workspaceId !== braid.credentials.workspaceId)) fail(`This branch's change is on ${state.origin}, repository ${state.workspaceId}; braid is signed in to ${braid.origin}, repository ${braid.credentials.workspaceId}.`);
    if (flags.retry) {
      if (saved?.status !== 'pending') fail('There is no unconfirmed submission from this branch to retry.');
    } else {
      if (saved?.status === 'pending') fail(`An earlier submission from this branch is unconfirmed. Resend it exactly with ${command(this, 'submit', '--retry')}, then submit again.`);
      // A change that landed or closed since this branch last looked takes no more revisions; the next one is new.
      const known = state?.change && !finished(state.change.status) ? state.change : undefined;
      const revising = known && !finished((await braid.get(`/api/changes/${known.id}`, changeSchema)).status) ? known : undefined;
      const base = revising && state ? state.nextBase && isAncestor(this, root, state.nextBase) ? state.nextBase : state.base : (await trunkBase(this, braid, root)).base;
      const proof = flags.proof ? readProof(root, braid.secrets) : undefined;
      const { files: changed } = collectChanges(this, root, base, braid.secrets);
      const commits = commitsSince(this, root, base), described = describe(commits), credited = coAuthors(commits);
      const previous = revising ? saved?.payload : undefined;
      const run = committedRun(this, root, commits, flags);
      const agent = { tool: run.tool, session: run.session, parentSession: run.parentSession };
      const payload: Payload = {
        title: clip(flags.title ?? previous?.title ?? described.title, 120) || 'Agent change',
        summary: clip(flags.summary ?? previous?.summary ?? described.summary, 1200) || 'Agent change',
        ...(flags.intent ?? previous?.intent ? { intent: clip(flags.intent ?? previous?.intent ?? '', 4000) } : {}),
        ...(flags.rationale ?? previous?.rationale ? { rationale: clip(flags.rationale ?? previous?.rationale ?? '', 6000) } : {}),
        ...(run.model ? { model: run.model } : {}),
        ...(Object.values(agent).some(Boolean) ? { agent } : {}),
        ...(revising ? { previousRevision: revising.revision } : {}),
        ...(credited.length ? { coAuthors: credited } : {}),
        baseCommit: base, files: changed,
        ...(flags.dependsOn !== undefined ? { dependsOn: flags.dependsOn } : {}),
        ...(flags.tests ? { tests: readTests(this, flags.tests) } : {}),
      };
      if (proof) {
        const evidence = await runProof(this, root, proof, braid.secrets);
        if (evidence.length) payload.evidence = evidence;
      }
      assertSubmittable(payload, braid.secrets);
      saved = { status: 'pending', key: randomUUID(), target: revising ? `/api/changes/${revising.id}/revisions` : '/api/changes', payload };
      writeJournal(files, saved);
      noteCommits(this, root, commits, run);
    }
    const pending = saved;
    let change;
    try {
      change = await braid.post(pending.target, pending.payload, changeSchema, { key: pending.key, timeout: 180_000 });
    } catch (error) {
      if (error instanceof ApiError && [400, 403, 404, 409, 413, 422].includes(error.status)) {
        writeJournal(files, { ...pending, status: 'rejected' });
        fail(`Braid did not accept the change (HTTP ${error.status}): ${error.message}`);
      }
      if (error instanceof CliError) fail(`${error.message} The submission is unconfirmed; resend it exactly with ${command(this, 'submit', '--retry')}.`);
      throw error;
    }
    const nextBase = state?.nextBase && state.nextBase !== pending.payload.baseCommit ? state.nextBase : undefined;
    writeState(files, { origin: braid.origin, workspaceId: braid.credentials.workspaceId, base: pending.payload.baseCommit, ...(nextBase ? { nextBase } : {}), change: { id: change.id, number: change.number, revision: change.revision, status: change.status, html_url: change.html_url } });
    writeJournal(files, { ...pending, status: 'complete' });
    attachActivity(this, root, braid.origin, braid.credentials.workspaceId, change);
    print(this, describeChange(change, braid.secrets) + nextStep(this, change, { root, origin: braid.origin }));
  });
}

export function parseDependsOn(value: string): (number | string)[] {
  const parsed = v.safeParse(dependencyFlag, value);
  if (!parsed.success) fail('Use up to 16 pull request numbers or change ids, separated by commas; none clears the dependencies.');
  return parsed.output;
}

const text = (brief: string, placeholder = 'text') => ({ kind: 'parsed', parse: String, brief, placeholder, optional: true }) as const;

export const submitCommand = buildCommand({
  func: submit,
  parameters: {
    flags: {
      dependsOn: { kind: 'parsed', parse: parseDependsOn, brief: 'Pull request numbers or ids, comma-separated; none clears dependencies', placeholder: '51,52', optional: true },
      title: text('Title; from the first commit when not given, and kept by later revisions'),
      summary: text('What changed; from the commits when not given'),
      intent: text('Why it was needed'),
      rationale: text('Why it was done this way'),
      model: { kind: 'parsed', parse: parseModel, brief: 'Model id; from BRAID_MODEL or the coding tool when not given', placeholder: 'id', optional: true },
      tool: { kind: 'parsed', parse: parseTool, brief: 'Tool and version; detected from the processes running braid when not given', placeholder: 'name', optional: true },
      session: { kind: 'parsed', parse: parseSession, brief: 'Session id; from BRAID_SESSION or the coding tool when not given', placeholder: 'id', optional: true },
      parentSession: { kind: 'parsed', parse: parseSession, brief: 'The orchestrator\'s session; from BRAID_PARENT_SESSION when not given', placeholder: 'id', optional: true },
      tests: text('JSON file of up to 10 agent-reported test results: [{command, result, detail?}]', 'file'),
      proof: { kind: 'boolean', brief: 'Run .braid/proof.json and attach its checks and screenshots', optional: true },
      retry: { kind: 'boolean', brief: 'Resend an unconfirmed submission exactly, with its key', optional: true },
      push: { kind: 'boolean', brief: 'Push the commits and their notes to the braid remote instead of sending files', optional: true },
    },
  },
  docs: {
    brief: 'Open or revise this branch\'s change',
    fullDescription: [
      'Sends the committed difference between the branch and its trunk base: a new change the first time, then the next revision of the same change. Commit first; untracked files outside .braid/ must be committed or ignored. Use --push for binary files or submissions larger than the JSON envelope. Artifacts limits individual blobs to 32 MB and each push to about 30 MB. Credential checks run before sending.',
      '',
      '--proof runs .braid/proof.json in the repository and attaches what happened:',
      '  {"checks": ["npm test", "npm run build"], "timeoutSeconds": 600,',
      '   "preview": {"command": "npm run dev -- --port 4319", "url": "http://127.0.0.1:4319", "pages": ["/", "/settings"], "timeoutSeconds": 120}}',
      'Up to 10 one-line checks (9 with a preview) run with CI=true and without BRAID_ variables; each one\'s exit code and the last 8,000 characters of its output are attached even when it fails. The preview must answer on a local port; each page is captured at 1280×800 and 390×844 by a local Playwright (npx playwright install chromium), then the preview is stopped.',
    ].join('\n'),
  },
});
