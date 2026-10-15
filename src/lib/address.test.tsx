import { describe, expect, it } from 'vitest';
import { addressPath, encodePath, isRepositoryScreen, legacyRedirect, parsePath, routeOf } from './address';

const origin = 'https://braid.example';

describe('Repository addresses', () => {
  it('reads a repository and its screens from the address', () => {
    expect(parsePath('/acmvit/examcooker')).toMatchObject({ screen: 'code', repo: { owner: 'acmvit', repo: 'examcooker' }, path: '' });
    expect(parsePath('/acmvit/examcooker/pulls')).toMatchObject({ screen: 'pulls', repo: { owner: 'acmvit', repo: 'examcooker' } });
    expect(parsePath('/acmvit/examcooker/pull/12/files')).toMatchObject({ screen: 'pull', id: '12', sub: 'files' });
    expect(parsePath('/acmvit/examcooker/tasks/task-1')).toMatchObject({ screen: 'task', id: 'task-1' });
    expect(parsePath('/acmvit/examcooker/settings/rules')).toMatchObject({ screen: 'settings', id: 'rules' });
    expect(parsePath('/acmvit/examcooker/agents')).toMatchObject({ screen: 'agents' });
  });

  it('lays files out as GitHub does, under tree, blob and blame', () => {
    expect(parsePath('/acmvit/examcooker/tree/main/src/app')).toMatchObject({ screen: 'code', view: 'tree', ref: 'main', path: 'src/app' });
    expect(parsePath('/acmvit/examcooker/blob/main/src/app/layout.tsx')).toMatchObject({ screen: 'code', view: 'blob', path: 'src/app/layout.tsx' });
    expect(parsePath('/example/relay/blame/main/src/delivery.ts')).toMatchObject({ screen: 'code', view: 'blame', path: 'src/delivery.ts', repo: { owner: 'example', repo: 'relay' } });
    expect(parsePath('/acmvit/examcooker/blob/main/a%20b/c%2Fd.md').path).toBe('a b/c/d.md');
    expect(parsePath('/acmvit/examcooker/blob')).toMatchObject({ screen: 'not-found' });
  });

  it('keeps the recorded example at /example/relay and no other address under example', () => {
    expect(parsePath('/example/relay')).toMatchObject({ screen: 'code', repo: { owner: 'example', repo: 'relay' } });
    expect(parsePath('/example/other')).toMatchObject({ screen: 'not-found', repo: null });
    expect(parsePath('/example')).toMatchObject({ screen: 'not-found' });
  });

  it('never mistakes the site, a reserved path or a bad slug for an address', () => {
    expect(parsePath('/')).toMatchObject({ screen: 'home', repo: null });
    expect(parsePath('/explore')).toMatchObject({ screen: 'explore', repo: null });
    expect(parsePath('/signin')).toMatchObject({ screen: 'signin', repo: null });
    expect(parsePath('/explore/x')).toMatchObject({ screen: 'not-found' });
    expect(parsePath('/settings/x')).toMatchObject({ screen: 'settings', id: 'x' });
    expect(parsePath('/api/state')).toMatchObject({ screen: 'not-found' });
    expect(parsePath('/login/x')).toMatchObject({ screen: 'not-found' });
    expect(parsePath('/Acme/repo')).toMatchObject({ screen: 'code', repo: { owner: 'acme', repo: 'repo' } });
    expect(parsePath('/acme/-repo')).toMatchObject({ screen: 'code', repo: { owner: 'acme', repo: '-repo' } });
    expect(parsePath('/acme')).toMatchObject({ screen: 'owner', id: 'acme' });
    expect(parsePath('/api')).toMatchObject({ screen: 'not-found' });
    expect(parsePath('/Acme')).toMatchObject({ screen: 'not-found' });
  });

  it('keeps the single-owner deployment’s flat routes', () => {
    expect(parsePath('/pulls')).toMatchObject({ screen: 'pulls', repo: null });
    expect(parsePath('/pull/3/checks')).toMatchObject({ screen: 'pull', id: '3', sub: 'checks', repo: null });
    expect(parsePath('/blame/main/README.md')).toMatchObject({ screen: 'code', view: 'blame', path: 'README.md', repo: null });
    expect(parsePath('/settings')).toMatchObject({ screen: 'settings', id: null, repo: null });
  });

  it('builds addresses and paths that read back the same', () => {
    expect(addressPath({ owner: 'acmvit', repo: 'examcooker' })).toBe('/acmvit/examcooker');
    expect(encodePath('src/a b/c#d.ts')).toBe('src/a%20b/c%23d.ts');
    expect(parsePath(`/x/y/blob/main/${encodePath('src/a b/c#d.ts')}`).path).toBe('src/a b/c#d.ts');
  });
});

