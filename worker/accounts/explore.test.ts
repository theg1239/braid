import { organizationWithRepository } from '../test/organization';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryPage } from '../../shared/repositories';
import api from '../http/api';
import { digest, sessionToken } from '../http/auth';
import { Directory } from './directory';
import type { BraidEnv } from '../env';
import { Security } from './security';
import { storageFixture } from '../test/storage';

const alice = { id: 'alice', email: 'alice@example.com', name: 'Alice' };

function fixture() {
  const db = storageFixture(), store = storageFixture();
  const directory = new Directory(db.ctx, {} as BraidEnv), security = new Security(store.ctx, {} as BraidEnv);
  const workspace = vi.fn(() => { throw new Error('Explore must only query the directory.'); });
  const env = {
    AUTH_MODE: 'github', SESSION_SECRET: 'explore-test-session-secret-123456789',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory },
    SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { get: workspace, getByName: workspace },
  } as unknown as BraidEnv;
  const team = organizationWithRepository(directory, alice, 'Original team');
  directory.updateTeam(alice.id, { teamId: team.id, slug: 'acmvit', name: 'Computing Society' });
  const add = (name: string, description = 'Past papers', date = '2099-10-12T10:00:00.000Z', visibility: 'public' | 'private' = 'public') => {
    const repo = directory.createWorkspace(alice.id, team.id, name, visibility);
    directory.repositoryImported(repo.id, undefined, description, true);
    directory.repositoryActivity(repo.id, date, description);
    return repo;
  };
  const call = (params: Record<string, string> = {}, cookie?: string, method = 'GET') => api.fetch(new Request(`https://braid.example/api/repos?${new URLSearchParams(params)}`, {
    method, headers: { 'cf-connecting-ip': '198.51.100.19', ...(cookie ? { cookie } : {}) },
  }), env);
  const page = async (params: Record<string, string> = {}) => {
    const response = await call(params);
    expect(response.status).toBe(200);
    return await response.json() as RepositoryPage;
  };
  const login = async () => {
    const token = await sessionToken(env.SESSION_SECRET);
    await security.issue(await digest(token), Date.now() + 86_400_000, alice);
    return `__Host-braid-session=${token}`;
  };
  return { db, store, directory, security, env, workspace, team, add, call, page, login };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.db.db.close(); f.store.db.close(); vi.restoreAllMocks(); });

