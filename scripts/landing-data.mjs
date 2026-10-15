// Regenerates src/components/landing/data.ts and demo/data.ts from the recorded example, so the landing page's figures
// and its working demo draw the product's own rows. Run after worker/changes/recorded*.json, the sample task in
// worker/workspace/seed.ts or the rules' wording in shared/questions.ts change: node scripts/landing-data.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runnerImport } from 'vite';
import sharp from 'sharp';
const root = new URL('..', import.meta.url).pathname;
const main = JSON.parse(readFileSync(`${root}/worker/changes/recorded-main.json`, 'utf8'));
const rec = JSON.parse(readFileSync(`${root}/worker/changes/recorded.json`, 'utf8'));
const file = main.files['src/delivery.ts'].split('\n');
if (file[file.length - 1] === '') file.pop();
const blame = rec.blame['src/delivery.ts'];
/** A person as the app names them: their login, or their name when Braid knows no login. */
const handle = (owner) => (owner.github ? `@${owner.github}` : owner.name);
const commits = new Map();
for (const [, , commit] of blame.ranges) {
  const p = rec.provenance.find((x) => x.commit === commit);
  const owner = handle(p.owner);
  commits.set(commit.slice(0, 7), { hash: commit.slice(0, 7), subject: p.subject, at: new Date(p.at).toISOString(), ...(p.agent ? { model: p.agent.name, tool: p.agent.tool, session: p.agent.session, ...(p.agent.parentSession ? { parentSession: p.agent.parentSession } : {}) } : {}), owner, ...(p.change ? { pull: p.change.number } : {}), confidence: p.confidence });
}
const q = (s) => JSON.stringify(s).replace(/'/g, "\\'").replace(/^"|"$/g, "'").replace(/\\"/g, '"');
const commitLines = [...commits.values()].map((c) => `  '${c.hash}': { ${Object.entries(c).map(([k, v]) => `${k}: ${typeof v === 'number' ? v : q(v)}`).join(', ')} },`).join('\n');
const outcome = (number) => q(({ landed: 'merged', closed: 'closed', revise: 'sent back', attention: 'needs a person', queued: 'merging', landing: 'merging' })[rec.changes.find(change => change.number === number).status]);
const runLines = blame.ranges.map(([start, lines, commit]) => `[${start}, ${lines}, '${commit.slice(0, 7)}']`).join(', ');
// The strands' order is fixed, since PULLS names strands by position; each owner is the roster's.
const strandLines = ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Fable 5.1', 'GPT-6 Astra', 'GPT-6.1 Sol', 'Gemini 3 Pro', 'Simulated']
  .map((model) => `  { model: ${q(model)}, owner: ${q(handle(rec.agents.find((agent) => agent.name === model).owner))}${model === 'Simulated' ? ', simulated: true' : ''} },`)
  .join('\n');
/** Who merged each pull request, in the order main took them: a model, a person by handle, or the labelled simulated fleet. */
const mergedBy = (c) => (c.author.kind === 'simulated' ? 'Simulated' : c.author.kind === 'agent' ? c.author.name : handle(c.author.owner));
const mainTook = rec.changes.filter((c) => c.status === 'landed').sort((a, b) => a.landedAt.localeCompare(b.landedAt) || a.number - b.number).map((c) => ({ pull: c.number, by: mergedBy(c), ...(c.author.kind === 'simulated' ? { simulated: true } : {}) }));
/** A value as a TypeScript literal in this file's quoting. */
const lit = (v) => Array.isArray(v) ? `[${v.map(lit).join(', ')}]` : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }` : typeof v === 'string' ? q(v) : String(v);
const text = `/*
 * The landing page's pictures draw these rows and nothing else: the blame of src/delivery.ts and
 * the pull requests the queue merged, frozen from the recorded example (worker/changes/recorded.json
 * and recorded-main.json, recorded ${rec.recordedAt.slice(0, 10)}) by scripts/landing-data.mjs. Nothing here is invented.
 */

type Confidence = 'braid' | 'trailers' | 'inferred';

/** How Braid knows who made a commit, in the words the blame card uses. */
export const CONFIDENCE: Record<Confidence, string> = { braid: 'Seen by Braid', trailers: 'From the commit', inferred: 'Inferred from the commit' };

