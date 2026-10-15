import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { listChanges, hotPaths } from './router';
import { ChangeShard } from './shard';
import { pageCursor, parse } from '../schemas';
import type { Change } from '../../shared/types';
import { concat, FLUSH, pktLine } from '../git/transport';
import { STORAGE_FULL } from './trunk';

const router = ['export const routes = [', "  '/health',", '];', '', 'export function handle(path: string) {', '  return routes.includes(path);', '}', ''].join('\n');
let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

async function setup(policy?: unknown) {
  harness = await changeHarness();
  const files: Record<string, string> = { 'src/router.ts': router, 'docs/guide.md': '# Guide\n', 'CHANGELOG.md': '# Changes\n' };
  if (policy) files['.braid/policy.json'] = JSON.stringify(policy, null, 2) + '\n';
  const base = harness.git.commitTree(files);
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
  return { harness, base };
}
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};
const change = (body: { title: string; files: { path: string; content: string | null }[] }, base: string) => ({ summary: body.title, baseCommit: base, ...body });

describe('changes through the landing queue', () => {
  it('lands concurrent agents editing the same file and sends a true conflict back to its author', async () => {
    const { harness, base } = await setup();
    const docs = ok(await harness.submit('scribe', change({ title: 'Document health checks', files: [{ path: 'docs/guide.md', content: '# Guide\n\nHealth checks live at /health.\n' }] }, base)));
    // Documentation may land unattended, but a new author earns that: its first changes get one review.
    expect(docs).toMatchObject({ status: 'open', autonomy: 'review', number: expect.any(Number) });
    expect(docs.policy?.requirements.find(requirement => requirement.id === 'trust')).toMatchObject({ satisfied: true, detail: expect.stringContaining('0 of 3 clean landings') });
    const metrics = ok(await harness.submit('atlas', change({ title: 'Add metrics route', files: [
      { path: 'src/router.ts', content: router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n") },
      { path: 'CHANGELOG.md', content: '# Changes\n- Metrics route\n' },
    ] }, base)));
    expect(metrics).toMatchObject({ status: 'open', autonomy: 'review', next: 'Waiting for 1 independent review.' });
    const lower = ok(await harness.submit('sable', change({ title: 'Case-insensitive routes', files: [
      { path: 'src/router.ts', content: router.replace('return routes.includes(path);', 'return routes.includes(path.toLowerCase());') },
      { path: 'CHANGELOG.md', content: '# Changes\n- Case-insensitive routes\n' },
    ] }, base)));
    const rival = ok(await harness.submit('reed', change({ title: 'Prefix routes', files: [
      { path: 'src/router.ts', content: router.replace('return routes.includes(path);', "return routes.some(route => path.startsWith(route));") },
    ] }, base)));
    // Overlap is visible to agents as soon as they submit; it never blocks them.
    expect(rival.overlaps.map(overlap => overlap.number).sort()).toEqual([metrics.number, lower.number].sort());

    await harness.settle();
    const [landedMetrics, landedLower, sentBack] = await Promise.all([metrics, lower, rival].map(item => harness.shard(parseInt(item.id[3], 16)).get(item.id)));
    expect(ok(landedMetrics).status).toBe('landed');
    expect(ok(landedLower)).toMatchObject({ status: 'landed', strategies: { 'src/router.ts': 'line', 'CHANGELOG.md': 'union' } });
    const conflict = ok(sentBack) as Change;
    expect(conflict).toMatchObject({ status: 'revise', conflicts: [expect.objectContaining({ path: 'src/router.ts', kind: 'content' })] });
    expect(conflict.next).toBe('Conflicts with work that landed first in src/router.ts.');

    const head = harness.head();
    expect(harness.git.native(['show', 'main:src/router.ts'])).toBe(router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n").replace('return routes.includes(path);', 'return routes.includes(path.toLowerCase());'));
    expect(harness.git.native(['show', 'main:CHANGELOG.md'])).toBe('# Changes\n- Metrics route\n- Case-insensitive routes\n');
    expect(harness.git.native(['log', '--format=%s', `${base}..main`]).trim().split('\n').sort()).toEqual(['Add metrics route', 'Case-insensitive routes', 'Document health checks']);
    // Each change keeps its own commit, with no trailers beyond the model as co-author; the rest is in its note.
    expect(harness.git.native(['log', '-1', '--format=%B', `main`]).trim()).toBe('Case-insensitive routes\n\nCase-insensitive routes');
    expect(JSON.parse(harness.git.native(['notes', '--ref=braid', 'show', 'main']))).toMatchObject({ v: 1, change: { number: lower.number, revision: 1 } });
    expect(harness.workspace.trunkAdvanced).toHaveBeenCalledWith(head, expect.objectContaining({ landed: 3, ejected: 1 }));

    // The rival agent rebases onto the new trunk, resolves its conflict and lands.
    const current = harness.git.native(['show', 'main:src/router.ts']);
    const shardIndex = parseInt(rival.id[3], 16);
    const revised = ok(await harness.shard(shardIndex).revise(harness.context('reed', shardIndex), rival.id,
      { summary: 'Prefix routes, rebased', baseCommit: head, previousRevision: 1, files: [{ path: 'src/router.ts', content: current.replace('return routes.includes(path.toLowerCase());', 'return routes.some(route => path.toLowerCase().startsWith(route));') }] }, 'revise-request-key-0001'));
    expect(revised).toMatchObject({ status: 'open', revision: 2, conflicts: [] });
    await harness.settle();
    expect(ok(await harness.shard(shardIndex).get(rival.id))).toMatchObject({ status: 'landed', revision: 2 });
    expect(harness.git.native(['show', 'main:src/router.ts'])).toContain('path.toLowerCase().startsWith(route)');
    harness.git.native(['fsck', '--full', '--no-dangling']);

    const status = await harness.trunk.status(harness.repository);
    expect(status).toMatchObject({ enabled: true, queued: 0, stats: { landed: 4, ejected: 1 } });
    const page = await listChanges(harness.env, harness.repository, { statuses: ['landed'], limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.counts.landed).toBe(4);
    const rest = await listChanges(harness.env, harness.repository, { statuses: ['landed'], limit: 2, before: parse(pageCursor, page.nextCursor) });
    expect(new Set([...page.items, ...rest.items].map(item => item.id)).size).toBe(4);
    expect(await hotPaths(harness.env, harness.repository)).toEqual([]);
  }, 60_000);

  it('treats one commit pushed as a revision and later as a change of its own as two requests', async () => {
    harness = await changeHarness();
    // Both pushes reach the same shard, as they do whenever the new change's shard matches the revised one.
    const baseCommit = harness.git.commitTree({ 'README.md': '# Relay\n' });
    harness.git.native(['update-ref', 'refs/heads/main', baseCommit]);
    const shard = harness.shard(0), context = harness.context('pusher', 0);
    const body = (content: string) => ({ title: 'Retry deliveries', summary: 'Retry.', baseCommit, files: [{ path: 'src/retry.ts', content }] });
    const firstBody = body('export const attempts = 3;\n'), nextBody = body('export const attempts = 5;\n');
    const firstCommit = harness.git.commitTree({ 'src/retry.ts': firstBody.files[0].content }, baseCommit, 'Retry deliveries');
    const nextCommit = harness.git.commitTree({ 'src/retry.ts': nextBody.files[0].content }, firstCommit, 'Increase retries');
    const first = await shard.push(context, { topic: 'retries', commit: firstCommit }, firstBody);
    const revised = await shard.push(context, { topic: 'retries', commit: nextCommit }, nextBody);
    expect(revised).toMatchObject({ ok: true, data: { revision: 2 } });
    const own = await shard.push(context, { commit: nextCommit }, nextBody);
    expect(own.ok && first.ok && own.data.id !== first.data.id).toBe(true);
  });

  it('holds governed paths for a person and lands them after approval', async () => {
    const { harness, base } = await setup({ rules: [{ paths: ['src/billing/**'], autonomy: 'human' }] });
    const billing = ok(await harness.submit('atlas', change({ title: 'Round invoice totals', files: [{ path: 'src/billing/total.ts', content: 'export const total = (cents: number) => Math.round(cents);\n' }] }, base)));
    await harness.settle();
    const index = parseInt(billing.id[3], 16);
    const waiting = ok(await harness.shard(index).get(billing.id));
    expect(waiting).toMatchObject({ status: 'attention', autonomy: 'human' });
    expect(waiting.policy?.requirements.find(requirement => requirement.id === 'human')).toMatchObject({ satisfied: false });
    // Agents cannot approve; an owner approves the exact revision.
    expect(ok(await harness.shard(index).approve(harness.context({ kind: 'owner', id: 'user:owner', name: 'owner@example.test' }, index), billing.id, { revision: 1 }))).toMatchObject({ status: 'queued' });
    await harness.settle();
    expect(ok(await harness.shard(index).get(billing.id)).status).toBe('landed');
    expect(harness.git.native(['show', 'main:src/billing/total.ts'])).toContain('Math.round');
  }, 30_000);

  it('reverts a landed change through the queue and keeps later work on other lines', async () => {
    const { harness, base } = await setup();
    const owner = { kind: 'owner' as const, id: 'user:owner', name: 'owner@example.test' };
    const metrics = ok(await harness.submit('atlas', change({ title: 'Add metrics route', files: [
      { path: 'src/router.ts', content: router.replace("  '/health',", "  '/health',\n  '/metrics',") },
      { path: 'src/metrics.ts', content: 'export const metrics = () => 0;\n' },
    ] }, base)));
    await harness.settle();
    const landed = ok(await harness.shard(parseInt(metrics.id[3], 16)).get(metrics.id));
    expect(landed).toMatchObject({ status: 'landed', landedParent: base });
    // Someone else changes another line of the same file afterwards.
    const later = ok(await harness.submit('sable', change({ title: 'Trim paths', files: [{ path: 'src/router.ts', content: harness.git.native(['show', 'main:src/router.ts']).replace('includes(path)', 'includes(path.trim())') }] }, harness.head())));
    await harness.settle();
    expect(ok(await harness.shard(parseInt(later.id[3], 16)).get(later.id)).status).toBe('landed');

    const index = parseInt(metrics.id[3], 16);
    // Agents cannot revert; the owner can, once.
    expect(await harness.shard(index).revert(harness.context({ kind: 'agent', id: 'agent:sable', name: 'Sable' }, index), metrics.id, 'revert-metrics-0001')).toMatchObject({ ok: false, status: 403 });
    const revert = ok(await harness.shard(index).revert(harness.context(owner, index), metrics.id, 'revert-metrics-0001'));
    expect(revert).toMatchObject({ title: 'Revert #1: Add metrics route', revertOf: { id: metrics.id, number: metrics.number } });
    expect(ok(await harness.shard(index).revert(harness.context(owner, index), metrics.id, 'revert-metrics-0002')).id).toBe(revert.id);
    await harness.settle();
    expect(ok(await harness.shard(parseInt(revert.id[3], 16)).get(revert.id)).status).toBe('landed');
    expect(ok(await harness.shard(index).get(metrics.id)).revertedBy).toEqual({ id: revert.id, number: revert.number });
    const after = harness.git.native(['show', 'main:src/router.ts']);
    expect(after).not.toContain('/metrics');
    expect(after).toContain('includes(path.trim())');
    expect(() => harness.git.native(['show', 'main:src/metrics.ts'])).toThrow();
  }, 60_000);

  it('sends back a change that adds a malicious dependency or a credential, before it can merge', async () => {
    const { harness, base } = await setup({ rules: [{ paths: ['package-lock.json', 'src/**'], autonomy: 'auto', reviewers: 0 }] });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://api.osv.dev/v1/querybatch') return Promise.resolve(Response.json({ results: [{ vulns: [{ id: 'MAL-2026-1234' }] }] }));
      if (url.startsWith('https://api.osv.dev/v1/vulns/')) return Promise.resolve(Response.json({ id: 'MAL-2026-1234', summary: 'Malicious code in evil-pkg' }));
      return real(input, init);
    });
    try {
      const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'relay' }, 'node_modules/evil-pkg': { version: '1.0.0' } } }, null, 2) + '\n';
      const item = ok(await harness.submit('atlas', change({ title: 'Add a helper package', files: [{ path: 'package-lock.json', content: lock }] }, base)));
      await harness.settle();
      const sent = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
      expect(sent).toMatchObject({ status: 'revise', next: 'Failed: Dependency review' });
      expect(sent.checks.find(check => check.label === 'Dependency review')).toMatchObject({ kind: 'dependencies', status: 'failed', source: 'braid', detail: expect.stringContaining('evil-pkg@1.0.0: reported as malicious') });
      // A credential goes back too, and the finding never repeats the value.
      const token = ['braid', '_agent_', 'z'.repeat(40)].join('');
      const leak = ok(await harness.submit('sable', change({ title: 'Configure the client', files: [{ path: 'src/client.ts', content: `export const token = '${token}';\n` }] }, base)));
      await harness.settle();
      const leaked = ok(await harness.shard(parseInt(leak.id[3], 16)).get(leak.id));
      expect(leaked).toMatchObject({ status: 'revise', next: 'Adds what looks like a Braid token to src/client.ts at line 1.' });
      expect(JSON.stringify(leaked.guards)).not.toContain(token);
      expect(() => harness.git.native(['show', 'main:src/client.ts'])).toThrow();
    } finally { vi.unstubAllGlobals(); }
  }, 30_000);

  it('recomposes when trunk moves between reading and pushing', async () => {
    const { harness, base } = await setup();
    const docs = ok(await harness.submit('scribe', change({ title: 'Docs', files: [{ path: 'docs/guide.md', content: '# Guide\n\nUpdated.\n' }] }, base)));
    const external = harness.git.commitTree({ 'README.md': 'Pushed by a person directly\n' }, base);
    harness.git.native(['update-ref', 'refs/heads/main', external]);
    harness.staleHeadOnce(base);
    await harness.settle();
    expect(ok(await harness.shard(parseInt(docs.id[3], 16)).get(docs.id)).status).toBe('landed');
    expect(harness.git.native(['rev-parse', 'main~1']).trim()).toBe(external);
    expect(harness.git.native(['show', 'main:README.md'])).toBe('Pushed by a person directly\n');
  }, 30_000);

  it('tells a task that its change merged even when the first message is lost', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { harness, base } = await setup({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 } });
      harness.workspace.taskChange.mockRejectedValueOnce(new Error('The Durable Object was reset.'));
      const item = ok(await harness.submit('atlas', { ...change({ title: 'Add a guide', files: [{ path: 'docs/tasks.md', content: '# Tasks\n' }] }, base), taskId: 'mission-1' }));
      await harness.settle(4);
      expect(ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status).toBe('landed');
      expect(harness.workspace.taskChange).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 10_000);
      await harness.shard(parseInt(item.id[3], 16)).alarm();
      expect(harness.workspace.taskChange).toHaveBeenLastCalledWith('mission-1', expect.objectContaining({ id: item.id, status: 'landed', commit: harness.head() }));
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('tells every change in a batch that it merged at once', async () => {
    const { harness, base } = await setup();
    const landed = ChangeShard.prototype.landed;
    let telling = 0, most = 0;
    const spy = vi.spyOn(ChangeShard.prototype, 'landed').mockImplementation(async function (this: ChangeShard, ...args: Parameters<ChangeShard['landed']>) {
      most = Math.max(most, ++telling);
      // A shard that answers slowly holds back only its own change.
      await new Promise(resolve => setTimeout(resolve, 20));
      telling--;
      return landed.apply(this, args);
    });
    try {
      const items = [
        ok(await harness.submit('scribe', change({ title: 'Document health checks', files: [{ path: 'docs/guide.md', content: '# Guide\n\nHealth checks live at /health.\n' }] }, base))),
        ok(await harness.submit('atlas', change({ title: 'Note health checks', files: [{ path: 'CHANGELOG.md', content: '# Changes\n- Health checks\n' }] }, base))),
      ];
      await harness.settle();
      expect((await harness.trunk.status(harness.repository)).recent[0].landed).toHaveLength(2);
      expect(most).toBe(2);
      for (const item of items) expect(ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status).toBe('landed');
    } finally { spy.mockRestore(); }
  });

  it('shows public readers only what clean revisions report, reading each revision once', async () => {
    const { harness, base } = await setup({ autonomy: 'human' });
    const token = ['braid', '_agent_', 'q'.repeat(40)].join('');
    const leak = ok(await harness.submit('sable', { ...change({ title: 'Configure the client', files: [{ path: 'src/client.ts', content: `export const token = '${token}';\n` }] }, base),
      tests: [{ command: 'npm test', result: 'passed' }, { command: 'npm run lint', result: 'passed' }] }));
    const index = parseInt(leak.id[3], 16), shard = harness.shard(index);
    ok(await shard.revise(harness.context('sable', index), leak.id, { summary: 'Read the token from the environment', baseCommit: base, previousRevision: 1,
      files: [{ path: 'src/client.ts', content: 'export const token = process.env.TOKEN;\n' }], tests: [{ command: 'npm test', result: 'passed' }] }, 'public-read-revise-0001'));
    const reads = vi.spyOn((shard as unknown as { content: { get(id: string): unknown } }).content, 'get');
    const shown = ok(await shard.get(leak.id, true));
    expect(shown.checks.map(check => [check.label, check.revision])).toEqual([['npm test', 2]]);
    expect(reads.mock.calls.map(([id]) => id).sort()).toEqual([`patch:${leak.id}:1`, `patch:${leak.id}:2`]);
    expect(ok(await shard.get(leak.id)).checks.map(check => check.revision)).toEqual([1, 1, 2]);
  });

  it('shows a reviewer what changed since the revision they last read', async () => {
    const { harness, base } = await setup({ autonomy: 'human' });
    const first = ok(await harness.submit('atlas', change({ title: 'Add metrics', files: [{ path: 'src/router.ts', content: router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n") }, { path: 'docs/metrics.md', content: '# Metrics\n' }] }, base)));
    const shard = harness.shard(parseInt(first.id[3], 16));
    const revised = ok(await shard.revise(harness.context('atlas', parseInt(first.id[3], 16)), first.id,
      { summary: 'Metrics without the doc', baseCommit: base, previousRevision: 1, files: [{ path: 'src/router.ts', content: router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n  '/ready',\n") }] }, 'compare-revise-key-0001'));
    expect(revised.events.find(event => event.type === 'revised')).toMatchObject({ revision: 2, base });
    // Against main, and against revision 1: only the line added after it was sent back.
    expect(ok(await shard.diff(harness.repository, first.id, 'src/router.ts'))).toMatchObject({ revision: 2, before: router });
    const since = ok(await shard.diff(harness.repository, first.id, 'src/router.ts', undefined, 1));
    expect(since).toMatchObject({ revision: 2, since: 1, before: expect.stringContaining("'/metrics',\n];"), after: expect.stringContaining("'/ready',") });
    // A file the new revision dropped reads as removed since revision 1, and is not part of revision 2 itself.
    expect(ok(await shard.diff(harness.repository, first.id, 'docs/metrics.md', undefined, 1))).toMatchObject({ before: '# Metrics\n', after: null });
    expect(await shard.diff(harness.repository, first.id, 'docs/metrics.md')).toMatchObject({ ok: false, status: 404 });
    expect(await shard.diff(harness.repository, first.id, 'src/router.ts', 1, 2)).toMatchObject({ ok: false, status: 400 });
    // The file list since revision 1 counts lines against it, and includes the file revision 2 dropped.
    expect(ok(await shard.compare(harness.repository, first.id, 1))).toEqual({ revision: 2, since: 1, files: [
      { path: 'docs/metrics.md', additions: 0, deletions: 1, deleted: true }, { path: 'src/router.ts', additions: 1, deletions: 0 }] });
  });

  it('keeps reviewer verdicts honest: revisions, escalation and self-review', async () => {
    harness = await changeHarness({ review: () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'revise', risk: 'medium', summary: 'Handle empty paths.', findings: [{ path: 'src/router.ts', severity: 'error', message: 'Empty path throws.' }] }) } }] }) });
    const base = harness.git.commitTree({ 'src/router.ts': router });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
    const submitted = ok(await harness.submit('atlas', change({ title: 'Edit router', files: [{ path: 'src/router.ts', content: router.replace('includes(path)', 'includes(path.trim())') }] }, base)));
    await harness.settle();
    const index = parseInt(submitted.id[3], 16);
    expect(ok(await harness.shard(index).get(submitted.id))).toMatchObject({ status: 'revise', sentBack: 'review', next: expect.stringContaining('Handle empty paths.') });
    const self = await harness.shard(index).review(harness.context('atlas', index), submitted.id, { revision: 1, verdict: 'approve', summary: 'Looks good to me' });
    expect(self).toMatchObject({ ok: false, status: 403 });
    expect(harness.ai.run).toHaveBeenCalledWith('@cf/test/reviewer', expect.objectContaining({ response_format: expect.objectContaining({ type: 'json_schema' }) }));
  }, 30_000);
});

describe('simulated swarm', () => {
  it('lands every simulated agent editing the same registry, route table and changelog', async () => {
    const { harness } = await setup();
    const started = await harness.swarm.start(harness.repository, { agents: 60, scenario: 'mixed' }, 'owner@example.test');
    expect(started).toMatchObject({ ok: true, data: { status: 'preparing', agents: 60 } });
    for (let round = 0; round < 60 && (await harness.swarm.status())?.status !== 'finished'; round++) await harness.settle(1);
    const run = (await harness.swarm.status())!;
    expect(run).toMatchObject({ status: 'finished', launched: 60 });
    expect(run.counts.landed).toBe(61);
    const registry = JSON.parse(harness.git.native(['show', 'main:swarm/registry.json'])) as { handlers: Record<string, string> };
    expect(Object.keys(registry.handlers)).toHaveLength(60);
    const routes = harness.git.native(['show', 'main:swarm/routes.ts']);
    for (let i = 0; i < 60; i++) expect(routes).toContain(`'/h${String(i).padStart(4, '0')}'`);
    expect(harness.git.native(['show', 'main:swarm/CHANGELOG.md']).split('\n').filter(line => line.startsWith('- Added'))).toHaveLength(60);
    expect(harness.git.native(['ls-tree', '--name-only', 'main:swarm/handlers']).trim().split('\n')).toHaveLength(60);
    // git grep exits non-zero when nothing matches: no planted defect reached trunk.
    expect(() => harness.git.native(['grep', '-c', 'BRAID-SIMULATED-DEFECT', 'main', '--', 'swarm'])).toThrow();
    const queue = await harness.trunk.status(harness.repository);
    expect(queue.stats.landed).toBe(61);
    expect((queue.stats.strategies.json ?? 0) + (queue.stats.strategies.union ?? 0) + (queue.stats.strategies.line ?? 0)).toBeGreaterThan(0);
    harness.git.native(['fsck', '--full', '--no-dangling']);
  }, 120_000);

  it('works through a hotspot where every agent rewrites the same line', async () => {
    const { harness } = await setup();
    expect(await harness.swarm.start(harness.repository, { agents: 8, scenario: 'hotspot' }, 'owner')).toMatchObject({ ok: true });
    for (let round = 0; round < 80 && (await harness.swarm.status())?.status !== 'finished'; round++) await harness.settle(1);
    const run = (await harness.swarm.status())!;
    expect(run.status).toBe('finished');
    expect(run.counts.landed).toBe(9);
    expect(run.revisions).toBeGreaterThan(0);
    expect(harness.git.native(['show', 'main:swarm/hot.ts'])).toMatch(/export const LIMIT = [1-8];/);
  }, 120_000);
});

describe('a repository at its storage limit', () => {
  it('pauses the merge queue on the first refused landing, keeping the change queued and main unchanged', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'src/router.ts': router });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
    // Artifacts answers every push this way once a repository holds its storage limit.
    const network = globalThis.fetch;
    const pushes = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).endsWith('/git-receive-pack') && init?.method === 'POST'
      ? new Response(concat([pktLine('ERR artifacts_git_receive_pack_storage_limit\n'), FLUSH]), { headers: { 'content-type': 'application/x-git-receive-pack-result' } })
      : network(input, init));
    try {
      ok(await harness.submit('atlas', change({ title: 'Add a', files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }] }, base)));
      await harness.settle();
      const status = await harness.trunk.status(harness.repository);
      expect(status).toMatchObject({ paused: STORAGE_FULL, queued: 1 });
      expect(harness.git.native(['rev-parse', 'main']).trim()).toBe(base);
      expect(pushes.mock.calls.filter(([input]) => String(input).endsWith('/git-receive-pack'))).toHaveLength(1);
    } finally { pushes.mockRestore(); }
  });
});

