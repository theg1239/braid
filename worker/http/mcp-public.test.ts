import { afterEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import type { BraidEnv } from '../env';
import { Workspace } from '../workspace/workspace';
import { Security } from '../accounts/security';
import { Directory } from '../accounts/directory';
import { storageFixture } from '../test/storage';
import { edgeCache } from '../test/edge-cache';
import { withheldFixture } from '../test/withheld';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const origin = 'https://braid.example';
const readCases = (path: string, number: number) => [
  ['get_repository', {}, '/api/queue'],
  ['get_file_contents', { path }, `/api/repository?path=${encodeURIComponent(path)}`],
  ['list_commits', {}, '/api/repository/commits'],
  ['search_code', { query: 'export' }, '/api/repository/search?q=export'],
  ['get_blame', { path }, `/api/blame?path=${encodeURIComponent(path)}`],
  ['compare_commits', { base: 'main', head: 'main' }, '/api/repository/compare?base=main&head=main'],
  ['get_merge_queue', {}, '/api/queue'],
  ['list_pull_requests', {}, '/api/changes?status=active&limit=20'],
  ['get_pull_request', { number }, `/api/changes/${number}`],
  ['list_pull_request_review_comments', { number }, `/api/changes/${number}/comments`],
  ['get_rules', {}, '/api/policy'],
  ['files_in_progress', { paths: [path] }, `/api/coordination?paths=${encodeURIComponent(path)}`],
] as const;
const mcp = (env: BraidEnv, workspace: string, name: string, args: object = {}) => api.fetch(new Request(`${origin}/mcp`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-braid-workspace': workspace, 'cf-connecting-ip': '198.51.100.7' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
}), env);
const get = (env: BraidEnv, workspace: string, path: string) => api.fetch(new Request(`${origin}${path}`, {
  headers: { 'x-braid-workspace': workspace, 'cf-connecting-ip': '198.51.100.7' },
}), env);