export interface Commit {
  hash: string;
  subject: string;
  at: string;
  /** The model, when an agent wrote it. */
  model?: string;
  /** Whose agent it was, or the person. */
  owner: string;
  tool?: string;
  session?: string;
  parentSession?: string;
  pull?: number;
  confidence: Confidence;
}

const commits = {
${commitLines}
} satisfies Record<string, Commit>;

type CommitId = keyof typeof commits;

/** The commits behind src/delivery.ts at main's head, ${main.head.slice(0, 7)}. */
export const COMMITS: Record<CommitId, Commit> = commits;

/** src/delivery.ts at main's head. */
export const DELIVERY: string[] = [
${file.map((l) => `  ${q(l)},`).join('\n')}
];

/** Main's files, as the demo's tree lists them; the simulator's folder is left out. */
export const PATHS: string[] = ${lit(Object.keys(main.files).filter((path) => !path.startsWith('swarm/')).sort())};

/** Blame of src/delivery.ts: the first line, how many lines, and the commit that last changed them. */
export const DELIVERY_RUNS: [start: number, lines: number, commit: CommitId][] = [${runLines}];

/* ---------- Many agents, one main: the pull requests the queue landed, in order ---------- */

type Outcome = 'merged' | 'closed' | 'sent back' | 'merging' | 'needs a person';

interface Strand {
  model: string;
  owner: string;
  simulated?: boolean;
}

/** One strand per model and owner, as the roster lists them; the simulated fleet is one labelled strand. */
export const STRANDS: Strand[] = [
${strandLines}
];

interface Attempt {
  /** The column, left to right, where the queue answered. */
  at: number;
  outcome: Outcome;
  note?: string;
  /** The check that failed on the combined result and sent it back. */
  failed?: string;
}

export interface Pull {
  label: string;
  strand: number;
  /** The column where it opened. */
  opened: number;
  /** A bundle of simulated pull requests that landed in one batch. */
  count?: number;
  attempts: Attempt[];
}

/** Columns are the order of events in the example, not elapsed time. */
export const PULLS: Pull[] = [
  { label: '#1', strand: 0, opened: 0, attempts: [{ at: 1, outcome: 'merged' }] },
  { label: '#3', strand: 1, opened: 0, attempts: [{ at: 1, outcome: 'merged', note: 'composed with concurrent work' }] },
  { label: '#2', strand: 2, opened: 0, attempts: [{ at: 1, outcome: 'merged' }] },
  { label: '#5', strand: 4, opened: 2, attempts: [{ at: 3, outcome: 'merged' }] },
  { label: '#6', strand: 5, opened: 2, attempts: [{ at: 3, outcome: 'sent back', note: 'Conflict in src/delivery.ts' }] },
  { label: '#7', strand: 3, opened: 2, attempts: [{ at: 3, outcome: 'needs a person', note: 'a finance decision' }] },
  { label: '#8', strand: 6, opened: 2, attempts: [{ at: 3, outcome: 'merged' }] },
  { label: '28', strand: 6, opened: 4, count: 28, attempts: [{ at: 5, outcome: 'merged' }] },
  { label: '8', strand: 6, opened: 5, count: 8, attempts: [{ at: 6, outcome: 'merged' }] },
  { label: '#69', strand: 0, opened: 6, attempts: [{ at: 7, outcome: 'sent back', note: 'npm test failed', failed: 'npm test' }, { at: 8, outcome: 'merged', note: 'Revision 2' }] },
  { label: '#22', strand: 4, opened: 8, attempts: [{ at: 9, outcome: 'merged' }] },
  { label: '#23', strand: 2, opened: 8, attempts: [{ at: 9, outcome: 'merged' }] },
  { label: '#36', strand: 2, opened: 10, attempts: [{ at: 11, outcome: ${outcome(36)} }] },
  { label: '#73', strand: 1, opened: 10, attempts: [{ at: 11, outcome: ${outcome(73)}, note: 'duplicate of #51' }] },
  { label: '#51', strand: 3, opened: 10, attempts: [{ at: 11, outcome: ${outcome(51)} }] },
];

/** Open pull requests in the example, as its Pull requests tab counts them. */
export const OPEN_PULLS = ${rec.changes.filter((c) => ['open', 'revise', 'attention', 'queued', 'landing'].includes(c.status)).length};

/* ---------- The close: every pull request main took, in order ---------- */

