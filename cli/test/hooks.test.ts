import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNote } from '../../shared/provenance';
import { HOOK, recordRun } from '../src/hooks';
import { braid, cleanup, repository, testContext } from './helpers';

afterEach(cleanup);

const init = (repo: ReturnType<typeof repository>) => braid(['init', '--url', 'https://braid.example', '--workspace', 'ws_1'], { cwd: repo.root, env: repo.env });

/** A stand-in `braid` on PATH that records how the hook calls it and exits with `status`. */
function stub(home: string, status = 0) {
  const bin = join(home, 'bin'), log = join(home, 'calls.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'braid'), `#!/bin/sh\necho "$*" >> '${log}'\nexit ${status}\n`, { mode: 0o755 });
  return { path: bin, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

/** The hooks an earlier `braid init` installed, which credited the model in the message. */
const EARLIER = {
  'prepare-commit-msg': '#!/bin/sh\n# braid-hook v1: under `braid agent run`, credits the model as a co-author unless the message already does.\n# Installed by `braid init`; the hook that was here before runs first as prepare-commit-msg.pre-braid.\nprevious="$(dirname "$0")/prepare-commit-msg.pre-braid"\nif [ -x "$previous" ]; then "$previous" "$@" || exit $?; fi\nif [ -n "$BRAID_MODEL" ] && command -v braid >/dev/null 2>&1; then braid hook prepare-commit-msg "$@" >/dev/null 2>&1; fi\nexit 0\n',
  'post-commit': '#!/bin/sh\n# braid-hook v1: under `braid agent run`, records the run in a refs/notes/braid note on the new commit.\n# Installed by `braid init`; the hook that was here before runs first as post-commit.pre-braid.\nprevious="$(dirname "$0")/post-commit.pre-braid"\nif [ -x "$previous" ]; then "$previous" "$@"; fi\nif [ -n "$BRAID_MODEL$BRAID_TOOL$BRAID_SESSION" ] && command -v braid >/dev/null 2>&1; then braid hook post-commit "$@" >/dev/null 2>&1; fi\nexit 0\n',
};

describe('braid init', () => {
  it('installs only the post-commit hook, which calls braid under an agent run and leaves the message alone', async () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'a\n' }, 'First');
    expect((await init(repo)).stdout).toBe('Linked to https://braid.example, repository ws_1, in .braid/config.json.\nAdded the braid remote, signed in through braid: git push braid HEAD:refs/for/main opens a change.\nInstalled the post-commit hook in .git/hooks.\n');
    expect(JSON.parse(readFileSync(join(repo.root, '.braid', 'config.json'), 'utf8'))).toEqual({ url: 'https://braid.example', workspaceId: 'ws_1' });
    expect(readFileSync(join(repo.root, '.git', 'hooks', 'post-commit'), 'utf8')).toBe(HOOK);
    expect(existsSync(join(repo.root, '.git', 'hooks', 'prepare-commit-msg'))).toBe(false);
    const fake = stub(repo.home, 1), path = `${fake.path}:${repo.env.PATH}`;
    repo.commit({ 'b.txt': 'b\n' }, 'A person commits', { extra: { PATH: path } });
    expect(fake.calls()).toEqual([]);
    repo.commit({ 'c.txt': 'c\n' }, 'An agent commits', { extra: { PATH: path, BRAID_MODEL: 'claude-opus-5-5', BRAID_SESSION: 's_1' } });
    expect(fake.calls()).toEqual(['hook post-commit']);
    expect(repo.git(['log', '-1', '--format=%B'])).toBe('An agent commits');
  });

  it('upgrades an earlier install, putting back the prepare-commit-msg hook Braid had set aside exactly', async () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'a\n' }, 'First');
    const hooks = join(repo.root, '.git', 'hooks');
    const theirs = '#!/bin/sh\nprintf "\\nReviewed-by: their hook\\n" >> "$1"\n';
    writeFileSync(join(hooks, 'prepare-commit-msg.pre-braid'), theirs, { mode: 0o750 });
    for (const [name, content] of Object.entries(EARLIER)) writeFileSync(join(hooks, name), content, { mode: 0o755 });
    const upgraded = await init(repo);
    expect(upgraded.stdout).toContain("Removed Braid's earlier prepare-commit-msg hook and put back the one it had set aside.");
    expect(readFileSync(join(hooks, 'prepare-commit-msg'), 'utf8')).toBe(theirs);
    expect(statSync(join(hooks, 'prepare-commit-msg')).mode & 0o777).toBe(0o750);
    expect(existsSync(join(hooks, 'prepare-commit-msg.pre-braid'))).toBe(false);
    expect(readFileSync(join(hooks, 'post-commit'), 'utf8')).toBe(HOOK);
    repo.commit({ 'b.txt': 'b\n' }, 'Still theirs', { extra: { BRAID_MODEL: 'claude-opus-5-5' } });
    expect(repo.git(['log', '-1', '--format=%B'])).toBe('Still theirs\n\nReviewed-by: their hook');
    expect((await init(repo)).stdout).not.toContain('prepare-commit-msg');
    expect(readFileSync(join(hooks, 'prepare-commit-msg'), 'utf8')).toBe(theirs);
  });

  it("removes Braid's earlier prepare-commit-msg hook, and never one that is not Braid's", async () => {
    const alone = repository();
    alone.commit({ 'a.txt': 'a\n' }, 'First');
    writeFileSync(join(alone.root, '.git', 'hooks', 'prepare-commit-msg'), EARLIER['prepare-commit-msg'], { mode: 0o755 });
    expect((await init(alone)).stdout).toContain("Removed Braid's earlier prepare-commit-msg hook.");
    expect(existsSync(join(alone.root, '.git', 'hooks', 'prepare-commit-msg'))).toBe(false);

    const replaced = repository();
    replaced.commit({ 'a.txt': 'a\n' }, 'First');
    const hooks = join(replaced.root, '.git', 'hooks'), mine = '#!/bin/sh\nexit 0\n', older = '#!/bin/sh\necho older\n';
    writeFileSync(join(hooks, 'prepare-commit-msg'), mine, { mode: 0o755 });
    writeFileSync(join(hooks, 'prepare-commit-msg.pre-braid'), older, { mode: 0o755 });
    expect((await init(replaced)).stdout).toContain('prepare-commit-msg.pre-braid is a hook Braid once set aside, and it no longer runs.');
    expect(readFileSync(join(hooks, 'prepare-commit-msg'), 'utf8')).toBe(mine);
    expect(readFileSync(join(hooks, 'prepare-commit-msg.pre-braid'), 'utf8')).toBe(older);
  });

  it('chains a post-commit hook that was already there, once', async () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'a\n' }, 'First');
    const hook = join(repo.root, '.git', 'hooks', 'post-commit'), marker = join(repo.home, 'theirs-ran');
    const original = `#!/bin/sh\ntouch '${marker}'\n`;
    writeFileSync(hook, original, { mode: 0o755 });
    expect((await init(repo)).stdout).toContain('the post-commit hook already there runs first');
    expect((await init(repo)).exitCode).toBe(0);
    expect(readFileSync(`${hook}.pre-braid`, 'utf8')).toBe(original);
    expect(readFileSync(hook, 'utf8')).toBe(HOOK);
    const fake = stub(repo.home);
    repo.commit({ 'b.txt': 'b\n' }, 'Chained', { extra: { PATH: `${fake.path}:${repo.env.PATH}`, BRAID_TOOL: 'codex/1.8.0' } });
    expect(existsSync(marker)).toBe(true);
    expect(fake.calls()).toEqual(['hook post-commit']);
  });
});

