import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blameFile, upgrade } from '../src/commands/blame';
import { collectStats } from '../src/stats';
import { Braid } from '../src/api';
import { testContext, server, json, session } from './helpers';
import { formatNote } from '../../shared/provenance';
import { landedProvenance, landingNote } from '../../worker/repositories/provenance';
import type { ChangeAuthor } from '../../shared/types';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
const first: ChangeAuthor = { kind: 'agent', id: 'agent:first', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', owner: { name: '@first' } };
const second: ChangeAuthor = { kind: 'agent', id: 'agent:second', name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', owner: { name: '@second' } };
const change = { changeId: 'ch_0000000000000', number: 1, revision: 1, title: 'Combined task',
  author: { kind: 'agent' as const, id: 'task:fixture', name: 'Claude Opus 5.5 and GPT-6.1 Sol', owner: { name: '@first' } },
  fileAuthors: { 'a.ts': first, 'b.ts': second }, approvedBy: 'Fixture' };

function fixture() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'braid-r6-cli-')));
  const env = { PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: root, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'a.ts'), 'one\ntwo\n');
  writeFileSync(join(root, 'b.ts'), 'three\n');
  git(['add', 'a.ts', 'b.ts']);
  // Only an isolated fixture gets Git objects; the shared checkout's refs and index are never touched.
  const sha = git(['commit-tree', git(['write-tree'])], 'Combined task\n');
  git(['update-ref', 'refs/heads/main', sha]);
  git(['notes', '--ref=braid', 'add', '-m', formatNote(landingNote(change)), sha]);
  mkdirSync(join(root, 'config'));
  return { sha, env, context: testContext({ cwd: root, env }).context };
}

describe('CLI consumption of the new per-file provenance map', () => {
  it('applies the file override in offline blame', () => {
    const f = fixture();
    const result = blameFile(f.context, root, 'b.ts', 'HEAD').blame;
    expect(result.ranges[0].provenance).toMatchObject({ kind: 'agent', agent: { model: second.model }, owner: { name: '@second' } });
  });
  it('retains the map at the HTTP schema boundary and applies it to witnessed upgrades', async () => {
    const f = fixture();
    const witnessed = landedProvenance(f.sha, '2026-10-13T00:00:00Z', change);
    const http = server({ 'POST /api/agent/session': session('fixture-workspace'), 'GET /api/provenance': () => json([witnessed]) });
    const context = testContext({ cwd: root, env: f.env, fetch: http.fetch }).context;
    // Exercise the same Valibot schema through Braid.get as the connected command.
    const braid = new Braid(context, { origin: 'https://braid.test', accessToken: 'fixture-token', workspaceId: 'fixture-workspace', expiresAt: '2099-01-01T00:00:00Z' });
    const result = await upgrade(braid, blameFile(f.context, root, 'b.ts', 'HEAD').blame);
    expect(result.ranges[0].provenance).toMatchObject({ confidence: 'braid', agent: { model: second.model }, owner: { name: '@second' } });
  });
  it('counts each selected model in stats instead of merging all files under the commit byline', async () => {
    const f = fixture();
    const result = await collectStats(f.context, [], { by: 'model' });
    expect(result.rows.map(row => ({ name: row.name, lines: row.lines }))).toEqual([
      { name: 'Claude Opus 5.5', lines: 2 }, { name: 'GPT-6.1 Sol', lines: 1 },
    ]);
  });
});
