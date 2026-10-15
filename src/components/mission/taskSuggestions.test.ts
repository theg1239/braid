import { describe, expect, it } from 'vitest';
import type { RepositoryTree } from '../../../shared/repository';
import type { ChangeSummary, WorkspaceSnapshot } from '../../../shared/types';
import { missionFixture } from '../../test/fixtures';
import { taskSuggestions } from './taskSuggestions';

const snapshot = (paths: string[] = []): WorkspaceSnapshot => ({
  project: { id: 'relay', name: 'relay', branch: 'main', head: 'a', description: '', stack: [] },
  capabilities: { mode: 'live', canWrite: true, authenticated: true, artifacts: true, ai: true, storage: 'durable-object', model: '', namespace: '' },
  files: Object.fromEntries(paths.map(path => [path, ''])), missions: [], context: [], activity: [],
});
const tree = (paths: string[], over: Partial<RepositoryTree> = {}): RepositoryTree => ({ ref: 'a', path: '', entries: paths.map(path => ({ path, name: path.split('/').pop()!, kind: 'file', hash: '', mode: '100644' })), nextCursor: null, ...over });
const merge = (over: Partial<ChangeSummary> = {}): ChangeSummary => ({ id: 'pr', number: 1, title: 'Retry timed-out deliveries', status: 'landed', landedCommit: 'a', checkState: 'passed', revision: 1, author: { kind: 'agent', id: 'agent', name: 'Agent' }, createdAt: '', updatedAt: '', files: 1, additions: 1, deletions: 0, ...over });

describe('task suggestions from loaded repository data', () => {
  it('suggests a source file without a matching test, excluding config, declarations and generated paths', () => {
    const state = snapshot(['src/delivery.ts', 'test/delivery.test.ts', 'src/signature.ts', 'src/types.d.ts', 'vite.config.ts', '.braid/helper.ts', 'node_modules/a.ts', 'dist/a.js', 'README.md']);
    expect(taskSuggestions(state)).toEqual(['Add tests for src/signature.ts', 'Document src/signature.ts in README.md']);
  });
  it.each(['src/delivery.test.ts', 'tests/delivery.spec.js', 'src/__tests__/delivery.ts', 'tests/test_delivery.py', 'test/delivery_test.go', 'spec/delivery_spec.rb', 'test/DeliveryTest.java'])('recognizes %s as a test for the source', test => {
    expect(taskSuggestions(snapshot(['src/delivery.ts', test, 'src/signature.ts']))[0]).toBe('Add tests for src/signature.ts');
  });
  it('uses cached listings only at the current head and only regular files', () => {
    const current = tree(['src/delivery.ts', 'src/signature.ts'], { path: 'src' });
    current.entries[0].kind = 'symlink';
    expect(taskSuggestions(snapshot(), [tree(['old.ts'], { ref: 'old' }), current])[0]).toBe('Add tests for src/signature.ts');
  });
  it('does not infer missing files from an unvisited or partially read repository', () => {
    const generic = ['Add tests for relay', 'Document how to run relay'];
    expect(taskSuggestions(snapshot())).toEqual(generic);
    expect(taskSuggestions(snapshot(), [tree([], { nextCursor: 'more' })])).toEqual(generic);
    expect(taskSuggestions(snapshot(), [tree([], { path: 'src' })])).toEqual(generic);
  });
  it('offers initialization only for a known empty root', () => {
    expect(taskSuggestions(snapshot(), [tree([])])).toEqual(['Add a README for relay', 'Add an AGENTS.md for relay']);
  });
  it('uses the actual README spelling and the current merged change title', () => {
    expect(taskSuggestions(snapshot(['Readme.markdown']), [], merge())[1]).toBe('Update Readme.markdown for “Retry timed-out deliveries”');
  });
  it('offers a failing-check task only for a failed check on the current default-branch commit', () => {
    const state = snapshot();
    state.project.branch = 'develop';
    expect(taskSuggestions(state, [], merge({ checkState: 'failed' }))[0]).toBe('Fix the failing check on develop');
    for (const over of [{ checkState: 'passed' }, { checkState: 'pending' }, { checkState: undefined }, { landedCommit: 'old', checkState: 'failed' }, { status: 'revise', checkState: 'failed' }] as Partial<ChangeSummary>[]) {
      expect(taskSuggestions(state, [], merge(over)).join(' ')).not.toContain('failing check');
    }
  });
  it('can use a completed live task at the current head, but never an open or recorded task', () => {
    const state = snapshot(['README.md']);
    state.missions = [missionFixture({ title: 'Retry deliveries', status: 'merged', source: 'live', mergeCommit: 'a' })];
    expect(taskSuggestions(state)[1]).toContain('“Retry deliveries”');
    state.missions[0].source = 'demo';
    expect(taskSuggestions(state)[1]).toBe('Document how to run relay');
    state.missions[0].source = 'live';
    state.missions[0].status = 'review';
    expect(taskSuggestions(state)[1]).toBe('Document how to run relay');
  });
  it('never offers arbitrary work in the recorded example or before a repository exists', () => {
    const state = snapshot(['README.md', 'src/delivery.ts']);
    state.capabilities.mode = 'demo';
    expect(taskSuggestions(state, [], merge({ checkState: 'failed' }))).toEqual([]);
    state.capabilities.mode = 'live';
    state.project.id = '';
    expect(taskSuggestions(state)).toEqual([]);
  });
});
