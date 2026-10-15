import { afterAll, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { changeHarness } from '../test/changes-harness';
import { fakeGitHub } from '../test/fake-github';
import { BASE_FILES } from '../workspace/seed';
import { agentRoster, hotPaths, listChanges } from './router';
import { submissionShard } from './names';
import { pageCursor, parse } from '../schemas';
import { withInstructions } from '../../shared/instructions-file';
import type { Change, ChangeReview, EvidenceInput, FileBlame, Instruction, Provenance, ProvenanceOwner } from '../../shared/types';
import type { Actor } from './shard';

/**
 * Records the public example: the real change store, policy, merge engine,
 * landing queue and GitHub gate run over the sample Relay project with
 * scripted agents. Regenerate with BRAID_RECORD=1 BRAID_PLAYWRIGHT=<playwright-core/index.mjs>
 * npx vitest run worker/changes/record.test.ts
 */
const recording = process.env.BRAID_RECORD === '1';
let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterAll(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); await harness?.close(); });

/** What an agent shows it ran: scripted, like the agents themselves, and recorded as agent-reported. */
const ran = (command: string, exitCode: number, output: string, durationMs: number): EvidenceInput => ({ kind: 'command', command, exitCode, output, durationMs });
/** Relay's test files as the scripted runs count them; endpoint validation adds its own during the run. */
const DELIVERY: [string, number] = ['test/delivery.test.ts', 24], ENDPOINTS: [string, number] = ['test/endpoints.test.ts', 3];
/** How a passing Vitest run ends in an agent's terminal, skipping some of the first file's tests when the agent filtered them. */
const vitest = (suites: [string, number][], ms: number, skipped = 0) => {
  const total = suites.reduce((sum, [, tests]) => sum + tests, 0);
  return `\n RUN  v3.2.4 /relay\n\n${suites.map(([file, tests], index) => ` ✓ ${file} (${tests} tests${skipped && !index ? ` | ${skipped} skipped` : ''}) ${Math.round(ms * tests / total)}ms`).join('\n')}\n\n Test Files  ${suites.length} passed (${suites.length})\n      Tests  ${total - skipped} passed${skipped ? ` | ${skipped} skipped` : ''} (${total})\n   Duration  ${(ms / 1000 + 0.6).toFixed(2)}s\n`;
};
/**
 * Real screenshots of a page as committed, rendered by Chromium through
 * playwright-core. A recording must keep its proof screenshots.
 */
