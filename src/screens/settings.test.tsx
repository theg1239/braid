import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '../../shared/policy';
import { parsePolicy } from '../../shared/policy-file';
vi.hoisted(() => vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', origin: 'https://braid.test' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() }));
const state = vi.hoisted(() => ({ section: 'collaborators' as string | undefined, signedIn: false, accounts: true, member: false, mode: 'demo', reports: null as unknown, policy: null as unknown, queue: null as unknown, queueError: null as string | null }));
vi.mock('../lib/live', () => ({ useLive: (key: string) => ({ data: key === 'policy' ? state.policy : key === 'queue' ? state.queue : key === 'agent-reports' ? state.reports : null, error: key === 'queue' ? state.queueError : null }), setLive: vi.fn(), refreshLive: vi.fn() }));
vi.mock('../lib/router', async original => ({ ...await original<typeof import('../lib/router')>(), useRoute: () => ({ id: state.section }) }));
vi.mock('../lib/title', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'relay' }, capabilities: { mode: state.mode } }) }));
vi.mock('../account/AccountProvider', () => ({ useAccount: () => ({ accounts: state.accounts, account: state.signedIn ? { user: { id: 'owner' } } : null }) }));
vi.mock('../account/RepositoryGate', () => ({ useRepository: () => ({ team: state.member ? { id: 'team' } : null }) }));
import { SettingsScreen, settingsSections } from './SettingsScreen';

beforeEach(() => { state.section = 'collaborators'; state.signedIn = false; state.accounts = true; state.member = false; state.mode = 'demo'; state.reports = null; state.policy = null; state.queue = null; state.queueError = null; });

describe('settings pages', () => {
  it('counts unresolved reports on the Agents settings link for members, reserving its place while loading', () => {
    state.section = 'rules'; state.member = true; state.signedIn = true; state.mode = 'live';
    expect(renderToStaticMarkup(<SettingsScreen />)).toContain('class="settings__report-count"');
    state.reports = { items: [{ id: 'one' }, { id: 'two' }], canResolve: false };
    expect(renderToStaticMarkup(<SettingsScreen />)).toContain('aria-label="2 unresolved reports">2</span>');
    state.reports = { items: [{ id: 'two' }], canResolve: false };
    expect(renderToStaticMarkup(<SettingsScreen />)).toContain('aria-label="1 unresolved report">1</span>');
    state.member = false;
    expect(renderToStaticMarkup(<SettingsScreen />)).not.toContain('settings__report-count');
  });
  it('keep the owner key off a deployment with accounts unless someone is signed in', () => {
    expect(settingsSections({ accounts: true, signedIn: false, member: false, repository: true })).not.toContain('account');
    expect(settingsSections({ accounts: true, signedIn: true, member: false, repository: true })).toContain('account');
    expect(settingsSections({ accounts: false, signedIn: false, member: false, repository: true })).toContain('account');
  });
  it('show Access to a signed-in member and GitHub once there is a repository', () => {
    expect(settingsSections({ accounts: true, signedIn: true, member: true, repository: false })).toEqual(['general', 'rules', 'security', 'queue', 'webhooks', 'agents', 'collaborators', 'account']);
    expect(settingsSections({ accounts: true, signedIn: false, member: false, repository: true })).toEqual(['general', 'rules', 'security', 'queue', 'webhooks', 'agents', 'github']);
  });
  it.each(['collaborators', 'account', 'missing'])('shows not found for unavailable %s addresses instead of General', section => {
    state.section = section;
    const html = renderToStaticMarkup(<SettingsScreen />);
    expect(html).toContain('Page not found');
    expect(html).toContain('Back to settings');
    expect(html).not.toContain('Default branch');
    expect(html).not.toContain('settings__body');
  });
  it('does not expose Access to a signed-in nonmember', () => {
    state.signedIn = true;
    expect(renderToStaticMarkup(<SettingsScreen />)).toContain('Page not found');
  });
  it('keeps Rules in its skeleton until the GitHub checks row is known', () => {
    state.section = 'rules'; state.policy = { policy: DEFAULT_POLICY, errors: [] };
    const waiting = renderToStaticMarkup(<SettingsScreen />);
    expect(waiting).toContain('Loading the rules');
    expect(waiting).not.toContain('id="checks"');
    state.queue = { github: { fullName: 'example/relay' } };
    const ready = renderToStaticMarkup(<SettingsScreen />);
    expect(ready).toContain('GitHub checks');
    expect(ready).toContain('id="checks"');
    expect(ready).not.toContain('Loading the rules');
  });
  it('still shows the known policy when the queue read fails', () => {
    state.section = 'rules'; state.policy = { policy: DEFAULT_POLICY, errors: [] }; state.queueError = 'Unavailable';
    const html = renderToStaticMarkup(<SettingsScreen />);
    expect(html).toContain('id="rulesets"');
    expect(html).not.toContain('Loading the rules');
  });
  it('states each safeguard once: Code security and the protected row keep theirs, and a shared sentence stays when it says more', () => {
    state.section = 'rules'; state.policy = { policy: DEFAULT_POLICY, errors: [] }; state.queue = {};
    const html = renderToStaticMarkup(<SettingsScreen />).replaceAll('&#x27;', "'");
    expect(html).toContain('A pull request that adds a token or private key or breaks an instruction goes back to its author.');
    expect(html).not.toContain('A pull request that deletes or skips tests or downgrades a dependency goes to a person.');
    expect(html).not.toContain('Dependencies a pull request adds are checked on OSV.dev');
    expect(html).not.toContain('Changes to the rules, CI, code owners');
    expect(html).toContain('A pull request sent back 4 times goes to a person instead of another round.');
  });
  it.each(['{\n  "autonomy": "auto",\n}', '{"autonomy":"invalid"}'])('shows policy errors and the person requirement in Rules: %s', text => {
    state.section = 'rules'; state.policy = parsePolicy(text); state.queue = {};
    const html = renderToStaticMarkup(<SettingsScreen />);
    expect(html).toContain('Pull requests wait for a person until');
    expect(html).toContain('fixed.');
    expect(html).toContain(text.includes('\n') ? 'The policy file must be a valid JSON object.' : 'autonomy must be');
  });
});
