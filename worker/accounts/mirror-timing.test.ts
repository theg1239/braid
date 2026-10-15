import { afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorFixture } from '../test/mirror';
import { Workspace } from '../workspace/workspace';

let fixture: Awaited<ReturnType<typeof mirrorFixture>> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('mirror reservation time', () => {
  it('returns the durable start before background setup and independently of an empty edge-cached public state', async () => {
    fixture = await mirrorFixture();
    // Hold background setup before it can create pending-project, as a slow authorization/initialization would.
    vi.spyOn(Workspace.prototype, 'readMirror').mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T00:00:15.000Z');
    const response = await fixture.request('/api/repos/alice/repo');
    expect(response.status).toBe(200);
    const address = await response.json() as { workspaceId: string; mirror: { startedAt: string } };
    expect(address.mirror.startedAt).toBe('2026-10-15T00:00:15.000Z');
    const reserved = fixture.directoryDb.storage.sql.exec<{ createdAt: string }>('SELECT created_at AS createdAt FROM workspaces WHERE id = ?', address.workspaceId).one();
    expect(address.mirror.startedAt).toBe(reserved.createdAt);
    const headers = { 'x-braid-workspace': address.workspaceId };
    const firstState = await fixture.request('/api/state', undefined, headers);
    expect(firstState.status).toBe(200); expect(await firstState.json()).not.toHaveProperty('importing');
    const mirror = fixture.directory.mirrorRecord(address.workspaceId)!;
    const ws = fixture.getWorkspace(`team:${mirror.teamId}:repository:${address.workspaceId}`);
    const reads = vi.spyOn(ws.workspace, 'fetch');
    vi.setSystemTime('2026-10-15T00:00:18.000Z');
    expect(await (await fixture.request('/api/state', undefined, headers)).json()).not.toHaveProperty('importing');
    expect(reads).not.toHaveBeenCalled();
    vi.setSystemTime('2026-10-15T00:01:00.000Z');
    expect(await (await fixture.request('/api/repos/alice/repo')).json()).toMatchObject({ mirror: { startedAt: reserved.createdAt } });
    // A later refresh must not mistake the original reservation for a new copy's start.
    fixture.directory.mirrorUpdated(address.workspaceId, { importing: false, syncedAt: '2026-10-15T00:01:00.000Z' });
    expect((await (await fixture.request('/api/repos/alice/repo')).json() as { mirror: unknown }).mirror).not.toHaveProperty('startedAt');
    fixture.directory.mirrorUpdated(address.workspaceId, { importing: true });
    expect((await (await fixture.request('/api/repos/alice/repo')).json() as { mirror: unknown }).mirror).not.toHaveProperty('startedAt');
  });
});