describe('verification on the composed trunk', () => {
  const check = (command: string, exitCode: number, output = '') => ({ command, exitCode, durationMs: 1200, output, truncated: false, phase: 'check' as const });
  const installed = () => ({ ...check('npm ci', 0), phase: 'install' as const });
  async function verifiedSetup(verify: NonNullable<Parameters<typeof changeHarness>[0]>['verify']) {
    harness = await changeHarness({ verify });
    const base = harness.git.commitTree({ 'src/router.ts': router, '.braid/policy.json': JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, verify: { install: 'npm ci', checks: ['npm test'], retries: 1 } }, null, 2) + '\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
    return { harness, base };
  }
  const file = (name: string, content: string) => ({ title: `Add ${name}`, files: [{ path: `src/${name}.ts`, content }] });

  it('pauses instead of blaming anyone when main already fails its checks', async () => {
    // npm test fails whenever the router carries a known bug, with or without the change.
    const { harness, base } = await verifiedSetup((_job, read) => {
      const broken = (read('src/router.ts') ?? '').includes('includes(path)');
      return { status: broken ? 'failed' : 'passed', checks: [installed(), check('npm test', broken ? 1 : 0, broken ? 'FAIL router › trims paths' : 'ok')] };
    });
    const item = ok(await harness.submit('atlas', change(file('a', 'export const a = 1;\n'), base)));
    await harness.settle();
    const status = await harness.trunk.status(harness.repository);
    expect(status.paused).toMatch(/^Main fails `npm test` on its own\. Merging is paused until main is fixed; no pull request was blamed\.$/);
    expect(harness.verifiedJobs[0]).toMatchObject({ baseline: base });
    const current = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
    expect(current.status).toBe('queued');
    expect(current.checks.some(entry => entry.status === 'failed')).toBe(false);
    expect(harness.head()).toBe(base);
  }, 30_000);

  it('lands only after the combined result passes, with the evidence on every change', async () => {
    const { harness, base } = await verifiedSetup(undefined);
    const a = ok(await harness.submit('atlas', change(file('a', 'export const a = 1;\n'), base)));
    const b = ok(await harness.submit('sable', change(file('b', 'export const b = 2;\n'), base)));
    expect((await harness.trunk.status(harness.repository)).waitingEntries?.map(item => item.number)).toEqual([a.number, b.number]);
    await harness.trunk.alarm();
    // Staged and verifying: trunk has not moved yet.
    expect(harness.head()).toBe(base);
    const queued = await harness.trunk.status(harness.repository);
    expect(queued.waitingEntries).toEqual([]);
    expect(queued.landing).toMatchObject({ status: 'verifying', changes: [{ changeId: a.id }, { changeId: b.id }], checks: [{ command: 'npm test', status: 'pending' }] });
    expect(harness.verifications[0].job).toMatchObject({ install: 'npm ci', checks: ['npm test'] });
    await harness.settle();
    expect(harness.git.native(['ls-tree', '--name-only', 'main:src']).trim().split('\n')).toEqual(['a.ts', 'b.ts', 'router.ts']);
    for (const item of [a, b]) {
      const landed = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
      expect(landed.status).toBe('landed');
      expect(landed.checks.at(-1)).toMatchObject({ source: 'braid', status: 'passed', label: 'npm test', detail: expect.stringContaining('with 1 other change'),
        run: { commit: harness.verifiedJobs[0].commit, exitCode: 0, seconds: 0 } });
      // What Braid ran on the combined result is the change's evidence too, beside anything its agent reported.
      expect(landed.evidence).toEqual(['npm ci', 'npm test'].map(command => ({ kind: 'command', command, exitCode: 0, output: 'ok', durationMs: 10, revision: 1, source: 'braid', at: expect.any(String) })));
    }
    // The staging branch is removed after landing.
    expect(() => harness.git.native(['rev-parse', '--verify', `refs/heads/braid/land/${harness.verifiedJobs[0].id}`])).toThrow();
  }, 30_000);

  it('finds the change that breaks the build among several and lands the rest', async () => {
    const { harness, base } = await verifiedSetup((_job: unknown, read: (path: string) => string | null) => {
      const broken = ['a', 'b', 'c', 'd'].some(name => read(`src/${name}.ts`)?.includes('throw'));
      return { status: broken ? 'failed' : 'passed', checks: [installed(), check('npm test', broken ? 1 : 0, broken ? 'TypeError: boom' : 'ok')] };
    });
    const items = [];
    for (const [name, content] of [['a', 'export const a = 1;\n'], ['b', 'export const b = () => { throw new Error(); };\n'], ['c', 'export const c = 3;\n'], ['d', 'export const d = 4;\n']])
      items.push(ok(await harness.submit(`agent-${name}`, change(file(name, content), base))));
    await harness.settle(12);
    const statuses = await Promise.all(items.map(async item => ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id))));
    expect(statuses.map(item => item.status)).toEqual(['landed', 'revise', 'landed', 'landed']);
    expect(statuses[1].checks.at(-1)).toMatchObject({ source: 'braid', status: 'failed', label: 'npm test', detail: expect.stringContaining('TypeError: boom') });
    expect(statuses[1].evidence?.at(-1)).toMatchObject({ kind: 'command', command: 'npm test', exitCode: 1, output: 'TypeError: boom', source: 'braid' });
    expect(statuses[1]).toMatchObject({ sentBack: 'checks', next: expect.stringMatching(/Failed: npm test/) });
    expect(() => harness.git.native(['show', 'main:src/b.ts'])).toThrow();
    const recent = (await harness.trunk.status(harness.repository)).recent;
    expect(recent.some(batch => batch.note?.includes('narrowing down'))).toBe(true);
    expect(recent.some(batch => batch.note?.includes('retrying once'))).toBe(true);
  }, 60_000);

  it('retries a flaky failure before blaming the change', async () => {
    let calls = 0;
    const { harness, base } = await verifiedSetup(() => ({ status: ++calls === 1 ? 'failed' : 'passed', checks: [installed(), check('npm test', calls === 1 ? 1 : 0)] }));
    const item = ok(await harness.submit('atlas', change(file('a', 'export const a = 1;\n'), base)));
    await harness.settle(6);
    expect(ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status).toBe('landed');
    // The failed run, the same check on main alone (it passes, so main is fine), then the retry.
    expect(calls).toBe(3);
    expect((await harness.trunk.status(harness.repository)).recent.find(batch => batch.status === 'failed')).toMatchObject({ requeued: [{ changeId: item.id, number: item.number }] });
  }, 30_000);

  it('composes and verifies again when trunk moves during verification', async () => {
    const { harness, base } = await verifiedSetup(undefined);
    const item = ok(await harness.submit('atlas', change(file('a', 'export const a = 1;\n'), base)));
    await harness.trunk.alarm();
    const external = harness.git.commitTree({ 'README.md': 'Pushed while checks ran\n' }, base);
    harness.git.native(['update-ref', 'refs/heads/main', external]);
    await harness.settle(6);
    expect(ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status).toBe('landed');
    expect(harness.git.native(['rev-parse', 'main~1']).trim()).toBe(external);
    expect(harness.verifiedJobs).toHaveLength(2);
  }, 30_000);
});

