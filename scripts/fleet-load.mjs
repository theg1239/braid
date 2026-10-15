#!/usr/bin/env node
/**
 * Drives a deployed Braid repository through its public API the way a fleet of
 * agents would: one fleet connection, a short-lived identity per agent, trunk
 * checkouts, concurrent submissions to the same files, rebases when a change is
 * sent back, and waiting for each change to land. Writes measured evidence.
 *
 *   BRAID_FLEET_TOKEN=braid_agent_... node scripts/fleet-load.mjs https://braid.example --workspace ID --agents 200 --concurrency 40
 *
 * Use a dedicated repository with landing on and a policy that lets these
 * synthetic changes land unattended, for example
 *   {"rules":[{"paths":["loadtest/**"],"autonomy":"auto","reviewers":0}],"trust":{"earnedAfter":0}}
 * Otherwise every new agent identity waits for a review. Never run it against
 * a repository whose trunk you do not want to receive these commits.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; };
const origin = new URL(args[0] ?? '').origin;
const workspace = option('workspace');
const agents = Number(option('agents', 50)), concurrency = Number(option('concurrency', 20)), timeout = Number(option('timeout', 900)) * 1000;
const fleetToken = process.env.BRAID_FLEET_TOKEN;
if (!fleetToken?.startsWith('braid_agent_') || !workspace) throw new Error('Set BRAID_FLEET_TOKEN to a fleet connection and pass --workspace ID.');
const runId = `load${Date.now().toString(36)}`;

const timings = { session: [], checkout: [], submit: [], land: [] };
const counts = { submitted: 0, revisions: 0, landed: 0, sentBack: 0, attention: 0, closed: 0, errors: 0, throttled: 0 };
const errors = new Map();
const note = (kind, detail) => { counts.errors++; errors.set(`${kind}: ${detail}`, (errors.get(`${kind}: ${detail}`) ?? 0) + 1); };

async function call(method, path, token, body, key) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const started = performance.now();
    const response = await fetch(`${origin}${path}`, { method, redirect: 'error', headers: { authorization: `Bearer ${token}`, 'x-braid-workspace': workspace, origin, ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) }).catch(error => ({ ok: false, status: 0, error }));
    if (response.status === 429 || response.status >= 500 || response.status === 0) {
      if (response.status === 429) counts.throttled++;
      await sleep(Math.min(10_000, 500 * 2 ** attempt + Math.random() * 500));
      continue;
    }
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data, ms: performance.now() - started };
  }
  return { ok: false, status: 503, data: {}, ms: 0 };
}

async function read(token, path, ref) {
  const result = await call('GET', `/api/repository?path=${encodeURIComponent(path)}&ref=${ref}`, token);
  return result.ok && result.data.kind !== 'binary' ? result.data.content : null;
}

/** One agent: add its own module and register it in shared files, as concurrent agents do in real repositories. */
async function agent(index) {
  const name = `agent-${String(index).padStart(5, '0')}`;
  const session = await call('POST', '/api/agent/session', fleetToken, { name: `${runId}-${name}`, model: 'load-test' });
  if (!session.ok) return note('session', session.status);
  timings.session.push(session.ms);
  const token = session.data.accessToken;
  const started = performance.now();
  let change, attempt = 0;
  while (performance.now() - started < timeout && attempt < 20) {
    const checkout = await call('POST', '/api/changes/checkout', token, {});
    if (!checkout.ok) return note('checkout', checkout.status);
    timings.checkout.push(checkout.ms);
    const head = checkout.data.head;
    const registry = await read(token, 'loadtest/registry.md', head) ?? '# Load test registry\n';
    const files = [
      { path: `loadtest/${runId}/${name}.md`, content: `# ${name}\n\nWritten by a synthetic load-test agent.\n` },
      { path: 'loadtest/registry.md', content: `${registry}- ${runId}/${name}\n` },
    ];
    const body = { title: `Load test ${name}`, summary: `Registers ${name} for run ${runId}.`, baseCommit: head, files, ...(change ? { previousRevision: change.revision } : {}) };
    const submitted = change
      ? await call('POST', `/api/changes/${change.id}/revisions`, token, body, `${runId}-${name}-r${attempt}`)
      : await call('POST', '/api/changes', token, body, `${runId}-${name}-submit`);
    if (!submitted.ok) return note('submit', `${submitted.status} ${submitted.data.error ?? ''}`.trim());
    timings.submit.push(submitted.ms);
    if (change) counts.revisions++; else counts.submitted++;
    change = submitted.data;
    for (let delay = 2000; performance.now() - started < timeout; delay = Math.min(15_000, delay * 1.4)) {
      await sleep(delay);
      const status = await call('GET', `/api/changes/${change.id}`, token);
      if (!status.ok) continue;
      change = status.data;
      if (change.status === 'landed') { counts.landed++; timings.land.push(performance.now() - started); return; }
      if (change.status === 'attention') { counts.attention++; return; }
      if (change.status === 'closed') { counts.closed++; return; }
      if (change.status === 'revise') { counts.sentBack++; break; }
    }
    attempt++;
  }
}

const percentile = (values, p) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]); };
const begin = Date.now();
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, agents) }, async () => { while (next < agents) await agent(next++); }));
const minutes = (Date.now() - begin) / 60_000;
const evidence = {
  runId, origin, workspace, agents, concurrency, startedAt: new Date(begin).toISOString(), durationSeconds: Math.round(minutes * 60), counts,
  throughput: { landedPerMinute: Math.round(counts.landed / minutes * 10) / 10 },
  latencyMs: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, { p50: percentile(values, 0.5), p95: percentile(values, 0.95), n: values.length }])),
  errors: Object.fromEntries(errors),
  note: 'Synthetic agents through the public API. Edits are generated; authentication, change storage, policy, merging and landing are the deployed system.',
};
mkdirSync('.cloudflare', { recursive: true });
writeFileSync(`.cloudflare/fleet-load-${runId}.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
