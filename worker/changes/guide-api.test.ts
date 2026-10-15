import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicRepository } from '../test/public-repository';
import { changesRoute } from './router';
import { GUIDE_MODEL, parseGuide, prepareGuide } from './guide';
import { recordedGuideInput, type GuideRecording } from './guide-recording';
import { recordedExample } from './demo';
import type { BraidEnv } from '../env';
import type { ChangeGuide } from '../../shared/guide';
import { type Result } from '../errors';
import { agentPathAllowed, publicPathAllowed } from '../http/agent-auth';
import recorded from './recorded.json';

const fixtures: Awaited<ReturnType<typeof publicRepository>>[] = [];
const ok = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error); return result.data; };
const setup = async () => { const f = await publicRepository(); fixtures.push(f); return f; };
afterEach(async () => { vi.useRealTimers(); for (const fixture of fixtures.splice(0)) await fixture.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const guideAnswer = (input: unknown) => {
  const data = JSON.parse((input as { messages: { content: string }[] }).messages[1].content);
  return { before: 'The route was absent.', after: 'The route is available.', chapters: [{ title: 'Add a route', summary: 'Updates the router.', kind: 'logic', hunks: data.hunks.map(({ path, newStart, newLines }: { path: string; newStart: number; newLines: number }) => ({ path, newStart, newLines })) }] };
};

describe('guide API and revision lifecycle', () => {
  it('schedules on submission, serves public pending reads without Git/AI, and caches revisions', async () => {
    const f = await setup();
    const change = ok(await f.h.submit('author', { title: 'Add route', summary: 'Add a health route.', baseCommit: f.base, files: [{ path: 'src/router.ts', content: 'export const routes = ["/health"];\n' }] }));
    const shard = f.h.shard(parseInt(change.id[3], 16));
    const calls = () => f.h.ai.run.mock.calls.filter(([model]) => model === GUIDE_MODEL);
    f.h.artifacts.get.mockClear();
    expect(await (await f.anonymous(`/api/changes/${change.id}/guide?revision=1`)).json()).toMatchObject({ status: 'pending', revision: 1, chapters: [], generatedBy: GUIDE_MODEL });
    expect(calls()).toHaveLength(0); expect(f.h.artifacts.get).not.toHaveBeenCalled();
    const original = f.h.ai.run.getMockImplementation()!;
    f.h.ai.run.mockImplementation(async (model, input) => model === GUIDE_MODEL ? guideAnswer(input) : original(model, input));
    await shard.alarm();
    const response = await f.anonymous(`/api/changes/${change.number}/guide`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    const first = await response.json() as ChangeGuide;
    expect(first).toMatchObject({ status: 'ready', revision: 1 });
    expect(calls()).toHaveLength(1);
    const second = ok(await shard.revise(f.h.context('author', parseInt(change.id[3], 16)), change.id, { previousRevision: 1, baseCommit: f.base, summary: 'Add readiness route.', files: [{ path: 'src/router.ts', content: 'export const routes = ["/ready"];\n' }] }, 'guide-revision-request-0002'));
    expect(second.revision).toBe(2);
    expect(ok(await shard.guide(change.id))).toMatchObject({ status: 'pending', revision: 2 });
    expect(ok(await shard.guide(change.id, 1))).toEqual(first);
    expect((await f.anonymous(`/api/changes/${change.id}/guide?revision=3`)).status).toBe(404);
    expect((await f.anonymous(`/api/changes/${change.id}/guide?revision=1.5`)).status).toBe(400);
  });
  it('applies repository privacy and withholds secret revisions before returning or scheduling a guide', async () => {
    const f = await setup();
    const secret = 'ghp_' + 'A1b2'.repeat(9);
    const change = ok(await f.h.submit('author', { title: 'Configure', summary: 'Configure the client.', baseCommit: f.base, files: [{ path: 'client.ts', content: `export const key = '${secret}';\n` }] }));
    const response = await f.anonymous(`/api/changes/${change.id}/guide`);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ status: 'failed', chapters: [], attributes: [], error: 'This revision is not available publicly.' });
    expect(JSON.stringify(result)).not.toContain(secret);
    vi.useFakeTimers({ toFake: ['Date'] });
    f.directory.updateWorkspace(f.alice.id, { teamId: 't', workspaceId: 'w', visibility: 'private' });
    vi.setSystemTime(Date.now() + 6000);
    expect((await f.anonymous(`/api/changes/${change.id}/guide`)).status).toBe(404);
  });
  it('keeps guide reads inside the same public and agent allowlists as PR reads', () => {
    expect(publicPathAllowed('/api/changes/ch_123456789abcd/guide', 'GET')).toBe(true);
    expect(publicPathAllowed('/api/changes/12/guide', 'HEAD')).toBe(true);
    expect(publicPathAllowed('/api/changes/12/guide', 'POST')).toBe(false);
    expect(agentPathAllowed('/api/changes/12/guide', 'GET', 'read')).toBe(true);
    expect(agentPathAllowed('/api/changes/12/guide', 'POST', 'read')).toBe(false);
  });
  it('exposes revision-specific explicit attributes while the model is still pending', async () => {
    const f = await setup();
    const base = f.h.git.commitTree({ '.gitattributes': '*.ts linguist-generated\n', 'src/.gitattributes': 'router.ts -linguist-generated linguist-vendored\n' }, f.base);
    f.h.git.native(['update-ref', 'refs/heads/main', base]);
    const change = ok(await f.h.submit('author', { title: 'Update router', summary: 'Update a vendored file.', baseCommit: base, files: [{ path: 'src/router.ts', content: 'export const routes = ["/new"];\n' }] }));
    const original = f.h.ai.run.getMockImplementation()!;
    let finish!: () => void;
    f.h.ai.run.mockImplementation(async (model, input) => model === GUIDE_MODEL ? new Promise(resolve => { finish = () => resolve(guideAnswer(input)); }) : original(model, input));
    const shard = f.h.shard(parseInt(change.id[3], 16)), pending = shard.alarm();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(ok(await shard.guide(change.id))).toMatchObject({ status: 'pending', chapters: [], attributes: [{ path: 'src/router.ts', generated: false, vendored: true }] });
    finish(); await pending;
    expect(ok(await shard.guide(change.id))).toMatchObject({ status: 'ready', attributes: [{ path: 'src/router.ts', generated: false, vendored: true }] });
  });
});

describe('recorded tour guides', () => {
  it('serves recorded model output without model calls or changing the recording label', async () => {
    const example = await recordedExample(), ai = { run: vi.fn(() => { throw new Error('Tour reads cannot run a model'); }) };
    const env = { AI: ai, WORKSPACES: { idFromName: (name: string) => name, get: () => ({}) } } as unknown as BraidEnv;
    const change = recorded.changes[0];
    const response = await changesRoute(new Request(`https://braid.example/api/changes/${change.number}/guide`), env, { repository: 'example/relay', mode: 'demo', role: 'viewer' });
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(example.guide(change.id));
    expect(example.guide(change.id)).toMatchObject({ status: 'ready', generatedBy: GUIDE_MODEL });
    expect(ai.run).not.toHaveBeenCalled();
    expect(() => example.guide(change.id, 99)).toThrow(/no revision/);
  });
  it('has validated, complete model guides for every recorded hunk at every revision', () => {
    const data = recorded as unknown as GuideRecording;
    for (const change of data.changes) for (let revision = 1; revision <= change.revision; revision++) {
      const guide = data.guides?.[`${change.id}:${revision}`];
      expect(guide, `#${change.number} revision ${revision}`).toMatchObject({ status: 'ready', generatedBy: GUIDE_MODEL, revision });
      const input = prepareGuide(recordedGuideInput(data, change, revision));
      const reparsed = parseGuide({ before: guide!.before, after: guide!.after, chapters: guide!.chapters.map(chapter => ({ ...chapter,
        hunks: chapter.files.flatMap(file => file.hunks.map(hunk => ({ path: file.path, newStart: hunk.newStart, newLines: hunk.newLines }))) })) }, input, revision);
      expect(reparsed).toEqual(guide);
    }
  });
});
