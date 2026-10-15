import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import type { Command } from '@stricli/core';
import { app } from '../../cli/src/app';
import type { BraidContext } from '../../cli/src/context';
import { parseDependsOn } from '../../cli/src/commands/submit';
import { proofSchema } from '../../cli/src/proof';
import { taskLink } from '../../cli/src/task';
import { braid, cleanup, repository, temporary } from '../../cli/test/helpers';
// The standalone download intentionally has no TypeScript dependencies.
// @ts-expect-error JavaScript CLI
import * as download from '../../public/cli/braid.mjs';
import api from './api';
import { agentAuthorization, agentPathAllowed } from './agent-auth';
import type { AgentScope, Change } from '../../shared/types';
import type { BraidEnv } from '../env';
import { handleMcp, type ApiCall } from './mcp';
import { agentRequest, agentSession, contextNote, parse, project, provenanceQuery, task } from '../schemas';
import { setupGuide } from './setup-guide';
import { changesRoute, type ChangeGateway } from '../changes/router';
import { HttpError } from '../errors';
import { changeHarness } from '../test/changes-harness';
import { storageFixture } from '../test/storage';
import { Security } from '../accounts/security';
import { Workspace } from '../workspace/workspace';
import { Directory } from '../accounts/directory';
import { verifyAccess } from './agent-token';