describe('landing limits', () => {
  it('holds changes for the veto delay and caps each author per day', async () => {
    const realNow = Date.now;
    let offset = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      const { harness, base } = await setup({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, delay: { minutes: 10 }, limits: { dailyPerAuthor: 1 } });
      const first = ok(await harness.submit('atlas', change({ title: 'First', files: [{ path: 'docs/one.md', content: 'One\n' }] }, base)));
      const second = ok(await harness.submit('atlas', change({ title: 'Second', files: [{ path: 'docs/two.md', content: 'Two\n' }] }, base)));
      const other = ok(await harness.submit('sable', change({ title: 'Other', files: [{ path: 'docs/three.md', content: 'Three\n' }] }, base)));
      await harness.settle(2);
      const status = async (item: { id: string }) => ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status;
      // Inside the veto delay nothing lands, so a person can still close any of them.
      expect(await Promise.all([first, second, other].map(status))).toEqual(['queued', 'queued', 'queued']);
      offset = 11 * 60_000;
      await harness.settle(2);
      expect(await Promise.all([first, second, other].map(status))).toEqual(['landed', 'queued', 'landed']);
      expect(await harness.trunk.author(harness.repository, 'agent:atlas')).toMatchObject({ landed: 1, landedToday: 1 });
    } finally { spy.mockRestore(); }
  }, 30_000);
});

