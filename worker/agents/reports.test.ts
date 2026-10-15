import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentReport, AgentReports, AgentScope } from '../../shared/types';
import type { AccountIdentity } from '../../shared/account';
import { AgentReportStore } from './reports';
import api from '../http/api';
import { digest, sessionToken } from '../http/auth';
import { mintAccess } from '../http/agent-token';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { Trunk } from '../changes/trunk';
import { trunkName } from '../changes/names';
import { handleMcp, type ApiCall } from '../http/mcp';
import type { BraidEnv } from '../env';
import { storageFixture } from '../test/storage';
import { organizationWithRepository } from '../test/organization';

const fixtures: ReturnType<typeof storageFixture>[] = [];
const storage = () => { const fixture = storageFixture(); fixtures.push(fixture); return fixture; };
afterEach(() => { vi.useRealTimers(); for (const fixture of fixtures.splice(0)) fixture.db.close(); });
const input = { summary: 'Missing branch creation tool', details: '<script>alert(1)</script>\n**Keep this literal.**', tool: 'create_branch', pull_request: 42 };
const agent: AgentReport['agent'] = { connection: 'connection-1', name: 'Codex', model: 'gpt-6', owner: { name: '@maya', publicId: 'person-maya' } };
const message = (args: unknown = input) => ({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { name: 'report_problem', arguments: args } });

async function fixture() {
  const directory = new Directory(storage().ctx, {} as BraidEnv), security = new Security(storage().ctx, {} as BraidEnv);
  const user = { id: 'maya', email: 'maya@example.test', name: 'Maya', username: 'maya' };
  const member = { id: 'member', email: 'member@example.test', name: 'Member' };
  const org = organizationWithRepository(directory, user, 'Agent reports', 'public'), workspace = org.workspaces[0].id;
  directory.setUsername(user, 'maya');
  await directory.accept(member, (await directory.invite(user.id, org.id, { email: member.email, role: 'member' })).token);
  const trunks = new Map<string, Trunk>();
  const fallback = vi.fn(async () => Response.json({}));
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', SESSION_SECRET: 'agent-report-test-secret-123456789',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: fallback }) },
    TRUNKS: { getByName: (name: string) => { if (!trunks.has(name)) trunks.set(name, new Trunk(storage().ctx, env)); return trunks.get(name)!; } },
  } as unknown as BraidEnv;
  const token = 'braid_agent_report_test', grant = agent.connection;
  const issue = async (scope: AgentScope = 'work') => {
    await security.issueAgent(await digest(token), { id: grant, user, workspaceId: workspace, scope, label: 'Codex', expires: Date.now() + 2 * 86_400_000 });
    return mintAccess(env, { grant, user, workspace, team: org.id, scope, agent: grant, name: 'Codex', model: 'gpt-6', owner: { name: '@maya', email: user.email, publicId: 'person-maya' }, exp: Date.now() + 60_000 });
  };
  const login = async (person: AccountIdentity) => { const token = await sessionToken(env.SESSION_SECRET); await security.issue(await digest(token), Date.now() + 86_400_000, person); return `__Host-braid-session=${token}`; };
  const call = (path: string, options: { body?: unknown; token?: string; cookie?: string; workspace?: string; headers?: Record<string, string> } = {}) => api.fetch(new Request(`https://braid.test${path}`, {
    method: options.body === undefined ? 'GET' : 'POST', headers: { 'x-braid-workspace': options.workspace ?? workspace, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }), env);
  return { directory, security, user, member, org, workspace, env, fallback, token, grant, issue, call, cookie: await login(user), memberCookie: await login(member) };
}

