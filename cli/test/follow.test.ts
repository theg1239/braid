import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveCredentials, writeLink } from '../src/config';
import { braid, cleanup, json, repository, server, session } from './helpers';
import { reviewComments } from '../../worker/test/review-comments';

afterEach(cleanup);

const origin = 'https://braid.example';
const base = { id: 'ch_0123456789abc', number: 7, title: 'Add the parser', revision: 2, conflicts: [], checks: [], reviews: [], overlaps: [] };
const open = { ...base, status: 'open' };
const sentBack = {
  ...base, status: 'revise', next: 'Fix the failing test and the conflict, then resubmit.',
  conflicts: [{ path: 'parser.ts', kind: 'content', regions: [{ baseStart: 2, oursStart: 2, theirsStart: 2, base: [], ours: [], theirs: [] }] }],
  evidence: [
    { kind: 'command', revision: 1, command: 'npm test', exitCode: 1, output: 'old failure', source: 'agent', at: '2026-10-08T12:00:00Z' },
    { kind: 'command', revision: 2, command: 'npm test', exitCode: 1, output: `\x1b[31mFAIL\x1b[39m parser.test.ts\nexpected "a" got " a"\nGITHUB_TOKEN=ghp_${'A1b2'.repeat(9)}`, source: 'braid', at: '2026-10-08T12:00:00Z' },
    { kind: 'screenshot', revision: 2, page: '/', viewport: 'desktop', image: 'x.png', width: 1, height: 1, source: 'braid', at: '2026-10-08T12:00:00Z' },
  ],
  checks: [{ revision: 2, label: 'lint', status: 'failed', detail: 'Unexpected console statement.', source: 'ci' }, { revision: 2, label: 'npm test', status: 'failed', detail: 'duplicate of the command', source: 'braid' }],
  guards: [{ kind: 'instructions', path: 'parser.ts', detail: 'Adds "console.log", which "Use the logger." blocks.' }],
  reviews: [{ id: 'r1', revision: 2, reviewer: 'Review agent', kind: 'agent', verdict: 'revise', summary: 'Handle empty input.', createdAt: '2026-10-08T12:00:00Z', findings: [{ path: 'parser.ts', line: 1, severity: 'error', message: 'Empty input throws.' }] }],
  overlaps: [{ changeId: 'ch_other', number: 9, title: 'Other', status: 'open', paths: ['parser.ts'] }],
};

/** A signed-in, linked repository whose branch already submitted change #7. */
function submittedBranch() {
  const repo = repository();
  const trunk = repo.commit({ 'parser.ts': 'export const parse = () => null;\n' }, 'Start');
  repo.git(['checkout', '-q', '-b', 'parser']);
  saveCredentials(repo.env, { origin, accessToken: `braid_agent_${'c'.repeat(64)}`, workspaceId: 'ws_1', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  writeLink(repo.root, { url: origin, workspaceId: 'ws_1' });
  const folder = join(repo.root, '.git', 'braid');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, 'parser.json'), JSON.stringify({ origin, workspaceId: 'ws_1', base: trunk, change: { id: 'ch_0123456789abc', number: 7, revision: 1, status: 'open' } }), { mode: 0o600 });
  return repo;
}