describe('duplicate work', () => {
  it('notes when two agents set out to do the same thing, and asks a person when the policy says so', async () => {
    const { harness, base } = await setup({ duplicates: 'attention' });
    const first = ok(await harness.submit('atlas', { ...change({ title: 'Retry failed webhook deliveries with exponential backoff', files: [{ path: 'src/retry.ts', content: 'export const retries = 3;\n' }] }, base), intent: 'Retry failed webhook deliveries with exponential backoff and jitter.' }));
    expect(first.duplicates).toBeUndefined();
    const second = ok(await harness.submit('sable', { ...change({ title: 'Retry failed webhook deliveries with exponential backoff', files: [{ path: 'src/backoff.ts', content: 'export const attempts = 3;\n' }] }, base), intent: 'Retry failed webhook deliveries with exponential backoff and jitter.' }));
    expect(second.duplicates).toEqual([expect.objectContaining({ changeId: first.id, number: first.number })]);
    expect(second.status).toBe('attention');
    expect(second.next).toContain(`#${first.number}`);
    // The timeline reads the duplicate and the policy hold from these fields, never from the sentences.
    const matched = [{ number: first.number, title: first.title }];
    expect(second.events.filter(event => event.type === 'overlap' || event.type === 'escalated')).toEqual([
      expect.objectContaining({ type: 'overlap', duplicates: matched }), expect.objectContaining({ type: 'escalated', requirement: 'duplicate', duplicates: matched })]);
    const unrelated = ok(await harness.submit('reed', { ...change({ title: 'Document the receiver contract', files: [{ path: 'docs/receivers.md', content: '# Receivers\n' }] }, base), intent: 'Explain signature verification for teams receiving webhooks.' }));
    expect(unrelated.duplicates).toBeUndefined();
  }, 30_000);
});

