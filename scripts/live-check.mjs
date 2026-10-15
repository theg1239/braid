import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';

const args = process.argv.slice(2), target = new URL(args[0]);
if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
  throw new Error('Pass the HTTPS origin of an isolated owner-key validation Worker.');
const base = target.origin, secretIndex = args.indexOf('--secrets-file');
const secretPath = secretIndex < 0 ? '.dev.vars' : args[secretIndex + 1];
if (!secretPath) throw new Error('Provide a path after --secrets-file.');
const key = parseEnv(readFileSync(secretPath, 'utf8')).ADMIN_TOKEN;
if (!key) throw new Error('The private validation secrets file must contain ADMIN_TOKEN.');
let cookie = '';
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method, redirect: 'error', headers: { cookie, ...(body ? { origin: base, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${result.error || response.status}`);
  return result;
}
await api('/api/session', 'POST', { token: key });
let state = await api('/api/state');
assert.equal(state.capabilities.mode, 'live');
assert.equal(state.capabilities.ai, true, 'Configure the sandbox image and Workers AI first.');
if (!state.project.id) {
  await api('/api/project', 'POST', { name: 'sandbox-release-check', description: 'Disposable hosted sandbox verification' });
  state = await api('/api/state');
}
if (state.project.name !== 'sandbox-release-check') throw new Error('The validation workspace contains a different project. Leaving it intact.');
const title = 'Verify sandbox execution';
let mission = state.missions.find(m => m.title === title && m.execution === 'cloud' && m.status === 'running');
if (!mission) {
  const { missionId } = await api('/api/missions', 'POST', { title, execution: 'cloud', agentCount: 1,
    intent: 'Read AGENTS.md and the repository. Add only sandbox-verification.txt containing Full repository sandbox verified. followed by a newline. Verify the file with a Node assertion and run git diff --check, marking both commands as checks. Do not install dependencies or change application code for this release smoke task. Submit the actual one-file change and describe the commands you ran.' });
  mission = { id: missionId };
}
console.log(`Hosted sandbox task ${mission.id}`);
let last = '';
const deadline = Date.now() + 30 * 60_000;
while (Date.now() < deadline) {
  state = await api('/api/state');
  const current = state.missions.find(m => m.id === mission.id);
  const status = current.agents.map(a => `${a.name}: ${a.status}${a.progress?.message ? ` · ${a.progress.message}` : ''}`).join(' · ');
  if (status !== last) { console.log(status); last = status; }
  if (current.status !== 'running') {
    mkdirSync('.cloudflare', { recursive: true, mode: 0o700 });
    writeFileSync('.cloudflare/live-run.json', JSON.stringify({ base, project: state.project, mission: current }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: current.status, overlaps: current.collisions.map(c => c.path), lanes: current.agents.map(a => ({ name: a.name, repo: a.repo, commit: a.commit, summary: a.summary, error: a.error })) }, null, 2));
    assert.equal(current.status, 'review', 'Every live agent must reach review before this check passes.');
    assert.equal(current.agents.length, 1);
    const agent = current.agents[0];
    assert.match(agent.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(agent.changes.map(file => file.path), ['sandbox-verification.txt']);
    const file = agent.changes[0];
    const diff = await api(`/api/missions/${current.id}/diff?${new URLSearchParams({ agent: agent.id, path: file.path, ref: file.contentRef })}`);
    assert.equal(diff.after, 'Full repository sandbox verified.\n');
    assert.ok(agent.checks.some(check => check.status === 'passed' && check.detail?.includes('Executed in the Cloudflare sandbox; exit 0')));
    assert.ok(!agent.checks.some(check => check.status === 'failed'));
    console.log('PASS: real Cloudflare sandbox checkout, commands, checks and Artifacts proposal publication. No merge performed.');
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 2500));
}
throw new Error('The live mission is still running. Inspect the deployed workspace.');
