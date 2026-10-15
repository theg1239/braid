import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileBlame, Provenance } from '../../shared/types';
import { blameFile } from '../src/commands/blame';
import { saveCredentials, writeLink } from '../src/config';
import { braid, cleanup, json, repository, server, session, testContext } from './helpers';

afterEach(cleanup);

const alice = { name: 'Alice', email: 'alice@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const copilot = { name: 'copilot-swe-agent[bot]', email: '198982749+Copilot@users.noreply.github.com' };

/** A file each of whose lines a different kind of author wrote, the last one still uncommitted. */
function history() {
  const repo = repository();
  const human = repo.commit({ 'app.ts': 'const a = 1;\nconst b = 2;\n' }, 'Start the app', { author: alice });
  const claude = repo.commit({ 'app.ts': 'const a = 1;\nconst b = 2;\nconst c = 3; // Claude Code\n' }, 'Add c\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>', { author: bob });
  const bot = repo.commit({ 'app.ts': 'const a = 1;\nconst b = 2;\nconst c = 3; // Claude Code\nconst d = 4; // Copilot\n' }, 'Add d', { author: copilot });
  const noted = repo.commit({ 'app.ts': 'const a = 1;\nconst b = 2;\nconst c = 3; // Claude Code\nconst d = 4; // Copilot\nconst e = 5; // braid agent run\n' }, 'Add e\n\nCo-authored-by: GPT-6.1 Sol <gpt-6.1-sol@agents.braid.local>');
  repo.git(['notes', '--ref=refs/notes/braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8.0', session: 's_run1', parentSession: 's_orchestrator' } }), noted]);
  appendFileSync(join(repo.root, 'app.ts'), 'const f = 6;\n');
  return { ...repo, human, claude, bot, noted };
}

describe('braid blame', () => {
  it('groups lines by the agent or person who last changed them', () => {
    const repo = history();
    const { blame, text } = blameFile(testContext({ cwd: repo.root, env: repo.env }).context, repo.root, 'app.ts');
    expect(blame).toMatchObject({ path: 'app.ts', ref: 'HEAD', lines: 6 });
    expect(blame.ranges.map(range => [range.start, range.lines, range.provenance.commit])).toEqual([[1, 2, repo.human], [3, 1, repo.claude], [4, 1, repo.bot], [5, 1, repo.noted], [6, 1, '0'.repeat(40)]]);
    const [human, claude, bot, noted, pending] = blame.ranges.map(range => range.provenance);
    expect(human).toMatchObject({ kind: 'human', owner: { name: 'Alice', email: 'alice@example.com' }, confidence: 'inferred', subject: 'Start the app' });
    expect(claude).toMatchObject({ kind: 'agent', agent: { name: 'Claude Opus 4.7' }, owner: { name: 'Bob' }, confidence: 'inferred' });
    expect(bot).toMatchObject({ kind: 'agent', agent: { name: 'Copilot', tool: 'github-copilot' }, confidence: 'inferred' });
    expect(noted).toMatchObject({ kind: 'agent', agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8.0', session: 's_run1', parentSession: 's_orchestrator' }, owner: { github: 'theg1239' }, confidence: 'trailers' });
    expect(pending).toMatchObject({ kind: 'human', subject: 'Not committed yet', owner: { name: 'Ishaan' } });
    expect(text[4]).toBe('const e = 5; // braid agent run');
  });

  it('prints a compact table, and JSON in the FileBlame shape', async () => {
    const repo = history();
    const table = await braid(['blame', 'app.ts'], { cwd: repo.root, env: repo.env });
    expect(table.exitCode).toBe(0);
    const rows = table.stdout.trimEnd().split('\n');
    expect(rows[0]).toMatch(/^Lines\s+Author\s+Owner\s+Pull request\s+Age\s+Code$/);
    expect(rows[1]).toMatch(/^1-2\s+Alice\s+\S+\s+const a = 1;$/);
    expect(rows[2]).toMatch(/^3\s+Claude Opus 4\.7\s+Bob\s+\S+\s+const c = 3;/);
    expect(rows[3]).toMatch(/^4\s+Copilot\s+\S+\s+const d = 4;/);
    expect(rows[4]).toMatch(/^5\s+GPT-6\.1 Sol\s+@theg1239\s+\S+\s+const e = 5;/);
    expect(rows[5]).toMatch(/^6\s+Not committed\s+now\s+const f = 6;$/);
    expect(table.stdout).not.toContain('\x1b[');

    const output = await braid(['blame', 'app.ts', '--json', '--rev', 'HEAD~1'], { cwd: repo.root, env: repo.env });
    const parsed = JSON.parse(output.stdout) as FileBlame;
    expect(parsed).toMatchObject({ path: 'app.ts', ref: 'HEAD~1', lines: 4 });
    expect(parsed.ranges.map(range => range.provenance.kind)).toEqual(['human', 'agent', 'agent']);
  });

  it('names files from the repository root wherever it runs, and refuses paths outside it', async () => {
    const repo = repository();
    mkdirSync(join(repo.root, 'src', 'lib'), { recursive: true });
    repo.commit({ 'src/lib/x.ts': 'export const x = 1;\n' }, 'Add x');
    const inside = await braid(['blame', 'x.ts', '--json'], { cwd: join(repo.root, 'src', 'lib'), env: repo.env });
    expect((JSON.parse(inside.stdout) as FileBlame).path).toBe('src/lib/x.ts');
    const outside = await braid(['blame', '../../../etc/passwd'], { cwd: join(repo.root, 'src', 'lib'), env: repo.env });
    expect(outside.exitCode).toBe(1);
    expect(outside.stderr).toContain('is not a file in this repository');
  });

  it("upgrades commits Braid witnessed, and stays local when Braid has no provenance endpoint", async () => {
    const repo = history();
    saveCredentials(repo.env, { origin: 'https://braid.example', accessToken: 'braid_agent_connection', workspaceId: 'ws_1', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    writeLink(repo.root, { url: 'https://braid.example', workspaceId: 'ws_1' });
    const witnessed: Provenance = { commit: repo.claude, at: '2026-09-01T14:00:00Z', subject: 'Add c', kind: 'agent', agent: { id: 'agent-9', name: 'Claude Opus 4.7', model: 'claude-opus-4-7', tool: 'claude-code/2.1.0' }, owner: { name: 'Bob', github: 'bob' }, change: { id: 'ch_1', number: 12 }, confidence: 'braid' };
    const braidServer = server({ 'POST /api/agent/session': session(), 'GET /api/provenance': () => json([witnessed]) });
    const upgraded = JSON.parse((await braid(['blame', 'app.ts', '--json'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch })).stdout) as FileBlame;
    expect(upgraded.ranges[1].provenance).toEqual(witnessed);
    expect(upgraded.ranges[0].provenance.confidence).toBe('inferred');
    const asked = braidServer.sent.find(request => request.path.startsWith('/api/provenance'))!;
    expect(new URLSearchParams(asked.path.split('?')[1]).get('commits')!.split(',').sort()).toEqual([repo.human, repo.claude, repo.bot, repo.noted].sort());
    expect(asked.headers.authorization).toMatch(/^Bearer braid_at_/);

    const missing = server({ 'POST /api/agent/session': session() });
    const local = await braid(['blame', 'app.ts', '--json'], { cwd: repo.root, env: repo.env, fetch: missing.fetch });
    expect(local.exitCode).toBe(0);
    expect((JSON.parse(local.stdout) as FileBlame).ranges[1].provenance.confidence).toBe('inferred');
  });
});
