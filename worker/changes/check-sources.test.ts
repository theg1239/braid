import { afterEach, expect, it } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { localProposal } from '../workspace/local';
import { localSubmission, parse } from '../schemas';

let h: Awaited<ReturnType<typeof changeHarness>>;
afterEach(async () => { if (h) await h.close(); });
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.data; };

it("credits a task's checks to the local agent by their kind, never by their label", async () => {
  h = await changeHarness();
  const base = h.git.commitTree({ 'README.md': 'Start\n' });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  const local = localProposal(parse(localSubmission, { baseCommit: base, summary: 'Docs', rationale: 'Docs', files: [{ path: 'docs/a.md', content: 'A\n' }],
    tests: [{ command: 'npm test', result: 'passed' }], evidence: [{ kind: 'command', command: 'npm run lint', exitCode: 0, output: '' }] }), base);
  const checks = [...local.checks, { label: 'Localization strings', status: 'passed' as const, detail: 'Run by the hosted agent.' }];
  const actor = { kind: 'agent' as const, id: 'task:fixture', name: 'Local coding agent', owner: { name: '@fixture' } };
  const change = ok(await h.shard(0).submit({ ...h.context(actor, 0), system: true, checks }, {
    title: 'Docs', summary: 'Docs', baseCommit: base, files: [{ path: 'docs/a.md', content: 'A\n' }],
  }, 'check-sources'));
  const stored = ok(await h.shard(0).get(change.id));
  const source = (label: string) => stored.checks.find(check => check.label === label)?.source;
  expect(source('Local execution')).toBe('agent');
  expect(source('Local report: npm test')).toBe('agent');
  expect(source('Local run: npm run lint')).toBe('agent');
  expect(source('Declared scope')).toBe('braid');
  expect(source('Localization strings')).toBe('braid');
});
