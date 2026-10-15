import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { ciStatusesUrl, repositoryFromStatuses, validHookUrl } from './ci';
import { mac } from '../http/auth';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await harness?.close(); harness = undefined; });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};
const secret = 'ci-webhook-secret-for-tests';

/** A repository whose rules require one status from its own CI, with a webhook to that CI. */
async function withCi() {
  harness = await changeHarness();
  const policy = { autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, verify: { required: ['buildkite/test'], minutes: 1 } };
  const base = harness.git.commitTree({ 'src/a.ts': 'export const a = 1;\n', '.braid/policy.json': JSON.stringify(policy) });
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
  ok(await harness.trunk.setHook(harness.repository, { url: 'https://ci.example/braid', secret, actor: 'owner@example.test', origin: 'https://braid.example' }));
  const deliveries: { body: Record<string, any>; signature: string | null; event: string | null }[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'https://ci.example/braid') return real(input, init);
    const headers = new Headers(init!.headers);
    deliveries.push({ body: JSON.parse(String(init!.body)), signature: headers.get('x-braid-signature-256'), event: headers.get('x-braid-event') });
    return new Response(null, { status: 202 });
  });
  const report = async (sha: string, status: Record<string, string>, key = secret) => {
    const body = JSON.stringify(status);
    return harness!.trunk.report(harness!.repository, sha, body, `sha256=${await mac(key, body)}`);
  };
  return { harness, base, deliveries, report };
}
const change = (title: string, path: string, content: string, base: string) => ({ title, summary: title, baseCommit: base, files: [{ path, content }] });

describe('CI through webhooks and statuses', () => {
  it('validates hook URLs and round-trips the statuses address', async () => {
    expect(validHookUrl('http://ci.example/hook')).toMatch(/https/);
    expect(validHookUrl('https://user:pw@ci.example/hook')).toMatch(/credentials/);
    expect(validHookUrl('https://192.168.1.4/hook')).toMatch(/public internet/);
    expect(validHookUrl('https://ci.example/hook')).toBeNull();
    expect(validHookUrl('https://fdic.example/hook')).toBeNull();
    for (const local of ['https://[fd00::1]/h', 'https://[::1]/h', 'https://build.internal/h', 'https://10.0.0.8/h']) expect(validHookUrl(local)).toMatch(/public internet/);
    const url = ciStatusesUrl('https://braid.example', 'team:t1:repository:w1', 'a'.repeat(40));
    expect(repositoryFromStatuses(url.split('/')[5])).toBe('team:t1:repository:w1');
    expect(await mac('k', 'body')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('tells CI about the merge group, waits for the required status, and merges on success', async () => {
    const { harness, base, deliveries, report } = await withCi();
    const item = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery.event).toBe('merge_group');
    expect(delivery.signature).toBe(`sha256=${await mac(secret, JSON.stringify(delivery.body))}`);
    const tip = delivery.body.merge_group.head_sha as string;
    expect(delivery.body).toMatchObject({ action: 'checks_requested', merge_group: { base_sha: base, pull_requests: [{ number: item.number, title: 'Add b' }] }, clone: { token: expect.any(String) },
      statuses_url: expect.stringMatching(new RegExp(`^https://braid\\.example/api/statuses/[A-Za-z0-9_-]+/${tip}$`)) });
    // A forged report is refused; a pending one changes nothing.
    expect(await report(tip, { state: 'success', context: 'buildkite/test' }, 'wrong-secret-for-tests-0000')).toMatchObject({ ok: false, status: 401 });
    expect(await report(tip, { state: 'pending', context: 'buildkite/test' })).toEqual({ ok: true });
    await harness.settle(2);
    expect(harness.head()).toBe(base);
    expect((await harness.trunk.status(harness.repository)).landing?.ci).toMatchObject({ required: ['buildkite/test'], statuses: { 'buildkite/test': { state: 'pending' } } });
    expect(await report(tip, { state: 'success', context: 'buildkite/test', description: '24 tests passed', target_url: 'https://ci.example/builds/7' })).toEqual({ ok: true });
    await harness.settle(2);
    const landed = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
    expect(landed.status).toBe('landed');
    expect(landed.checks.find(check => check.label === 'buildkite/test')).toMatchObject({ source: 'ci', status: 'passed', detail: expect.stringContaining('https://ci.example/builds/7') });
    expect((await harness.trunk.hook(harness.repository))!.deliveries[0]).toMatchObject({ event: 'merge_group', status: 202, sha: tip });
    expect(JSON.stringify(await harness.trunk.hook(harness.repository))).not.toContain(secret);
  }, 30_000);

  it('sends back the change CI fails, after a retry in case the failure was flaky', async () => {
    const { harness, base, deliveries, report } = await withCi();
    const item = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    for (let round = 0; round < 4 && ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status !== 'revise'; round++) {
      await harness.settle(2);
      const tip = deliveries.at(-1)!.body.merge_group.head_sha as string;
      await report(tip, { state: 'failure', context: 'buildkite/test', description: '1 test failed' });
      await harness.settle(2);
    }
    const sent = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
    expect(sent.status).toBe('revise');
    expect(sent.checks.find(check => check.source === 'ci')).toMatchObject({ label: 'buildkite/test', status: 'failed', detail: expect.stringContaining('1 test failed') });
    expect(harness.head()).toBe(base);
  }, 30_000);

  it('never merges when CI does not report, and composes again instead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { harness, base, deliveries } = await withCi();
    ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    expect(deliveries).toHaveLength(1);
    vi.setSystemTime(Date.now() + 7 * 60_000);
    await harness.settle(2);
    expect(harness.head()).toBe(base);
    expect((await harness.trunk.status(harness.repository)).recent.some(batch => batch.note?.startsWith('CI did not report buildkite/test within 1 minute,'))).toBe(true);
    expect(deliveries.length).toBeGreaterThan(1);
  }, 30_000);
});
