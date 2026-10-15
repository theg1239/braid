/*
 * The landing page's pictures draw these rows and nothing else: the blame of src/delivery.ts and
 * the pull requests the queue merged, frozen from the recorded example (worker/changes/recorded.json
 * and recorded-main.json, recorded 2026-10-13) by scripts/landing-data.mjs. Nothing here is invented.
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
  '2ab7bbe': { hash: '2ab7bbe', subject: 'Sign webhook payloads with HMAC-SHA256', at: '2026-10-13T12:08:35.324Z', model: 'GPT-6.1 Sol', tool: 'codex/1.8.0', session: 's_423ad', owner: '@devokafor', pull: 5, confidence: 'braid' },
  '40e78be': { hash: '40e78be', subject: 'Relay webhook service', at: '2026-10-13T12:08:33.000Z', owner: '@maya-chen', confidence: 'inferred' },
  '60bc22e': { hash: '60bc22e', subject: 'Retry network errors and 5xx responses', at: '2026-10-13T12:08:33.214Z', model: 'Claude Opus 5.5', tool: 'claude-code/2.4.1', session: 's_3c6e0', owner: '@maya-chen', pull: 1, confidence: 'braid' },
  '9dbb209': { hash: '9dbb209', subject: 'Parse Retry-After before retrying', at: '2026-10-13T12:08:37.204Z', model: 'Claude Opus 5.5', tool: 'claude-code/2.4.1', session: 's_49f69', parentSession: 's_4807a', owner: '@maya-chen', pull: 69, confidence: 'braid' },
} satisfies Record<string, Commit>;

type CommitId = keyof typeof commits;

/** The commits behind src/delivery.ts at main's head, 424c7a5. */
export const COMMITS: Record<CommitId, Commit> = commits;

/** src/delivery.ts at main's head. */
export const DELIVERY: string[] = [
  'import { sign } from \'./signature\';',
  '',
  'export interface DeliveryResult {',
  '  ok: boolean;',
  '  status: number;',
  '  attempts: number;',
  '}',
  '',
  'export async function deliver(',
  '  url: string,',
  '  body: string,',
  '  secret: string,',
  '): Promise<DeliveryResult> {',
  '  let status = 0;',
  '  for (let attempt = 1; attempt <= 3; attempt++) {',
  '    try {',
  '      const response = await fetch(url, {',
  '        method: \'POST\',',
  '        headers: { \'content-type\': \'application/json\', \'x-relay-signature\': await sign(body, secret) },',
  '        body,',
  '      });',
  '      status = response.status;',
  '      if (response.ok || (status < 500 && status !== 429)) return { ok: response.ok, status, attempts: attempt };',
  '      const retryAfter = response.headers.get(\'retry-after\');',
  '      if (retryAfter) await new Promise(resolve => setTimeout(resolve, Math.min(Number(retryAfter), 60) * 1000));',
  '    } catch { status = 0; }',
  '    await new Promise(resolve => setTimeout(resolve, Math.random() * 250 * 2 ** attempt));',
  '  }',
  '  return { ok: false, status, attempts: 3 };',
  '}',
];

/** Main's files, as the demo's tree lists them; the simulator's folder is left out. */
export const PATHS: string[] = ['.braid/instructions.json', '.braid/policy.json', 'AGENTS.md', 'CHANGELOG.md', 'README.md', 'docs/receivers.md', 'package.json', 'public/status.html', 'src/billing/ledger.ts', 'src/delivery.ts', 'src/endpoints.ts', 'src/index.ts', 'src/log.ts', 'src/signature.ts', 'test/delivery.test.ts', 'test/endpoints.test.ts', 'tsconfig.json'];

/** Blame of src/delivery.ts: the first line, how many lines, and the commit that last changed them. */
export const DELIVERY_RUNS: [start: number, lines: number, commit: CommitId][] = [[1, 2, '2ab7bbe'], [3, 9, '40e78be'], [12, 1, '2ab7bbe'], [13, 1, '40e78be'], [14, 5, '60bc22e'], [19, 1, '2ab7bbe'], [20, 4, '60bc22e'], [24, 2, '9dbb209'], [26, 4, '60bc22e'], [30, 1, '40e78be']];

/* ---------- Many agents, one main: the pull requests the queue landed, in order ---------- */

type Outcome = 'merged' | 'closed' | 'sent back' | 'merging' | 'needs a person';

interface Strand {
  model: string;
  owner: string;
  simulated?: boolean;
}

/** One strand per model and owner, as the roster lists them; the simulated fleet is one labelled strand. */
export const STRANDS: Strand[] = [
  { model: 'Claude Opus 5.5', owner: '@maya-chen' },
  { model: 'Claude Sonnet 5.5', owner: '@maya-chen' },
  { model: 'Claude Fable 5.1', owner: '@lena-park' },
  { model: 'GPT-6 Astra', owner: '@lena-park' },
  { model: 'GPT-6.1 Sol', owner: '@devokafor' },
  { model: 'Gemini 3 Pro', owner: '@devokafor' },
  { model: 'Simulated', owner: '@maya-chen', simulated: true },
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
  { label: '#36', strand: 2, opened: 10, attempts: [{ at: 11, outcome: 'merged' }] },
  { label: '#73', strand: 1, opened: 10, attempts: [{ at: 11, outcome: 'closed', note: 'duplicate of #51' }] },
  { label: '#51', strand: 3, opened: 10, attempts: [{ at: 11, outcome: 'merged' }] },
];

