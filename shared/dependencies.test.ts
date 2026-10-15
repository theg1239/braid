import { describe, expect, it } from 'vitest';
import { introducedDependencies } from './dependencies';

const lock = (packages: Record<string, string>) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'relay' }, ...Object.fromEntries(Object.entries(packages).map(([path, version]) => [path, { version }])) } });

describe('dependencies a change introduces', () => {
  it('reads exact versions from lockfiles, pinned manifests, requirements and go.mod', () => {
    const files = [
      { path: 'package-lock.json', before: lock({ 'node_modules/lodash': '4.17.21' }), after: lock({ 'node_modules/lodash': '4.17.20', 'node_modules/@scope/pad': '1.3.0', 'node_modules/a/node_modules/b': '2.0.0' }) },
      { path: 'services/api/package.json', before: '{"dependencies":{"hono":"^4.0.0"}}', after: '{"dependencies":{"hono":"^4.1.0","zod":"3.23.8"}}' },
      { path: 'requirements.txt', before: 'requests==2.31.0\n', after: 'requests==2.31.0\nurllib3==1.26.0  # pinned\nflask>=2\n' },
      { path: 'go.mod', before: 'module x\n', after: 'module x\nrequire golang.org/x/net v0.17.0\n' },
    ];
    expect(introducedDependencies(files).map(d => `${d.ecosystem}:${d.name}@${d.version}`)).toEqual([
      'npm:lodash@4.17.20', 'npm:@scope/pad@1.3.0', 'npm:b@2.0.0', 'npm:zod@3.23.8', 'PyPI:urllib3@1.26.0', 'Go:golang.org/x/net@0.17.0',
    ]);
  });

  it('ignores ranges, removals and unparseable files', () => {
    expect(introducedDependencies([
      { path: 'package.json', before: null, after: '{"dependencies":{"react":"^19.0.0"}}' },
      { path: 'package-lock.json', before: lock({ 'node_modules/x': '1.0.0' }), after: null },
      { path: 'package-lock.json', before: null, after: '{not json' },
    ])).toEqual([]);
  });
});