describe('braid wait', () => {
  it.each(['wait', 'status'])('%s prints unresolved comments and replies with their anchored location', async command => {
    const repo = submittedBranch();
    const comments = [...reviewComments, { ...reviewComments[0], id: 'rc_terminal', body: '\x1b[31mPlease add a regression test.\x1b[0m' }];
    const api = server({ 'POST /api/agent/session': session(), 'GET /api/changes/ch_0123456789abc': () => json({ ...sentBack, comments }) });
    const result = await braid([command], { cwd: repo.root, env: repo.env, fetch: api.fetch });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Unresolved review comments:');
    expect(result.stdout).toContain('src/parser.ts:14 (RIGHT; revision 1)');
    expect(result.stdout).toContain('Handle **empty input** before parsing.');
    expect(result.stdout).toContain('Reply to rc_open by GPT-6 Astra for @maya');
    expect(result.stdout).toContain('src/retry.ts:6 (LEFT, Outdated; revision 1)');
    expect(result.stdout).not.toContain('Already addressed.');
    expect(result.stdout).not.toContain('\x1b');
  });

  it('waits until the change comes back, then lists everything to fix and the exact next commands', async () => {
    const repo = submittedBranch();
    mkdirSync(join(repo.root, '.braid'), { recursive: true });
    writeFileSync(join(repo.root, '.braid', 'proof.json'), '{"checks": ["npm test"]}');
    const waits: number[] = [];
    const braidServer = server({ 'POST /api/agent/session': session(), 'GET /api/changes/ch_0123456789abc': [() => json(open), () => json(open), () => json(sentBack)] });
    const result = await braid(['wait'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch, sleep: async ms => { waits.push(ms); } });
    expect(waits).toEqual([5000, 7500]);
    expect(result.stdout).toBe([
      'Pull request #7 · Add the parser · changes requested · revision 2',
      'Next: Fix the failing test and the conflict, then resubmit.',
      'Conflict (content) in parser.ts at line 3',
      'Failed in Braid: npm test (exit 1)',
      '  FAIL parser.test.ts',
      '  expected "a" got " a"',
      '  GITHUB_TOKEN=[redacted]',
      'Failed check (ci): lint',
      'Unexpected console statement.',
      'Instruction broken in parser.ts: Adds "console.log", which "Use the logger." blocks.',
      'Review (Review agent): revise: Handle empty input.',
      '  parser.ts:1 Empty input throws.',
      'Also active on the same files: #9',
      'Fetch main, rebase onto it and resolve the conflicts, fix anything else listed, commit, then resubmit:',
      '  braid sync',
      '  braid submit --proof',
      '',
    ].join('\n'));
  });

  it('prints where things stand at the timeout, with the command to keep waiting', async () => {
    const repo = submittedBranch();
    let now = 0;
    const braidServer = server({ 'POST /api/agent/session': session(), 'GET /api/changes/ch_0123456789abc': () => json(open) });
    const result = await braid(['wait', '--timeout', '20'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch, now: () => now, sleep: async ms => { now += ms; }, self: ['npx', 'braid-git'] });
    expect(result.stdout).toBe('Pull request #7 · Add the parser · open · revision 2\nNext, wait until it merges or needs changes:\n  npx braid-git wait\n');
    expect(now).toBe(20_000);
  });
});

describe('braid status', () => {
  it('stops an agent when a person must decide', async () => {
    const repo = submittedBranch();
    const braidServer = server({ 'POST /api/agent/session': session(), 'GET /api/changes/ch_0123456789abc': () => json({ ...open, status: 'attention' }) });
    const result = await braid(['status'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch });
    expect(result.stdout).toContain('Connection: connected');
    expect(result.stdout).toContain('Pull request #7 · Add the parser · review required · revision 2\nA person must decide. Ask the owner to open pull request #7 in this repository at https://braid.example.\n');
  });

  it('follows any change by number, and says when this branch has none', async () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'a\n' }, 'Start');
    saveCredentials(repo.env, { origin, accessToken: `braid_agent_${'c'.repeat(64)}`, workspaceId: 'ws_1', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    writeLink(repo.root, { url: origin, workspaceId: 'ws_1' });
    const braidServer = server({ 'POST /api/agent/session': session(), 'GET /api/changes/12': () => json({ ...open, number: 12, status: 'landed', landedCommit: 'f'.repeat(40) }) });
    expect((await braid(['status', '--change', '12'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch })).stdout).toContain(`Pull request #12 · Add the parser · merged · revision 2\nMerged as ${'f'.repeat(40)}.\n`);
    expect((await braid(['status'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch })).stdout).toContain('Queued activity: 0');
  });
});