describe('the post-commit hook', () => {
  it('records the run in a refs/notes/braid note and leaves the message as written', () => {
    const repo = repository();
    const commit = repo.commit({ 'a.txt': 'a\n' }, 'Agent work');
    const { context } = testContext({ cwd: repo.root, env: repo.env });
    expect(recordRun(context, repo.root, { model: 'claude-opus-5-5', tool: 'claude-code/2.1.291', session: 's_1', parentSession: 's_0', agentId: 'agent-1' })).toBe(true);
    expect(parseNote(repo.git(['notes', '--ref=refs/notes/braid', 'show', commit]))).toEqual({ v: 1, agent: { name: 'Claude Opus 5.5', id: 'agent-1', model: 'claude-opus-5-5', tool: 'claude-code/2.1.291', session: 's_1', parentSession: 's_0' } });
    expect(repo.git(['log', '-1', '--format=%B'])).toBe('Agent work');
    expect(recordRun(context, repo.root, {})).toBe(false);
  });

  it('does not claim commits Git replays in a rebase', () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'a\n' }, 'Someone else');
    mkdirSync(join(repo.root, '.git', 'rebase-merge'));
    expect(recordRun(testContext({ cwd: repo.root, env: repo.env }).context, repo.root, { model: 'claude-opus-5-5' })).toBe(false);
    expect(repo.git(['notes', '--ref=refs/notes/braid', 'list'])).toBe('');
  });
});
