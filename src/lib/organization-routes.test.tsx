import { describe, expect, it } from 'vitest';
import { parsePath, isRepositoryScreen } from './address';
import { RESERVED_OWNERS } from '../../shared/routes';
describe('organization routes', () => {
  it.each(['repositories', 'teams', 'people', 'settings'])('resolves /orgs/acme/%s as a site page', section => {
    expect(parsePath(`/orgs/acme/${section}`)).toMatchObject({ screen: 'organization', repo: null, id: 'acme', sub: section });
  });
  it('resolves organization creation and a nested team without treating them as repositories', () => {
    expect(parsePath('/organizations/new')).toMatchObject({ screen: 'new-organization', repo: null });
    expect(parsePath('/orgs/acme/teams/engineering')).toMatchObject({ screen: 'organization', repo: null, id: 'acme', sub: 'teams', path: 'engineering' });
    for (const screen of ['organization', 'new-organization'] as const) expect(isRepositoryScreen(screen)).toBe(false);
  });
  it.each(['/orgs', '/orgs/acme', '/orgs/acme/nope', '/orgs/acme/people/someone', '/orgs/acme/teams/dev/more', '/organizations/other', '/organizations/new/extra'])('rejects %s', path => expect(parsePath(path).screen).toBe('not-found'));
  it('reserves both top-level namespaces and keeps repository URLs intact', () => {
    expect(RESERVED_OWNERS.has('orgs')).toBe(true); expect(RESERVED_OWNERS.has('organizations')).toBe(true);
    expect(parsePath('/acme/app')).toMatchObject({ screen: 'code', repo: { owner: 'acme', repo: 'app' } });
  });
});