const origin = 'https://braid.example';
const guides = ['/llms.txt', '/setup.md', '/auth.md', '/changes.md', '/local-agents.md'].map(path => ({ path, text: setupGuide(path, origin)! }));
const text = guides.map(guide => guide.text).join('\n');
const guide = (path: string) => guides.find(guide => guide.path === path)!.text;
const words = (command: string) => (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^(["'])(.*)\1$/, '$2'));
const blocks = [...text.matchAll(/^    ((?:node ~\/\.braid\/braid\.mjs|braid) .+)$/gm)].map(match => match[1]);

/** Read the actual example, including nested objects, without evaluating guide text as code. */
function jsonAfter(document: string, marker: string) {
  const at = document.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const start = document.indexOf('{', at);
  let depth = 0, quoted = false, escaped = false;
  for (let end = start; end < document.length; end++) {
    const char = document[end];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return JSON.parse(document.slice(start, end + 1));
  }
  throw new Error(`No complete JSON example after ${marker}`);
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanup(); });

describe('guide command contracts', () => {
  const inline = [
    'node ~/.braid/braid.mjs restack 52 --dir DIRECTORY',
    'node ~/.braid/braid.mjs progress --dir DIRECTORY --message "Implementation complete; running checks."',
    'node ~/.braid/braid.mjs update --dir DIRECTORY',
    'node ~/.braid/braid.mjs submit --dir DIRECTORY --retry',
    'change sync --dir DIRECTORY', 'change status --dir DIRECTORY', 'change submit --dir DIRECTORY --retry',
    'change submit --dir DIRECTORY --depends-on 51,52',
  ];

  const downloaded = [...new Set([
    ...blocks.filter(command => command.startsWith('node ')).map(command => command.slice('node ~/.braid/braid.mjs '.length)),
    ...inline.map(command => command.replace('node ~/.braid/braid.mjs ', '')),
    'connect --url https://braid.example --workspace ID',
    'change start --url https://braid.example --dir NEW_DIRECTORY --workspace ID',
    'change wait --dir DIRECTORY --timeout 60', 'wait --dir DIRECTORY --timeout 60',
    'submit --dir DIRECTORY --tests FILE', 'submit --dir DIRECTORY --depends-on 51,52',
    'submit --dir DIRECTORY --depends-on none', 'change submit --dir DIRECTORY --depends-on none',
  ])];

  it('keeps inline examples and all documented CLI flags in the exercised command set', () => {
    for (const example of inline) expect(text).toContain(example);
    const exercised = downloaded.join(' ') + ' --push --model -- --help';
    // The other flags belong to the curl installer and the user-selected preview command.
    for (const flag of new Set(text.match(/--[a-z][a-z-]*/g))) {
      if (!['--create-dirs', '--port'].includes(flag)) expect(exercised, flag).toContain(flag);
    }
  });

  it.each(downloaded)('parses the downloadable CLI example: %s', async example => {
    const repo = repository();
    const args = words(example).map(word => word === 'DIRECTORY' ? repo.root : word === 'NEW_DIRECTORY' ? join(repo.home, 'new')
      : word === 'TASK_URL' ? `${origin}/tasks/mission-contract?workspace=w` : word);
    const log = vi.fn(), fetch = vi.fn(async () => new Response(null, { status: 503 }));
    if (args.includes('--help')) {
      await download.main(args, { env: repo.env, fetch, log });
      expect(log).toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      return;
    }
    // Reach a known execution boundary. Help alone bypasses parsing in this CLI.
    // No credentials or task binding exist in this isolated checkout; no live request is made.
    try {
      await download.main(args, { env: repo.env, fetch, log });
      throw new Error('Expected the isolated execution boundary');
    } catch (error) {
      const message = (error as Error).message;
      if (args[0] === 'connect' || args[0] === 'start') expect(message).toContain('Authorization request failed (HTTP 503)');
      else if (args[0] === 'change' && args[1] === 'start') expect(message).toMatch(/Run connect/);
      else expect(error).toMatchObject({ code: 'ENOENT', path: args[0] === 'submit' ? join(repo.root, '.braid', 'task.json') : join(repo.root, '.braid') });
    }
  });

  const full = [...new Set([
    ...blocks.filter(command => command.startsWith('braid ')).map(command => command.slice(6)),
    'blame FILE', 'stats', 'log', 'agent list', 'status', 'sync', 'restack 52', 'submit --push',
    'submit --depends-on 51,52', 'submit --depends-on none', 'wait --timeout 60',
    'agent run --model gpt-6 -- claude',
    `task start ${origin}/tasks/mission-contract?workspace=w`, 'task resume --dir DIRECTORY',
    'task update --dir DIRECTORY', 'task progress --dir DIRECTORY --message "A milestone"',
    'task submit --dir DIRECTORY --summary "What changed" --model gpt-6 --proof',
    'task submit --dir DIRECTORY --retry', 'task submit --dir DIRECTORY --tests FILE',
    'task submit --dir DIRECTORY --depends-on 51,52', 'task wait --dir DIRECTORY --timeout 60',
  ])];

  it.each(full)('parses the full CLI example without invoking its handler: braid %s', async example => {
    const args = words(example);
    let target = app.root, offset = 0;
    while ('getRoutingTargetForInput' in target) {
      const next = target.getRoutingTargetForInput(args[offset++]);
      expect(next, example).toBeDefined();
      target = next!;
    }
    const handler = vi.fn(async () => {});
    vi.spyOn(target as Command<BraidContext>, 'loader').mockResolvedValue(handler);
    const result = await braid(args, { cwd: temporary(), env: {} });
    expect(result, example).toMatchObject({ exitCode: 0, stderr: '' });
    expect(handler).toHaveBeenCalledOnce();
    if (args.includes('--depends-on')) expect(handler.mock.calls[0]).toEqual([expect.objectContaining({ dependsOn: args.includes('none') ? [] : [51, 52] })]);
  });

  it('distinguishes Git submission from proof and preserves command escape parsing', async () => {
    const repo = repository();
    const result = await braid(['submit', '--push', '--proof'], { cwd: repo.root, env: repo.env });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('leave out the description, --tests, --proof and --depends-on');
    expect(guide('/changes.md')).toContain('--push cannot be combined with --proof, --tests or --depends-on');
    expect(guide('/changes.md')).toContain('braid blame FILE');
    const bad = await braid(['submit', '--does-not-exist'], { cwd: repo.root, env: repo.env });
    expect(bad.exitCode).not.toBe(0);
    await expect(download.main(['submit', '--dir', repo.root, '--does-not-exist'], { env: repo.env })).rejects.toThrow('Unknown or duplicate option');
    for (const value of ['51,52', 'none']) expect(download.parseDependsOn(value)).toEqual(parseDependsOn(value));
    expect(() => download.parseDependsOn('[]')).toThrow();
    expect(() => parseDependsOn('[]')).toThrow();
  });

  it('accepts both documented task URL forms in both CLIs', () => {
    for (const url of [`${origin}/alice/relay/tasks/mission-contract`, `${origin}/tasks/mission-contract?workspace=w&agent=coder`]) {
      expect(download.taskLink(url)).toMatchObject({ origin, missionId: 'mission-contract' });
      expect(taskLink(url)).toMatchObject({ origin, missionId: 'mission-contract' });
    }
  });
});

describe('guide MCP contracts', () => {
  it('serves initialize and tools/list at the documented transport without an account', async () => {
    for (const method of ['initialize', 'tools/list']) {
      const response = await api.fetch(new Request(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) }), {} as BraidEnv);
      expect(response.status).toBe(200);
      const answer = await response.json() as { result: { tools?: unknown[]; serverInfo?: { name: string } } };
      if (method === 'tools/list') expect(answer.result.tools).toHaveLength(18);
      else expect(answer.result.serverInfo?.name).toBe('braid');
    }
  });

  it('registers every named tool and every named argument, including optional shorthand', async () => {
    const listing = await handleMcp({ id: 1, method: 'tools/list' }, vi.fn<ApiCall>(), false) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] } };
    const tools = new Map(listing.result.tools.map(tool => [tool.name, tool.inputSchema]));
    const landing = readFileSync(new URL('../../src/components/landing/Ways.tsx', import.meta.url), 'utf8');
    const names = new Set((text + landing).match(/\b(?:get_|list_|search_|compare_|create_|update_|review_|restack_|add_reply_to_)[a-z_]+\b|\bfiles_in_progress\b/g));
    for (const name of names) expect(tools.has(name), name).toBe(true);
    for (const document of [guide('/llms.txt'), guide('/setup.md'), guide('/changes.md'), readFileSync(new URL('../../docs/AGENT-ONBOARDING.md', import.meta.url), 'utf8')])
      for (const name of ['get_file_contents', 'list_commits', 'compare_commits', 'get_merge_queue', 'search_code', 'get_blame']) expect(document).toContain(name);
    for (const match of text.matchAll(/\b([a-z_]+)\((\{[^\n]*?\})\)/g)) {
      if (!tools.has(match[1])) continue;
      const fields = match[2].startsWith('{"') ? Object.keys(JSON.parse(match[2]))
        : match[2].slice(1, -1).split(',').map(field => field.split(':')[0].replace(/\?/g, '').trim()).filter(field => field && field !== '...');
      for (const field of fields) expect(tools.get(match[1])!.properties, `${match[1]}.${field}`).toHaveProperty(field);
      for (const required of tools.get(match[1])!.required ?? []) expect(fields, match[1]).toContain(required);
    }
    const create = jsonAfter(guide('/changes.md'), 'For create_pull_request, use arguments like');
    for (const field of Object.keys(create)) expect(tools.get('create_pull_request')!.properties).toHaveProperty(field);
    for (const name of ['create_pull_request', 'update_pull_request']) expect(tools.get(name)!.properties).toHaveProperty('depends_on');
  });
});