describe('anonymous MCP reads use the public API gateway', () => {
  it('runs all twelve read tools on a public repository without credentials', async () => {
    const f = await withheldFixture();
    try {
      const opened = await f.h.submit('Reader', { title: 'Document routes', summary: 'Document routes', baseCommit: f.base, files: [{ path: 'README.md', content: '# Relay\n\nRoutes.\n' }] });
      if (!opened.ok) throw new Error(opened.error);
      const forwarded = vi.spyOn(f.workspace, 'fetch');
      for (const [name, args, path] of readCases('src/router.ts', opened.data.number)) {
        const direct = await get(f.env, 'w', path);
        expect(direct.status, `${name}: API`).toBe(200);
        const response = await mcp(f.env, 'w', name, args);
        const answer = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
        expect(response.status, `${name}: ${JSON.stringify(answer)}`).toBe(200);
        expect(answer.result.isError, `${name}: ${JSON.stringify(answer)}`).toBeUndefined();
        expect(answer.result.content[0].text, name).not.toBe('');
      }
      expect(forwarded).toHaveBeenCalled();
      for (const [request] of forwarded.mock.calls) {
        expect(request.headers.get('authorization')).toBeNull();
        expect(request.headers.get('cookie')).toBeNull();
        expect(request.headers.get('x-braid-role')).toBe('viewer');
        expect(request.headers.get('x-braid-public')).toBe('true');
      }
    } finally { await f.close(); }
  });

  it('runs all twelve read tools on the recorded tour', async () => {
    edgeCache();
    const state = storageFixture(), auth = storageFixture(), people = storageFixture();
    const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'false', SESSION_SECRET: 'mcp-tour-test-session-secret-123456789',
      IP_LIMITER: { limit: async () => ({ success: true }) }, ANONYMOUS_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as BraidEnv;
    const workspace = new Workspace(state.ctx, env), security = new Security(auth.ctx, env), directory = new Directory(people.ctx, env);
    env.WORKSPACES = { idFromName: (name: string) => name, get: () => workspace } as unknown as BraidEnv['WORKSPACES'];
    env.SECURITY = { idFromName: (name: string) => name, get: () => security } as unknown as BraidEnv['SECURITY'];
    env.DIRECTORY = { idFromName: (name: string) => name, get: () => directory } as unknown as BraidEnv['DIRECTORY'];
    try {
      await state.ready();
      for (const [name, args] of readCases('src/delivery.ts', 36)) {
        const response = await mcp(env, 'demo', name, args);
        expect(response.status, name).toBe(200);
        const answer = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
        expect(answer.result.isError, `${name}: ${JSON.stringify(answer)}`).toBeUndefined();
        expect(answer.result.content[0].text, name).not.toBe('');
      }
    } finally { await state.settled(); state.db.close(); auth.db.close(); people.db.close(); }
  });

  it('refuses every private-repository read with the same status and answer as the API', async () => {
    const f = await withheldFixture();
    try {
      f.db.db.prepare("UPDATE workspaces SET visibility = 'private'").run();
      const forwarded = vi.spyOn(f.workspace, 'fetch');
      for (const [name, args, path] of readCases('src/router.ts', 1)) {
        const direct = await get(f.env, 'w', path), response = await mcp(f.env, 'w', name, args);
        expect(direct.status, name).toBe(404);
        expect(response.status, name).toBe(direct.status);
        expect(await response.json()).toMatchObject({ error: (await direct.json() as { error: string }).error });
      }
      expect(forwarded).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(['create_pull_request', 'update_pull_request', 'restack_pull_request', 'review_pull_request', 'add_reply_to_pull_request_comment', 'report_problem'])('refuses anonymous %s before repository access', async name => {
    for (const workspace of ['demo', 'public-repo', 'private-repo']) {
      const response = await mcp({} as BraidEnv, workspace, name);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'Connect with a Braid access token: send Authorization: Bearer <token> and X-Braid-Workspace with each request. See /auth.md.' });
    }
  });

  it('charges the same network, anonymous and content budgets before cached reads', async () => {
    const f = await withheldFixture();
    try {
      expect((await mcp(f.env, 'w', 'list_commits')).status).toBe(200);
      for (const binding of ['IP_LIMITER', 'ANONYMOUS_LIMITER', 'PUBLIC_EXPENSIVE_LIMITER'] as const) {
        const limit = vi.fn(async () => ({ success: false })), original = f.env[binding];
        f.env[binding] = { limit };
        const direct = await get(f.env, 'w', '/api/repository/commits'), response = await mcp(f.env, 'w', 'list_commits');
        expect(direct.status, binding).toBe(429);
        // Network refusals are API results; budget exceptions preserve the HTTP status.
        if (response.status === 200) expect(await response.json()).toMatchObject({ result: { isError: true, content: [{ text: `Braid answered 429: ${(await direct.json() as { error: string }).error}` }] } });
        else {
          expect(response.status, binding).toBe(429);
          expect(await response.json()).toMatchObject({ error: (await direct.json() as { error: string }).error });
        }
        expect(limit).toHaveBeenCalledTimes(2);
        expect(limit.mock.calls[0]).toEqual(limit.mock.calls[1]);
        f.env[binding] = original;
      }
    } finally { await f.close(); }
  });

  it('keeps unpublished commits and hidden refs behind the existing publication checks', async () => {
    const f = await withheldFixture();
    try {
      const reads = [
        ['list_commits', { sha: f.tip }, `/api/repository/commits?ref=${f.tip}`],
        ['get_file_contents', { path: 'client.ts', ref: f.tip }, `/api/repository?path=client.ts&ref=${f.tip}`],
        ['get_blame', { path: 'client.ts', ref: f.tip }, `/api/blame?path=client.ts&ref=${f.tip}`],
        ['compare_commits', { base: 'main', head: f.tip }, `/api/repository/compare?base=main&head=${f.tip}`],
        ['list_commits', { ref: 'refs/braid/incoming/secret' }, '/api/repository/commits?ref=refs%2Fbraid%2Fincoming%2Fsecret'],
      ] as const;
      for (const [name, args, path] of reads) {
        const direct = await get(f.env, 'w', path), response = await mcp(f.env, 'w', name, args);
        if (name === 'get_blame') {
          const data = await direct.json();
          expect(data).toMatchObject({ ranges: [], lines: 0 });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ result: { structuredContent: data } });
          continue;
        }
        expect(direct.status, name).toBeGreaterThanOrEqual(400);
        const problem = (await direct.json() as { error: string }).error;
        const answer = await response.json();
        if (response.status === 200) expect(answer).toMatchObject({ result: { isError: true, content: [{ text: `Braid answered ${direct.status}: ${problem}` }] } });
        else { expect(response.status, name).toBe(direct.status); expect(answer).toMatchObject({ error: problem }); }
        expect(JSON.stringify(answer)).not.toContain('unpublished-ledger');
      }
    } finally { await f.close(); }
  });
});
