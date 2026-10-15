import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import api from '../http/api';
import { mirrorFixture, mirrorAlice as alice, mirrorBob as bob } from '../test/mirror';
import { MIRROR_SYNC_MS, MIRROR_TOTAL_BYTES, MIRROR_PACK_BYTES, MIRROR_LARGE, MIRROR_NAMESPACE_CHANGED, mirrorTransfer } from './mirrors';
import { HISTORY_RETRY_MS } from '../workspace/workspace';
import { HISTORY_REF } from '../repositories/branches';
import { concat, FLUSH, pktLine } from '../git/transport';
import type { RepositoryAddress } from '../../shared/account';

const fixtures: Awaited<ReturnType<typeof mirrorFixture>>[] = [];
async function fixture() { const value = await mirrorFixture(); fixtures.push(value); return value; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const address = async (f: Awaited<ReturnType<typeof fixture>>, user?: typeof alice) => {
  const response = await f.request('/api/repos/alice/repo', user);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<RepositoryAddress>;
};

describe('GitHub mirror lifecycle with production-shaped Artifacts', () => {
  it('coalesces concurrent first visits, reads through import without SQLite writes, copies single-branch history, and syncs on staleness', async () => {
    const f = await fixture();
    f.state.restLimited = true;
    const found = await Promise.all(Array.from({ length: 8 }, () => address(f)));
    expect(new Set(found.map(repo => repo.workspaceId)).size).toBe(1);
    const repo = found[0]; expect(repo).toMatchObject({ canWrite: false, mirror: { source: 'https://github.com/alice/repo', syncedAt: null, importing: true, claimable: false } });
    await f.directoryDb.settled();
    expect(f.artifacts.import).toHaveBeenCalledTimes(1);
    expect(f.artifacts.import.mock.calls[0][0]).toMatchObject({ source: { depth: 1, branch: 'main', url: expect.stringMatching(/^https:\/\/braid.example\/api\/github\/import\//) } });
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    const ws = f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`);
    const writes = vi.spyOn(ws.db.storage, 'put'), sql = vi.spyOn(ws.db.storage.sql, 'exec'), dirSql = vi.spyOn(f.directoryDb.storage.sql, 'exec');
    for (let n = 0; n < 4; n++) {
      expect((await address(f)).mirror?.importing).toBe(true);
      const response = await f.request('/api/state', undefined, { 'x-braid-workspace': repo.workspaceId });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ importing: { source: 'alice/repo' } });
      // A read during a long import is pending, not an error, and never cached as a revision.
      const pending = await f.request('/api/repository?path=README.md', undefined, { 'x-braid-workspace': repo.workspaceId });
      expect(pending.status).toBe(202); expect(pending.headers.get('cache-control')).toContain('no-store');
    }
    expect(writes).not.toHaveBeenCalled();
    expect([...sql.mock.calls, ...dirSql.mock.calls].filter(([q]) => /^(INSERT|UPDATE|DELETE|REPLACE)/i.test(q))).toEqual([]);
    writes.mockRestore(); sql.mockRestore(); dirSql.mockRestore();
    f.completeImport(); await f.drain();
    await ws.workspace.alarm(); await f.drain();
    expect((await address(f)).mirror).toMatchObject({ importing: false, syncedAt: expect.any(String) });
    const file = await f.request('/api/repository?path=README.md', undefined, { 'x-braid-workspace': repo.workspaceId });
    expect(file.status, await file.clone().text()).toBe(200); expect(await file.json()).toMatchObject({ content: '# Mirror\nHello\n' });
    await ws.workspace.alarm(); await f.drain();
    // History beneath the imported tip arrived in a part; the hidden ref keeps it referenced.
    expect(f.target.native(['rev-parse', HISTORY_REF]).trim()).toBe(f.first);
    expect(f.target.native(['cat-file', '-t', f.first]).trim()).toBe('commit');
    const next = f.source.commitTree({ 'README.md': '# Updated\n' }, f.head, 'Third commit');
    f.github.git(['fetch', `file://${f.source.root}/repo.git`, `${next}:refs/heads/main`]);
    f.directory.mirrorUpdated(repo.workspaceId, { syncedAt: new Date(Date.now() - MIRROR_SYNC_MS - 1).toISOString() });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.advanceTimersByTime(31_000);
    await address(f); await f.drain();
    expect(f.target.native(['rev-parse', 'main']).trim()).toBe(next);
    expect(f.directory.mirrorRecord(repo.workspaceId)?.head).toBe(next);
    expect(f.network.mock.calls.filter(([url]) => String(url).startsWith('https://github.com')).every(([, init]) => !new Headers(init?.headers).has('authorization'))).toBe(true);
    expect(f.network.mock.calls.some(([url]) => String(url).startsWith('https://api.github.com'))).toBe(false);
  });

  it('imports private bytes only through the reader own token, without granting another viewer or anonymous Git access', async () => {
    const f = await fixture(); f.state.private = true;
    const signedOut = await f.request('/api/repos/alice/repo');
    expect(signedOut.status).toBe(404); expect(await signedOut.json()).toMatchObject({ code: 'github_not_found_or_private', error: "Not found on GitHub. If it's private, sign in with GitHub to see it." });
    const inaccessible = await f.request('/api/repos/alice/repo', bob);
    expect(inaccessible.status).toBe(404); expect(await inaccessible.json()).toMatchObject({ code: 'github_not_found_or_private', error: "Not found on GitHub, or you don't have access." });
    const repo = await address(f, alice); expect(repo.visibility).toBe('private');
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!; const ws = f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`);
    await ws.workspace.alarm(); await f.drain();
    const file = await f.request('/api/repository?path=README.md', alice, { 'x-braid-workspace': repo.workspaceId });
    expect(file.status, await file.clone().text()).toBe(200);
    expect((await f.request('/api/repository?path=README.md', bob, { 'x-braid-workspace': repo.workspaceId })).status).toBe(404);
    expect((await f.request(`/git/${repo.workspaceId}.git/info/refs?service=git-upload-pack`)).status).not.toBe(200);
    const transfers = f.network.mock.calls.filter(([url]) => String(url).startsWith('https://github.com') && String(url).endsWith('/git-upload-pack'));
    expect(transfers.length).toBeGreaterThan(0);
    for (const [, init] of transfers) expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${btoa(`x-access-token:own-${alice.id}`)}`);
    expect((await f.request('/api/owners/alice', bob)).status).toBe(200);
    expect(await (await f.request('/api/owners/alice', bob)).json()).toMatchObject({ repositories: [] });
  });
  it('imports a private repository whatever size GitHub reports for its history', async () => {
    const f = await fixture(); f.state.private = true; f.state.size = MIRROR_TOTAL_BYTES / 1024 + 1;
    const response = await f.request('/api/repos/alice/repo', alice);
    expect(response.status).toBe(200);
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    expect(f.artifacts.import).toHaveBeenCalledTimes(1);
  });
  it('shows an import only HEAD and the default branch, not the pull request refs GitHub lists', async () => {
    const f = await fixture();
    f.github.git(['update-ref', 'refs/pull/7/head', f.head]);
    let listed = '';
    f.artifacts.import.mockImplementationOnce(async (options: { source: { url: string } }) => {
      const refs = await api.fetch(new Request(`${options.source.url}/info/refs?service=git-upload-pack`), f.env);
      listed = new TextDecoder().decode(await refs.arrayBuffer());
      throw Object.assign(new Error('Stopped after the advertisement.'), { code: 'INVALID_INPUT' });
    });
    await address(f); await f.directoryDb.settled(); await f.drain();
    expect(listed).toContain(`${f.head} HEAD\0`);
    expect(listed).toContain('symref=HEAD:refs/heads/main');
    expect(listed).toContain(`${f.head} refs/heads/main\n`);
    expect(listed).not.toContain('refs/pull/');
  });
  it('copies a mirror too large for one import in parts, then serves it', async () => {
    const f = await fixture();
    f.artifacts.import.mockRejectedValueOnce(Object.assign(new Error('Out of memory.'), { code: 'MEMORY_LIMIT' }));
    const repo = await address(f);
    await f.directoryDb.settled(); await f.drain();
    expect(f.artifacts.create).toHaveBeenCalledTimes(1);
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    await f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`).workspace.alarm(); await f.drain();
    const file = await f.request('/api/repository?path=README.md', alice, { 'x-braid-workspace': repo.workspaceId });
    expect(file.status, await file.clone().text()).toBe(200);
    expect(await file.json()).toMatchObject({ content: '# Mirror\nHello\n' });
    expect(f.target.native(['for-each-ref', 'refs/braid/parts/']).trim()).toBe('');
  });
  it('copies in parts after the bridge stops an import at the import limit', async () => {
    const f = await fixture();
    f.artifacts.import.mockImplementationOnce(async () => {
      // As the bridge does past MIRROR_IMPORT_BYTES; Artifacts then names no cause.
      const { workspace } = f.directoryDb.storage.sql.exec<{ workspace: string }>('SELECT workspace FROM mirrors').one();
      f.directory.mirrorUpdated(workspace, { importing: false, error: MIRROR_LARGE });
      throw Object.assign(new Error('The import failed.'), { code: 'INTERNAL_ERROR' });
    });
    const repo = await address(f);
    await f.directoryDb.settled(); await f.drain();
    expect(f.artifacts.create).toHaveBeenCalledTimes(1);
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    expect(mirror.error).toBeNull();
    await f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`).workspace.alarm(); await f.drain();
    const file = await f.request('/api/repository?path=README.md', alice, { 'x-braid-workspace': repo.workspaceId });
    expect(file.status, await file.clone().text()).toBe(200);
  });
  it("tries a failed first copy again only for the operator's seeding key, under a new name", async () => {
    const f = await fixture(); f.state.refusePushes = true; f.env.MIRROR_SEED_TOKEN = 's'.repeat(40);
    f.artifacts.import.mockRejectedValueOnce(Object.assign(new Error('Out of memory.'), { code: 'MEMORY_LIMIT' }));
    const repo = await address(f);
    await f.directoryDb.settled(); await f.drain();
    expect((await f.request('/api/repos/alice/repo', alice)).status).toBe(413);
    f.state.refusePushes = false;
    // The copy in parts took its own name; the failed import's name was let go.
    const failed = f.artifacts.create.mock.lastCall![0], first = f.artifacts.import.mock.lastCall![0].target.name;
    expect(failed).toBe(`${first}-parts`);
    expect(f.artifacts.delete).toHaveBeenCalledWith(first);
    // Earlier tries spent the transfer budget; a retry starts with all of it.
    f.directoryDb.storage.sql.exec('UPDATE mirrors SET bytes = ?', MIRROR_TOTAL_BYTES);
    const seeded = await f.request('/api/repos/alice/repo', undefined, { 'x-braid-mirror-seed': 's'.repeat(40) });
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    expect(f.artifacts.import.mock.lastCall![0].target.name).toMatch(new RegExp(`^${first}-[a-z0-9]+$`));
    expect(f.artifacts.delete).toHaveBeenCalledWith(failed);
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    await f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`).workspace.alarm(); await f.drain();
    const file = await f.request('/api/repository?path=README.md', alice, { 'x-braid-workspace': repo.workspaceId });
    expect(file.status, await file.clone().text()).toBe(200);
  });
  it('answers a mirror too large to copy with its code wherever it is read', async () => {
    const f = await fixture(); f.state.refusePushes = true;
    f.artifacts.import.mockRejectedValueOnce(Object.assign(new Error('Out of memory.'), { code: 'MEMORY_LIMIT' }));
    const repo = await address(f);
    await f.directoryDb.settled(); await f.drain();
    const headers = { 'x-braid-workspace': repo.workspaceId };
    for (const response of [await f.request('/api/repos/alice/repo', alice), await f.request('/api/state', alice, headers)]) {
      expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ error: MIRROR_LARGE, code: 'mirror_too_large' });
    }
    // Before the Directory records the failure, the workspace answers with the same code.
    f.directory.mirrorUpdated(repo.workspaceId, { error: null });
    expect(await (await f.request('/api/state', alice, headers)).json()).toMatchObject({ importing: { error: MIRROR_LARGE, code: 'mirror_too_large' } });
    const file = await f.request('/api/repository?path=README.md', alice, headers);
    expect(file.status).toBe(413); expect(await file.json()).toMatchObject({ error: MIRROR_LARGE, code: 'mirror_too_large' });
  });
  it('preserves native addresses and only admits mirrors under a matching verified native owner', async () => {
    const f = await fixture(); f.directory.account(alice, { id: 101, login: 'alice' }, true);
    const owner = f.directory.personalOwner(alice.id)!;
    const native = f.directory.createWorkspace(alice.id, owner.id, 'repo', 'public');
    expect((await address(f)).workspaceId).toBe(native.id); expect(f.network).not.toHaveBeenCalled();
    // Extending an existing namespace needs immutable owner proof from this visitor; smart HTTP has no owner ID.
    expect((await f.request('/api/repos/alice/another')).status).toBe(404);
    const response = await f.request('/api/repos/alice/another', alice);
    expect(response.status).toBe(200); const repo = await response.json() as RepositoryAddress;
    expect(repo.canWrite).toBe(false); expect(f.directory.mirrorRecord(repo.workspaceId)?.teamId).toBe(owner.id);
    f.directory.setUsername(bob, 'bob'); // Email-style registration has no verified GitHub identity in Directory.
    expect((await f.request('/api/repos/bob/another')).status).toBe(404);
    expect(f.network.mock.calls.some(([url]) => /\/(?:users\/)?bob(?:\/|\?|$)/.test(String(url)))).toBe(false);
  });
  it.each([false, true])('freezes an existing pinned mirror after the GitHub owner ID changes (private: %s)', async privateSource => {
    const f = await fixture(); f.state.private = privateSource;
    f.directory.account(alice, { id: 101, login: 'alice' }, true);
    const repo = await address(f, alice);
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    expect(mirror.namespaceId).toBe(101);
    const ws = f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`);
    await ws.workspace.alarm(); await f.drain();
    expect((await address(f, alice)).mirror?.importing).toBe(false);
    const before = f.directory.mirrorRecord(repo.workspaceId)!;
    f.profiles.set(alice.id, { id: 404, login: 'alice', type: 'User' });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.advanceTimersByTime(MIRROR_SYNC_MS + 1);
    const response = await f.request('/api/repos/alice/repo', alice);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: MIRROR_NAMESPACE_CHANGED });
    const frozen = f.directory.mirrorRecord(repo.workspaceId)!;
    expect(frozen).toMatchObject({ head: before.head, syncedAt: before.syncedAt, importing: 0, error: MIRROR_NAMESPACE_CHANGED });
    // A delayed completion cannot clear the freeze, advance its head, or reserve another transfer.
    f.directory.mirrorUpdated(repo.workspaceId, { syncedAt: new Date().toISOString(), head: 'f'.repeat(40), importing: false });
    expect(f.directory.mirrorRecord(repo.workspaceId)).toEqual(frozen);
    expect(f.directory.reserveMirrorBytes(repo.workspaceId, 1)).toBe(false);
    const maintenance = vi.spyOn(ws.workspace, 'readMirror');
    expect((await f.request('/api/repos/alice/repo', alice)).status).toBe(409);
    await ws.workspace.readMirror(frozen, alice.id); await f.drain();
    expect(maintenance).toHaveBeenCalledTimes(1); // Only the explicit recovery attempt, never the read.
    expect(f.target.native(['rev-parse', 'main']).trim()).toBe(before.head);
  });
  it('keeps serving an imported mirror whose history copy runs out of budget, and clears an older too-large mark', async () => {
    const f = await fixture();
    const repo = await address(f, alice);
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    const ws = f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`);
    await ws.workspace.alarm(); await f.drain();
    expect(f.directory.mirrorRecord(repo.workspaceId)!.syncedAt).not.toBeNull();
    while (f.directory.reserveMirrorBytes(repo.workspaceId, MIRROR_PACK_BYTES));
    expect(f.directory.mirrorRecord(repo.workspaceId)!.error).toBeNull();
    expect((await f.request('/api/repos/alice/repo', alice)).status).toBe(200);
    // Mirrors marked by the earlier rule read again.
    f.directory.mirrorUpdated(repo.workspaceId, { error: MIRROR_LARGE });
    expect((await f.request('/api/repos/alice/repo', alice)).status).toBe(200);
    expect(f.directory.mirrorRecord(repo.workspaceId)!.error).toBeNull();
  });
  it('copies the history an older mirror never had on its next sync, and resumes a copy whose alarm was lost', async () => {
    const f = await fixture();
    const repo = await address(f);
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    const ws = f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`);
    await ws.workspace.alarm(); await f.drain();
    expect(await ws.db.storage.get('history-copy')).toBe('complete');
    // An older mirror: its copy is still one commit deep, and nothing records that history was never copied.
    rmSync(join(f.target.root, 'repo.git'), { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--bare', '--depth', '1', '--branch', 'main', `file://${f.github.path}`, join(f.target.root, 'repo.git')]);
    f.target.native(['config', 'http.receivepack', 'true']); f.target.native(['config', 'receive.shallowUpdate', 'true']);
    await ws.db.storage.delete('history-copy');
    expect(() => f.target.native(['cat-file', '-e', f.first])).toThrow();
    vi.useFakeTimers({ toFake: ['Date'] });
    const sync = async () => { vi.advanceTimersByTime(MIRROR_SYNC_MS + 31_000); await address(f); await f.drain(); };
    await sync();
    expect(await ws.db.storage.get('branch-copy')).toMatchObject({ mirror: { workspaceId: repo.workspaceId }, shallow: f.head, attempts: 0 });
    // The alarm is lost before it runs; the next sync finds the waiting copy and schedules it again.
    await ws.db.storage.deleteAlarm();
    await sync();
    expect(await ws.db.storage.getAlarm()).not.toBeNull();
    await ws.workspace.alarm(); await f.drain();
    expect(f.target.native(['cat-file', '-t', f.first]).trim()).toBe('commit');
    expect(f.target.native(['rev-parse', HISTORY_REF]).trim()).toBe(f.first);
    expect(await ws.db.storage.get('history-copy')).toBe('complete');
    expect(await ws.db.storage.get('branch-copy')).toBeUndefined();
    // Copied once: later syncs leave it alone.
    await sync();
    expect(await ws.db.storage.get('branch-copy')).toBeUndefined();
  });
  it('tries a failed history copy again only after the retry interval', async () => {
    const f = await fixture();
    const repo = await address(f);
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    const ws = f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`);
    await ws.workspace.alarm(); await f.drain();
    // A copy that gave up, such as one that ran out of transfer budget.
    vi.useFakeTimers({ toFake: ['Date'] });
    await ws.db.storage.put('history-copy', { failedAt: Date.now() });
    const sync = async (wait: number) => { vi.advanceTimersByTime(wait); await address(f); await f.drain(); };
    await sync(MIRROR_SYNC_MS + 31_000);
    expect(await ws.db.storage.get('branch-copy')).toBeUndefined();
    await sync(HISTORY_RETRY_MS);
    expect(await ws.db.storage.get('branch-copy')).toMatchObject({ mirror: { workspaceId: repo.workspaceId }, attempts: 0 });
  });
  /** Ten commits on main, and a copy that answers pushes as Artifacts does at its storage limit while `full` is set. */
  async function fillable() {
    const f = await fixture();
    const line = [f.first, f.head];
    for (let n = 3; n <= 10; n++) line.push(f.source.commitTree({ [`src/${n}.ts`]: `export const n = ${n};\n` }, line.at(-1), `Commit ${n}`));
    f.github.git(['fetch', `file://${f.source.root}/repo.git`, `${line.at(-1)}:refs/heads/main`]);
    const network = f.network.getMockImplementation()!, limit = { full: false };
    f.network.mockImplementation(async (input, init) => limit.full && String(input) === `${f.target.remote}/git-receive-pack`
      ? new Response(concat([pktLine('ERR artifacts_git_receive_pack_storage_limit\n'), FLUSH]), { headers: { 'content-type': 'application/x-git-receive-pack-result' } })
      : network(input, init));
    const repo = await address(f);
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    return { f, line, limit, repo, ws: f.getWorkspace(`team:${mirror.teamId}:repository:${repo.workspaceId}`), name: `mirror-${repo.workspaceId.replaceAll('-', '')}` };
  }
  it("lets the operator's seeding clear an orphaned error only after confirming the serving copy", async () => {
    const { f, repo, ws } = await fillable();
    await ws.workspace.alarm(); await f.drain();
    f.env.MIRROR_SEED_TOKEN = 's'.repeat(40);
    expect(await ws.db.storage.get('pending-project')).toBeUndefined();
    f.directory.mirrorUpdated(repo.workspaceId, { error: 'The import did not finish. Try again.' });
    expect((await f.request('/api/repos/alice/repo')).status).toBe(502);
    const seeded = await f.request('/api/repos/alice/repo', undefined, { 'x-braid-mirror-seed': 's'.repeat(40) });
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    expect(f.directory.mirrorRecord(repo.workspaceId)?.error).toBeNull();
    const file = await f.request('/api/repository?path=README.md', undefined, { 'x-braid-workspace': repo.workspaceId });
    expect(file.status, await file.clone().text()).toBe(200);
  });
  it("lets the operator's seeding drop a failed replacement that left the serving copy marked failed", async () => {
    const { f, repo, ws } = await fillable();
    await ws.workspace.alarm(); await f.drain();
    f.env.MIRROR_SEED_TOKEN = 's'.repeat(40);
    // The state an interrupted copy in parts once left: a failed replacement, and the error on the serving mirror.
    await ws.db.storage.put('pending-project', { name: 'mirror-replacement-parts', displayName: 'repo', description: '', mirror: { workspaceId: repo.workspaceId, fullName: 'alice/repo' },
      replaces: (await ws.db.storage.get<{ project: { id: string } }>('state'))?.project.id ?? 'mirror', error: 'The import did not finish. Try again.', startedAt: new Date().toISOString(), sourceUrl: 'https://github.com/alice/repo.git' });
    f.directory.mirrorUpdated(repo.workspaceId, { error: 'The import did not finish. Try again.' });
    expect((await f.request('/api/repos/alice/repo')).status).toBe(502);
    const seeded = await f.request('/api/repos/alice/repo', undefined, { 'x-braid-mirror-seed': 's'.repeat(40) });
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    expect(await ws.db.storage.get('pending-project')).toBeUndefined();
    expect(f.directory.mirrorRecord(repo.workspaceId)?.error).toBeNull();
    const file = await f.request('/api/repository?path=README.md', undefined, { 'x-braid-workspace': repo.workspaceId });
    expect(file.status, await file.clone().text()).toBe(200);
  });
  it('replaces a copy a sync finds full with a fresh import whose history keeps a share of the old depth', async () => {
    const { f, line, limit, repo, ws, name } = await fillable();
    await ws.workspace.alarm(); await f.drain();
    expect(await ws.db.storage.get('history-copy')).toBe('complete');
    // GitHub moves on, and the copy takes no more pushes.
    const next = f.source.commitTree({ 'README.md': '# Updated\n' }, line.at(-1), 'Commit 11');
    f.github.git(['fetch', `file://${f.source.root}/repo.git`, `${next}:refs/heads/main`]);
    limit.full = true;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.advanceTimersByTime(MIRROR_SYNC_MS + 31_000);
    await address(f); await f.drain();
    // The replacement is imported beside the full copy, which keeps serving until it lands.
    expect(f.artifacts.import).toHaveBeenCalledTimes(2);
    expect(f.artifacts.import.mock.lastCall![0].target.name).toMatch(new RegExp(`^${name}-[a-z0-9]+$`));
    expect(f.artifacts.delete).not.toHaveBeenCalled();
    expect(f.directory.mirrorRecord(repo.workspaceId)).toMatchObject({ head: line.at(-1), importing: 0 });
    // The full copy reached ten commits deep; its replacement copies six beneath the new tip.
    expect(await ws.db.storage.get('history-limit')).toBe(6);
    // Until the replacement lands, a visit leaves the full copy alone.
    const reads = f.network.mock.calls.length;
    vi.advanceTimersByTime(MIRROR_SYNC_MS + 31_000); await address(f); await f.drain();
    expect(f.network.mock.calls.slice(reads).filter(([url]) => String(url).startsWith(f.target.remote))).toEqual([]);
    expect(f.artifacts.import).toHaveBeenCalledTimes(2);
    limit.full = false;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.artifacts.delete.mockRejectedValueOnce(Object.assign(new Error('cleanup private-fixture-token'), { code: 'UPSTREAM_UNAVAILABLE' }));
    await ws.workspace.alarm(); await f.drain();
    expect(f.artifacts.delete).toHaveBeenCalledWith(name);
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ event: 'mirror_old_copy_cleanup_failed', code: 'UPSTREAM_UNAVAILABLE', repository: name }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-fixture-token');
    expect(f.directory.mirrorRecord(repo.workspaceId)).toMatchObject({ head: next, importing: 0 });
    const file = await f.request('/api/repository?path=README.md', undefined, { 'x-braid-workspace': repo.workspaceId });
    expect(await file.json()).toMatchObject({ content: '# Updated\n' });
    await ws.workspace.alarm(); await f.drain();
    const has = (hash: string) => { try { f.target.native(['cat-file', '-e', hash]); return true; } catch { return false; } };
    expect(line.map(has)).toEqual([false, false, false, false, true, true, true, true, true, true]);
    expect(await ws.db.storage.get('history-copy')).toBe('too-large');
  });
  it('keeps serving a full copy whose replacement failed to import, and tries again on a later sync', async () => {
    const { f, line, limit, repo, ws, name } = await fillable();
    await ws.workspace.alarm(); await f.drain();
    const next = f.source.commitTree({ 'README.md': '# Updated\n' }, line.at(-1), 'Commit 11');
    f.github.git(['fetch', `file://${f.source.root}/repo.git`, `${next}:refs/heads/main`]);
    limit.full = true;
    f.artifacts.import.mockRejectedValueOnce(Object.assign(new Error('GitHub is unavailable.'), { code: 'UPSTREAM_UNAVAILABLE' }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.artifacts.delete.mockRejectedValueOnce(Object.assign(new Error('cleanup private-fixture-token'), { code: 'UPSTREAM_UNAVAILABLE' }));
    vi.useFakeTimers({ toFake: ['Date'] });
    const sync = async () => { vi.advanceTimersByTime(MIRROR_SYNC_MS + 31_000); await address(f); await f.drain(); };
    await sync();
    const failed = f.artifacts.import.mock.lastCall![0].target.name;
    expect(f.artifacts.delete).toHaveBeenCalledWith(failed);
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ event: 'mirror_replacement_cleanup_failed', code: 'UPSTREAM_UNAVAILABLE', repository: failed }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-fixture-token');
    expect(await ws.db.storage.get('pending-project')).toBeUndefined();
    expect(f.directory.mirrorRecord(repo.workspaceId)).toMatchObject({ head: line.at(-1), importing: 0, error: null });
    const file = await f.request('/api/repository?path=README.md', undefined, { 'x-braid-workspace': repo.workspaceId });
    expect(await file.json()).toMatchObject({ content: '# Mirror\nHello\n' });
    await sync();
    expect(f.artifacts.import).toHaveBeenCalledTimes(3);
    limit.full = false;
    await ws.workspace.alarm(); await f.drain();
    expect(f.artifacts.delete).toHaveBeenCalledWith(name);
    expect(f.directory.mirrorRecord(repo.workspaceId)).toMatchObject({ head: next, importing: 0 });
  });
  it('replaces a copy that fills while its history is copied, keeping a share of the depth it reached', async () => {
    const { f, line, limit, repo, ws, name } = await fillable();
    await ws.workspace.alarm(); await f.drain();
    // A copy five commits beneath its tip when it filled.
    rmSync(join(f.target.root, 'repo.git'), { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--bare', '--depth', '6', '--branch', 'main', `file://${f.github.path}`, join(f.target.root, 'repo.git')]);
    f.target.native(['config', 'http.receivepack', 'true']); f.target.native(['config', 'receive.shallowUpdate', 'true']);
    await ws.db.storage.put('branch-copy', { sourceUrl: 'https://github.com/alice/repo.git', mirror: { workspaceId: repo.workspaceId, fullName: 'alice/repo' }, shallow: line.at(-1),
      history: { boundary: [line[4]], depth: 256, copied: 5 }, failed: [], attempts: 0 });
    limit.full = true;
    await ws.workspace.alarm(); await f.drain();
    expect(f.artifacts.import).toHaveBeenCalledTimes(2);
    expect(await ws.db.storage.get('branch-copy')).toBeUndefined();
    expect(await ws.db.storage.get('history-limit')).toBe(3);
    limit.full = false;
    await ws.workspace.alarm(); await f.drain();
    expect(f.artifacts.delete).toHaveBeenCalledWith(name);
    await ws.workspace.alarm(); await f.drain();
    const has = (hash: string) => { try { f.target.native(['cat-file', '-e', hash]); return true; } catch { return false; } };
    expect(line.map(has)).toEqual([false, false, false, false, false, false, true, true, true, true]);
    expect(await ws.db.storage.get('history-copy')).toBe('too-large');
  });
  it('charges a transfer only once it reaches its end', async () => {
    const f = await fixture();
    const repo = await address(f);
    await f.directoryDb.settled(); f.completeImport(); await f.drain();
    const release = vi.spyOn(f.directory, 'releaseMirrorBytes');
    // Cut short, as when a part of history outgrows a push: nothing was stored, so all of it comes back.
    const cut = (await mirrorTransfer(f.env, repo.workspaceId)).wrap(new Blob(['x'.repeat(1000)]).stream()).getReader();
    await cut.read(); await cut.cancel();
    expect(release).toHaveBeenLastCalledWith(repo.workspaceId, MIRROR_PACK_BYTES);
    await new Response((await mirrorTransfer(f.env, repo.workspaceId)).wrap(new Blob(['y'.repeat(1000)]).stream())).arrayBuffer();
    expect(release).toHaveBeenLastCalledWith(repo.workspaceId, MIRROR_PACK_BYTES - 1000);
  });
  it('keeps a missing and a private source indistinguishable and leaves example/relay on the recorded route', async () => {
    const f = await fixture(); f.state.missing = true;
    const missing = await f.request('/api/repos/alice/repo');
    expect(missing.status).toBe(404); expect(await missing.json()).toMatchObject({ code: 'github_not_found_or_private' });
    f.network.mockClear();
    expect((await f.request('/api/repos/example/relay')).status).toBe(404); expect(f.network).not.toHaveBeenCalled();
    const state = await f.request('/api/state', undefined, { 'x-braid-workspace': 'demo' });
    expect(state.status).toBe(200); expect(await state.json()).toMatchObject({ capabilities: { mode: 'demo' } });
  });
});