describe('report_problem through the repository gateway', () => {
  it('saves both work token types with the known owner and connection, ignoring supplied attribution', async () => {
    const f = await fixture(), access = await f.issue();
    for (const token of [access, f.token]) {
      const response = await f.call('/mcp', { token, body: message({ ...input, agent: { connection: 'forged' }, model: 'forged', owner: { name: 'forged' } }), headers: { 'x-braid-owner': 'forged', 'x-braid-connection': 'forged' } });
      expect(response.status).toBe(200);
      const answer = await response.json() as { result: { structuredContent: AgentReport; isError?: boolean; content: { text: string }[] } };
      expect(answer.result.isError).toBeUndefined();
      expect(answer.result.content[0].text).toContain('Report saved');
      expect(answer.result.structuredContent).toMatchObject({ summary: input.summary, details: input.details, tool: input.tool, pullRequest: 42, agent: { connection: f.grant, owner: { name: '@maya' } } });
      expect(answer.result.structuredContent.agent.model).toBe(token === access ? 'gpt-6' : undefined);
      expect(JSON.stringify(answer)).not.toContain('forged');
      expect(JSON.stringify(answer)).not.toContain(f.user.email);
    }
    const listed = await f.call('/api/agent-reports', { cookie: f.cookie });
    expect(listed.status).toBe(200);
    expect((await listed.json() as AgentReports).items).toHaveLength(2);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it('refuses anonymous calls, forged headers, browser report writes and wrong-repository tokens', async () => {
    const f = await fixture(), access = await f.issue();
    const anonymous = await f.call('/mcp', { body: message() });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: expect.stringContaining('Bearer') });
    expect((await f.call('/api/agent-reports', { body: input, headers: { 'x-braid-role': 'owner', 'x-braid-connection': f.grant } })).status).toBe(401);
    expect((await f.call('/api/agent-reports')).status).toBe(401);
    expect((await f.call('/api/agent-reports', { body: input, cookie: f.cookie })).status).toBe(403);
    expect((await f.call('/mcp', { body: message(), token: access, workspace: 'another' })).status).toBe(403);
    expect((await f.call('/mcp', { body: message(), token: 'invalid' })).status).toBe(401);
    expect((await f.call('/api/agent-reports', { body: input, token: access, workspace: 'demo' })).status).toBe(403);
    expect((await (await f.call('/api/agent-reports', { cookie: f.cookie })).json() as AgentReports).items).toEqual([]);
  });

  it.each(['read', 'setup', 'fleet'] as const)('refuses %s connections and access tokens', async scope => {
    const f = await fixture(), access = await f.issue(scope);
    for (const token of [f.token, access]) expect((await f.call('/mcp', { token, body: message() })).status).toBe(403);
  });

  it('rejects a revoked connection and its already minted token', async () => {
    const f = await fixture(), access = await f.issue();
    f.security.revokeAgent(f.user.id, f.grant);
    for (const token of [access, f.token]) expect((await f.call('/mcp', { token, body: message() })).status).toBe(401);
  });

  it('shares a daily quota across tokens, returns an honest MCP refusal and Retry-After on HTTP', async () => {
    const f = await fixture(), access = await f.issue();
    const results = await Promise.all(Array.from({ length: 21 }, (_, i) => f.call('/api/agent-reports', { token: i % 2 ? access : f.token, body: { summary: `Problem ${i}` } })));
    expect(results.filter(result => result.status === 201)).toHaveLength(20);
    const limited = results.find(result => result.status === 429)!;
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(86_390);
    expect(await limited.json()).toMatchObject({ error: expect.stringContaining('20 reports per day') });
    const answer = await f.call('/mcp', { token: access, body: message() });
    expect(await answer.json()).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('20 reports per day') }] } });
  });

  it('keeps fleet attribution while sharing the connection quota across identities and renewals', async () => {
    const f = await fixture();
    await f.issue('fleet');
    for (let i = 0; i < 21; i++) {
      const name = `Agent ${i}`, token = await mintAccess(f.env, { grant: f.grant, user: f.user, workspace: f.workspace, team: f.org.id,
        scope: 'work', agent: `fleet:${f.grant}:agent-${i}`, name, model: 'gpt-6', fleet: 'Fleet', exp: Date.now() + 60_000 });
      const response = await f.call('/api/agent-reports', { token, body: input });
      expect(response.status).toBe(i < 20 ? 201 : 429);
      if (i < 20) expect(await response.json()).toMatchObject({ agent: { connection: f.grant, name, model: 'gpt-6', owner: { name: '@maya' } } });
    }
  });

  it('lets members read and only owners resolve, including when a member has repository write access', async () => {
    const f = await fixture(), access = await f.issue();
    const saved = await (await f.call('/api/agent-reports', { token: access, body: input })).json() as AgentReport;
    const path = `/api/agent-reports/${saved.id}/resolve`;
    expect(await (await f.call('/api/agent-reports', { cookie: f.memberCookie })).json()).toMatchObject({ items: [saved], canResolve: false });
    expect((await f.call(path, { body: {}, cookie: f.memberCookie })).status).toBe(403);
    const team = f.directory.createOrgTeam(f.user.id, { orgId: f.org.id, name: 'Writers' }).team;
    f.directory.setTeamMember(f.user.id, { orgId: f.org.id, teamId: team.id, memberId: f.member.id, role: 'member' });
    f.directory.setTeamRepository(f.user.id, { orgId: f.org.id, teamId: team.id, workspaceId: f.workspace, permission: 'write' });
    expect((await f.call(path, { body: {}, cookie: f.memberCookie })).status).toBe(403);
    for (const token of [access, f.token]) expect((await f.call(path, { body: {}, token })).status).toBe(403);
    expect(await (await f.call(path, { body: {}, cookie: f.cookie })).json()).toEqual({ items: [], canResolve: true });
    expect((await f.call(path, { body: {}, cookie: f.cookie })).status).toBe(200);
    expect((await f.call('/api/agent-reports/ar_00000000-0000-0000-0000-000000000000/resolve', { body: {}, cookie: f.cookie })).status).toBe(404);
  });
});