/** Each merged pull request of the tour and who made it, in the order main took them. */
export const MERGED: { pull: number; by: string; simulated?: true }[] = [
${mainTook.map((m) => `  ${lit(m)},`).join('\n')}
];
`;
writeFileSync(`${root}/src/components/landing/data.ts`, text);
console.log('wrote', text.length, 'chars;', commits.size, 'commits;', file.length, 'lines');

/* ---------- The demo: every view it opens, from the same recording and the app's own wording ---------- */

/** The app's modules, loaded as the app loads them, so the demo states rules and questions in the app's words. */
const load = async (path) => (await runnerImport(`${root}/${path}`, { configFile: false, root, logLevel: 'error' })).module;
const { seedWorkspace } = await load('worker/workspace/seed.ts');
const { describePolicy, labelFor, questionFor } = await load('shared/questions.ts');
const { GOVERNANCE } = await load('shared/policy.ts');
const { progressOf, reviewerName } = await load('shared/labels.ts');

/** The simulator's load stays out of the demo, as it stays out of the fleet. */
const named = (path) => !path.startsWith('swarm/');
const short = (hash) => hash.slice(0, 7);
const demoFiles = Object.keys(main.files).filter(named).sort();
const lines = (text) => { const out = text.split('\n'); if (out.at(-1) === '') out.pop(); return out; };
const demoCommits = new Map();
for (const path of demoFiles) for (const [, , commit] of rec.blame[path].ranges) {
  const p = rec.provenance.find((x) => x.commit === commit);
  demoCommits.set(short(commit), { hash: short(commit), subject: p.subject, at: new Date(p.at).toISOString(), ...(p.agent ? { model: p.agent.name, tool: p.agent.tool } : {}), owner: handle(p.owner), ...(p.change ? { pull: p.change.number } : {}), confidence: p.confidence });
}

/** Who made a pull request, as its page names them. */
const byOf = (author) => (author.kind === 'agent' ? { model: author.name, owner: handle(author.owner), tool: author.tool } : { owner: handle(author.owner) });
const stateOf = (status) => (status === 'landed' ? 'merged' : status === 'closed' ? 'closed' : 'open');
/** Where a command ran, in the words the proof uses. */
const WHERE = { braid: 'Braid', agent: "agent's machine" };
const shotFile = { desktop: 'desktop', mobile: 'phone' };
const policy = rec.policy.policy;
const pulls = rec.changes.filter((c) => c.author.kind !== 'simulated').sort((a, b) => b.number - a.number).map((c) => {
  const question = questionFor(c, policy);
  const current = c.evidence?.filter((e) => e.revision === c.revision) ?? [];
  return {
    number: c.number, title: c.title, state: stateOf(c.status), status: c.status, progress: progressOf(c.status),
    ...(labelFor(c, policy) ? { label: labelFor(c, policy) } : {}),
    by: byOf(c.author), additions: c.additions, deletions: c.deletions, files: c.files.length, summary: c.summary || c.intent,
    checks: c.checks.filter((check) => check.revision === c.revision).map((check) => ({ label: check.label, status: check.status, source: check.source, detail: check.detail.split('\n')[0] })),
    shots: current.filter((e) => e.kind === 'screenshot').map((e) => ({ page: e.page, viewport: shotFile[e.viewport], width: e.width, height: e.height, where: WHERE[e.source] })),
    commands: current.filter((e) => e.kind === 'command').map((e) => ({ command: e.command, seconds: Math.round(e.durationMs / 100) / 10, where: WHERE[e.source], ok: e.exitCode === 0 })),
    reviews: c.reviews.filter((review) => review.revision === c.revision).map((review) => ({ reviewer: reviewerName(review.reviewer), app: review.reviewer.startsWith('github:'), verdict: review.verdict, ...(review.risk ? { risk: review.risk } : {}), summary: review.summary })),
    events: c.events.filter((e) => e.type !== 'reviewed').map((e) => ({ type: e.type, message: e.message })),
    ...(question ? { question: { label: question.label, heading: question.heading, detail: question.detail, answers: question.answers.map((answer) => answer.label) } } : {}),
    ...(c.landedCommit ? { merged: short(c.landedCommit) } : {}),
  };
});
mkdirSync(`${root}/src/components/landing/demo`, { recursive: true });
for (const e of rec.changes.find((c) => c.number === 23).evidence.filter((e) => e.kind === 'screenshot'))
  writeFileSync(`${root}/src/components/landing/demo/status-${shotFile[e.viewport]}.png`, Buffer.from(rec.images[e.image], 'base64'));

/** The fleet as the Agents tab lists it: most merged first. */
const fleet = rec.agents.filter((agent) => agent.models[0] !== 'simulated')
  .sort((a, b) => b.changes.landed - a.changes.landed || b.lines.added - a.lines.added)
  .map((agent) => ({ model: agent.name, owner: handle(agent.owner), tool: agent.tools[0].split('/')[0], merged: agent.changes.landed, sentBack: agent.changes.sentBack, open: agent.changes.open, added: agent.lines.added, alive: agent.lines.alive }));

const task = (() => {
  const mission = seedWorkspace('demo', {}).missions[0];
  const collision = mission.collisions[0];
  return {
    title: mission.title, intent: mission.intent, base: short(mission.baseCommit), conflict: collision.path,
    agents: mission.agents.map((agent) => ({ id: agent.id, model: agent.name, owner: handle(agent.owner), role: agent.role, summary: agent.summary, commit: short(agent.commit),
      files: agent.changes.map((change) => ({ path: change.path, additions: change.additions, deletions: change.deletions })),
      ...(collision.agentIds.includes(agent.id) ? { version: lines(agent.changes.find((change) => change.path === collision.path).after) } : {}) })),
  };
})();

const summary = describePolicy(policy);
/** As Settings › Rules leaves out what its protected row and Code security already say. */
const SAID_ELSEWHERE = new Set(['governance', 'secrets', 'tests', 'dependencies', 'dependency-review']);
const SHOWN = ['.braid/policy.json', 'CODEOWNERS', '.github/workflows/**', 'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.coderabbit.yaml'];
const rules = { areas: summary.areas, fallback: summary.fallback, protected: SHOWN, more: GOVERNANCE.filter((pattern) => !SHOWN.includes(pattern)).length, checks: summary.checks, github: rec.queue.github?.fullName ?? null,
  safeguards: summary.safeguards.filter((safeguard) => !safeguard.about.every((about) => SAID_ELSEWHERE.has(about))).map((safeguard) => safeguard.text) };

/** The merge queue: one merge group as it ran, combined, checked and merged, then every group before it. */
const queue = (() => {
  const isNamed = (number) => pulls.some((pull) => pull.number === number);
  const live = rec.queue.recent.find((group) => group.status === 'landed' && group.landed.some((each) => each.number === 23));
  const proof = pulls.find((pull) => pull.number === 23);
  return {
    head: short(main.head), merged: rec.queue.stats.landed, groups: rec.queue.stats.batches,
    group: { base: short(live.base), head: short(live.head), pulls: live.landed.map((each) => pulls.find((pull) => pull.number === each.number)).sort((a, b) => a.number - b.number).map((pull) => ({ number: pull.number, title: pull.title, by: pull.by })), checks: proof.checks.map((check) => ({ label: check.label, source: check.source })) },
    history: rec.queue.recent.map((group) => ({ base: short(group.base), head: short(group.head), merged: group.status === 'landed', pulls: group.landed.map((each) => each.number).filter(isNamed), others: group.landed.filter((each) => !isNamed(each.number)).length,
      back: group.ejected.filter((each) => isNamed(each.number)).map((each) => ({ number: each.number, reason: each.reason })) })).filter((group) => group.pulls.length || group.back.length),
  };
})();

/**
 * #23's screenshots cropped to what they show: the background the page was captured on is trimmed away, and a little
 * of it is kept round the content so nothing touches the edge. The pixels are the agent's own.
 */
const TIGHT = { desktop: 36, phone: 20 };
const tight = [];
for (const shot of pulls.find((pull) => pull.number === 23).shots) {
  const file = `${root}/src/components/landing/demo/status-${shot.viewport}.png`;
  const [r, g, b] = await sharp(file).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  const margin = TIGHT[shot.viewport];
  const trimmed = await sharp(file).trim({ threshold: 6 }).toBuffer();
  const { data, info } = await sharp(trimmed).extend({ top: margin, bottom: margin, left: margin, right: margin, background: { r, g, b } }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  writeFileSync(`${root}/src/components/landing/demo/status-${shot.viewport}-tight.png`, data);
  tight.push({ viewport: shot.viewport, width: info.width, height: info.height });
}

/** The line in each version of the contested file that decides what it does past the limit: wait, or fail fast. */
const DECIDING = { atlas: 16, sable: 18 };
const moments = {
  proof: (({ number, title, by, shots, commands, merged }) => ({ number, title, by, captured: shots.map(({ viewport, width, height }) => ({ viewport, width, height })), tight, commands, merged }))(pulls.find((pull) => pull.number === 23)),
  overlap: {
    path: task.conflict,
    lanes: task.agents.filter((agent) => agent.version).map((agent) => ({ model: agent.model, owner: agent.owner, line: agent.version[DECIDING[agent.id]].trim(), number: DECIDING[agent.id] + 1 })),
  },
};
writeFileSync(`${root}/src/components/landing/data.ts`, `${text}
/* ---------- Two of the app's moments, drawn large: a pull request's proof, and two agents' versions of one file ---------- */

