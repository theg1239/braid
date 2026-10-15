import { afterEach, describe, expect, it } from 'vitest';
import type { LocalActivityPage } from '../../shared/agent-activity';
import { localActivityFixture } from '../test/local-activity';

const fixtures: Awaited<ReturnType<typeof localActivityFixture>>[] = [];
const fixture = async () => { const found = await localActivityFixture(); fixtures.push(found); return found; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const started = { id: 'event-1', sequence: 1, at: new Date().toISOString(), kind: 'started', source: 'process' };
const input = { session: 's_local', model: 'claude-opus-5-5', tool: 'claude-code', events: [started], active: true };

describe('local activity API', () => {
  it('accepts only a work connection, rejects spoofed headers, expired tokens, and other repositories', async () => {
    const f = await fixture();
    expect((await f.call(input)).status).toBe(202);
    expect((await f.call(input, { token: null, headers: { 'x-braid-connection-digest': 'forged', 'x-braid-role': 'owner' } })).status).toBeGreaterThanOrEqual(400);
    expect((await f.call(input, { token: null, cookie: f.cookie })).status).toBe(403);
    expect((await f.call(input, { token: await f.issue() })).status).toBe(403);
    expect((await f.call(input, { workspace: 'wrong' })).status).toBe(403);
    for (const scope of ['read', 'setup', 'fleet'] as const) { await f.issue(scope); expect((await f.call(input)).status).toBe(403); }
    await f.issue('work', 'local-connection', Date.now() - 1);
    expect((await f.call(input)).status).toBe(401);
  });
  it('deduplicates retries, attaches only the author’s PR and keeps its identity across reconnects', async () => {
    const f = await fixture();
    expect((await f.call({ ...input, changeId: 'ch_0123456789abc' })).status).toBe(202);
    expect((await f.call(input)).status).toBe(202);
    await f.issue('work', 'reconnected');
    expect((await f.call({ ...input, events: [{ ...started, id: 'event-2', sequence: 2, kind: 'finished', exitCode: 0 }] })).status).toBe(202);
    const response = await f.call(undefined, { token: null, cookie: f.cookie, query: '?changeId=ch_0123456789abc' });
    expect(response.status).toBe(200);
    const page = await response.json() as LocalActivityPage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ changeNumber: 7, agent: { name: 'Claude Opus 5.5', owner: { name: '@local-owner' } } });
    expect(page.items[0].events).toHaveLength(2);
    expect(JSON.stringify(page)).not.toMatch(/local@example|braid_agent|local-connection/);
    expect((await f.call({ ...input, changeId: 'ch_0123456789abc' })).status).toBe(202);
  });
  it('enforces event, body and field bounds and excludes hosted diagnostics', async () => {
    const f = await fixture();
    for (const body of [
      { ...input, events: Array.from({ length: 41 }, () => started) },
      { ...input, events: [{ ...started, path: 'a'.repeat(241) }] },
      { ...input, events: [{ ...started, source: 'hosted' }] },
      { ...input, events: [{ ...started, failure: { lines: ['private'] } }] },
      { ...input, events: [{ ...started, output: 'private', env: { SECRET: 'secret' } }] },
      { ...input, events: [{ ...started, message: 'arbitrary private text' }] },
      { ...input, tool: '/Users/private/bin/agent' },
      { ...input, events: [{ ...started, exitCode: 999 }] },
    ]) expect((await f.call(body)).status).toBe(400);
    expect((await f.call({ ...input, untrusted: 'a'.repeat(40_000) })).status).toBe(413);
  });
  it('redacts commands and outside paths again at the server boundary', async () => {
    const f = await fixture();
    await f.call({ ...input, events: [{ ...started, kind: 'command', command: 'TOKEN=private npm test --token private', path: '/Users/private/secrets', exitCode: 2 }] });
    const page = await (await f.call(undefined, { token: null, cookie: f.cookie })).json() as LocalActivityPage;
    expect(page.items[0].events[0]).toMatchObject({ command: 'npm test', path: '[outside repository]', exitCode: 2 });
    expect(JSON.stringify(page)).not.toContain('TOKEN');
  });
  it('rate limits per owner, returns Retry-After and bounds retained events', async () => {
    const f = await fixture();
    for (let i = 0; i < 120; i++) expect((await f.call({ ...input, events: Array.from({ length: 3 }, (_, j) => ({ ...started, id: `e-${i}-${j}`, sequence: i * 3 + j })) })).status).toBe(202);
    const page = await (await f.call(undefined, { token: null, cookie: f.cookie })).json() as LocalActivityPage;
    expect(page.items[0].events).toHaveLength(200);
    const limited = await f.call(input);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    await f.issue('work', 'rotated');
    expect((await f.call(input)).status).toBe(429);
  });
  it('refuses unauthenticated reads of activity even for a public repository', async () => {
    const f = await fixture();
    expect((await f.call(undefined, { token: null })).status).toBeGreaterThanOrEqual(400);
  });
});