async function screenshots(html: string, page: string): Promise<EvidenceInput[]> {
  type Tab = { setContent(html: string): Promise<void>; screenshot(options: { type: 'png' }): Promise<Uint8Array>; close(): Promise<void> };
  type Chromium = { launch(): Promise<{ newPage(options: { viewport: { width: number; height: number } }): Promise<Tab>; close(): Promise<void> }> };
  const location = process.env.BRAID_PLAYWRIGHT ?? new URL('../../.cloudflare/tools/node_modules/playwright-core/index.mjs', import.meta.url).pathname;
  const { chromium } = await import(/* @vite-ignore */ location) as { chromium: Chromium };
  const browser = await chromium.launch();
  try {
    const shots: EvidenceInput[] = [];
    for (const [viewport, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]] as const) {
      const tab = await browser.newPage({ viewport: { width, height } });
      await tab.setContent(html);
      shots.push({ kind: 'screenshot', page, viewport, width, height, contentType: 'image/png', data: Buffer.from(await tab.screenshot({ type: 'png' })).toString('base64') });
      await tab.close();
    }
    return shots;
  } finally { await browser.close(); }
}
/** The example's instructions on main from the start; a third is added during the run through the instructions API. */
const INSTRUCTIONS: Instruction[] = [
  { id: 'no-secret-logs', text: 'Never log webhook secrets.', block: ['console.log(secret'], paths: ['src/**'] },
  { id: 'no-em-dashes', text: 'No em dashes in UI copy.', block: ['—'], paths: ['public/**'] },
];
const STATUS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay status</title>
<style>
  body { margin: 0; padding: 40px 20px; background: #0d1117; color: #e6edf3; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  .state { display: inline-block; margin-bottom: 28px; padding: 2px 10px; border-radius: 999px; background: #12361f; color: #56d364; font-size: 13px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 12px 24px; margin: 0; }
  dt { color: #8b949e; }
  dd { margin: 0; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: #161b22; padding: 1px 6px; border-radius: 6px; }
</style>
</head>
<body>
<main>
  <h1>Relay status</h1>
  <span class="state">Delivering webhooks</span>
  <dl>
    <dt>Retries</dt><dd>Up to three attempts with jittered backoff, for network errors, 429 and 5xx responses</dd>
    <dt>Signatures</dt><dd><code>x-relay-signature</code>, HMAC-SHA256 over the exact body</dd>
    <dt>Timeouts</dt><dd>Ten seconds per endpoint unless it sets its own</dd>
    <dt>Duplicates</dt><dd>Every attempt carries the same <code>idempotency-key</code></dd>
  </dl>
</main>
</body>
</html>
`;

const verdicts: Record<string, { verdict: string; risk: string; summary: string; findings?: { path: string; line?: number; severity: string; message: string }[] }> = {
  'Retry network errors and 5xx responses': { verdict: 'approve', risk: 'medium', summary: 'Retries stop after three attempts, never retry 4xx responses other than 429, and reuse the event ID as an idempotency key so receivers can drop duplicates.' },
  'Sign webhook payloads with HMAC-SHA256': { verdict: 'approve', risk: 'medium', summary: 'Signatures cover the exact body that is sent and the secret never reaches logs. Constant-time comparison is the receiver\'s job and is documented.' },
  'Add per-endpoint delivery timeouts': { verdict: 'approve', risk: 'low', summary: 'Timeouts are bounded between one and thirty seconds and default to the previous value.' },
  'Parse Retry-After before retrying': { verdict: 'approve', risk: 'low', summary: 'Honours Retry-After in seconds and caps the wait at sixty seconds.' },
  'Add a health route': { verdict: 'approve', risk: 'low', summary: 'Read-only route with no access to delivery secrets.' },
  'Round refund amounts in the ledger': { verdict: 'escalate', risk: 'high', summary: 'Changes how refunds are rounded. The code is correct, but whether to round half-up or to even is a finance decision.', findings: [{ path: 'src/billing/ledger.ts', line: 4, severity: 'warning', message: 'Rounding mode changes customer-visible refund totals; confirm with finance.' }] },
};

/** The reviewer's verdicts above are scripted like the agents, so the example names no model for them. */
function unnamed(review: ChangeReview): ChangeReview {
  if (!review.reviewer.startsWith('braid-reviewer:')) return review;
  const { model: _model, ...rest } = review;
  return { ...rest, reviewer: 'braid-reviewer' };
}

it.skipIf(!recording)('records the public example', async () => {
  // Number blocks grow for submissions within two seconds of each other. Pin those intervals too, so
  // a busy developer machine cannot renumber the recording. Alarms still run only through the harness.
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = (elapsed: number) => vi.setSystemTime(start + elapsed);
  at(0);
  harness = await changeHarness({
    review: input => {
      const prompt = JSON.stringify(input);
      const title = Object.keys(verdicts).find(candidate => prompt.includes(`Title: ${candidate}`));
      const verdict = title ? verdicts[title] : { verdict: 'approve', risk: 'low', summary: 'The change matches its intent and stays in scope.' };
      return { choices: [{ message: { content: JSON.stringify({ findings: [], ...verdict }) } }] };
    },
    verify: (job, read) => {
      const delivery = read('src/delivery.ts') ?? '';
      const broken = delivery.includes('Number(retryAfter) * 1000 * 1000');
      const tests = DELIVERY[1] + (read(ENDPOINTS[0]) === null ? 0 : ENDPOINTS[1]);
      return { status: broken ? 'failed' : 'passed', checks: [
        { command: 'npm ci', exitCode: 0, durationMs: 14_200, output: 'added 12 packages in 13s', truncated: false, phase: 'install' as const },
        { command: 'npm run typecheck', exitCode: 0, durationMs: 4_100, output: 'tsc --noEmit', truncated: false, phase: 'check' as const },
        { command: 'npm test', exitCode: broken ? 1 : 0, durationMs: 9_800, output: broken ? `FAIL test/delivery.test.ts > waits for Retry-After\n  expected 2000 to be 2 (wait in milliseconds)\nTests: 1 failed, ${tests - 1} passed` : `Tests: ${tests} passed`, truncated: false, phase: 'check' as const },
      ] };
    },
  });
  const github = fakeGitHub({ root: harness.git.root, gitOrigin: harness.git.remote.replace(/\/repo\.git$/, '') });
  Object.assign(harness.env, github.env);
  github.state.reviews = pull => [
    { user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'COMMENTED', body: 'Reviewed the combined change set. No blocking issues; one suggestion on jitter bounds.', commit_id: pull.head, submitted_at: new Date().toISOString() },
    { user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, state: 'COMMENTED', body: 'Copilot reviewed the changed files and generated no comments.', commit_id: pull.head, submitted_at: new Date().toISOString() },
  ];
  github.state.checks = sha => [{ name: 'ci / test', status: 'completed', conclusion: 'success', output: { title: `${DELIVERY[1] + (harness!.git.native(['ls-tree', '--name-only', sha, ENDPOINTS[0]]).trim() ? ENDPOINTS[1] : 0)} tests passed` } }, { name: 'CodeQL', status: 'completed', conclusion: 'success', output: { title: 'No new alerts' } }];
  const policy = { autonomy: 'review', reviewers: 1, duplicates: 'attention',
    rules: [{ paths: ['src/billing/**'], autonomy: 'human', note: 'Refunds and invoices need a person.' }, { paths: ['*.md', 'docs/**'], autonomy: 'auto', reviewers: 0 }, { paths: ['swarm/**'], autonomy: 'review', reviewers: 1 }],
    verify: { install: 'npm ci', checks: ['npm run typecheck', 'npm test'], retries: 1, parallel: 3 }, trust: { newAuthors: 'review', earnedAfter: 2 }, guards: { tests: 'attention' }, github: { reviewers: ['copilot'] } };
  const files = { ...BASE_FILES, 'CHANGELOG.md': '# Changelog\n', 'src/billing/ledger.ts': 'export const refund = (cents: number) => Math.floor(cents);\n',
    'test/delivery.test.ts': "import { deliver } from '../src/delivery';\n\nit('delivers once on success', async () => {});\nit('stops after three attempts', async () => {});\n", '.braid/policy.json': JSON.stringify(policy, null, 2) + '\n',
    '.braid/instructions.json': JSON.stringify({ instructions: INSTRUCTIONS }, null, 2) + '\n', 'AGENTS.md': withInstructions(BASE_FILES['AGENTS.md'], INSTRUCTIONS)! };
  const base = harness.git.commitTree(files, undefined, 'Relay webhook service', { name: 'Maya Chen', email: '5821004+maya-chen@users.noreply.github.com' });
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['--git-dir', github.path, 'fetch', '--quiet', `${harness.git.root}/repo.git`, 'main:main']);
  await harness.trunk.configure(harness.repository, { enabled: true, actor: 'maya@example.test' });
  expect(await harness.trunk.linkGitHub(harness.repository, github.link('pull-requests'))).toMatchObject({ ok: true });
  // Agents are known by their model and the person who owns them, never by an invented name, and people by their
  // GitHub login. Maya's and Dev's commits name them by their no-reply addresses; Braid has no GitHub address for
  // Lena, so hers carry a Braid address.
  const maya: ProvenanceOwner = { id: 'user:maya', name: 'Maya Chen', email: '5821004+maya-chen@users.noreply.github.com', github: 'maya-chen' };
  const dev: ProvenanceOwner = { id: 'user:dev', name: 'Dev Okafor', email: '7730291+devokafor@users.noreply.github.com', github: 'devokafor' };
  const lena: ProvenanceOwner = { id: 'user:lena', name: 'Lena Park', github: 'lena-park' };
  // Commits keep the co-author lines their tools wrote and Braid adds none: Maya leaves Claude Code's on, Lena turned it off.
  type Agent = Actor & { tool: string; coAuthors?: string[] };
  const agent = (id: string, model: string, owner: ProvenanceOwner, tool: string, coAuthors?: string[]): Agent => ({ kind: 'agent', id: `agent:${id}`, name: id, model, owner, tool, ...(coAuthors ? { coAuthors } : {}) });
  /** Each submission is one run of the agent's tool, with its own session. */
  let runs = 0, submissions = 0;
  const run = (who: Agent, parentSession?: string) => ({ tool: who.tool, session: `s_${(0x3a7f1 + ++runs * 7919).toString(16)}`, ...(parentSession ? { parentSession } : {}) });
  // Reserve the original request key and agent session before changing submission order. The key picks the
  // shard (and its number block), so the documentation's pull request numbers remain stable.
  const submission = (who: Agent, title: string, summary: string, edits: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const key = `test-request-key-${++submissions}-padding`, shard = submissionShard(`${who.id}:${key}`);
    const input = { title, summary, intent: summary, baseCommit: harness!.head(), files: Object.entries(edits).map(([path, content]) => ({ path, content })), agent: run(who),
      ...(who.coAuthors ? { coAuthors: who.coAuthors } : {}), ...extra };
    return async () => {
      const result = await harness!.shard(shard).submit(harness!.context(who, shard), input, key);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };
  };
  const submit = (...args: Parameters<typeof submission>) => submission(...args)();
  const delivery = BASE_FILES['src/delivery.ts'];
  const wake = async (rounds = 2) => {
    for (let round = 0; round < rounds; round++) {
      vi.setSystemTime(Date.now() + 10);
      await harness!.trunk.githubEvent(harness!.repository, { name: 'check_suite', sha: (await harness!.trunk.status(harness!.repository)).landing?.head });
      await harness!.settle(1);
    }
  };

  const opus = agent('maya-claude-code', 'claude-opus-5-5', maya, 'claude-code/2.4.1', ['Claude Opus 5.5 <noreply@anthropic.com>']), sol = agent('dev-codex', 'gpt-6.1-sol', dev, 'codex/1.8.0');
  const fable = agent('lena-claude-code', 'claude-fable-5-1', lena, 'claude-code/2.4.1'), gemini = agent('dev-gemini', 'gemini-3-pro', dev, 'gemini-cli/0.9.2');
  const sonnet = agent('maya-cursor', 'claude-sonnet-5-5', maya, 'cursor/1.7.3'), astra = agent('lena-codex', 'gpt-6-astra', lena, 'codex/1.8.0');
  await submit(opus, 'Retry network errors and 5xx responses', 'Retries failed deliveries up to three times with jittered exponential backoff. Client errors other than 429 are never retried.', {
    'src/delivery.ts': delivery.replace('export async function deliver(\n  url: string,\n  body: string,\n): Promise<DeliveryResult> {\n  const response = await fetch(url, {\n    method: \'POST\',\n    headers: { \'content-type\': \'application/json\' },\n    body,\n  });\n  return { ok: response.ok, status: response.status, attempts: 1 };\n}',
      'export async function deliver(\n  url: string,\n  body: string,\n): Promise<DeliveryResult> {\n  let status = 0;\n  for (let attempt = 1; attempt <= 3; attempt++) {\n    try {\n      const response = await fetch(url, {\n        method: \'POST\',\n        headers: { \'content-type\': \'application/json\' },\n        body,\n      });\n      status = response.status;\n      if (response.ok || (status < 500 && status !== 429)) return { ok: response.ok, status, attempts: attempt };\n    } catch { status = 0; }\n    await new Promise(resolve => setTimeout(resolve, Math.random() * 250 * 2 ** attempt));\n  }\n  return { ok: false, status, attempts: 3 };\n}'),
    'CHANGELOG.md': '# Changelog\n- Retry network errors and 5xx responses.\n',
  }, { evidence: [ran('npm test', 0, vitest([DELIVERY], 812), 9_412)] });
  await submit(fable, 'Document the receiver contract', 'Explains signature verification, retries and idempotency for teams receiving Relay webhooks, and links the guide from the README.', {
    'docs/receivers.md': '# Receiving Relay webhooks\n\nVerify `x-relay-signature` with HMAC-SHA256 over the raw body. Deliveries may repeat; use `idempotency-key` to drop duplicates. Respond with 2xx within ten seconds.\n',
    'README.md': BASE_FILES['README.md'].replace('Delivery currently makes one attempt.\n', 'Delivery currently makes one attempt.\n\n## Receivers\n\nTeams receiving Relay webhooks should read [the receiver contract](docs/receivers.md): how to verify signatures and drop duplicate deliveries.\n'),
  });
  await submit(sonnet, 'Add a health route', 'Adds GET /health so load balancers can check Relay without sending a webhook.', {
    'src/index.ts': BASE_FILES['src/index.ts'].replace("    if (request.method !== 'POST') {", "    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true });\n    if (request.method !== 'POST') {"),
    'CHANGELOG.md': '# Changelog\n- Add a health route.\n',
  }, { evidence: [ran('npm test', 0, vitest([DELIVERY], 640), 7_903)] });
  await harness.settle(2);
  await wake(3);
  // The owner writes down the rule the retry change followed, once, for every agent: a change of its own that lands like any other.
  at(900);
  const person = { kind: 'owner' as const, id: 'user:maya', name: 'Maya Chen', owner: maya }, instructKey = 'record-instruction-retries-0001', instructShard = submissionShard(`${person.id}:${instructKey}`);
  expect(await harness.shard(instructShard).instruct(harness.context(person, instructShard), { add: { text: 'Retries back off; never retry 4xx except 429.', paths: ['src/**'] } }, instructKey)).toMatchObject({ ok: true });
  await wake(2);

  at(1500);
  await submit(sol, 'Sign webhook payloads with HMAC-SHA256', 'Adds an x-relay-signature header computed over the exact body, so receivers can verify that a delivery came from Relay.', {
    'src/signature.ts': "export async function sign(body: string, secret: string): Promise<string> {\n  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);\n  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));\n  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');\n}\n",
    'src/delivery.ts': harness.git.native(['show', 'main:src/delivery.ts']).replace("import { sign } from './signature';\n", '').replace('export interface DeliveryResult', "import { sign } from './signature';\n\nexport interface DeliveryResult")
      .replace("        headers: { 'content-type': 'application/json' },", "        headers: { 'content-type': 'application/json', 'x-relay-signature': await sign(body, secret) },").replace('  body: string,\n): Promise', '  body: string,\n  secret: string,\n): Promise'),
    'CHANGELOG.md': `${harness.git.native(['show', 'main:CHANGELOG.md'])}- Sign webhook payloads.\n`,
  }, { evidence: [ran('npm run typecheck', 0, '\n> relay-webhooks@0.1.0 typecheck\n> tsc --noEmit\n', 4_118), ran('npm test', 0, vitest([DELIVERY], 935), 10_244)] });
  // Gemini 3 Pro edits the same request options from an older trunk: the queue will send it back to rebase.
  const geminiBase = base;
  await submit(gemini, 'Add per-endpoint delivery timeouts', 'Aborts slow receivers after a configurable timeout so retries are not stuck behind one endpoint.', {
    'src/delivery.ts': delivery.replace("    headers: { 'content-type': 'application/json' },\n    body,", "    headers: { 'content-type': 'application/json' },\n    body,\n    signal: AbortSignal.timeout(10_000),").replace('  body,\n  });\n  return', '  body,\n    signal: AbortSignal.timeout(10_000),\n  });\n  return'),
  }, { baseCommit: geminiBase, evidence: [ran('npm test', 0, vitest([DELIVERY], 701), 8_120)] });
  await submit(astra, 'Round refund amounts in the ledger', 'Rounds refunds half-up instead of truncating, so partial refunds no longer lose a cent.', {
    'src/billing/ledger.ts': 'export const refund = (cents: number) => Math.round(cents);\n',
  }, { evidence: [ran('npm test', 0, vitest([DELIVERY], 655), 7_480)] });
  // The simulated run's id and seed are pinned, so its agents land on the same shards and make the same edits each
  // time this is recorded, and the changes keep their numbers.
  const pinned = [vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T12:00:00Z')), vi.spyOn(Math, 'random').mockReturnValue(0.5)];
  const started = await harness.swarm.start(harness.repository, { agents: 36, scenario: 'mixed' }, 'Maya Chen', maya);
  for (const spy of pinned) spy.mockRestore();
  at(2100);
  expect(started.ok).toBe(true);
  for (let round = 0; round < 40 && (await harness.swarm.status())?.status !== 'finished'; round++) await wake(1);
  await wake(4);
  at(3900);
  // A flawed change fails the repository's tests on the combined trunk and is sent back with the output.
  const retryAfter = (wait: string) => harness!.git.native(['show', 'main:src/delivery.ts']).replace('    } catch { status = 0; }', `      const retryAfter = response.headers.get('retry-after');\n      if (retryAfter) await new Promise(resolve => setTimeout(resolve, ${wait}));\n    } catch { status = 0; }`);
  // Claude Opus 5.5's own run passes because it ran only the retry tests; Braid's checks on the combined result run them all.
  const flawed = await submit(opus, 'Parse Retry-After before retrying', 'Waits for the receiver\'s Retry-After value before retrying a 429 or 503.', {
    'src/delivery.ts': retryAfter('Number(retryAfter) * 1000 * 1000'),
  }, { evidence: [ran('npm test -- -t retries', 0, vitest([DELIVERY], 1_204, 18), 6_031)] });
  for (let round = 0; round < 8; round++) await wake(1);
  // Claude Opus 5.5 fixes what the tests caught; a reviewer can read just that fix as the change since revision 1.
  const flawedShard = parseInt(flawed.id[3], 16);
  // A subagent of the first run makes the fix, so the revision names its orchestrator's session.
  expect(await harness.shard(flawedShard).revise(harness.context(opus, flawedShard), flawed.id, { summary: 'Converts Retry-After seconds to milliseconds once and caps the wait at sixty seconds.', agent: run(opus, flawed.author.session), coAuthors: opus.coAuthors,
    baseCommit: harness.head(), previousRevision: 1, files: [{ path: 'src/delivery.ts', content: retryAfter('Math.min(Number(retryAfter), 60) * 1000') }], evidence: [ran('npm test', 0, vitest([DELIVERY], 1_310), 12_402)] }, 'record-retry-after-revision-2')).toMatchObject({ ok: true });
  for (let round = 0; round < 8; round++) await wake(1);
  // An agent stuck on a failing test skips it; the guard hands that to a person.
  at(5000);
  await submit(gemini, 'Stabilise delivery tests', 'Makes the delivery suite pass on slow runners.', {
    'test/delivery.test.ts': "import { deliver } from '../src/delivery';\n\nit('delivers once on success', async () => {});\nit.skip('stops after three attempts', async () => {});\n",
  }, { evidence: [ran('npm test', 0, vitest([DELIVERY], 598, 1), 6_870)] });
  // A failing run the agent reported sends its change straight back; the fix lands with a passing one.
  const endpoints = (scheme: string) => `/** Deliveries go only to HTTPS endpoints on public hosts. */\nexport function validEndpoint(url: string): boolean {\n  if (!URL.canParse(url)) return false;\n  const { protocol, hostname } = new URL(url);\n  return protocol === '${scheme}' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname);\n}\n`;
  const endpointTest = "import { validEndpoint } from '../src/endpoints';\n\nit('accepts https endpoints', () => expect(validEndpoint('https://hooks.acme.dev/relay')).toBe(true));\nit('rejects http endpoints', () => expect(validEndpoint('http://hooks.acme.dev/relay')).toBe(false));\nit('rejects localhost', () => expect(validEndpoint('https://localhost/relay')).toBe(false));\n";
  const validation = await submit(sol, 'Validate endpoint URLs before delivering', 'Refuses endpoints that are not HTTPS on a public host.', { 'src/endpoints.ts': endpoints('https'), 'test/endpoints.test.ts': endpointTest }, {
    evidence: [ran('npm test', 1, `\n RUN  v3.2.4 /relay\n\n ❯ test/endpoints.test.ts (3 tests | 1 failed) 12ms\n   × accepts https endpoints 4ms\n     → expected false to be true // Object.is equality\n ✓ test/delivery.test.ts (24 tests) 731ms\n\n FAIL  test/endpoints.test.ts > accepts https endpoints\nAssertionError: expected false to be true // Object.is equality\n ❯ test/endpoints.test.ts:3:85\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 26 passed (27)\n   Duration  1.62s\n`, 9_877)] });
  expect(validation).toMatchObject({ status: 'revise', next: 'Failed: npm test' });
  const validationShard = parseInt(validation.id[3], 16);
  expect(await harness.shard(validationShard).revise(harness.context(sol, validationShard), validation.id, { summary: 'Compares the protocol with its trailing colon, as URL reports it.', agent: run(sol),
    baseCommit: harness.head(), previousRevision: 1, files: [{ path: 'src/endpoints.ts', content: endpoints('https:') }, { path: 'test/endpoints.test.ts', content: endpointTest }],
    evidence: [ran('npm test', 0, vitest([ENDPOINTS, DELIVERY], 1_118), 10_112)] }, 'record-endpoints-revision-2')).toMatchObject({ ok: true });
  // A page that changes comes with what it looks like: screenshots Chromium rendered from the committed file.
  await submit(fable, 'Add a delivery status page', 'Adds a static status page that says how Relay delivers, retries and signs webhooks.', { 'public/status.html': STATUS_PAGE }, {
    evidence: [...await screenshots(STATUS_PAGE, '/status.html'), ran('npm test', 0, vitest([DELIVERY], 1_096), 9_950)] });
  for (let round = 0; round < 6; round++) await wake(1);
  // Code security: a committed credential and a vulnerable dependency go back to their authors.
  // OSV.dev answers are scripted stand-ins in the recording, like the reviewer and the checks.
  const previous = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.osv.dev/v1/querybatch') {
      const { queries } = JSON.parse(String(init!.body)) as { queries: { package: { name: string }; version: string }[] };
      return Promise.resolve(Response.json({ results: queries.map(query => ({ vulns: query.package.name === 'lodash' && query.version === '4.17.20' ? [{ id: 'GHSA-35jh-r3h4-6jhm' }] : [] })) }));
    }
    if (url.startsWith('https://api.osv.dev/v1/vulns/')) return Promise.resolve(Response.json({ id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command Injection in lodash', database_specific: { severity: 'HIGH' } }));
    return previous(input, init);
  });
  await submit(sonnet, 'Configure the delivery client', 'Adds the client configuration for the staging relay.', {
    'src/client.ts': `export const relayToken = '${['braid', '_agent_', 's'.repeat(40)].join('')}';\n`,
  });
  const manifest = JSON.parse(BASE_FILES['package.json']) as Record<string, unknown>;
  await submit(astra, 'Use lodash for retry jitter', 'Replaces the hand-written jitter with lodash.random.', {
    'package.json': JSON.stringify({ ...manifest, dependencies: { lodash: '4.17.20' } }, null, 2) + '\n',
  }, { evidence: [ran('npm test', 0, vitest([DELIVERY, ENDPOINTS], 1_133), 10_481)] });
  // Two agents set out to do the same thing. Reserve Sonnet's request now, but let Astra submit first.
  const submitDuplicate = submission(sonnet, 'Add structured delivery logging', 'Logs each delivery attempt with host, attempt number and status, never the body or secret.', { 'src/logging.ts': "export const log = (event: object) => console.log(JSON.stringify(event));\n" }, { intent: 'Log each delivery attempt with host, attempt number and status.', evidence: [ran('npm test', 0, vitest([DELIVERY, ENDPOINTS], 1_002), 9_210)] });
  // An instruction given once catches the agent that forgets it.
  await submit(gemini, 'Log signature mismatches', 'Logs the secret and both signatures when a delivery fails verification, to debug receivers.', {
    'src/verify.ts': "import { sign } from './signature';\n\n/** Whether a delivery's signature matches its body. */\nexport async function verify(body: string, signature: string, secret: string): Promise<boolean> {\n  const expected = await sign(body, secret);\n  if (expected !== signature) console.log(secret, signature, expected);\n  return expected === signature;\n}\n",
  }, { evidence: [ran('npm test', 0, vitest([DELIVERY, ENDPOINTS], 1_021), 9_334)] });
  const logging = await submit(astra, 'Add structured delivery logging', 'Logs each delivery attempt with host, attempt number and status, never the body or secret.', { 'src/log.ts': "export const logAttempt = (url: string, attempt: number, status: number) => console.log(JSON.stringify({ event: 'delivery', host: new URL(url).host, attempt, status }));\n" }, { intent: 'Log each delivery attempt with host, attempt number and status.', evidence: [ran('npm test', 0, vitest([DELIVERY, ENDPOINTS], 1_045), 9_288)] });
  const duplicate = await submitDuplicate();
  expect(logging.number).toBe(51);
  expect(duplicate).toMatchObject({ number: 73, status: 'attention', duplicates: [{ changeId: logging.id, number: 51 }],
    policy: { requirements: expect.arrayContaining([expect.objectContaining({ id: 'duplicate', satisfied: false })]) } });
  const duplicateShard = parseInt(duplicate.id[3], 16), owner = harness.context(person, duplicateShard);
  expect(await harness.shard(duplicateShard).comment(owner, duplicate.id, { revision: duplicate.revision, body: 'Duplicate of #51. Keep the version with explicit host, attempt and status fields.' }, 'record-close-duplicate-comment')).toMatchObject({ ok: true });
  expect(await harness.shard(duplicateShard).close(owner, duplicate.id, { reason: 'superseded' })).toMatchObject({ ok: true, data: { status: 'closed', closeReason: 'superseded' } });
  const readme = harness.git.native(['show', 'main:README.md']).replace(' Delivery currently makes one attempt.', '');
  await submit(fable, 'Explain retry timing in the README', 'Documents the retry schedule and the Retry-After behaviour.', { 'README.md': `${readme}\n## Retries\n\nRelay retries 5xx and network errors up to three times with jittered backoff.\n` });
  // Finish the final group through the sandbox workflow stand-in and fakeGitHub, exactly as earlier merges.
  // No unfinished group is handed to the visitor's copy to land without its recorded checks.
  await wake(8);

  const page = await listChanges(harness.env, harness.repository, { limit: 100 });
  const more = page.nextCursor ? await listChanges(harness.env, harness.repository, { limit: 100, before: parse(pageCursor, page.nextCursor) }) : { items: [] };
  const summaries = [...page.items, ...more.items];
  const changes: Change[] = [];
  const diffs: Record<string, { before: string | null; after: string | null }> = {};
  const images: Record<string, string> = {};
  for (const summary of summaries) {
    const shard = parseInt(summary.id[3], 16);
    const result = await harness.shard(shard).get(summary.id);
    if (!result.ok) continue;
    changes.push({ ...result.data, reviews: result.data.reviews.map(unnamed) });
    for (const item of result.data.evidence ?? []) if (item.kind === 'screenshot') {
      const image = await harness.shard(shard).image(summary.id, item.image);
      if (image.ok) images[item.image] = Buffer.from(image.data.bytes).toString('base64');
    }
    // Every revision's files, so the example can show what changed since an earlier one.
    for (let revision = 1; revision <= result.data.revision; revision++) for (const file of result.data.files) {
      const diff = await harness.shard(shard).diff(harness.repository, summary.id, file.path, revision);
      if (diff.ok) diffs[`${summary.id}:${revision}:${file.path}`] = { before: diff.data.before, after: diff.data.after };
    }
  }
  // The example's repository is main as the recording left it, so Code, Changes and the sample task share one history.
  const cited = [
    [1, 'Retry network errors and 5xx responses', 'Claude Opus 5.5', 'landed'],
    [5, 'Sign webhook payloads with HMAC-SHA256', 'GPT-6.1 Sol', 'landed'],
    [6, 'Add per-endpoint delivery timeouts', 'Gemini 3 Pro', 'revise'],
    [7, 'Round refund amounts in the ledger', 'GPT-6 Astra', 'attention'],
    [8, 'Prepare shared files for simulated agents', 'Simulated setup', 'landed'],
    [12, 'Log signature mismatches', 'Gemini 3 Pro', 'revise'],
    [22, 'Validate endpoint URLs before delivering', 'GPT-6.1 Sol', 'landed'],
    [23, 'Add a delivery status page', 'Claude Fable 5.1', 'landed'],
    [36, 'Explain retry timing in the README', 'Claude Fable 5.1', 'landed'],
    [51, 'Add structured delivery logging', 'GPT-6 Astra', 'landed'],
    [69, 'Parse Retry-After before retrying', 'Claude Opus 5.5', 'landed'],
    [70, 'Stabilise delivery tests', 'Gemini 3 Pro', 'attention'],
    [73, 'Add structured delivery logging', 'Claude Sonnet 5.5', 'closed'],
  ];
  for (const [number, title, author, status] of cited) expect(changes.find(change => change.number === number)).toMatchObject({ number, title, author: { name: author }, status });
  // Re-recording copy must preserve every existing pull request's identity and outcome.
  const previousRecording = JSON.parse(readFileSync(new URL('./recorded.json', import.meta.url), 'utf8')) as { changes: Change[] };
  // #8's wording changes without changing its number, author or outcome.
  const previousChanges = previousRecording.changes.map(change => change.number === 8 && change.title === 'Prepare the swarm workspace'
    ? { ...change, title: 'Prepare shared files for simulated agents' } : change);
  const identities = (items: Change[]) => items.map(({ number, title, author, status }) => ({ number, title, author, status })).sort((a, b) => a.number - b.number);
  expect(identities(changes)).toEqual(identities(previousChanges));
  const queue = await harness.trunk.status(harness.repository);
  expect(queue).toMatchObject({ queued: 0, merging: [] });
  expect(queue.landing).toBeUndefined();
  expect(queue.verifying ?? []).toEqual([]);
  for (const number of [36, 51]) {
    const change = changes.find(change => change.number === number)!;
    expect(change.status).toBe('landed');
    expect(change.policy!.requirements.every(requirement => requirement.satisfied)).toBe(true);
    expect(change.checks).toEqual(expect.arrayContaining(['npm ci', 'npm run typecheck', 'npm test'].map(label =>
      expect.objectContaining({ label, status: 'passed', source: 'braid', revision: change.revision }))));
    expect(change.checks).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'github', status: 'passed' })]));
    expect(change.reviews.map(review => review.reviewer)).toEqual(expect.arrayContaining(['github:coderabbitai[bot]', 'github:copilot-pull-request-reviewer[bot]']));
  }
  expect(harness.verifiedJobs).toEqual(expect.arrayContaining([expect.objectContaining({ commit: queue.head, install: 'npm ci', checks: ['npm run typecheck', 'npm test'] })]));
  const shots = changes.find(change => change.number === 23)!.evidence!.filter(item => item.kind === 'screenshot');
  expect(shots.map(shot => shot.viewport)).toEqual(['desktop', 'mobile']);
  for (const shot of shots) expect(Buffer.from(images[shot.image], 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const mainFiles: Record<string, string> = {};
  for (const path of harness.git.native(['ls-tree', '-r', '--name-only', queue.head]).trim().split('\n')) {
    const text = harness.git.native(['show', `${queue.head}:${path}`]);
    if (!text.includes('\u0000') && text.length <= 40_000) mainFiles[path] = text;
  }
  expect(mainFiles['src/log.ts']).toContain('logAttempt');
  expect(mainFiles['src/logging.ts']).toBeUndefined();
  expect(mainFiles['README.md']).not.toContain('Delivery currently makes one attempt.');
  expect(mainFiles['README.md']).toContain('Relay retries 5xx and network errors up to three times with jittered backoff.');
  // Keep the open refund proposal as a real Git branch, based on the completed main. It touches only the
  // ledger, which has not changed since the proposal opened. Branches and Compare read this pinned tree.
  const refund = changes.find(change => change.number === 7)!;
  const branchFiles = { ...mainFiles };
  for (const file of refund.files) {
    const diff = diffs[`${refund.id}:${refund.revision}:${file.path}`];
    expect(branchFiles[file.path] ?? null).toBe(diff.before);
    if (diff.after === null) delete branchFiles[file.path]; else branchFiles[file.path] = diff.after;
  }
  const branchName = 'refund-rounding';
  const loggingCommit = (await harness.git.repository.readCommit(changes.find(change => change.number === 51)!.landedCommit!))!;
  const branchHead = harness.git.commitTree(branchFiles, queue.head, `${refund.title}\n\n${refund.summary}`, loggingCommit.author);
  harness.git.native(['update-ref', `refs/heads/${branchName}`, branchHead]);
  const branchCommit = (await harness.git.repository.readCommit(branchHead))!;
  const branches = [{ name: branchName, base: queue.head, changeId: refund.id, tip: { hash: branchHead, title: refund.title, time: new Date(branchCommit.authoredAt * 1000).toISOString(), author: refund.author }, files: branchFiles }];
  // Who wrote each line of every text file on main, who made each commit in it, and the roster. Ranges name their
  // commit, whose provenance is kept once.
  const blames: FileBlame[] = [];
  for (const path of Object.keys(mainFiles)) {
    const result = await harness.trunk.blame(harness.repository, path);
    if (result.ok) blames.push(result.data);
  }
  const blame = Object.fromEntries(blames.map(({ ranges, ...file }) => [file.path, { ...file, ranges: ranges.map(range => [range.start, range.lines, range.provenance.commit] as const) }]));
  expect(Object.keys(blame)).toEqual(expect.arrayContaining(['src/delivery.ts', 'README.md']));
  // Landed commits keep the change's message and only the co-author lines its commits carried: Maya's Claude Code runs keep Claude Code's.
  for (const change of changes.filter(change => change.landedCommit && change.author.kind === 'agent'))
    expect(harness.git.native(['log', '-1', '--format=%B', change.landedCommit!]).trimEnd())
      .toBe(`${change.title}\n\n${change.summary}${change.author.id === opus.id ? '\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>' : ''}`);
  const commits = [...new Set([...blames.flatMap(file => file.ranges.map(range => range.provenance.commit)), ...changes.flatMap(change => change.landedCommit ? [change.landedCommit] : [])])];
  const provenance: Provenance[] = [];
  for (let start = 0; start < commits.length; start += 100) provenance.push(...await harness.trunk.provenance(harness.repository, commits.slice(start, start + 100)));
  const agents = await agentRoster(harness.env, harness.repository);
  expect(new Set(blames.find(file => file.path === 'src/delivery.ts')!.ranges.map(range => range.provenance.agent?.name)).size).toBeGreaterThan(2);
  const recorded = {
    recordedAt: new Date().toISOString(),
    note: 'Recorded run of Braid\'s change store, policy, merge engine, landing queue and GitHub gate. Agent edits, reviewer verdicts, check results, the command runs agents report and intent similarity are scripted stand-ins; the screenshots are Chromium\'s renders of the committed status page; merging, policy, instruction checks, verification gating and landing are the real engine. Commit IDs are from the recording repository.',
    changes, diffs, images, queue, hot: await hotPaths(harness.env, harness.repository),
    policy: await harness.trunk.policy(harness.repository), instructions: await harness.trunk.instructions(harness.repository), swarm: await harness.swarm.status(),
    blame, provenance, agents, branches,
  };
  // Main is small and seeds every example workspace; the recording loads only when the example is opened.
  // BRAID_RECORD_TO writes a trial recording elsewhere, leaving the example as it is.
  const output = (name: string) => process.env.BRAID_RECORD_TO ? `${process.env.BRAID_RECORD_TO}/${name}` : new URL(`./${name}`, import.meta.url);
  writeFileSync(output('recorded-main.json'), JSON.stringify({ head: queue.head, files: mainFiles }));
  writeFileSync(output('recorded.json'), JSON.stringify(recorded));
  expect(changes.length).toBeGreaterThan(40);
}, 600_000);