describe('Earlier addresses', () => {
  it('moves files from the query into blob and blame paths', () => {
    expect(legacyRedirect('/code', '?path=src%2Fdelivery.ts&view=blame', '')).toBe('/blame/main/src/delivery.ts');
    expect(legacyRedirect('/code', '?path=src%2Fdelivery.ts', '')).toBe('/blob/main/src/delivery.ts');
    expect(legacyRedirect('/repository', '?path=docs%2F', '')).toBe('/blob/main/docs');
    expect(legacyRedirect('/code', '', '')).toBe('/');
    expect(legacyRedirect('/repository', '', '')).toBe('/');
  });

  it('keeps the earlier pull request, task and settings links working', () => {
    expect(legacyRedirect('/changes/3', '', '')).toBe('/pull/3');
    expect(legacyRedirect('/changes', '?stage=needs-you', '')).toBe('/pulls?review=requested');
    expect(legacyRedirect('/pulls/7', '', '')).toBe('/pull/7');
    expect(legacyRedirect('/missions/m1', '', '')).toBe('/tasks/m1');
    expect(legacyRedirect('/landing', '', '')).toBe('/queue');
    expect(legacyRedirect('/rules', '', '#notes')).toBe('/settings/agents');
    expect(legacyRedirect('/settings', '', '#team')).toBe('/settings/collaborators');
    expect(legacyRedirect('/pulls', '', '')).toBeNull();
    expect(legacyRedirect('/acmvit/examcooker/pulls', '', '')).toBeNull();
  });

  it('resolves an href through the redirects to its route', () => {
    expect(routeOf('/code?path=README.md', origin)).toMatchObject({ screen: 'code', view: 'blob', path: 'README.md', href: '/blob/main/README.md' });
    expect(routeOf('/example/relay/pull/23?x=1#top', origin)).toMatchObject({ screen: 'pull', id: '23', hash: 'top', href: '/example/relay/pull/23?x=1#top' });
    expect(routeOf('/example/relay/pull/23?x=1', origin).query.get('x')).toBe('1');
  });
});

describe('owner pages, history, branches and comparisons', () => {
  it('reads a team page, a branch or path history, the branch list and a comparison', () => {
    expect(parsePath('/acmvit')).toMatchObject({ screen: 'owner', repo: null, id: 'acmvit' });
    expect(parsePath('/explore')).toMatchObject({ screen: 'explore' });
    expect(parsePath('/acmvit/examcooker/commits')).toMatchObject({ screen: 'commits', ref: null, path: '' });
    expect(parsePath('/acmvit/examcooker/commits/feature%2Flogin/src/a.ts')).toMatchObject({ screen: 'commits', ref: 'feature/login', path: 'src/a.ts' });
    expect(parsePath('/acmvit/examcooker/branches')).toMatchObject({ screen: 'branches', repo: { owner: 'acmvit', repo: 'examcooker' } });
    expect(parsePath('/acmvit/examcooker/commit/dd4e6718182dc29689823547e724612726b1c500')).toMatchObject({ screen: 'commit', id: 'dd4e6718182dc29689823547e724612726b1c500' });
    expect(parsePath('/acmvit/examcooker/commit')).toMatchObject({ screen: 'not-found' });
    expect(routeOf('/acmvit/examcooker/search?q=retry', origin)).toMatchObject({ screen: 'search' });
    expect(parsePath('/acmvit/examcooker/compare/main...stable')).toMatchObject({ screen: 'compare', id: 'main...stable' });
    expect(isRepositoryScreen('owner')).toBe(false);
    expect(isRepositoryScreen('commits')).toBe(true);
  });
});
