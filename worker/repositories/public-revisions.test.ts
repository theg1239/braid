import { describe, expect, it, vi } from 'vitest';
import { grow, hide, withheldFixture } from '../test/withheld';
import type { BraidEnv } from '../env';
import { formatNote, NOTES_REF } from '../../shared/provenance';

const query = (path: string, values: Record<string, string>) => `${path}?${new URLSearchParams(values)}`;
/** Artifacts calls that only a revision check makes: listing refs, or reading history from a commit by hash. */
const walking = (calls: string[]) => calls.filter(call => call === 'createToken' || /^log:[0-9a-f]{40}$/.test(call));
/** How many rounds history reads took: reads started together, before any of them ended, count once. */
const rounds = (events: string[]) => events.filter(event => / log:/.test(event)).filter((event, index, logs) => event.startsWith('start') && !logs[index - 1]?.startsWith('start')).length;

describe('public revisions: what a check costs', () => {
  it('reads by branch name with no Artifacts call a member\'s same read does not make, and none of a revision check', async () => {
    const paths = ['/api/repository?path=README.md', query('/api/repository', { ref: 'main', path: 'src/router.ts' }), query('/api/repository/tree', { ref: 'feature' }),
      query('/api/repository/commits', { ref: 'feature' }), query('/api/repository', { ref: 'feature', path: 'feature.txt', download: '1' }), query('/api/repository/compare', { base: 'main', head: 'feature' })];
    const reads = async (member: boolean) => {
      const f = await withheldFixture({ branches: ['feature'] });
      try {
        f.h.git.native(['update-ref', 'refs/heads/feature', f.h.git.commitTree({ 'feature.txt': 'feature\n' }, f.base, 'Feature')]);
        const calls: string[][] = [];
        for (const path of paths) {
          f.calls.length = 0;
          const response = await f.call(path, member);
          expect(response.status, path).toBe(200);
          // What a read hands to the background, such as the search prebuild a member's first view starts, counts toward it.
          await f.store.settled();
          calls.push([...f.calls]);
        }
        return calls;
      } finally { await f.close(); }
    };
    const [visitor, member] = [await reads(false), await reads(true)];
    paths.forEach((path, index) => {
      expect(walking(visitor[index]), path).toEqual([]);
      // Every call a visitor's read makes, the member's same read makes too, as often.
      const left = [...member[index]];
      for (const call of visitor[index]) {
        const at = left.indexOf(call);
        expect(at, `${path}: ${call}`).toBeGreaterThanOrEqual(0);
        left.splice(at, 1);
      }
    });
  });

  it('reads the tree, a file and history for a visitor by default, by branch, by tag and by full ref name', async () => {
    const f = await withheldFixture({ branches: ['feature'] });
    try {
      const { main } = grow(f, 3);
      const feature = f.h.git.commitTree({ 'feature.txt': 'feature\n' }, f.base, 'Feature'), tag = f.h.git.commitTree({ 'tag.txt': 'tag\n' }, f.base, 'Tag');
      f.h.git.native(['update-ref', 'refs/heads/feature', feature]); f.h.git.native(['update-ref', 'refs/tags/v1', tag]);
      for (const [ref, commit, path, content] of [[undefined, main.get(3), 'n.txt', '3\n'], ['main', main.get(3), 'n.txt', '3\n'], ['refs/heads/main', main.get(3), 'n.txt', '3\n'],
        ['feature', feature, 'feature.txt', 'feature\n'], ['v1', tag, 'tag.txt', 'tag\n'], ['refs/tags/v1', tag, 'tag.txt', 'tag\n']] as const) {
        const selected: Record<string, string> = ref ? { ref } : {};
        const history = await f.call(query('/api/repository/commits', selected));
        expect(history.status, `history ${ref}`).toBe(200);
        expect((await history.json() as { items: { hash: string }[] }).items[0].hash, `history ${ref}`).toBe(commit);
        const tree = await f.call(query('/api/repository/tree', selected));
        expect(tree.status, `tree ${ref}`).toBe(200); expect(await tree.json(), `tree ${ref}`).toMatchObject({ ref: commit });
        const file = await f.call(query('/api/repository', { ...selected, path }));
        expect(file.status, `file ${ref}`).toBe(200); expect(await file.json(), `file ${ref}`).toMatchObject({ content, ref: commit });
      }
    } finally { await f.close(); }
  });

  it('reads the default branch at its recorded head when Artifacts cannot read branch names, for visitors and members', async () => {
    const f = await withheldFixture();
    try {
      // As Artifacts answers for a copy still shallow from its import: commits by hash, branches by name not at all.
      const shallow = (artifacts: BraidEnv['ARTIFACTS']) => ({ get: async (id: string) => new Proxy(await artifacts.get(id), { get(target, prop) {
        const value = Reflect.get(target, prop) as (options?: { ref?: string }) => Promise<unknown>;
        if (prop === 'log' || prop === 'readFile') return (options: { ref?: string } = {}) => /^[0-9a-f]{40}$/.test(options.ref ?? '') ? value.call(target, options) : Promise.resolve(prop === 'log' ? [] : null);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) }) as BraidEnv['ARTIFACTS'];
      f.env.ARTIFACTS = shallow(f.env.ARTIFACTS); f.h.env.ARTIFACTS = shallow(f.h.env.ARTIFACTS);
      for (const member of [false, true]) for (const selected of [{}, { ref: 'main' }] as Record<string, string>[]) {
        const who = `${member ? 'member' : 'visitor'} ${selected.ref ?? 'default'}`;
        const history = await f.call(query('/api/repository/commits', selected), member);
        expect(history.status, who).toBe(200);
        expect((await history.json() as { items: { hash: string }[] }).items.map(item => item.hash), who).toEqual([f.base]);
        expect(await (await f.call(query('/api/repository/tree', selected), member)).json(), who).toMatchObject({ ref: f.base });
        expect(await (await f.call(query('/api/repository', { ...selected, path: 'README.md' }), member)).json(), who).toMatchObject({ content: '# Relay\n', ref: f.base });
        expect((await f.call(query('/api/repository/search', { ...selected, q: 'Relay' }), member)).status, who).toBe(200);
      }
      // Blame reads the trunk's head through Git's own listing of the branch.
      expect(await (await f.call(query('/api/blame', { path: 'README.md' }), true)).json()).toMatchObject({ ref: f.base });
    } finally { await f.close(); }
  });

  it('shows the agent a Braid note names, though Artifacts cannot read the notes ref by name, on history and a commit', async () => {
    const f = await withheldFixture();
    try {
      const head = f.h.git.commitTree({ 'agent.txt': 'by an agent\n' }, f.base, 'Agent change');
      f.h.git.native(['update-ref', 'refs/heads/main', head]);
      const notes = f.h.git.commitTree({ [`${head.slice(0, 2)}/${head.slice(2)}`]: formatNote({ v: 1, agent: { name: 'Claude', model: 'claude-opus-5-5' },
        owner: { name: 'Maya Chen', github: 'maya-chen' }, change: { id: 'ch_0123456789abc', number: 7, revision: 1 } }) }, undefined, 'Notes');
      f.h.git.native(['update-ref', NOTES_REF, notes]);
      const author = { kind: 'agent', model: 'claude-opus-5-5', owner: { name: 'Maya Chen', github: 'maya-chen' } };
      for (const member of [false, true]) {
        const history = await (await f.call('/api/repository/commits', member)).json() as { items: { hash: string }[] };
        expect(history.items[0], member ? 'member' : 'visitor').toMatchObject({ hash: head, author, pullRequest: 7 });
        expect(await (await f.call(query('/api/repository/commit', { sha: head }), member)).json(), member ? 'member' : 'visitor').toMatchObject({ author });
      }
      // Artifacts rejects full refs; the commit the trunk lists for the notes ref is read directly.
      expect(f.calls).not.toContain(`log:${NOTES_REF}`);
      expect(f.calls).toContain(`log:${notes}`);
    } finally { await f.close(); }
  });

  it('checks a recent commit named by hash in one round, then knows it and its neighbours', async () => {
    const f = await withheldFixture();
    try {
      const { main } = grow(f, 40);
      f.calls.length = 0;
      const first = await f.call(query('/api/repository', { ref: main.get(20)!, path: 'n.txt' }));
      expect(first.status).toBe(200); expect(await first.json()).toMatchObject({ content: '20\n' });
      // The default branch's newest commits answer it; the reader then reads the file at the commit as named.
      expect(f.calls.filter(call => call.startsWith('log:'))).toEqual(['log:main']);
      for (const [n, path] of [[25, '/api/repository'], [10, '/api/repository/tree'], [5, '/api/repository/commits']] as const) {
        f.calls.length = 0;
        const read = await f.call(query(path, { ref: main.get(n)!, path: path === '/api/repository' ? 'n.txt' : '' }));
        expect(read.status).toBe(200);
        expect(walking(f.calls.filter(call => call !== `log:${main.get(n)}`))).toEqual([]);
        expect(f.calls).not.toContain('log:main');
      }
    } finally { await f.close(); }
  });

  it('reads a deep old commit of the default branch by hash from that branch alone, past many stale branches', async () => {
    const f = await withheldFixture();
    try {
      const { main } = grow(f, 5_000, { branchEvery: 100 });
      f.calls.length = 0; f.events.length = 0;
      const read = await f.call(query('/api/repository', { ref: main.get(3)!, path: 'n.txt' }));
      expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ content: '3\n' });
      // A hundred newest commits, then a thousand, then two and four thousand read side by side: no branch is listed.
      expect(f.calls.filter(call => call.startsWith('log:'))).toHaveLength(8);
      expect(rounds(f.events)).toBe(4);
      expect(f.calls).not.toContain('createToken');
      // Everything above it is known now, by any reader.
      f.calls.length = 0;
      for (const n of [4, 2_500, 4_990]) expect((await f.call(query('/api/repository/commit', { sha: main.get(n)! }))).status).toBe(200);
      expect(walking(f.calls)).toEqual([]);
      expect(f.calls).not.toContain('log:main');
    } finally { await f.close(); }
  });

  it('keeps walking a default branch whose older history arrives after the walk reached its end', async () => {
    const f = await withheldFixture();
    try {
      const { main } = grow(f, 300);
      // As in a mirror still copying its history: commits older than the frontier are not in the repository yet.
      let absent = new Set([...main].filter(([n]) => n < 150).map(([, hash]) => hash));
      const artifacts = f.env.ARTIFACTS;
      f.env.ARTIFACTS = { get: async (id: string) => {
        const repo = await artifacts.get(id);
        return new Proxy(repo, { get(target, prop) {
          if (prop === 'readCommit') return async (hash: string) => absent.has(hash) ? null : target.readCommit(hash);
          if (prop === 'log') return async (options: Parameters<ArtifactsRepo['log']>[0] = {}) => {
            if (options.ref && absent.has(options.ref)) return [];
            const found = await target.log(options), end = found.findIndex(commit => absent.has(commit.hash));
            return end < 0 ? found : found.slice(0, end);
          };
          return Reflect.get(target, prop);
        } });
      } } as unknown as BraidEnv['ARTIFACTS'];
      vi.useFakeTimers({ toFake: ['Date'] });
      // The walk to a commit below the newest reaches the frontier.
      expect((await f.call(query('/api/repository/commit', { sha: main.get(160)! }))).status).toBe(200);
      absent = new Set();
      vi.advanceTimersByTime(11_000);
      expect((await f.call(query('/api/repository/commit', { sha: main.get(100)! }))).status).toBe(200);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it('reads commits only a merge or a stale branch reaches, and still refuses one that nothing publishes', async () => {
    const f = await withheldFixture();
    try {
      const { side, stale } = grow(f, 3_000, { mergeEvery: 50, branchEvery: 100 });
      f.calls.length = 0;
      const merged = await f.call(query('/api/repository', { ref: side.get(250)!, path: 'side-250.txt' }));
      expect(merged.status).toBe(200); expect(await merged.json()).toMatchObject({ content: 'side 250\n' });
      // The default branch down to that date names the merge that brought it in: no branch had to be listed.
      expect(f.calls).not.toContain('createToken');
      expect(f.calls.filter(call => call.startsWith('log:'))).toHaveLength(4);
      // A branch whose first commit is no longer its tip.
      f.h.git.native(['update-ref', 'refs/heads/stale-1200', hide(f, stale.get(1_200)!)]);
      f.calls.length = 0; f.events.length = 0;
      const branch = await f.call(query('/api/repository', { ref: stale.get(1_200)!, path: 'stale-1200.txt' }));
      expect(branch.status).toBe(200); expect(await branch.json()).toMatchObject({ content: 'stale 1200\n' });
      // The four merges nearest its date one at a time, then the thirty branch tips, listed once and read 25 at a time.
      expect(f.calls.filter(call => call === 'createToken')).toHaveLength(1);
      expect(f.calls.filter(call => call.startsWith('log:'))).toHaveLength(34);
      expect(rounds(f.events)).toBe(6);
      // A commit no ref reaches, dated among them: refused once the chains near its date are read, never asked to retry.
      const hidden = hide(f, side.get(1_500)!);
      f.calls.length = 0;
      const refused = await f.call(query('/api/repository', { ref: hidden, path: 'hidden.txt' }));
      expect(refused.status).toBe(404); expect(await refused.text()).not.toContain('unpublished');
      expect((await f.call(query('/api/repository/commit', { sha: hidden }))).status).toBe(404);
    } finally { await f.close(); }
  });

  it('fetches a public branch over Git without asking the repository about its commits', async () => {
    const f = await withheldFixture();
    try {
      const { main } = grow(f, 10);
      expect((await f.call('/git/w.git/info/refs?service=git-upload-pack')).status).toBe(200);
      f.calls.length = 0;
      const fetched = await f.upload(main.get(10)!, 1);
      expect(fetched.status).toBe(200);
      expect(f.calls).toEqual(['createToken', 'revokeToken']);
    } finally { await f.close(); }
  });
});
