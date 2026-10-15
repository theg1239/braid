import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const account = vi.hoisted(() => ({
  user: { id: 'github:1', email: 'ishaan@example.com', name: 'Ishaan' },
  organizations: [
    { id: 'team-acmvit', name: 'ACM VIT', slug: 'acmvit', role: 'owner', workspaces: [{ id: 'ws-1', organizationId: 'team-acmvit', name: 'ExamCooker', slug: 'examcooker', visibility: 'public', createdAt: '2026-10-02T09:10:00Z' }] },
    { id: 'team-conclave', name: 'Conclave', slug: 'conclave', role: 'member', workspaces: [] },
  ],
}));

vi.mock('@cloudflare/kumo', async (original) => ({ ...(await original<typeof import('@cloudflare/kumo')>()), useKumoToastManager: () => ({ add: () => {} }) }));
vi.mock('../../account/AccountProvider', () => ({ useAccount: () => ({ account, refresh: async () => {} }) }));
vi.mock('../../account/OrganizationSetup', () => ({ CreateOrganizationForm: () => <form>Create organization</form> }));
vi.mock('../../account/VisibilityChoice', () => ({ VisibilityChoice: () => <fieldset>Visibility</fieldset> }));
vi.mock('../../lib/api', () => ({ errorMessage: (error: unknown) => String(error) }));
vi.mock('../../account/api', () => ({ accountApi: { createWorkspace: async () => ({}) } }));
vi.mock('../../lib/router', () => ({ navigate: () => {}, paths: { repo: () => '/', site: () => '/' }, useRoute: () => ({ query: new URLSearchParams('team=acmvit') }) }));
vi.stubGlobal('window', { location: { host: 'braid.example' }, history: { length: 1, back: () => {} } });
vi.stubGlobal('document', { title: '' });

const { repositoryName } = await import('./name');
const { NewRepositoryScreen } = await import('../../screens/NewRepositoryScreen');

describe('a new repository', () => {
  it('asks for the owner, the name and who can see it, offering only teams the person owns', () => {
    const html = renderToStaticMarkup(<NewRepositoryScreen />);
    expect(html).toContain('New repository');
    expect(html).toContain('acmvit');
    expect(html).not.toContain('Conclave');
    expect(html).toContain('Repository name');
    expect(html).toContain('Visibility');
    expect(html).toContain('Create repository');
  });

  it('names the code after the repository in a form the server accepts', () => {
    expect(repositoryName('the-everything-assistant')).toBe('the-everything-assistant');
    expect(repositoryName('The Everything Assistant')).toBe('the-everything-assistant');
    expect(repositoryName('2048')).toBe('repo-2048');
    expect(repositoryName('你好')).toBe('repository');
    expect(repositoryName('a'.repeat(80))).toHaveLength(48);
    expect(repositoryName('x')).toBe('x-repo');
  });
});
