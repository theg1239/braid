import type { AgentRecord, BatchSummary, Change, ChangeCloseReason, ChangeComparison, ChangeDiff, ChangeCounts, ChangeEvent, ChangePage, ChangeStatus, ChangeSummary, FileBlame, HotPath, Instruction, Provenance, SwarmRun, TrunkStatus } from '../../shared/types';
import type { Policy } from '../../shared/policy';
import type { BranchCommit } from '../../shared/compare';
import { HttpError } from '../errors';
import { imageType } from './evidence';
import { checkStateOf } from '../../shared/questions';
import { splitLines, textDiffStats } from '../../shared/diff';
import { changeCursor } from '../schemas';
import { agentKey, canonicalAgentKey, fileProvenance } from '../../shared/provenance';
import { mergeFile } from '../../shared/merge';
import { landedProvenance } from '../repositories/provenance';
import { shift as moveLines, type Range } from './blame';
import main from './recorded-main.json';
import type { ChangeGuide } from '../../shared/guide';
import { GUIDE_MODEL } from './guide';
import { base64Bytes } from '../http/auth';
import { hash } from './names';

/**
 * The public example serves a recorded run of the real change store, merge
 * engine, landing queue and GitHub gate (see record.test.ts), on the same
 * repository that the example's code view and sample task use. Timestamps are
 * shifted so the recording reads as recent. A visitor's answers to changes
 * that wait for a person, and the sample task's result once they land it, are
 * kept in their own demo workspace and replayed over the recording: approved
 * work moves through the queue and lands within seconds without running any
 * checks, which the landed change says.
 */
interface FileDiff { before: string | null; after: string | null }
/** A real branch from the recording repository, pinned to its parent and complete text tree. */
interface ExampleBranch { name: string; base: string; changeId: string; tip: BranchCommit; files: Record<string, string> }
/** A file's blame as recorded: each range names its commit, whose provenance is recorded once. */
type RecordedBlame = Omit<FileBlame, 'ranges'> & { ranges: [start: number, lines: number, commit: string][] };
/**
 * `images` holds each screenshot the recorded changes show, as base64 by name. `blame` is every text file on the
 * recorded main as the landing queue attributed it, `provenance` who made each commit in it, and `agents` the roster.
 */
interface Recorded {
  guides?: Record<string, ChangeGuide>;
  recordedAt: string; changes: Change[]; diffs: Record<string, FileDiff>; images: Record<string, string>;
  queue: TrunkStatus; hot: HotPath[]; policy: { policy: Policy; errors: string[]; head: string; instructions: Instruction[] }; swarm: SwarmRun | null;
  instructions: { instructions: Instruction[]; errors: string[]; head: string };
  blame: Record<string, RecordedBlame>; provenance: Provenance[]; agents: AgentRecord[]; branches: ExampleBranch[];
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function latest(value: unknown, best = 0): number {
  if (typeof value === 'string') return ISO.test(value) ? Math.max(best, Date.parse(value)) : best;
  if (Array.isArray(value)) return value.reduce((max: number, item) => latest(item, max), best);
  if (value && typeof value === 'object') return Object.values(value).reduce((max: number, item) => latest(item, max), best);
  return best;
}
function shift<T>(value: T, delta: number): T {
  if (typeof value === 'string') return (ISO.test(value) ? new Date(Date.parse(value) + delta).toISOString() : value) as T;
  if (Array.isArray(value)) return value.map(item => shift(item, delta)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item, delta)])) as T;
  return value;
}

/** The example repository: main as the recorded run left it. Small, because it seeds every example workspace. */
export const exampleMain = (): { head: string; files: Record<string, string> } => main;

