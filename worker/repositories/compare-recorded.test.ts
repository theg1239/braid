import { describe, expect, it, vi } from 'vitest';
import { exampleBranches, recordedComparison, recordedComparisonDiff } from './compare';
import { exampleMain, recordedExample } from '../changes/demo';
import type { BraidEnv } from '../env';
import { Workspace } from '../workspace/workspace';
import { storageFixture } from '../test/storage';

describe('recorded commit comparisons', () => {
  it('compares full and abbreviated hashes without changing the recording or its files', async () => {
    const example = await recordedExample(), state = { decisions: {}, changes: [] };
    const main = exampleMain(), project = { branch: 'main', head: main.head };
    const before = JSON.stringify(main);
    const status = example.change('23', state), validation = example.change('22', state);
    const result = recordedComparison(example, state, project, main.files, status.landedParent!, validation.landedCommit!.slice(0, 7).toUpperCase());
    expect(result).toMatchObject({ status: 'ready', base: status.landedParent, head: validation.landedCommit, mergeBase: status.landedParent });
    expect(result.commits.map(commit => commit.hash)).toEqual([validation.landedCommit, status.landedCommit]);
    expect(result.files.map(file => file.path)).toEqual(['public/status.html', 'src/endpoints.ts', 'test/endpoints.test.ts']);
    expect(recordedComparisonDiff(example, state, project, main.files, result.mergeBase!, result.head, 'public/status.html')).toMatchObject({ before: null, after: example.diff(status.id, 'public/status.html', {}, state).after });
    expect(JSON.stringify(main)).toBe(before);
  });

  it('keeps identical and reverse comparisons, missing hashes and absent files honest', async () => {
    const example = await recordedExample(), state = { decisions: {}, changes: [] };
    const main = exampleMain(), project = { branch: 'main', head: main.head };
    const status = example.change('23', state);
    expect(recordedComparison(example, state, project, main.files, 'main', main.head.slice(0, 7))).toMatchObject({ status: 'identical', files: [], commits: [] });
    expect(recordedComparison(example, state, project, main.files, 'main', status.landedCommit!)).toMatchObject({ status: 'ready', mergeBase: status.landedCommit, files: [], commits: [] });
    expect(() => recordedComparison(example, state, project, main.files, 'missing', 'main')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => recordedComparison(example, state, project, main.files, '0000000', 'main')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => recordedComparisonDiff(example, state, project, main.files, status.landedCommit!, main.head, 'missing.ts')).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('serves hashes, settled example landings and pinned diffs from the workspace without live Artifacts', async () => {
    const fixture = storageFixture(), getRepo = vi.fn();
    try {
      const workspace = new Workspace(fixture.ctx, { ARTIFACTS: { get: getRepo } } as unknown as BraidEnv);
      await fixture.ready();
      const get = (path: string) => workspace.fetch(new Request(`https://braid.test/api/repository/${path}`));
      const example = await recordedExample();
      const response = await get(`compare?base=${example.change('23').landedParent}&head=main`);
      expect(response.status).toBe(200);
      const comparison = await response.json() as ReturnType<typeof recordedComparison>;
      expect(comparison.status).toBe('ready');
      expect(comparison.commits.length).toBeGreaterThan(1);
      expect(comparison.files.map(file => file.path)).toContain('src/endpoints.ts');
      for (const file of comparison.files) {
        const diff = await get(`compare/diff?base=${comparison.mergeBase}&head=${comparison.head}&path=${encodeURIComponent(file.path)}`);
        expect(diff.status).toBe(200);
        expect(await diff.json()).toMatchObject({ path: file.path, binary: false, tooLarge: false });
      }
      expect(getRepo).not.toHaveBeenCalled();
    } finally { fixture.db.close(); }
  });

  it('compares the recorded open proposal branch by name and pinned commit, in both directions', async () => {
    const example = await recordedExample(), state = { since: Date.now(), decisions: {}, changes: [] };
    const main = exampleMain(), project = { branch: 'main', head: main.head };
    const branches = exampleBranches(project, example, state);
    expect(branches.branches.map(branch => branch.name)).toEqual(['main', 'refund-rounding']);
    expect(branches.branches[0].tip!.hash).toBe(main.head);
    const tip = branches.branches[1].tip!;
    expect(tip).toMatchObject({ title: 'Round refund amounts in the ledger', author: { name: 'GPT-6 Astra' } });
    const comparison = recordedComparison(example, state, project, main.files, 'main', 'refund-rounding');
    expect(comparison).toMatchObject({ status: 'ready', base: main.head, head: tip.hash, mergeBase: main.head,
      commits: [tip], files: [{ path: 'src/billing/ledger.ts', additions: 1, deletions: 1 }] });
    expect(recordedComparison(example, state, project, main.files, main.head.slice(0, 7), tip.hash.slice(0, 7))).toEqual(comparison);
    expect(recordedComparisonDiff(example, state, project, main.files, comparison.mergeBase!, comparison.head, 'src/billing/ledger.ts'))
      .toMatchObject({ before: expect.stringContaining('Math.floor'), after: expect.stringContaining('Math.round') });
    expect(recordedComparison(example, state, project, main.files, 'refund-rounding', 'main')).toMatchObject({ status: 'ready', mergeBase: main.head, commits: [], files: [] });
    expect(recordedComparison(example, state, project, main.files, 'refs/heads/refund-rounding', tip.hash)).toMatchObject({ status: 'identical', mergeBase: tip.hash, commits: [], files: [] });
  });
});
