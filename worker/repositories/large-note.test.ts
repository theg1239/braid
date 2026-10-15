import { expect, it } from 'vitest';
import { landingNote } from './provenance';
import { historyCommits } from './history';
import { repositoryBranches } from './compare';
import { formatNote, NOTES_REF, parseNote } from '../../shared/provenance';
import type { ChangeAuthor } from '../../shared/types';

it('reads a valid task landing note after the per-file map makes it larger than 16 KiB, on history and branch pages alike', async () => {
  const author: ChangeAuthor = { kind: 'agent', id: 'task-agent:mission-fixture:coder', name: 'Claude Opus 5.5',
    model: 'claude-opus-5-5', tool: 'claude-code/2.4.1', session: 's_fixture', parentSession: 's_parent', owner: { name: '@fixture', github: 'fixture' } };
  const aggregate = { ...author, id: 'task:mission-fixture', name: 'Claude Opus 5.5 and GPT-6.1 Sol', model: undefined };
  const text = formatNote(landingNote({ changeId: 'ch_0000000000000', number: 27, revision: 1, title: 'Task result',
    author: aggregate, approvedBy: 'Fixture', fileAuthors: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`src/file-${i}.ts`, author])) }));
  expect(new Blob([text]).size).toBeGreaterThan(16_384);
  expect(parseNote(text)).not.toBeNull();
  const sha = 'a'.repeat(40);
  const commit = { hash: sha, treeHash: 'c'.repeat(40), parents: [], committedAt: 1_791_849_600, authoredAt: 1_791_849_600,
    author: { name: '@fixture', email: '' }, committer: { name: 'Braid', email: '' }, message: 'Task result' };
  const notes = { ...commit, hash: 'b'.repeat(40), treeHash: 'd'.repeat(40) };
  const repo = { log: async ({ ref }: { ref?: string } = {}) => [ref === NOTES_REF ? notes : commit], readCommit: async () => commit,
    readTree: async () => [{ name: sha, type: 'blob', mode: '100644', hash: 'e'.repeat(40) }], readBlob: async () => new Blob([text]) } as unknown as Parameters<typeof historyCommits>[0];
  const [read] = await historyCommits(repo, [commit]);
  expect(read).toMatchObject({ author: { kind: 'agent', name: aggregate.name }, pullRequest: 27 });
  const { branches: [main] } = await repositoryBranches(repo, { branch: 'main' });
  expect(main.tip).toMatchObject({ hash: sha, author: { kind: 'agent', name: aggregate.name, owner: { github: 'fixture' } } });
});
