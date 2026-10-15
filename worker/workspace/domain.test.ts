import { describe, expect, it } from 'vitest';
import { change, composeChanges, detectCollisions, mergeBlocker, validPath } from './domain';
import { seedWorkspace } from './seed';
const capabilities = { mode: 'demo' as const, artifacts: true, ai: true, storage: 'durable-object' as const, authenticated: false, model: 'test', namespace: 'test', canWrite: false };
const fixture = () => seedWorkspace('demo', capabilities).missions[0];

describe('integration gate', () => {
  it('counts changed lines without counting unchanged lines between edits', () => {
    const patch = change('a.ts', 'old\nkeep\nkeep too\nlast\n', 'new\nkeep\nkeep too\nchanged\n');
    expect(patch.additions).toBe(2); expect(patch.deletions).toBe(2);
    expect(change('empty', '', 'one\n').additions).toBe(1);
  });
  it('counts very large newline-dense files without allocating an operation per line', () => {
    const prefix = 'same\n'.repeat(10_000), suffix = 'end\n'.repeat(10_000);
    expect(change('large', prefix + 'old\n' + suffix, prefix + 'new\nextra\n' + suffix)).toMatchObject({ additions: 2, deletions: 1 });
    expect(change('new', '', '\n'.repeat(1_000_000))).toMatchObject({ additions: 1_000_000, deletions: 0 });
    expect(change('old', '\n'.repeat(1_000_000), '')).toMatchObject({ additions: 0, deletions: 1_000_000 });
    const large = ('x'.repeat(50) + '\n').repeat(9000);
    expect(change('partial', large + 'b\n', large + 'zb\n')).toMatchObject({ additions: 1, deletions: 1 });
    expect(change('partial', large + 'p\nb', large + 'p\nXb')).toMatchObject({ additions: 1, deletions: 1 });
  });
  it('recognizes differing versions but not identical shared files', () => {
    const m = fixture();
    expect(detectCollisions(m.agents).map(c => c.path)).toEqual(['src/limits.ts']);
  });
  it('blocks unresolved overlaps, incomplete agents, failed checks and a moved trunk', () => {
    const m = fixture();
    expect(mergeBlocker(m, m.baseCommit)).toMatch(/overlapping/);
    m.collisions[0].resolution = { agentId: 'sable', reason: 'Bound the time budget', resolvedAt: new Date().toISOString() };
    expect(mergeBlocker(m, m.baseCommit)).toBeNull();
    expect(mergeBlocker(m, 'different')).toMatch(/branch changed/);
    m.agents[0].status = 'failed'; expect(mergeBlocker(m, m.baseCommit)).toMatch(/completed proposal/);
    m.agents[0].status = 'review'; m.agents[0].checks.push({ label: 'Policy', status: 'failed', detail: 'Failure' });
    expect(mergeBlocker(m, m.baseCommit)).toMatch(/failed checks/);
  });
  it('preserves independent changes and selects only the decided conflicting file', () => {
    const m = fixture();
    expect(() => composeChanges(m)).toThrow(/Resolve/);
    m.collisions[0].resolution = { agentId: 'sable', reason: 'Fail fast under load', resolvedAt: new Date().toISOString() };
    const files = composeChanges(m);
    expect(files['src/limits.ts']).toContain('class RateLimited');
    expect(files['src/delivery.ts']).toContain('await acquire(url);');
    expect(files['docs/receivers.md']).toContain('## Rate limits');
    expect(Object.keys(files).sort()).toEqual(['docs/receivers.md', 'src/delivery.ts', 'src/limits.ts']);
  });
  it('rejects resolutions that do not belong to an overlapping lane', () => {
    const m = fixture();
    m.collisions[0].resolution = { agentId: 'reed', reason: 'Invalid', resolvedAt: new Date().toISOString() };
    expect(mergeBlocker(m, m.baseCommit)).toMatch(/overlapping/);
  });
});
describe('untrusted agent proposals', () => {
  it.each(['/etc/passwd', '../x', 'src/../../x', '.git/config', 'src/./x', 'a\\b', '.braid/decisions.json', 'a\u0000b'])('blocks unsafe path %s', path => expect(validPath(path)).toBe(false));
});