/** A visitor's answer to a change in the recorded example. */
export interface DemoDecision { action: 'approve' | 'send-back' | 'close'; at: number; revision: number; note?: string; reason?: ChangeCloseReason }
/** A task result the visitor landed, which becomes a change of its own. */
export interface ExampleChange { change: Change; diffs: Record<string, FileDiff>; at: number; missionId: string; fileAuthors?: Record<string, Change['author']> }
/** Everything one visitor did in the example, and when they first arrived. */
export interface ExampleState { decisions: Record<string, DemoDecision>; changes: ExampleChange[]; since?: number }
const EMPTY: ExampleState = { decisions: {}, changes: [] };
const QUEUED_FOR = 4_000, LANDING_FOR = 6_000;
/** How long approved work takes to land in the example. */
const LANDS_AFTER = QUEUED_FOR + LANDING_FOR;

/** A stable, obviously synthetic commit name for work landed in the example. */
function exampleCommit(changeId: string) {
  let value: number | undefined, out = '';
  for (let round = 0; out.length < 40; round++) {
    value = hash(`${changeId}:${round}`, value);
    out += value.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}
/** A change the example merged at `at`, under a synthetic commit, saying that no checks ran. */
function merged(change: Change, at: number, batchId: string): Change {
  const landedAt = new Date(at).toISOString(), commit = exampleCommit(change.id);
  const { next: _next, label: _label, ...rest } = change;
  return { ...rest, status: 'landed', landedCommit: commit, landedAt, updatedAt: landedAt, batchId,
    events: [...change.events, { at: landedAt, type: 'landed', message: `Merged as ${commit.slice(0, 7)} in the recorded example after your approval. No checks ran.` }] };
}
/** Approved work moving through the example's queue: queued, then landing, then landed. */
function moving(change: Change, at: number, now: number, approval: ChangeEvent | null): Change {
  const iso = new Date(at).toISOString();
  const { next: _next, label: _label, policy, ...rest } = change;
  const satisfied = policy && { ...policy, requirements: policy.requirements.map(requirement => requirement.id === 'checks' ? requirement : { ...requirement, satisfied: true }) };
  const events: ChangeEvent[] = [...change.events, ...(approval ? [approval] : []), { at: iso, type: 'queued', message: 'Added to the merge queue.' }];
  const base = { ...rest, ...(satisfied ? { policy: satisfied } : {}), events, updatedAt: iso };
  const elapsed = now - at;
  if (elapsed < QUEUED_FOR) return { ...base, status: 'queued', next: 'Queued to merge.' };
  if (elapsed < LANDS_AFTER) return { ...base, status: 'landing', next: 'Merging.' };
  return merged(base, at + LANDS_AFTER, `b_example_${change.number}`);
}
/** A file after one landing, as the example's workspace applies it: replaced while unchanged since, merged otherwise. */
function applied(path: string, current: string | undefined, diff: FileDiff): string | undefined {
  if (diff.after === null) return current === undefined || current === diff.before ? undefined : current;
  if (current === undefined || current === diff.before) return diff.after;
  const result = mergeFile(path, diff.before ?? '', current, diff.after);
  return result.clean ? result.text : current;
}
/** The recorded change with the visitor's decision applied, as of `now`. */
function decided(change: Change, decision: DemoDecision | undefined, now: number): Change {
  if (!decision || decision.revision !== change.revision) return change;
  const at = new Date(decision.at).toISOString();
  const { next: _next, label: _label, ...rest } = change;
  if (decision.action === 'close') {
    const reason = decision.reason ?? 'rejected';
    return { ...rest, status: 'closed', closeReason: reason, updatedAt: at, events: [...change.events, { at, type: 'closed', message: `You closed it as ${reason}.`, actor: 'You' }] };
  }
  if (decision.action === 'send-back') {
    const note = decision.note ?? 'Sent back.';
    return { ...rest, status: 'revise', sentBack: 'review', label: 'Changes requested', next: `Sent back by you: ${note}`.slice(0, 200), updatedAt: at,
      reviews: [...change.reviews, { id: `rv_example_${change.number}`, revision: change.revision, reviewer: 'example-visitor', kind: 'human', verdict: 'revise', summary: note, createdAt: at, findings: [] }],
      events: [...change.events, { at, type: 'reviewed', message: `You sent it back: ${note}`, actor: 'You' }] };
  }
  const approved = decision.note ? { ...change, reviews: [...change.reviews, { id: `rv_example_${change.number}`, revision: change.revision, reviewer: 'example-visitor', kind: 'human' as const, verdict: 'approve' as const, summary: decision.note, createdAt: at, findings: [] }] } : change;
  return moving(approved, decision.at, now, { at, type: 'approved', message: 'You approved these changes.', actor: 'You' });
}
function summary(change: Change, headCommit = change.headCommit): ChangeSummary {
  const { files, intent: _intent, summary: _summary, rationale: _rationale, baseCommit: _base, policy: _policy, reviews: _reviews, checks: _checks, conflicts: _conflicts, overlaps: _overlaps, events: _events, strategies: _strategies, github: _github, batchId: _batch, landedAt: _landedAt, conflictBase: _conflictBase,
    landedParent: _parent, revertedBy: _revertedBy, revertOf: _revertOf, guards: _guards, duplicates: _duplicates, evidence: _evidence, comments: _comments, ...rest } = change;
  const checkState = checkStateOf(change);
  return { ...rest, ...(headCommit ? { headCommit } : {}), files: files.length, commentCount: change.comments?.length ?? 0, ...(checkState ? { checkState } : {}) };
}

/** One piece of the visitor's work that has landed, with the files it changed. */
interface ExampleLanding { id: string; number: number; title: string; commit: string; landedAt: number; diffs: Record<string, FileDiff>; missionId?: string }

let loading: Promise<RecordedExample> | undefined;
/** The recorded run, loaded when someone first opens the example rather than on every isolate start. */
export function recordedExample(): Promise<RecordedExample> {
  return loading ??= import('./recorded.json').then(module => example(module.default as unknown as Recorded));
}
export type RecordedExample = ReturnType<typeof example>;

/** The recorded run, read as of a visitor's own answers and arrival. */
function example(recorded: Recorded) {
  // A resolved review of the actual fix already in #22. The recording and its numbers stay untouched.
  recorded = { ...recorded, changes: recorded.changes.map(change => change.number !== 22 ? change : { ...change, comments: [
    { id: 'rc_example_https', body: 'Can we reject HTTP endpoints before sending a delivery?', author: { kind: 'human', id: 'example-reviewer', name: 'Maya Chen', owner: { name: 'Maya Chen', github: 'maya-chen' } },
      createdAt: change.createdAt, revision: change.revision, anchor: { path: 'src/endpoints.ts', line: 5, side: 'RIGHT', revision: change.revision, position: 5, outdated: false }, resolved: true },
    { id: 'rc_example_https_reply', body: 'The validator requires `https:` before accepting an endpoint. The revised tests cover HTTP URLs.', author: change.author,
      createdAt: change.updatedAt, revision: change.revision, inReplyTo: 'rc_example_https' },
  ] } satisfies Change) };
  // Signature logging builds on the already-merged signing change. Overlay only: ids, order and Git history stay recorded.
  const parent = recorded.changes.find(change => change.number === 5)!, child = recorded.changes.find(change => change.number === 12)!;
  const ref = ({ id, number, status }: Change) => ({ id, number, status });
  recorded = { ...recorded, changes: recorded.changes.map(change => change.id === child.id
    ? { ...change, dependsOn: [ref(parent)], waitingOn: [], stack: { position: 2, total: 2 } }
    : change.id === parent.id ? { ...change, requiredBy: [ref(child)], stack: { position: 1, total: 2 } } : change) };
  recorded = { ...recorded, agents: recorded.agents.map(agent => ({ ...agent, id: canonicalAgentKey(agent.id) })) };
  // Model prose is immutable recorded content too; do not clone or shift it for each visitor's clock.
  const { diffs, images, guides, ...rest } = recorded;
  const until = latest(rest);
  const shifted = new Map<number, Recorded>();
  /**
   * The recording, moved so its last event happened two minutes before the
   * visitor arrived. Anchoring to their first visit keeps one timeline: the
   * recorded run happened just before, and everything they do comes after it.
   */
  function data(since = Date.now()): Recorded {
    const minute = Math.floor(since / 60_000) * 60_000;
    let result = shifted.get(minute);
    if (!result) {
      result = { ...shift(rest, minute - 120_000 - until), diffs, images };
      if (shifted.size >= 64) shifted.delete(shifted.keys().next().value!);
      shifted.set(minute, result);
    }
    return result;
  }
  function all(state: ExampleState, now = Date.now()): Change[] {
    const changes = [...data(state.since).changes.map(change => decided(change, state.decisions[change.id], now)), ...state.changes.map(extra => moving(extra.change, extra.at, now, null))];
    const dependent = changes.find(change => change.id === child.id)!;
    return changes.map(change => change.id === parent.id ? { ...change, requiredBy: [ref(dependent)] } : change);
  }
  function change(reference: string, state: ExampleState = EMPTY): Change {
    const found = all(state).find(item => item.id === reference || String(item.number) === reference);
    if (!found) throw new HttpError(404, 'Change not found.');
    return found;
  }
  /** A recorded change merged at `landedAt`, with the files its current revision changed. */
  function landingOf(landed: Change, landedAt: number): ExampleLanding {
    const files = Object.fromEntries(landed.files.flatMap(file => { const diff = diffs[`${landed.id}:${landed.revision}:${file.path}`]; return diff ? [[file.path, diff]] : []; }));
    return { id: landed.id, number: landed.number, title: landed.title, commit: exampleCommit(landed.id), landedAt, diffs: files };
  }
  /** What has merged on the example's main since the recording, for this visitor: their approvals and their task. */
  function landingsAt(state: ExampleState, now: number): ExampleLanding[] {
    const approved = Object.entries(state.decisions).filter(([, decision]) => decision.action === 'approve' && now - decision.at >= LANDS_AFTER).flatMap(([id, decision]): ExampleLanding[] => {
      const landed = recorded.changes.find(item => item.id === id);
      return landed && landed.revision === decision.revision ? [landingOf(landed, decision.at + LANDS_AFTER)] : [];
    });
    const tasks = state.changes.filter(extra => now - extra.at >= LANDS_AFTER)
      .map(extra => ({ id: extra.change.id, number: extra.change.number, title: extra.change.title, commit: exampleCommit(extra.change.id), landedAt: extra.at + LANDS_AFTER, diffs: extra.diffs, missionId: extra.missionId }));
    return [...approved, ...tasks].sort((a, b) => a.landedAt - b.landedAt);
  }
  /** Who made a commit merged on the example's main, as Braid records its own landings. */
  function landingProvenance(landing: ExampleLanding, state: ExampleState): Provenance {
    const landed = change(landing.id, state);
    return landedProvenance(landing.commit, new Date(landing.landedAt).toISOString(),
      { changeId: landed.id, number: landed.number, revision: landed.revision, title: landed.title, author: landed.author, fileAuthors: state.changes.find(extra => extra.change.id === landed.id)?.fileAuthors, ...(landed.taskId ? { taskId: landed.taskId } : {}), approvedBy: '' });
  }
  function branch(ref: string, state: ExampleState = EMPTY): ExampleBranch | undefined {
    return data(state.since).branches.find(branch => branch.name === ref || `refs/heads/${branch.name}` === ref || branch.tip.hash === ref);
  }
  /** The recorded branch uses this proposal's patch; it has not been witnessed landing on main. */
  function branchProvenance(branch: ExampleBranch, state: ExampleState): Provenance {
    const source = change(branch.changeId, state);
    return { ...landedProvenance(branch.tip.hash, branch.tip.time,
      { changeId: source.id, number: source.number, revision: source.revision, title: source.title, author: source.author, approvedBy: '' }), confidence: 'inferred' };
  }
  return {
    change,
    /** Already generated by Workers AI during recording. A tour read never invokes a model. */
    guide(reference: string, revision?: number, state: ExampleState = EMPTY): ChangeGuide {
      const found = change(reference, state), target = revision ?? found.revision;
      if (target < 1 || target > found.revision) throw new HttpError(404, `This change has no revision ${target}.`);
      return guides?.[`${found.id}:${target}`] ?? { status: 'failed', revision: target, chapters: [], attributes: [], generatedBy: GUIDE_MODEL, error: 'No model guide was recorded for this revision.' };
    },
    branches: (state: ExampleState = EMPTY): ExampleBranch[] => data(state.since).branches,
    branch,
    /** The number the visitor's next landed task gets, after every recorded change. */
    nextNumber(state: ExampleState) {
      return Math.max(0, ...recorded.changes.map(item => item.number), ...state.changes.map(extra => extra.change.number)) + 1;
    },
    /** What has merged on the example's main since the recording, in landing order. */
    landings: (state: ExampleState, now = Date.now()): ExampleLanding[] => landingsAt(state, now),
    changes(query: { statuses?: ChangeStatus[]; before?: { updatedAt: string; id: string }; limit: number; author?: string; taskId?: string; agent?: string }, state: ExampleState = EMPTY): ChangePage {
      const changes = all(state);
      const counts: ChangeCounts = { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 };
      for (const item of changes) counts[item.status]++;
      let items = changes.filter(item => (!query.statuses || query.statuses.includes(item.status)) && (!query.author || item.author.id === query.author) && (!query.taskId || item.taskId === query.taskId)
        && (!query.agent || agentKey(item.author) === query.agent))
        .sort((a, b) => a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1)
        .map(item => summary(item, item.headCommit ?? recorded.branches.find(branch => branch.changeId === item.id)?.tip.hash));
      const { before } = query;
      if (before) items = items.filter(item => item.updatedAt < before.updatedAt || (item.updatedAt === before.updatedAt && item.id < before.id));
      const page = items.slice(0, query.limit);
      return { items: page, nextCursor: page.length === query.limit && items.length > query.limit ? changeCursor(page[page.length - 1]) : null, counts };
    },
    diff(reference: string, path: string, versions: { revision?: number; since?: number }, state: ExampleState = EMPTY): ChangeDiff {
      const found = change(reference, state);
      const target = versions.revision ?? found.revision, { since } = versions;
      if (since !== undefined && since >= target) throw new HttpError(400, 'Compare with an earlier revision.');
      // An entry URL can ask for the first file before it has read the change's detail.
      path ||= Object.keys(state.changes.find(extra => extra.change.id === found.id)?.diffs ?? {}).sort()[0]
        ?? Object.keys(diffs).filter(key => key.startsWith(`${found.id}:${target}:`)).map(key => key.split(':').slice(2).join(':')).sort()[0] ?? '';
      const recorded = (number: number) => state.changes.find(extra => extra.change.id === found.id)?.diffs[path] ?? diffs[`${found.id}:${number}:${path}`];
      const diff = recorded(target), earlier = since === undefined ? undefined : recorded(since);
      if (!diff && !earlier) throw new HttpError(404, 'This recorded change does not include that file.');
      // A file a revision leaves alone reads as main did before the change.
      const after = diff ? diff.after : earlier!.before, before = since === undefined ? diff!.before : earlier ? earlier.after : diff!.before;
      const result = { path, revision: target, ...(since === undefined ? {} : { since }), binary: false };
      if (before !== null) return { ...result, before, after };
      if (after !== null) return { ...result, before: null, after };
      throw new HttpError(404, 'This recorded change does not include that file.');
    },
    /** The files that differ between two recorded revisions of a change, with their line counts. */
    compare(reference: string, since: number, revision: number | undefined, state: ExampleState = EMPTY): ChangeComparison {
      const found = change(reference, state);
      const target = revision ?? found.revision;
      if (since >= target) throw new HttpError(400, 'Compare with an earlier revision.');
      const paths = new Set(Object.keys(diffs).filter(key => key.startsWith(`${found.id}:${since}:`) || key.startsWith(`${found.id}:${target}:`)).map(key => key.split(':').slice(2).join(':')));
      const files: ChangeComparison['files'] = [];
      for (const path of [...paths].sort()) {
        const earlier = diffs[`${found.id}:${since}:${path}`], later = diffs[`${found.id}:${target}:${path}`];
        // A file a revision leaves alone reads as main did before the change.
        const before = earlier ? earlier.after : later!.before, after = later ? later.after : earlier!.before;
        if (before === after) continue;
        files.push({ path, ...textDiffStats(before ?? '', after ?? ''), ...(before === null ? { added: true as const } : {}), ...(after === null ? { deleted: true as const } : {}) });
      }
      return { revision: target, since, files };
    },
    /** The recorded queue as this visitor sees it, plus the landings their own work produced. */
    queue(state: ExampleState = EMPTY): TrunkStatus {
      const now = Date.now(), waitingEntries = all(state, now).filter(item => item.status === 'queued').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.number - b.number).map(item => ({ changeId: item.id, number: item.number, title: item.title }));
      const queue = { ...data(state.since).queue, waitingEntries: waitingEntries.slice(0, 100), waitingEntriesTruncated: waitingEntries.length > 100, stacks: [[ref(change(parent.id, state)), ref(change(child.id, state))]] };
      const mine = new Set([...Object.entries(state.decisions).filter(([, decision]) => decision.action === 'approve').map(([id]) => id), ...state.changes.map(extra => extra.change.id)]);
      const moved = all(state, now).filter(item => mine.has(item.id) && ['queued', 'landing', 'landed'].includes(item.status));
      if (!moved.length) return queue;
      const landed = moved.filter(item => item.status === 'landed');
      const inQueue = moved.filter(item => item.status === 'queued' || item.status === 'landing').length, waiting = moved.filter(item => item.status === 'queued').length;
      const batches: BatchSummary[] = landed.map(item => ({ id: item.batchId!, status: 'landed', base: queue.head, head: item.landedCommit!, startedAt: item.updatedAt, finishedAt: item.landedAt!,
        landed: [{ changeId: item.id, number: item.number, commit: item.landedCommit! }], ejected: [], strategies: {}, note: 'Merged in the recorded example after your approval. No checks ran.' }));
      const finishedAt = (batch: BatchSummary) => batch.finishedAt ?? batch.startedAt;
      return { ...queue, head: landingsAt(state, now).at(-1)?.commit ?? queue.head, queued: queue.queued + inQueue, waiting: queue.waiting + waiting,
        merging: [...queue.merging, ...moved.filter(item => item.status === 'landing').map(item => ({ changeId: item.id, number: item.number, title: item.title }))],
        recent: [...batches, ...queue.recent].sort((a, b) => finishedAt(b).localeCompare(finishedAt(a))).slice(0, 20),
        stats: { ...queue.stats, landed: queue.stats.landed + landed.length, batches: queue.stats.batches + landed.length } };
    },
    /** A screenshot a recorded change shows as evidence. */
    image(reference: string, name: string, state: ExampleState = EMPTY): { type: string; bytes: Uint8Array<ArrayBuffer> } {
      const encoded = change(reference, state).evidence?.some(item => item.kind === 'screenshot' && item.image === name) ? images[name] : undefined;
      if (!encoded) throw new HttpError(404, 'This change has no such screenshot.');
      return { type: imageType(name), bytes: base64Bytes(encoded) };
    },
    hot: (state: ExampleState = EMPTY): HotPath[] => data(state.since).hot,
    policy: (state: ExampleState = EMPTY) => data(state.since).policy,
    instructions: (state: ExampleState = EMPTY) => data(state.since).instructions,
    swarm: (state: ExampleState = EMPTY): SwarmRun | null => data(state.since).swarm,
    /**
     * Move the recorded line map through visitor landings or a proposal branch's patch. A pinned branch keeps
     * its recorded parent, and its new lines have inferred attribution because the proposal has not landed.
     */
    blame(path: string, state: ExampleState = EMPTY, requested?: string): FileBlame {
      const recorded = data(state.since), found = recorded.blame[path];
      const selected = requested ? branch(requested, state) : undefined, allLandings = landingsAt(state, Date.now());
      const head = allLandings.at(-1)?.commit ?? recorded.queue.head, index = allLandings.findIndex(landing => landing.commit === requested);
      if (requested && !selected && !['main', 'refs/heads/main', recorded.queue.head, head].includes(requested) && index < 0) throw new HttpError(404, 'Repository revision not found.');
      const landings = selected || requested === recorded.queue.head ? [] : index >= 0 ? allLandings.slice(0, index + 1) : allLandings;
      const before = exampleMain().files[path] ?? null, after = selected?.files[path] ?? null;
      const steps = selected ? (before === after ? [] : [{ diff: { before, after }, provenance: branchProvenance(selected, state) }])
        : landings.filter(landing => landing.diffs[path]).map(landing => ({ diff: landing.diffs[path], provenance: landingProvenance(landing, state) }));
      if (!found && !steps.length) throw new HttpError(404, `${path} is not on the recorded main.`);
      const byCommit = new Map(recorded.provenance.map(item => [item.commit, item]));
      const ref = selected?.tip.hash ?? landings.at(-1)?.commit ?? recorded.queue.head;
      if (!steps.length) return { ...found!, ref, ranges: found!.ranges.map(([start, lines, commit]) => ({ start, lines, provenance: byCommit.get(commit)! })) };
      // The queue's line map numbers its commits from 1; here each number is a commit's provenance.
      const table: Provenance[] = [], numbers = new Map<string, number>();
      const number = (item: Provenance) => {
        let found = numbers.get(item.commit);
        if (found === undefined) numbers.set(item.commit, (found = table.push(item)));
        return found;
      };
      let text: string | undefined = exampleMain().files[path];
      let ranges: Range[] = found ? found.ranges.map(([start, lines, commit]) => [start, lines, number(byCommit.get(commit)!)]) : [];
      for (const step of steps) {
        const next = applied(path, text, step.diff);
        if (next === text) continue;
        ranges = next === undefined ? [] : moveLines(ranges, splitLines(text ?? ''), splitLines(next), number(step.provenance)).ranges;
        text = next;
      }
      if (text === undefined) throw new HttpError(404, `${path} is not on the example's main.`);
      return { path, ref, lines: splitLines(text).length, ranges: ranges.map(([start, lines, commit]) => ({ start, lines, provenance: fileProvenance(table[commit - 1], path) })) };
    },
    provenance(commits: string[], state: ExampleState = EMPTY): Provenance[] {
      const known = new Map(data(state.since).provenance.map(item => [item.commit, item]));
      for (const branch of data(state.since).branches) if (commits.includes(branch.tip.hash)) known.set(branch.tip.hash, branchProvenance(branch, state));
      for (const landing of landingsAt(state, Date.now())) if (commits.includes(landing.commit)) known.set(landing.commit, landingProvenance(landing, state));
      return commits.flatMap(commit => known.get(commit) ?? []);
    },
    agents: (state: ExampleState = EMPTY): AgentRecord[] => data(state.since).agents,
    touching(paths: string[], state: ExampleState = EMPTY) {
      const active = all(state).filter(item => !['landed', 'closed'].includes(item.status));
      return Object.fromEntries(paths.map(path => [path, active.filter(item => item.files.some(file => file.path === path))
        .map(item => ({ changeId: item.id, number: item.number, title: item.title, status: item.status, author: item.author.name }))]));
    },
  };
}
