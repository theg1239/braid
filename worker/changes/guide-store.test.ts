import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageFixture } from '../test/storage';
import { GuideStore } from './guide-store';
import { GUIDE_TIMEOUT_MS, type GuideInput } from './guide';

const input: GuideInput = { title: 'Change limit', summary: 'Raise the limit.', description: 'Permit a larger batch.', attributes: [{ path: 'vendor.ts', vendored: true }], files: [{ path: 'vendor.ts', before: 'export const limit = 1;\n', after: 'export const limit = 2;\n' }] };
const valid = { before: 'The limit was one.', after: 'The limit is two.', chapters: [{ title: 'Raise the limit', summary: 'Permits two items.', kind: 'logic', hunks: [{ path: 'vendor.ts', newStart: 1, newLines: 1 }] }] };
const fixtures: ReturnType<typeof storageFixture>[] = [];
const setup = () => { const db = storageFixture(); fixtures.push(db); return { ...db, store: new GuideStore(db.storage.sql) }; };
const ai = (run: ReturnType<typeof vi.fn>) => ({ run }) as unknown as Ai;
afterEach(() => { vi.useRealTimers(); fixtures.splice(0).forEach(fixture => fixture.db.close()); });

describe('durable guide runs', () => {
  it('caches each revision across restarts and never invokes the model on reads', async () => {
    const { store, storage } = setup(), run = vi.fn(async () => valid);
    expect(store.enqueue('ch_1', 1, input)).toBe(true);
    expect(store.enqueue('ch_1', 1, input)).toBe(false);
    expect(store.get('ch_1', 1)).toMatchObject({ status: 'pending', chapters: [] });
    expect(run).not.toHaveBeenCalled();
    await store.runDue(ai(run), async () => input);
    const restored = new GuideStore(storage.sql);
    expect(restored.get('ch_1', 1)).toMatchObject({ status: 'ready', revision: 1, attributes: input.attributes });
    restored.enqueue('ch_1', 2, { ...input, description: 'Second revision.' });
    expect(restored.get('ch_1', 2)?.status).toBe('pending');
    expect(restored.get('ch_1', 1)?.status).toBe('ready');
    await restored.runDue(ai(run), async (_id, revision, description) => { expect(revision).toBe(2); expect(description.description).toBe('Second revision.'); return input; });
    await restored.runDue(ai(run), async () => input);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('keeps reads instant during inference and deduplicates overlapping alarms', async () => {
    const { store } = setup(); store.enqueue('ch_1', 1, input);
    let finish!: (value: typeof valid) => void;
    const run = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const pending = store.runDue(ai(run), async () => input);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(store.get('ch_1', 1)).toMatchObject({ status: 'pending', attributes: input.attributes });
    await store.runDue(ai(run), async () => input);
    expect(run).toHaveBeenCalledOnce();
    finish(valid); await pending;
    expect(store.get('ch_1', 1)?.status).toBe('ready');
  });
  it('retries once with the validation error and never manufactures missing chapters', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store } = setup(); store.enqueue('ch_1', 1, input);
    const run = vi.fn().mockResolvedValueOnce({ ...valid, chapters: [] }).mockResolvedValueOnce(valid);
    await store.runDue(ai(run), async () => input);
    expect(store.get('ch_1', 1)).toMatchObject({ status: 'pending', chapters: [] });
    vi.setSystemTime(Date.now() + 1001);
    await store.runDue(ai(run), async () => input);
    expect(run.mock.calls[1][1].messages.at(-1).content).toContain('Invalid guide JSON');
    expect(store.get('ch_1', 1)?.status).toBe('ready');
  });
  it('retains a failed result after two invalid answers and hides raw provider errors', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store } = setup(); store.enqueue('ch_1', 1, input);
    const run = vi.fn().mockRejectedValue(new Error('secret-provider-token'));
    await store.runDue(ai(run), async () => input);
    vi.setSystemTime(Date.now() + 1001);
    await store.runDue(ai(run), async () => input);
    expect(store.get('ch_1', 1)).toMatchObject({ status: 'failed', chapters: [], error: 'Workers AI could not generate the guide.', attributes: input.attributes });
    vi.setSystemTime(Date.now() + 1_000_000);
    await store.runDue(ai(run), async () => input);
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(store.get('ch_1', 1))).not.toContain('secret-provider-token');
  });
  it('recovers abandoned leases and caps total attempts', async () => {
    const { store, db, storage } = setup(); store.enqueue('ch_1', 1, input);
    db.prepare('UPDATE change_guides SET attempts = 2, due = 0').run();
    const run = vi.fn();
    await new GuideStore(storage.sql).runDue(ai(run), async () => input);
    expect(store.get('ch_1', 1)).toMatchObject({ status: 'failed', error: expect.stringContaining('two attempts') });
    expect(run).not.toHaveBeenCalled();
  });
  it('fences an old attempt that finishes after its replacement', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store } = setup(); store.enqueue('ch_1', 1, input);
    let release!: (value: typeof valid) => void;
    const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue({ ...valid, before: 'The replacement attempt succeeded.' });
    const first = store.runDue(ai(run), async () => input);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    vi.setSystemTime(Date.now() + GUIDE_TIMEOUT_MS + 30_001);
    await store.runDue(ai(run), async () => input);
    release(valid); await first;
    expect(store.get('ch_1', 1)).toMatchObject({ status: 'ready', before: 'The replacement attempt succeeded.' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('times out Git input work and never starts inference after that attempt expired', async () => {
    vi.useFakeTimers();
    const { store } = setup(); store.enqueue('ch_1', 1, input);
    let release!: (input: GuideInput) => void;
    const run = vi.fn(), pending = store.runDue(ai(run), () => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(GUIDE_TIMEOUT_MS + 1); await pending;
    release(input); await Promise.resolve(); await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(store.get('ch_1', 1)).toMatchObject({ status: 'pending', chapters: [] });
  });
});
