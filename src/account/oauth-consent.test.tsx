import { renderToReadableStream } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Organization } from '../../shared/account';
import type { OAuthRequestView } from '../../shared/types';
import { isRepositoryScreen, routeOf } from '../lib/address';
import { textOf } from '../test/fixtures';

vi.hoisted(() => vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', origin: 'https://braid.test' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() }));
vi.mock('./AccountProvider', () => ({ useAccount: () => ({}) }));
vi.mock('../components/shell/GlobalHeader', () => ({ GlobalHeader: () => <header /> }));
import { ConsentForm, returnsTo } from './OAuthConsent';

const team: Organization = { id: 'org', name: 'Acme', slug: 'acme', role: 'owner', workspaces: [{ id: 'w1', organizationId: 'org', name: 'Relay', slug: 'relay', visibility: 'private', createdAt: '2026-10-15T00:00:00Z' }] };
const repositories = team.workspaces.map(workspace => ({ team, workspace }));
const loopback: OAuthRequestView = { client: { name: 'Claude Code', redirect: { kind: 'loopback', host: 'localhost' }, document: null }, scope: 'work' };
async function render(view: OAuthRequestView | null, choices = repositories) {
  const stream = await renderToReadableStream(<ConsentForm view={view} repositories={choices} onAnswer={async () => undefined} />);
  await stream.allReady;
  return new Response(stream).text();
}

describe('the OAuth consent page', () => {
  it('names the client, where the answer goes and what it could do, and warns about a loopback redirect', async () => {
    const html = await render(loopback);
    const text = textOf(html);
    expect(html).toMatch(/<h1[^>]*>Authorize Claude Code<\/h1>/);
    expect(text).toContain('Returns to This computer (localhost)');
    expect(text).toContain('Read code and open pull requests within your permissions.');
    expect(text).toContain('It cannot approve or merge pull requests, or change who has access.');
    expect(text).toContain('Approve only if you started this sign-in on this computer.');
    expect(text).not.toContain('Published by');
    expect(html).toContain('All repositories you can access');
    expect(text).toContain('Access Work Read');
  });

  it('shows the host of a client metadata document and an app redirect without the loopback warning', async () => {
    const text = textOf(await render({ client: { name: 'VS Code', redirect: { kind: 'app', host: 'vscode' }, document: 'code.visualstudio.com' }, scope: 'read' }));
    expect(text).toContain('Returns to The vscode app');
    expect(text).toContain('Published by code.visualstudio.com');
    expect(text).toContain('Read code within your permissions.');
    expect(text).not.toContain('this computer');
    expect(text).not.toContain('Access Work');
  });

  it('allows account authorization without a repository, and keeps the layout while loading', async () => {
    const empty = await render(loopback, []);
    expect(textOf(empty)).toContain('All repositories you can access');
    expect(empty).not.toContain('disabled=""');
    const loading = await render(null);
    expect(loading).toMatch(/<h1[^>]*>Authorize a client<\/h1>/);
    expect(textOf(loading)).toContain('Returns to');
    expect(loading.match(/disabled=""/g)?.length).toBe(2);
  });

  it('reads where each kind of redirect returns', () => {
    expect(returnsTo({ kind: 'web', host: 'claude.ai' })).toBe('claude.ai');
    expect(returnsTo({ kind: 'loopback', host: '127.0.0.1' })).toBe('This computer (127.0.0.1)');
    expect(returnsTo({ kind: 'app', host: 'cursor' })).toBe('The cursor app');
  });

  it('is the site page at /oauth/authorize with any query', () => {
    expect(routeOf('/oauth/authorize?client_id=x&state=y', 'https://braid.test')).toMatchObject({ screen: 'authorize', repo: null });
    expect(routeOf('/oauth/token', 'https://braid.test').screen).toBe('not-found');
    expect(isRepositoryScreen('authorize')).toBe(false);
  });
});
