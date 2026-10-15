import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:5173';
let cookie = '';
async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'x-braid-workspace': 'demo', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function until(check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const state = await api('/api/state'); if (check(state)) return state; await new Promise(r => setTimeout(r, 500)); }
  throw new Error('Timed out waiting for the durable state transition.');
}
const state = await api('/api/state');
assert.equal(state.capabilities.mode, 'demo');
const cacheHeaders = { 'x-braid-workspace': 'demo', cookie };
const snapshot = await fetch(`${base}/api/state`, { headers: cacheHeaders });
assert.equal(snapshot.status, 200);
const etag = snapshot.headers.get('etag');
assert.ok(etag, 'Workspace snapshots must provide an ETag.');
await snapshot.arrayBuffer();
const strong = etag.replace(/^W\//, '');
for (const validator of [strong, `W/${strong}`, `"stale", W/${strong}`, '*']) {
  const unchanged = await fetch(`${base}/api/state`, { headers: { ...cacheHeaders, 'if-none-match': validator } });
  assert.equal(unchanged.status, 304, 'Matching validators must reuse the current workspace snapshot.');
  assert.equal(await unchanged.text(), '');
}
const stale = await fetch(`${base}/api/state`, { headers: { ...cacheHeaders, 'if-none-match': '"stale"' } });
assert.equal(stale.status, 200, 'Stale validators must receive the current workspace snapshot.');
await stale.arrayBuffer();
assert.equal(state.missions[0].agents.length, 3);
const mission = state.missions[0];
assert.equal(mission.collisions.length, 1);
const undecided = await api(`/api/missions/${mission.id}/integration`);
assert.equal(undecided.totals.unresolved, 1);
assert.equal(undecided.totals.agreements, 1);
assert.equal(undecided.ready, false);
await api(`/api/missions/${mission.id}/merge`, 'POST', {}, 409);
await api(`/api/missions/${mission.id}/resolve`, 'POST', { collisionId: mission.collisions[0].id, agentId: 'reed', reason: 'Invalid lane' }, 400);
await api(`/api/missions/${mission.id}/resolve`, 'POST', { collisionId: mission.collisions[0].id, agentId: 'sable', reason: 'Fail fast so a busy receiver is never flooded.' });
const reviewed = await api(`/api/missions/${mission.id}/integration`);
assert.equal(reviewed.ready, true);
await api(`/api/missions/${mission.id}/resolve`, 'POST', { collisionId: mission.collisions[0].id, agentId: 'atlas', reason: 'A competing decision made after preview.' });
await api(`/api/missions/${mission.id}/merge`, 'POST', { integrationFingerprint: reviewed.fingerprint }, 409);
assert.equal((await api('/api/state')).missions[0].status, 'review');
await api(`/api/missions/${mission.id}/resolve`, 'POST', { collisionId: mission.collisions[0].id, agentId: 'sable' });
const finalPreview = await api(`/api/missions/${mission.id}/integration`);
const landing = await api(`/api/missions/${mission.id}/merge`, 'POST', { integrationFingerprint: finalPreview.fingerprint }, 202);
// The task's result lands as a change through the example's queue, on the same main as everything else.
assert.ok(landing.change?.number, 'Landing a task must produce a change.');
assert.equal((await api(`/api/changes/${landing.change.number}`)).taskId, mission.id);
const merged = await until(s => s.missions[0].status === 'merged', 30_000);
assert.ok(merged.project.head !== state.project.head);
assert.equal(merged.project.head, (await api('/api/queue')).head);
assert.equal((await api(`/api/changes/${landing.change.number}`)).status, 'landed');
assert.ok(merged.files['src/limits.ts'].includes('class RateLimited'));
assert.ok(merged.files['src/delivery.ts'].includes('await acquire(url);'));
assert.ok(merged.files['docs/receivers.md'].includes('## Rate limits'));
const ledger = JSON.parse(merged.files[`.braid/missions/${mission.id}/decision.json`]);
assert.equal(ledger.resolutions[0].resolution.agentId, 'sable');
assert.equal(ledger.integration.fingerprint, finalPreview.fingerprint);
assert.ok(merged.files[`.braid/missions/${mission.id}/handoff.md`].includes(finalPreview.fingerprint));
const note = await api('/api/context', 'POST', { title: 'Smoke check', body: 'Keep API review decisions persistent.', kind: 'constraint' }, 201);
assert.ok(note.id);
const historic = await api(`/api/missions/${mission.id}/integration`);
assert.equal(historic.fingerprint, finalPreview.fingerprint);
assert.equal(historic.contextAvailable, true);
assert.equal(historic.constraints.some(item => item.id === note.id), false, 'Later context must not rewrite the launch snapshot.');
const next = await api('/api/missions', 'POST', { title: 'Replay the sample task', intent: 'Run the recorded parallel-agent example.' }, 202);
await until(s => s.missions[0].id === next.missionId && s.missions[0].agents.every(a => a.status === 'working'));
await until(s => s.missions[0].status === 'review');
const csrf = await fetch(`${base}/api/context`, { method: 'POST', headers: { cookie, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
assert.equal(csrf.status, 403);
console.log('PASS: conditional reads, persistence, merge gate, exact integration preview, changed-preview rejection, landing through the queue on one main, portable handoff, concurrent replay, and origin protection.');
