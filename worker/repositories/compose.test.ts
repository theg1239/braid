import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeChanges, type ComposeChange } from './compose';
import { pushCommits } from '../git/push';
import { startGitServer } from '../test/git-server';

let git: Awaited<ReturnType<typeof startGitServer>>;
beforeAll(async () => { git = await startGitServer(); });
afterAll(async () => { await git?.close(); });

const router = ['export const routes = [', "  '/health',", "  '/status',", '];', '', 'export function handle(path: string) {', '  return routes.includes(path);', '}', ''].join('\n');
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'relay', version: '1.0.0', dependencies: deps }, null, 2) + '\n';

describe('composing concurrent changes', () => {
  it('lands many agents editing the same file in one batch and reports exactly what needs attention', async () => {
    const base = git.commitTree({ 'src/router.ts': router, 'package.json': pkg({ hono: '^4.0.0' }), 'CHANGELOG.md': '# Changes\n', 'docs/a.md': 'A\n' });
    // Main moved after the agents started: someone else already changed the handler.
    const head = git.commitTree({ 'src/router.ts': router.replace('return routes.includes(path);', 'return routes.includes(path.toLowerCase());') }, base, 'Earlier landing');
    const changes: ComposeChange[] = [
      { id: 'add-route', baseCommit: base, files: { 'src/router.ts': router.replace("  '/status',\n", "  '/status',\n  '/metrics',\n"), 'CHANGELOG.md': '# Changes\n- Metrics route\n' } },
      { id: 'add-dependency', baseCommit: base, files: { 'package.json': pkg({ hono: '^4.0.0', zod: '^4.0.0' }), 'CHANGELOG.md': '# Changes\n- Validate input\n' } },
      { id: 'another-dependency', baseCommit: base, files: { 'package.json': pkg({ hono: '^4.0.0', jose: '^6.0.0' }) } },
      // Rewrites the same handler line the earlier landing changed: a real conflict.
      { id: 'conflicting-handler', baseCommit: base, files: { 'src/router.ts': router.replace('return routes.includes(path);', 'return routes.some(route => route === path);') } },
      { id: 'duplicate-route', baseCommit: base, files: { 'src/router.ts': router.replace("  '/status',\n", "  '/status',\n  '/metrics',\n") } },
      { id: 'delete-docs', baseCommit: base, files: { 'docs/a.md': null } },
    ];
    const results = await composeChanges(git.repository, head, changes);
    const byId = Object.fromEntries(results.map(result => [result.id, result]));
    expect(byId['add-route']).toMatchObject({ status: 'applied', strategies: { 'src/router.ts': 'line', 'CHANGELOG.md': 'fast-forward' } });
    expect(byId['add-dependency']).toMatchObject({ status: 'applied', strategies: { 'package.json': 'fast-forward', 'CHANGELOG.md': 'union' } });
    expect(byId['another-dependency']).toMatchObject({ status: 'applied', strategies: { 'package.json': 'json' } });
    expect(byId['conflicting-handler'].status).toBe('conflicted');
    expect(byId['conflicting-handler'].conflicts).toEqual([expect.objectContaining({ path: 'src/router.ts', kind: 'content', regions: [expect.objectContaining({ base: ['  return routes.includes(path);\n'], ours: ['  return routes.includes(path.toLowerCase());\n'], theirs: ['  return routes.some(route => route === path);\n'] })] })]);
    // An identical edit that already landed earlier in the batch adds nothing.
    expect(byId['duplicate-route']).toMatchObject({ status: 'empty', strategies: { 'src/router.ts': 'already-applied' } });
    expect(byId['delete-docs']).toMatchObject({ status: 'applied', files: { 'docs/a.md': null } });

    git.native(['update-ref', 'refs/heads/main', head]);
    const landed = results.filter(result => result.status === 'applied');
    const commits = await pushCommits({ repository: git.repository, remote: git.remote, token: 'fixture', branch: 'main', expectedHead: head, commits: landed.map(result => ({ files: result.files, message: result.id })) });
    expect(commits).toHaveLength(4);
    expect(git.native(['show', 'main:src/router.ts'])).toBe(router.replace("  '/status',\n", "  '/status',\n  '/metrics',\n").replace('return routes.includes(path);', 'return routes.includes(path.toLowerCase());'));
    expect(JSON.parse(git.native(['show', 'main:package.json'])).dependencies).toEqual({ hono: '^4.0.0', jose: '^6.0.0', zod: '^4.0.0' });
    expect(git.native(['show', 'main:CHANGELOG.md'])).toBe('# Changes\n- Metrics route\n- Validate input\n');
    expect(git.native(['ls-tree', '-r', '--name-only', 'main'])).not.toContain('docs/a.md');
    git.native(['fsck', '--full', '--no-dangling']);
  }, 30_000);

  it('composes a swarm of fifty agents appending to the same registry', async () => {
    const registry = 'export const handlers = {\n};\n';
    const base = git.commitTree({ 'src/handlers/index.ts': registry, 'src/handlers/README.md': '# Handlers\n' });
    const changes: ComposeChange[] = Array.from({ length: 50 }, (_, i) => ({
      id: `agent-${i}`, baseCommit: base,
      files: {
        [`src/handlers/h${i}.ts`]: `export function h${i}() { return ${i}; }\n`,
        'src/handlers/index.ts': `import { h${i} } from './h${i}';\n` + registry.replace('};', `  h${i},\n};`),
      },
    }));
    const results = await composeChanges(git.repository, base, changes, { union: ['src/handlers/index.ts'] });
    expect(results.filter(result => result.status === 'applied')).toHaveLength(50);
    git.native(['update-ref', 'refs/heads/swarm', base]);
    const stale = git.commitTree({ 'unrelated.txt': 'moved\n' }, base);
    const commits = await pushCommits({ repository: git.repository, remote: git.remote, token: 'fixture', branch: 'swarm', expectedHead: base, commits: results.map(result => ({ files: result.files, message: result.id })) });
    expect(commits).toHaveLength(50);
    const final = git.native(['show', 'swarm:src/handlers/index.ts']);
    for (let i = 0; i < 50; i++) {
      expect(final).toContain(`import { h${i} } from './h${i}';`);
      expect(final).toContain(`  h${i},`);
    }
    // A batch composed for one trunk revision never lands on another.
    git.native(['update-ref', 'refs/heads/swarm', stale]);
    await expect(pushCommits({ repository: git.repository, remote: git.remote, token: 'fixture', branch: 'swarm', expectedHead: base, commits: [{ files: results[0].files, message: 'stale' }] })).rejects.toThrow(/branch moved/);
  }, 30_000);

  it('reports deletes, type changes, binary edits and conflicting modes instead of guessing', async () => {
    const base = git.commitTree({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'dir/c.txt': 'c\n', 'bin.dat': 'x\0y' });
    const head = git.commitTree({ 'a.txt': 'a changed on main\n', 'b.txt': null, 'bin.dat': 'x\0z' }, base);
    const results = await composeChanges(git.repository, head, [
      { id: 'delete-modified', baseCommit: base, files: { 'a.txt': null } },
      { id: 'modify-deleted', baseCommit: base, files: { 'b.txt': 'b changed\n' } },
      { id: 'file-over-directory', baseCommit: base, files: { 'dir': 'not a directory\n' } },
      { id: 'binary', baseCommit: base, files: { 'bin.dat': 'x\0w' } },
      { id: 'add-add', baseCommit: base, files: { 'new.txt': 'one\n' } },
      { id: 'add-add-again', baseCommit: base, files: { 'new.txt': 'two\n' } },
      { id: 'under-new-file', baseCommit: base, files: { 'new.txt/child': 'x\n' } },
    ]);
    expect(results.map(result => [result.id, result.status, result.conflicts.map(conflict => conflict.kind)])).toEqual([
      ['delete-modified', 'conflicted', ['delete-modify']],
      ['modify-deleted', 'conflicted', ['modify-delete']],
      ['file-over-directory', 'conflicted', ['type']],
      ['binary', 'conflicted', ['binary']],
      ['add-add', 'applied', []],
      ['add-add-again', 'conflicted', ['add-add']],
      ['under-new-file', 'conflicted', ['type']],
    ]);
  });
});
