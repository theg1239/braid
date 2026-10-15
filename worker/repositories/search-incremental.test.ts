import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { repositorySearch, SEARCH_LIMITS } from './search';
import { startGitServer } from '../test/git-server';
import { storageFixture } from '../test/storage';

let git: Awaited<ReturnType<typeof startGitServer>>;
beforeAll(async () => { git = await startGitServer(); });
afterAll(async () => { await git.close(); });

describe('blob reuse across commit indexes', () => {
  it('reads only changed blobs after eviction and follows renames, deletions and duplicates', async () => {
    const fixture = storageFixture(), repo = { ...git.repository, readBlob: vi.fn(git.repository.readBlob) };
    const first = git.commitTree({ 'keep.ts': 'needle stable', 'move.ts': 'needle moved', 'drop.ts': 'needle gone', 'edit.ts': 'needle old' });
    const second = git.commitTree({ 'keep.ts': 'needle stable', 'renamed.ts': 'needle moved', 'copy.ts': 'needle stable', 'edit.ts': 'needle new' });
    try {
      await repositorySearch({}, repo, { q: 'needle', ref: first }, { storage: fixture.storage });
      expect(repo.readBlob).toHaveBeenCalledTimes(4); repo.readBlob.mockClear();
      const result = await repositorySearch({}, repo, { q: 'needle', ref: second }, { storage: fixture.storage });
      expect(repo.readBlob).toHaveBeenCalledTimes(1);
      expect(result.results.map(file => file.path)).toEqual(['copy.ts', 'edit.ts', 'keep.ts', 'renamed.ts']);
      expect(result).toEqual(await repositorySearch({}, git.repository, { q: 'needle', ref: second }));
      expect((await repositorySearch({}, repo, { q: 'old', ref: first }, { storage: fixture.storage })).matchCount).toBe(1);
    } finally { fixture.db.close(); }
  });

  it('retains binary and oversized metadata without rereading those unchanged blobs', async () => {
    const fixture = storageFixture(), repo = { ...git.repository, readBlob: vi.fn(git.repository.readBlob) };
    const files = { 'binary.dat': 'needle\0binary', 'large.txt': 'needle'.padEnd(SEARCH_LIMITS.fileBytes + 1, 'x'), 'text.ts': 'needle' };
    try {
      await repositorySearch({}, repo, { q: 'needle', ref: git.commitTree(files) }, { storage: fixture.storage });
      repo.readBlob.mockClear();
      const result = await repositorySearch({}, repo, { q: 'needle', ref: git.commitTree({ ...files, 'new.ts': 'needle new' }) }, { storage: fixture.storage });
      expect(repo.readBlob).toHaveBeenCalledTimes(1);
      expect(result.results.map(file => file.path)).toEqual(['new.ts', 'text.ts']);
    } finally { fixture.db.close(); }
  });

  it('charges reused bytes and duplicates to the new commit scan budget', async () => {
    const fixture = storageFixture(), repo = { ...git.repository, readBlob: vi.fn(git.repository.readBlob) };
    const text = 'needle'.padEnd(SEARCH_LIMITS.fileBytes, 'x');
    try {
      await repositorySearch({}, repo, { q: 'needle', ref: git.commitTree({ 'original.ts': text }) }, { storage: fixture.storage });
      repo.readBlob.mockClear();
      const ref = git.commitTree(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`file-${i}.ts`, text])));
      const result = await repositorySearch({}, repo, { q: 'needle', ref }, { storage: fixture.storage });
      expect(result).toMatchObject({ matchCount: 16, truncated: true });
      expect(repo.readBlob).not.toHaveBeenCalled();
      expect(result).toEqual(await repositorySearch({}, git.repository, { q: 'needle', ref }));
    } finally { fixture.db.close(); }
  });

  it('keeps a fetched overflow blob reusable without exposing it past the scan boundary', async () => {
    const fixture = storageFixture(), repo = { ...git.repository, readBlob: vi.fn(git.repository.readBlob) };
    const files = { 'a-large.txt': 'x'.repeat(SEARCH_LIMITS.bytes + 1), 'b.ts': 'needle' };
    try {
      const first = git.commitTree(files);
      expect(await repositorySearch({}, repo, { q: 'needle', ref: first }, { storage: fixture.storage })).toMatchObject({ matchCount: 0, truncated: true });
      expect(await repositorySearch({}, repo, { q: 'needle', ref: first }, { storage: fixture.storage })).toMatchObject({ matchCount: 0, truncated: true });
      repo.readBlob.mockClear();
      const second = git.commitTree({ 'b.ts': 'needle' });
      expect(await repositorySearch({}, repo, { q: 'needle', ref: second }, { storage: fixture.storage })).toMatchObject({ matchCount: 1, truncated: false });
      expect(repo.readBlob).not.toHaveBeenCalled();
    } finally { fixture.db.close(); }
  });
});