/** Open pull requests in the example, as its Pull requests tab counts them. */
export const OPEN_PULLS = 6;

/* ---------- The close: every pull request main took, in order ---------- */

/** Each merged pull request of the tour and who made it, in the order main took them. */
export const MERGED: { pull: number; by: string; simulated?: true }[] = [
  { pull: 1, by: 'Claude Opus 5.5' },
  { pull: 2, by: 'Claude Fable 5.1' },
  { pull: 3, by: 'Claude Sonnet 5.5' },
  { pull: 4, by: '@maya-chen' },
  { pull: 5, by: 'GPT-6.1 Sol' },
  { pull: 8, by: 'Simulated', simulated: true },
  { pull: 9, by: 'Simulated', simulated: true },
  { pull: 10, by: 'Simulated', simulated: true },
  { pull: 11, by: 'Simulated', simulated: true },
  { pull: 17, by: 'Simulated', simulated: true },
  { pull: 18, by: 'Simulated', simulated: true },
  { pull: 19, by: 'Simulated', simulated: true },
  { pull: 20, by: 'Simulated', simulated: true },
  { pull: 21, by: 'Simulated', simulated: true },
  { pull: 25, by: 'Simulated', simulated: true },
  { pull: 26, by: 'Simulated', simulated: true },
  { pull: 27, by: 'Simulated', simulated: true },
  { pull: 28, by: 'Simulated', simulated: true },
  { pull: 29, by: 'Simulated', simulated: true },
  { pull: 30, by: 'Simulated', simulated: true },
  { pull: 31, by: 'Simulated', simulated: true },
  { pull: 35, by: 'Simulated', simulated: true },
  { pull: 43, by: 'Simulated', simulated: true },
  { pull: 44, by: 'Simulated', simulated: true },
  { pull: 45, by: 'Simulated', simulated: true },
  { pull: 46, by: 'Simulated', simulated: true },
  { pull: 47, by: 'Simulated', simulated: true },
  { pull: 48, by: 'Simulated', simulated: true },
  { pull: 52, by: 'Simulated', simulated: true },
  { pull: 53, by: 'Simulated', simulated: true },
  { pull: 54, by: 'Simulated', simulated: true },
  { pull: 55, by: 'Simulated', simulated: true },
  { pull: 56, by: 'Simulated', simulated: true },
  { pull: 57, by: 'Simulated', simulated: true },
  { pull: 32, by: 'Simulated', simulated: true },
  { pull: 33, by: 'Simulated', simulated: true },
  { pull: 34, by: 'Simulated', simulated: true },
  { pull: 49, by: 'Simulated', simulated: true },
  { pull: 50, by: 'Simulated', simulated: true },
  { pull: 61, by: 'Simulated', simulated: true },
  { pull: 62, by: 'Simulated', simulated: true },
  { pull: 63, by: 'Simulated', simulated: true },
  { pull: 69, by: 'Claude Opus 5.5' },
  { pull: 22, by: 'GPT-6.1 Sol' },
  { pull: 23, by: 'Claude Fable 5.1' },
  { pull: 36, by: 'Claude Fable 5.1' },
  { pull: 51, by: 'GPT-6 Astra' },
];

/* ---------- Two of the app's moments, drawn large: a pull request's proof, and two agents' versions of one file ---------- */

/** #23's proof: the agent's screenshots, captured and cropped to their content, and every command with where it ran. */
export const PROOF = { number: 23, title: 'Add a delivery status page', by: { model: 'Claude Fable 5.1', owner: '@lena-park', tool: 'claude-code/2.4.1' }, captured: [{ viewport: 'desktop', width: 1280, height: 800 }, { viewport: 'phone', width: 390, height: 844 }], tight: [{ viewport: 'desktop', width: 675, height: 305 }, { viewport: 'phone', width: 384, height: 363 }], commands: [{ command: 'npm test', seconds: 10, where: 'agent\'s machine', ok: true }, { command: 'npm ci', seconds: 14.2, where: 'Braid', ok: true }, { command: 'npm run typecheck', seconds: 4.1, where: 'Braid', ok: true }, { command: 'npm test', seconds: 9.8, where: 'Braid', ok: true }], merged: '687e5cc' };

/** The sample task's contested file: each agent's version, by the line that decides what it does past the limit. */
export const OVERLAP = { path: 'src/limits.ts', lanes: [{ model: 'Claude Opus 5.5', owner: '@maya-chen', line: 'await new Promise(resolve => setTimeout(resolve, ((1 - bucket.tokens) / RATE) * 1000));', number: 17 }, { model: 'GPT-6.1 Sol', owner: '@maya-chen', line: 'if (window.count >= LIMIT) throw new RateLimited(host);', number: 19 }] };