/** #${moments.proof.number}'s proof: the agent's screenshots, captured and cropped to their content, and every command with where it ran. */
export const PROOF = ${lit(moments.proof)};

/** The sample task's contested file: each agent's version, by the line that decides what it does past the limit. */
export const OVERLAP = ${lit(moments.overlap)};
`);

const demo = `/*
 * Every view of the landing page's working demo draws these rows: main's files and their blame, the pull requests of
 * the named agents with their proof, checks and reviews, the fleet, the sample task and the rules, frozen from the
 * recorded example (recorded ${rec.recordedAt.slice(0, 10)}) and worded by the app's own functions by scripts/landing-data.mjs.
 * The simulator's load is left out, as the fleet leaves it out. Nothing here is invented.
 */
import type { Commit } from '../data';

/** Main's head, where every file below is read. */
export const HEAD = ${q(short(main.head))};

/** Main's files and their lines. */
export const FILES: Record<string, string[]> = {
${demoFiles.map((path) => `  ${q(path)}: ${lit(lines(main.files[path]))},`).join('\n')}
};

/** Blame of each file: the first line, how many lines, and the commit that last changed them. */
export const BLAME: Record<string, [start: number, lines: number, commit: string][]> = {
${demoFiles.map((path) => `  ${q(path)}: [${rec.blame[path].ranges.map(([start, count, commit]) => `[${start}, ${count}, ${q(short(commit))}]`).join(', ')}],`).join('\n')}
};