describe('bounded persistent reports', () => {
  it('keeps the newest 200 across restarts and retains quotas after pruning and resolving', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fixture = storage(); let store = new AgentReportStore(fixture.storage);
    for (let i = 0; i < 220; i++) expect(store.add({ ...agent, connection: `connection-${Math.floor(i / 20)}` }, { summary: String(i) }).ok).toBe(true);
    store = new AgentReportStore(fixture.storage);
    expect(store.list()).toHaveLength(200);
    expect(store.list().map(report => report.summary)).toEqual(Array.from({ length: 200 }, (_, i) => String(219 - i)));
    for (const report of store.list()) expect(store.resolve(report.id).ok).toBe(true);
    expect(store.list()).toEqual([]);
    for (const connection of ['connection-0', 'connection-10']) expect(store.add({ ...agent, connection }, input)).toMatchObject({ ok: false, status: 429 });
    vi.advanceTimersByTime(86_400_000);
    expect(store.add({ ...agent, connection: 'connection-0' }, input).ok).toBe(true);
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM agent_reports').get()?.count).toBe(200);
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM agent_report_limits').get()?.count).toBe(1);
  });

  it.each([{}, { summary: '' }, { summary: '  ' }, { summary: 'x'.repeat(201) }, { summary: 'ok', details: 'x'.repeat(4001) },
    { summary: 'ok', tool: 'x'.repeat(201) }, { summary: 'ok', tool: ' ' }, { summary: 'ok', pull_request: 0 }, { summary: 'ok', pull_request: 1.5 }, { summary: 'ok', pull_request: '42' }, { summary: 'ok', details: {} }])('refuses invalid input at both the MCP and storage boundary: %j', async input => {
    const call = vi.fn<ApiCall>();
    expect(await handleMcp(message(input), call, true)).toMatchObject({ result: { isError: true } });
    expect(call).not.toHaveBeenCalled();
    const store = new AgentReportStore(storage().storage);
    expect(store.add(agent, input)).toMatchObject({ ok: false, status: 400 });
    expect(store.list()).toEqual([]);
  });

  it('accepts exact bounds, preserves literal markup and removes private text before storing or returning it', () => {
    const store = new AgentReportStore(storage().storage);
    expect(store.add(agent, { summary: 's'.repeat(200), details: 'd'.repeat(4000), tool: 't'.repeat(200), pull_request: 42 }).ok).toBe(true);
    const result = store.add({ ...agent, name: 'dev@example.test', owner: { name: 'owner@example.test' } }, { ...input, summary: 'Contact dev@example.test', tool: 'braid_agent_privatecredential' });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(store.list())).not.toMatch(/dev@example.test|owner@example.test|braid_agent_privatecredential/);
    expect(store.list()[0].details).toBe(input.details);
  });

  it('isolates storage by repository Durable Object', async () => {
    const f = await fixture();
    const a = f.env.TRUNKS.getByName(trunkName('repo-a')), b = f.env.TRUNKS.getByName(trunkName('repo-b'));
    const result = await a.reportProblem(agent, input);
    expect(result.ok).toBe(true);
    expect(await b.agentReports()).toEqual([]);
    if (result.ok) expect(await b.resolveAgentReport(result.data.id)).toMatchObject({ ok: false, status: 404 });
  });
});
