import { afterEach, describe, expect, it } from 'vitest';
import { provenanceOf } from '../../shared/provenance';
import type { Provenance } from '../../shared/types';
import { historyCommits } from './history';
import { compareRepository } from './compare';
import { Trunk } from '../changes/trunk';
import { agentRoster } from '../changes/router';
import { changeHarness } from '../test/changes-harness';
import { storageFixture } from '../test/storage';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

const author = { name: 'dependabot[bot]', email: '101+dependabot[bot]@users.noreply.github.com' };
async function setup() {
  harness = await changeHarness();
  const root = harness.git.commitTree({ 'deps.txt': 'one\n' }, undefined, 'Start');
  const head = harness.git.commitTree({ 'deps.txt': 'one\ntwo\n' }, root,
    'Bump dependencies\n\nCo-authored-by: Example Owner <101+example-owner@users.noreply.github.com>', author);
  harness.git.native(['update-ref', 'refs/heads/main', head]);
  const commit = (await harness.git.repository.readCommit(head))!;
  const inferred = provenanceOf({ id: head, at: new Date(commit.authoredAt * 1000).toISOString(), author: commit.author, message: commit.message });
  const legacy: Provenance = { ...inferred, kind: 'agent' };
  return { harness, root, head, commit, legacy };
}

describe('bot history and imported provenance', () => {
  it('keeps the bot kind and tool through commit and branch conversion, including older inferred rows', async () => {
    const { harness, root, head, commit, legacy } = await setup();
    for (const known of [async () => [], async () => [legacy]]) {
      const history = await historyCommits(harness.git.repository, [commit], known);
      expect(history[0].author).toMatchObject({ kind: 'bot', name: 'Dependabot', tool: 'dependabot[bot]' });
      const comparison = await compareRepository(harness.git.repository, root, head, known);
      expect(comparison.commits[0].author).toMatchObject({ kind: 'bot', name: 'Dependabot', tool: 'dependabot[bot]' });
    }
  });

  it.each(['braid', 'trailers'] as const)('does not reclassify an existing %s record from Git author heuristics', async confidence => {
    const { harness, root, head, commit, legacy } = await setup();
    const known = async () => [{ ...legacy, confidence }];
    expect((await historyCommits(harness.git.repository, [commit], known))[0].author.kind).toBe('agent');
    expect((await compareRepository(harness.git.repository, root, head, known)).commits[0].author.kind).toBe('agent');
  });

  it('keeps old stored rows readable and refreshes inferred attribution when blame reads the Git facts again', async () => {
    const { harness, head, legacy } = await setup();
    const store = storageFixture();
    try {
      const trunk = new Trunk(store.ctx, harness.env);
      store.storage.sql.exec('INSERT INTO commits (sha, provenance, agent, added) VALUES (?, ?, ?, ?)', head, JSON.stringify(legacy), '["","Example Owner","dependabot[bot]"]', 7);
      const id = store.storage.sql.exec<{ id: number }>('SELECT id FROM commits WHERE sha = ?', head).one().id;
      expect(await trunk.provenance(harness.repository, [head], true)).toEqual([legacy]);
      const blame = await trunk.blame(harness.repository, 'deps.txt');
      expect(blame.ok).toBe(true);
      if (!blame.ok) throw new Error(blame.error);
      expect(blame.data.ranges.find(range => range.start === 2)?.provenance).toMatchObject({ kind: 'bot', agent: { name: 'Dependabot' }, confidence: 'inferred' });
      expect(await trunk.provenance(harness.repository, [head], true)).toMatchObject([{ kind: 'bot' }]);
      expect(store.storage.sql.exec('SELECT id, agent, added, alive FROM commits WHERE sha = ?', head).one()).toEqual({ id, agent: null, added: 7, alive: 1 });
      expect(await trunk.agentLines(harness.repository)).toEqual({});
      expect(await agentRoster(harness.env, harness.repository)).toEqual([]);
    } finally { await store.settled(); store.db.close(); }
  });
});