/** The commits behind those lines. */
export const COMMITS: Record<string, Commit> = {
${[...demoCommits.values()].map((c) => `  ${q(c.hash)}: ${lit(c)},`).join('\n')}
};

export interface DemoPull {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  status: string;
  /** Where it is, in GitHub's words. */
  progress: string;
  /** Why it waits for a person or went back, as the list tags it. */
  label?: string;
  by: { model?: string; owner: string; tool?: string };
  additions: number;
  deletions: number;
  files: number;
  summary: string;
  checks: { label: string; status: string; source: string; detail: string }[];
  shots: { page: string; viewport: 'desktop' | 'phone'; width: number; height: number; where: string }[];
  commands: { command: string; seconds: number; where: string; ok: boolean }[];
  reviews: { reviewer: string; app: boolean; verdict: string; risk?: string; summary: string }[];
  events: { type: string; message: string }[];
  /** The one question it puts to a person, with its answers. */
  question?: { label: string; heading: string; detail: string; answers: string[] };
  /** Main's commit, once merged. */
  merged?: string;
}

/** The named agents' and people's pull requests, newest first. */
export const PULLS: DemoPull[] = [
${pulls.map((pull) => `  ${lit(pull)},`).join('\n')}
];

/** The fleet: one row per model, owner and tool. */
export const FLEET = ${lit(fleet)};

/** The sample task: three agents from one commit, two of them with their own version of one file. */
export const TASK = ${lit(task)};

/** .braid/policy.json as Settings › Rules states it. */
export const RULES = ${lit(rules)};

/** The merge queue: #23's merge group as it ran, then the groups with named pull requests, newest first. */
export const QUEUE = ${lit(queue)};
`;
writeFileSync(`${root}/src/components/landing/demo/data.ts`, demo);
console.log('wrote demo', demo.length, 'chars;', demoFiles.length, 'files;', pulls.length, 'pull requests;', fleet.length, 'agents');