describe('Explore search and sort', () => {
  it('hides empty and unfinished repositories from rows, counts and both cursor orders without deleting them', async () => {
    const empty = f.directory.createWorkspace(alice.id, f.team.id, 'Empty papers', 'public');
    const importing = f.directory.createWorkspace(alice.id, f.team.id, 'Copying papers', 'public');
    f.directory.repositoryImported(importing.id, true, 'papers');
    f.directory.repositoryActivity(empty.id, '2099-12-01T00:00:00.000Z', 'papers');
    f.add('Alpha'); f.add('Zulu');
    for (const sort of ['updated', 'name']) {
      const first = await f.page({ q: 'papers', limit: '1', sort });
      const last = await f.page({ q: 'papers', limit: '1', sort, cursor: first.nextCursor! });
      expect(first.total).toBe(2); expect(last.total).toBe(2); expect(last.nextCursor).toBeNull();
      expect([...first.items, ...last.items].map(item => item.repo.name).sort()).toEqual(['Alpha', 'Zulu']);
    }
    expect(f.directory.list(alice)[0].workspaces.map(repo => repo.id)).toEqual(expect.arrayContaining([empty.id, importing.id]));
    expect(await f.directory.resolveRepository(null, f.team.slug, empty.slug)).toMatchObject({ ok: true });
    f.directory.repositoryImported(importing.id, true, 'papers', true);
    expect((await f.page({ q: 'papers' })).total).toBe(3);
    expect(f.workspace).not.toHaveBeenCalled();
  });
  it.each(['ACMVIT', 'cOmPuTiNg', 'examcooker', 'Study Hub', 'PAST PAPERS'])('matches %s case-insensitively across owner and repository metadata', async q => {
    const repo = f.add('ExamCooker');
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: repo.id, name: 'Study Hub' });
    const page = await f.page({ q: `  ${q}  ` });
    expect(page.items.map(item => item.repo.slug)).toEqual(['examcooker']);
    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeNull();
    expect(f.workspace).not.toHaveBeenCalled();
  });

  it('defaults to newest activity, omits counts without a search, and accepts a blank query', async () => {
    f.add('Older', '', '2099-10-10T10:00:00.000Z');
    f.add('Latest', '', '2099-10-12T10:00:00.000Z');
    const page = await f.page();
    expect(page.items.map(item => item.repo.name)).toEqual(['Latest', 'Older']);
    expect(page.total).toBeUndefined();
    expect(await f.page({ q: '   ', sort: 'updated' })).toEqual(page);
  });

  it('sorts by the display name case-insensitively, independently of the slug and activity', async () => {
    const repo = f.add('Zulu');
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: repo.id, name: 'alpha' });
    f.add('Bravo', '', '2099-10-13T10:00:00.000Z');
    f.add('charlie');
    expect((await f.page({ sort: 'name' })).items.map(item => item.repo.name)).toEqual(['alpha', 'Bravo', 'charlie']);
  });

  it.each(['updated', 'name'])('pages filtered results with %s sorting, including ties, without duplicates', async sort => {
    const repos = Array.from({ length: 5 }, () => f.add('Same name', 'A matching description'));
    f.add('Other', 'Unrelated');
    f.add('Hidden', 'A matching description', undefined, 'private');
    let cursor: string | null = null;
    const slugs: string[] = [];
    for (let index = 0; index < 3; index++) {
      const page: RepositoryPage = await f.page({ q: 'MaTcHiNg', sort, limit: '2', ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(5);
      expect(page.items).toHaveLength(index < 2 ? 2 : 1);
      slugs.push(...page.items.map(item => item.repo.slug));
      cursor = page.nextCursor;
      expect(cursor === null).toBe(index === 2);
    }
    expect(slugs).toEqual([...repos].sort((a, b) => sort === 'name' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)).map(repo => repo.slug));
    expect(new Set(slugs).size).toBe(5);
  });

  it('does not reveal private matches or count them even to their signed-in owner', async () => {
    f.add('Hidden', 'Unique private phrase', undefined, 'private');
    for (const cookie of [undefined, await f.login()]) {
      const response = await f.call({ q: 'unique private' }, cookie);
      expect(await response.json()).toEqual({ items: [], nextCursor: null, total: 0 });
    }
  });

  it.each(['%', '_', "' OR 1=1 --", 'two words'])('treats %s as a literal substring', async q => {
    f.add('Match', `Before ${q} after`);
    f.add('Unrelated', 'Other text');
    expect((await f.page({ q })).items.map(item => item.repo.name)).toEqual(['Match']);
  });

  it('redacts matches and keeps raw names out of alphabetical cursors', async () => {
    const secret = 'braid_agent_' + 'a1b2c3d4'.repeat(8);
    const repo = f.add('First', `Contact bob@example.com with ${secret}`);
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: repo.id, name: 'A alice@example.com' });
    f.directory.updateTeam(alice.id, { teamId: f.team.id, name: 'Team owner@example.com' });
    f.add('Second', 'Contact support');
    const page = await f.page({ q: 'contact', sort: 'name', limit: '1' });
    const body = JSON.stringify(page);
    expect(body).toContain('[private email]');
    expect(body).not.toMatch(/alice@example|bob@example|owner@example|braid_agent_/);
    expect(atob(page.nextCursor!)).not.toMatch(/alice@example|braid_agent_/);
    expect(JSON.parse(atob(page.nextCursor!)).name).toBe('a [private email]');
    const next = await f.page({ q: 'contact', sort: 'name', limit: '1', cursor: page.nextCursor! });
    expect(next.items.map(item => item.repo.name)).toEqual(['Second']);
    expect(next.total).toBe(2);
  });

  it('does not disclose hidden emails or credentials through search matches or counts', async () => {
    const repo = f.add('Public', 'Contact alice@example.com with braid_agent_a1b2c3d4');
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: repo.id, name: 'Repo bob@example.com' });
    f.directory.updateTeam(alice.id, { teamId: f.team.id, name: 'Team carol@example.com' });
    for (const q of ['alice@example', 'bob@example', 'carol@example', 'braid_agent_a1b2']) {
      expect(await f.page({ q })).toEqual({ items: [], nextCursor: null, total: 0 });
    }
    expect((await f.page({ q: 'contact' })).total).toBe(1);
  });

  it('continues after a Unicode name cursor even when its repository becomes private', async () => {
    const first = f.add('Café');
    f.add('Résumé');
    const page = await f.page({ q: 'papers', sort: 'name', limit: '1' });
    expect(page.items[0].repo.name).toBe('Café');
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: first.id, visibility: 'private' });
    const next = await f.page({ q: 'papers', sort: 'name', cursor: page.nextCursor! });
    expect(next.items.map(item => item.repo.name)).toEqual(['Résumé']);
    expect(next.nextCursor).toBeNull();
  });

  it.each(['CAFÉ', 'ÉQUIPE', 'RÉSUMÉ'])('matches Unicode casing in %s', async q => {
    f.directory.updateTeam(alice.id, { teamId: f.team.id, name: 'Équipe' });
    f.add('Café', 'Résumé');
    expect((await f.page({ q })).total).toBe(1);
  });

  it('updates searchable descriptions on imports and activity without retaining old matches', async () => {
    const repo = f.add('Repo', 'First description');
    f.directory.repositoryImported(repo.id, true, 'Imported résumé alice@example.com');
    expect((await f.page({ q: 'first description' })).total).toBe(0);
    expect((await f.page({ q: 'RÉSUMÉ' })).total).toBe(1);
    expect((await f.page({ q: 'alice@example' })).total).toBe(0);
    f.directory.repositoryActivity(repo.id, '2099-10-13T10:00:00.000Z', 'Revised description');
    expect((await f.page({ q: 'résumé' })).total).toBe(0);
    expect((await f.page({ q: 'revised' })).total).toBe(1);
  });

  it('backfills existing rows and indexes later legacy import metadata', async () => {
    const repo = f.add('Café', 'An existing résumé');
    f.db.storage.sql.exec('UPDATE teams SET search_name = NULL');
    f.db.storage.sql.exec('UPDATE workspaces SET search_name = NULL, search_description = NULL');
    const directory = new Directory(f.db.ctx, { WORKSPACES: { getByName: () => ({ publicationMetadata: async () => ({ sourcePublic: true, description: 'Migrated résumé alice@example.com' }) }) } } as unknown as BraidEnv);
    expect((await directory.publicRepositories(20, undefined, { q: 'café' })).items).toHaveLength(1);
    expect((await directory.publicRepositories(20, undefined, { q: 'computing' })).items).toHaveLength(1);
    f.db.storage.sql.exec('UPDATE workspaces SET legacy_visibility = 1, visibility_explicit = 0 WHERE id = ?', repo.id);
    await directory.dispatch(alice, 'list', {});
    expect((await directory.publicRepositories(20, undefined, { q: 'migrated résumé' })).items).toHaveLength(1);
    expect((await directory.publicRepositories(20, undefined, { q: 'existing résumé' })).items).toHaveLength(0);
    expect((await directory.publicRepositories(20, undefined, { q: 'alice@example' })).items).toHaveLength(0);
  });

  it.each<Record<string, string>>([{ q: 'q'.repeat(201) }, { sort: 'stars' }, { limit: '101' }, { limit: '0' }, { cursor: 'bad cursor' }])('validates query %j before listing', async query => {
    const read = vi.spyOn(f.directory, 'publicRepositories');
    expect((await f.call(query)).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects cursors from another sort and keeps old updated cursors working', async () => {
    f.add('One'); f.add('Two');
    const updated = await f.page({ limit: '1' });
    expect((await f.page({ limit: '1', cursor: updated.nextCursor! })).items).toHaveLength(1);
    expect((await f.call({ sort: 'name', cursor: updated.nextCursor! })).status).toBe(400);
    const named = await f.page({ sort: 'name', limit: '1' });
    expect((await f.call({ cursor: named.nextCursor! })).status).toBe(400);
  });

  it('uses the public order indexes, limits materialized rows, and avoids a sorting table', async () => {
    f.add('One'); f.add('Two');
    const exec = vi.spyOn(f.db.storage.sql, 'exec');
    for (const sort of ['updated', 'name']) {
      const first = await f.page({ q: 'papers', sort, limit: '1' });
      await f.page({ q: 'papers', sort, limit: '1', cursor: first.nextCursor! });
      const queries = exec.mock.calls.filter(([query]) => query.startsWith('SELECT w.id,'));
      for (const [query, ...bindings] of queries.slice(-2)) {
        expect(bindings.at(-1)).toBe(2);
        const plan = f.db.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bindings as (string | number | null)[]).map(row => row.detail).join(' ');
        expect(plan).toContain(sort === 'name' ? 'public_search_name' : 'public_activity');
        expect(plan).not.toContain('USE TEMP B-TREE');
      }
    }
  });

  it('charges anonymous requests before search and supports HEAD without a body', async () => {
    f.add('Repo');
    const head = await f.call({ q: 'papers', sort: 'name' }, undefined, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const read = vi.spyOn(f.directory, 'publicRepositories');
    f.env.ANONYMOUS_LIMITER = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    for (const cookie of [undefined, await f.login()]) {
      const response = await f.call({ q: 'papers', sort: 'name' }, cookie);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
    }
    expect(read).not.toHaveBeenCalled();
  });
});