describe('guide JSON and scope contracts', () => {
  it('accepts the literal request and proof examples at their input boundaries', () => {
    const auth = guide('/auth.md'), setup = guide('/setup.md');
    expect(parse(agentRequest, jsonAfter(auth, '1. POST /api/agent/requests'))).toEqual({ name: 'GPT-6', scope: 'work' });
    expect(parse(agentSession, jsonAfter(auth, '## Short-lived tokens'))).toEqual({ model: 'gpt-6' });
    expect(parse(agentSession, jsonAfter(auth, 'such as'))).toEqual({ name: 'gpt-6:1', model: 'gpt-6' });
    expect(parse(project, jsonAfter(setup, 'For an empty repository'))).toMatchObject({ name: 'repository-name', sourceUrl: 'https://github.com/owner/public-repository.git' });
    expect(parse(contextNote, jsonAfter(setup, 'POST /api/context:'))).toMatchObject({ kind: 'constraint' });
    expect(parse(task, jsonAfter(setup, 'When asked to create a task'))).toMatchObject({ execution: 'local', agentCount: 1 });
    for (const path of ['/changes.md', '/local-agents.md']) {
      const proof = jsonAfter(guide(path), path === '/changes.md' ? 'Create .braid/proof.json' : 'If .braid/proof.json');
      expect(download.validateProof(proof)).toEqual(v.parse(proofSchema, proof));
    }
    expect(parse(provenanceQuery, { commits: ['a'.repeat(40), 'b'.repeat(40)].join(',') }).commits).toHaveLength(2);
    expect(guide('/changes.md')).toContain('full 40-character commit hashes');
  });

  const reads = ['/api/state', '/api/queue', '/api/coordination', '/api/blame', '/api/provenance', '/api/agents', '/api/changes/ch_0123456789abc', '/api/changes/ch_0123456789abc/comments'];
  const setupWrites = ['/api/project', '/api/project/import/retry', '/api/context', '/api/missions'];
  const workWrites = ['/api/changes/checkout', '/api/changes', ...['revisions', 'restack', 'reviews', 'close', 'comments'].map(action => `/api/changes/ch_0123456789abc/${action}`),
    ...['checkout', 'update', 'progress', 'submit'].map(action => `/api/missions/mission-contract/agents/coder/${action}`)];
  it.each<AgentScope>(['read', 'setup', 'work', 'fleet'])('enforces the documented %s endpoint permissions', scope => {
    for (const path of reads) expect(agentPathAllowed(path, 'GET', scope), path).toBe(true);
    for (const path of setupWrites) expect(agentPathAllowed(path, 'POST', scope), path).toBe(scope === 'setup');
    for (const path of workWrites) expect(agentPathAllowed(path, 'POST', scope), path).toBe(scope === 'work');
    expect(agentPathAllowed('/api/agent/session', 'POST', scope)).toBe(true);
    for (const path of ['/api/queue/landing', '/api/changes/1/approve', '/api/changes/1/revert', '/api/changes/1/comments/rc_root/resolve', '/api/missions/mission-contract/merge']) {
      expect(agentPathAllowed(path, 'POST', scope), path).toBe(false);
    }
  });
});