describe('speculative verification', () => {
  const file = (name: string, content: string) => ({ title: `Add ${name}`, files: [{ path: `src/${name}.ts`, content }] });
  async function stacked(verify: NonNullable<Parameters<typeof changeHarness>[0]>['verify']) {
    harness = await changeHarness({ verify });
    const base = harness.git.commitTree({ 'src/router.ts': router, '.braid/policy.json': JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, verify: { checks: ['npm test'], retries: 0, parallel: 3 } }, null, 2) + '\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
    return { harness, base };
  }

  it('verifies several batches at once, each on the one ahead, and lands them in order', async () => {
    const { harness, base } = await stacked(undefined);
    const items = [];
    for (const [round, names] of [['a', 'b'], ['c', 'd'], ['e', 'f']].entries()) {
      for (const name of names) items.push(ok(await harness.submit(`agent-${name}`, change(file(name, `export const ${name} = ${round};\n`), base))));
      await harness.trunk.alarm();
    }
    const status = await harness.trunk.status(harness.repository);
    expect(status.verifying?.map(batch => batch.landed.length + batch.ejected.length)).toHaveLength(3);
    expect(harness.verifications).toHaveLength(3);
    // Each later batch already contains the earlier ones, so it tests what will actually be on trunk.
    const [first, second, third] = harness.verifications.map(pending => pending.job.commit);
    expect(harness.git.native(['merge-base', '--is-ancestor', first, second])).toBe('');
    expect(harness.git.native(['merge-base', '--is-ancestor', second, third])).toBe('');
    expect(harness.head()).toBe(base);
    await harness.settle(2);
    expect(harness.head()).toBe(third);
    for (const item of items) expect(ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status).toBe('landed');
    expect((await harness.trunk.status(harness.repository)).verifying).toBeUndefined();
  }, 60_000);

  it('still sends a change back when its shard misses the first message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { harness, base } = await stacked((_job: unknown, read: (path: string) => string | null) => {
        const broken = read('src/a.ts') !== null;
        return { status: broken ? 'failed' : 'passed', checks: [{ command: 'npm test', exitCode: broken ? 1 : 0, durationMs: 1000, output: broken ? 'FAIL a' : 'ok', truncated: false, phase: 'check' as const }] };
      });
      const item = ok(await harness.submit('agent-a', change(file('a', 'export const a = 1;\n'), base)));
      const shard = harness.shard(parseInt(item.id[3], 16));
      vi.spyOn(shard, 'requeue').mockRejectedValueOnce(new Error('The Durable Object was reset.'));
      await harness.settle(4);
      expect(ok(await shard.get(item.id)).status).toBe('landing');
      // The queue keeps the message and delivers it once the shard answers again.
      vi.setSystemTime(Date.now() + 10_000);
      await harness.trunk.alarm();
      expect(ok(await shard.get(item.id))).toMatchObject({ status: 'revise', checks: expect.arrayContaining([expect.objectContaining({ label: 'npm test', status: 'failed' })]) });
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('composes the batches behind a failure again and still lands them', async () => {
    const { harness, base } = await stacked((_job: unknown, read: (path: string) => string | null) => {
      const broken = read('src/b.ts')?.includes('throw');
      return { status: broken ? 'failed' : 'passed', checks: [{ command: 'npm test', exitCode: broken ? 1 : 0, durationMs: 1000, output: broken ? 'boom' : 'ok', truncated: false, phase: 'check' as const }] };
    });
    const a = ok(await harness.submit('agent-a', change(file('a', 'export const a = 1;\n'), base)));
    const b = ok(await harness.submit('agent-b', change(file('b', 'export const b = () => { throw new Error(); };\n'), base)));
    await harness.trunk.alarm();
    const c = ok(await harness.submit('agent-c', change(file('c', 'export const c = 3;\n'), base)));
    await harness.trunk.alarm();
    expect((await harness.trunk.status(harness.repository)).verifying).toHaveLength(2);
    await harness.settle(12);
    const statuses = await Promise.all([a, b, c].map(async item => ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status));
    expect(statuses).toEqual(['landed', 'revise', 'landed']);
    expect(() => harness.git.native(['show', 'main:src/b.ts'])).toThrow();
    expect((await harness.trunk.status(harness.repository)).recent.some(batch => batch.note?.includes('combined with main again'))).toBe(true);
  }, 60_000);
});
