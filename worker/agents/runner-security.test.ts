import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as commands from './container';
import { ContentStore } from '../workspace/content';
import { runVerification } from './runner';
import { changeHarness } from '../test/changes-harness';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

afterEach(() => vi.restoreAllMocks());

it('does not let candidate leftovers fabricate broken-main evidence', async () => {
  const h = await changeHarness(), store = storageFixture();
  const root = mkdtempSync(join(tmpdir(), 'braid-r7-runner-')), work = join(root, 'checkout');
  const git = (args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const clean = "module.exports = () => require('node:fs').existsSync('.candidate-poison') ? 1 : 0;\n";
  const poison = "module.exports = () => { require('node:fs').writeFileSync('.candidate-poison', 'candidate only'); return 1; };\n";
  try {
    const base = h.git.commitTree({ 'probe.cjs': clean, 'check.cjs': "process.exit(require('./probe.cjs')());\n",
      '.braid/policy.json': JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, checks: ['node check.cjs'], verify: { retries: 0 } }) });
    h.git.native(['update-ref', 'refs/heads/main', base]);
    await h.trunk.configure(h.repository, { enabled: true, actor: 'Owner' });
    const submitted = await h.submit('writer', { title: 'Poison baseline', summary: 'Candidate changes one source module.', baseCommit: base, files: [{ path: 'probe.cjs', content: poison }] });
    expect(submitted.ok).toBe(true);
    await h.trunk.alarm();
    const { job, batchId } = h.verifications[0];
    const container = { images: { agent: 'fixture' }, destroy: vi.fn(async () => rmSync(work, { recursive: true, force: true })), start: vi.fn(), setInactivityTimeout: vi.fn(async () => {}) };
    Object.assign(store.ctx, { container });
    // Only the container transport is substituted. The actual runner, real Git checkout and
    // repository check execute locally; no Cloudflare or external network is contacted.
    vi.spyOn(commands, 'runCommand').mockImplementation(async (_container, argv) => {
      const result = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode, truncated: false });
      if (argv[0] === 'git' && argv.includes('clone')) {
        execFileSync('git', ['clone', '--no-checkout', '--', join(h.git.root, 'repo.git'), work], { stdio: 'pipe' });
        return result();
      }
      if (argv[0] === 'git') { git(argv.slice(1)); return result(); }
      if (argv[0] === 'node') return result(git(['rev-parse', 'HEAD']).trim());
      if (argv.at(-1) === 'true') return result();
      expect(argv.at(-1)).toBe('node check.cjs');
      const check = spawnSync(process.execPath, ['check.cjs'], { cwd: work, encoding: 'utf8' });
      return { ...result(check.stdout, check.status ?? 1), stderr: check.stderr };
    });
    const env = { ARTIFACTS: { get: async () => ({ createToken: async () => ({ plaintext: 'synthetic-test-token' }), revokeToken: async () => {}, [Symbol.dispose]() {} }) } } as unknown as BraidEnv;
    const result = await runVerification(store.ctx, env, new ContentStore(store.storage), { ...job, remote: 'https://fixture.artifacts.cloudflare.net/git/a/repo.git' });
    expect(result.status).toBe('failed');
    // Feed the runner's real result to the real queue, through the same callback the workflow uses.
    await h.trunk.verified(h.repository, batchId, result);
    expect.soft((await h.trunk.status(h.repository)).paused).toBeUndefined();
    expect.soft(result.baseline).toEqual({ commit: base, failing: [] });
    expect(h.head()).toBe(base);
  } finally { rmSync(root, { recursive: true, force: true }); store.db.close(); await h.close(); }
});