describe('guide route contracts', () => {
  it('routes the documented MCP workflow and Git checkout through the real pull request store', async () => {
    const h = await changeHarness();
    const base = h.git.commitTree({ 'README.md': '# Guide contract\n' });
    h.git.native(['update-ref', 'refs/heads/main', base]);
    const gateway: ChangeGateway = { repository: h.repository, mode: 'live', role: 'owner', agent: { id: 'guide-author', label: 'GPT-6', scope: 'work' } };
    const seen = new Set<string>();
    const call: ApiCall = async (method, path, body, key) => {
      seen.add(`${method} ${new URL(path, origin).pathname}`);
      try {
        const response = await changesRoute(new Request(new URL(path, origin), { method,
          headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), h.env, gateway);
        expect(response, `${method} ${path}`).not.toBeNull();
        return { status: response!.status, data: await response!.json() };
      } catch (error) {
        if (error instanceof HttpError) return { status: error.status, data: { error: error.message } };
        throw error;
      }
    };
    const tool = async (name: string, args: object) => {
      const answer = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, call, true) as { result: { isError?: boolean; content: { text: string }[]; structuredContent: Change } };
      expect(answer.result.isError, JSON.stringify(answer)).not.toBe(true);
      return answer.result;
    };
    try {
      await tool('get_rules', {});
      expect((await tool('get_repository', {})).content[0].text).toContain(h.head());
      await tool('files_in_progress', { paths: ['docs/setup.md'] });
      const args = { ...jsonAfter(guide('/changes.md'), 'For create_pull_request, use arguments like'), base_commit: h.head() };
      const prerequisite = (await tool('create_pull_request', { ...args, title: 'Prerequisite', files: [{ path: 'docs/prerequisite.md', content: '# Prerequisite\n' }] })).structuredContent;
      let pr = (await tool('create_pull_request', { ...args, depends_on: [prerequisite.number] })).structuredContent;
      for (const field of ['status', 'next', 'reviews', 'checks', 'conflicts', 'comments']) expect(pr).toHaveProperty(field);
      await tool('list_pull_requests', { state: 'open', limit: 20 });
      await tool('get_pull_request', { number: pr.number });
      gateway.agent = undefined;
      const root = await call('POST', `/api/changes/${pr.id}/comments`, { revision: pr.revision, body: 'Explain the owner approval.' }, crypto.randomUUID());
      expect(root.status).toBe(201);
      gateway.agent = { id: 'guide-author', label: 'GPT-6', scope: 'work' };
      const reply = jsonAfter(guide('/changes.md'), 'add_reply_to_pull_request_comment(');
      reply.number = pr.number;
      reply.comment_id = (root.data as Change).comments![0].id;
      await tool('add_reply_to_pull_request_comment', reply);
      await tool('list_pull_request_review_comments', { number: pr.number, unresolved_only: true });
      gateway.agent = { id: 'guide-reviewer', label: 'Reviewer', scope: 'work' };
      for (const event of ['approve', 'request_changes', 'comment']) await tool('review_pull_request', { number: pr.number, event, body: 'Checked the documentation.' });
      gateway.agent = { id: 'guide-author', label: 'GPT-6', scope: 'work' };
      pr = (await tool('update_pull_request', { ...args, number: pr.number, summary: 'Explain the approval step.', files: [{ path: 'docs/setup.md', content: '# Setup\nWait for owner approval.\n' }] })).structuredContent;
      await tool('restack_pull_request', { number: pr.number, previous_revision: pr.revision, idempotency_key: crypto.randomUUID() });
      const checkout = await call('POST', '/api/changes/checkout', {});
      expect(checkout.status).toBe(200);
      expect(checkout.data).toMatchObject({ remote: h.git.remote, token: 'fixture-token', branch: 'main', head: h.head() });
      const artifacts = await h.artifacts.get.mock.results.at(-1)!.value;
      expect(artifacts.createToken).toHaveBeenCalledWith('read', 600);
      expect((await call('GET', `/api/provenance?commits=${h.head()}`)).status).toBe(200);
      expect((await call('GET', '/api/agents')).status).toBe(200);
      const blame = await call('GET', '/api/blame?path=README.md');
      expect(blame.status).toBe(200);
      expect((await call('POST', `/api/changes/${pr.id}/close`, { reason: 'abandoned' })).status).toBe(200);
      for (const path of ['/api/changes', '/api/changes/checkout', '/api/queue', '/api/coordination', '/api/blame', '/api/provenance', '/api/agents']) {
        expect([...seen].some(route => route.endsWith(` ${path}`)), path).toBe(true);
      }
    } finally { await h.close(); }
  });

  it('routes setup, state and task endpoints to their schemas or explicit preconditions', async () => {
    const db = storageFixture();
    const workspace = new Workspace(db.ctx, { AUTH_MODE: 'owner-key', LIVE_ENABLED: 'true' } as BraidEnv);
    await db.ready();
    const request = (path: string, body?: unknown) => workspace.fetch(new Request(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'x-braid-mode': 'live', 'x-braid-role': 'owner', 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    try {
      const state = await request('/api/state');
      expect(state.status).toBe(200);
      expect(await state.json()).toMatchObject({ project: { id: '' }, capabilities: { mode: 'live' }, missions: [] });
      const context = jsonAfter(guide('/setup.md'), 'POST /api/context:');
      expect(await (await request('/api/context', context)).json()).toMatchObject(context);
      for (const path of ['/api/project', '/api/missions']) {
        const result = await request(path, {});
        expect(result.status, path).toBe(path === '/api/missions' ? 409 : 400);
        expect((await result.json() as { error: string }).error).not.toBe('Endpoint not found.');
      }
      const retry = await request('/api/project/import/retry', {});
      expect(retry.status).toBe(404);
      expect(await retry.json()).toEqual({ error: 'There is no repository import to retry.' });
      for (const action of ['checkout', 'update', 'progress', 'submit']) {
        const result = await request(`/api/missions/mission-contract/agents/coder/${action}`, {});
        expect(result.status).toBe(404);
        expect(await result.json()).toEqual({ error: 'Task not found.' });
      }
    } finally { db.db.close(); }
  });

  it.each<AgentScope>(['read', 'setup', 'work', 'fleet'])('authorizes and renews the documented %s scope with the actual token fields and lifetimes', async scope => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = storageFixture(), people = storageFixture();
    const security = new Security(store.ctx, {} as BraidEnv);
    const directory = new Directory(people.ctx, {} as BraidEnv);
    const user = { id: 'guide-owner', name: 'Guide Owner', email: 'guide@example.test' };
    const org = directory.createOrganization(user, 'Guide');
    const repo = directory.createWorkspace(user.id, org.id, 'Contract', 'private');
    const env = { AUTH_MODE: 'github', PUBLIC_ORIGIN: origin, SESSION_SECRET: 'guide-contract-fixture-secret-'.repeat(2),
      SECURITY: { idFromName: () => 'security', get: () => security }, DIRECTORY: { idFromName: () => 'directory', get: () => directory },
    } as unknown as BraidEnv;
    const request = (path: string, body: unknown) => new Request(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const started = await agentAuthorization(request('/api/agent/requests', { ...jsonAfter(guide('/auth.md'), '1. POST /api/agent/requests'), scope }), env, 'contract', null);
      expect(started.status).toBe(201);
      const pending = await started.json() as { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };
      expect(pending).toMatchObject({ interval: 5, expiresIn: 600, verificationUri: `${origin}/?connect=${pending.userCode}` });
      expect(pending.deviceCode).not.toBe(pending.userCode);
      const poll = () => agentAuthorization(request('/api/agent/token', { deviceCode: pending.deviceCode }), env, 'contract', null);
      expect((await poll()).status).toBe(202);
      const backoff = await poll();
      expect(backoff.status).toBe(429);
      expect(backoff.headers.get('retry-after')).toBe('5');
      const approved = await agentAuthorization(request(`/api/agent/requests/${pending.userCode}`, { workspaceId: repo.id, scope }), env, 'contract', user);
      expect(approved.status).toBe(200);
      vi.advanceTimersByTime(5000);
      const connection = await (await poll()).json() as { accessToken: string; tokenType: string; expiresAt: string; workspaceId: string; scope: AgentScope };
      expect(connection).toMatchObject({ tokenType: 'Bearer', scope, workspaceId: repo.id });
      expect(Date.parse(connection.expiresAt) - Date.now()).toBe((scope === 'work' || scope === 'fleet' ? 7 * 86_400_000 : 3_600_000) - 5000);
      const session = request('/api/agent/session', scope === 'fleet' ? { name: 'gpt-6:1', model: 'gpt-6' } : { model: 'gpt-6' });
      session.headers.set('authorization', `Bearer ${connection.accessToken}`);
      session.headers.set('x-braid-workspace', repo.id);
      const minted = await api.fetch(session, env);
      expect(minted.status).toBe(200);
      const access = await minted.json() as { accessToken: string; tokenType: string; expiresAt: string; workspaceId: string };
      expect(access).toMatchObject({ tokenType: 'Bearer', workspaceId: repo.id });
      expect(Date.parse(access.expiresAt) - Date.now()).toBe(300_000);
      expect(await verifyAccess(env, access.accessToken)).toMatchObject({ scope: scope === 'fleet' ? 'work' : scope, model: 'gpt-6', workspace: repo.id });
      const local = await api.fetch(request('/api/session', {}), { ...env, AUTH_MODE: 'owner-key', LIVE_ENABLED: 'false' });
      expect(local.status).toBe(503);
      expect(await local.json()).toMatchObject({ error: 'Use the deployed workspace to run live agents.' });
    } finally { store.db.close(); people.db.close(); }
  });
});
