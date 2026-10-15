import { describe, expect, it } from 'vitest';
import { guardFindings, instructionFindings } from './guards';
import { DEFAULT_POLICY, evaluatePolicy, revisionRequested } from './policy';
import { parsePolicy } from './policy-file';

describe('guards against gaming verification', () => {
  it('flags deleted, removed and newly skipped tests, and dependency downgrades', () => {
    const findings = guardFindings([
      { path: 'test/retry.test.ts', before: "it('retries', () => {});\n", after: null },
      { path: 'src/delivery.test.ts', before: "it('a', () => {});\nit('b', () => {});\n", after: "it('a', () => {});\n" },
      { path: 'src/sign.spec.ts', before: "it('signs', () => {});\n", after: "it.skip('signs', () => {});\n" },
      { path: 'tests/test_api.py', before: 'def test_get():\n    pass\n', after: '@pytest.mark.skip\ndef test_get():\n    pass\n' },
      { path: 'package.json', before: JSON.stringify({ dependencies: { hono: '^4.6.0', zod: '^4.0.0' } }), after: JSON.stringify({ dependencies: { hono: '^4.2.0', zod: '^4.1.0' } }) },
      { path: 'src/index.ts', before: 'export const a = 1;\n', after: 'export const a = 2;\n' },
    ]);
    expect(findings.map(finding => [finding.kind, finding.detail])).toEqual([
      ['tests', 'Deletes the test file test/retry.test.ts.'],
      ['tests', 'Removes 1 test case from src/delivery.test.ts.'],
      ['tests', 'Skips 1 more test in src/sign.spec.ts.'],
      ['tests', 'Skips 1 more test in tests/test_api.py.'],
      ['dependencies', 'Downgrades hono from ^4.6.0 to ^4.2.0.'],
    ]);
  });

  it('routes findings to a person, or back to the author, as the policy says', () => {
    const guards = guardFindings([{ path: 'src/a.test.ts', before: "it('a', () => {});\n", after: "it.skip('a', () => {});\n" }]);
    const subject = { paths: ['src/a.test.ts'], additions: 1, deletions: 1, revision: 1, author: { kind: 'agent', id: 'agent:a' }, reviews: [], checks: [], approved: false, guards, history: { landed: 10, sentBack: 0 } };
    const decision = evaluatePolicy(DEFAULT_POLICY, subject);
    expect(decision.autonomy).toBe('human');
    expect(decision.requirements.find(requirement => requirement.id === 'guard')).toMatchObject({ satisfied: false, detail: 'Skips 1 more test in src/a.test.ts.' });
    const { policy } = parsePolicy(JSON.stringify({ guards: { tests: 'revise' } }));
    expect(evaluatePolicy(policy, subject).requirements.some(requirement => requirement.id === 'guard')).toBe(false);
    expect(revisionRequested(subject, policy)).toEqual([{ from: 'guard', text: 'Skips 1 more test in src/a.test.ts.' }]);
    expect(evaluatePolicy(DEFAULT_POLICY, { ...subject, approved: true }).requirements.filter(requirement => !requirement.satisfied)).toEqual([]);
  });

  it('earns unattended landing and escalates repeated failures', () => {
    const subject = { paths: ['docs/a.md'], additions: 1, deletions: 0, revision: 1, author: { kind: 'agent', id: 'agent:a', name: 'Atlas' }, reviews: [], checks: [], approved: false };
    expect(evaluatePolicy(DEFAULT_POLICY, { ...subject, history: { landed: 0, sentBack: 0 } })).toMatchObject({ autonomy: 'review', reviewers: 1 });
    expect(evaluatePolicy(DEFAULT_POLICY, { ...subject, history: { landed: 3, sentBack: 0 } })).toMatchObject({ autonomy: 'auto', reviewers: 0 });
    const looping = evaluatePolicy(DEFAULT_POLICY, { ...subject, history: { landed: 9, sentBack: 4 } });
    expect(looping.autonomy).toBe('human');
    expect(looping.requirements.find(requirement => requirement.id === 'rounds')).toMatchObject({ satisfied: false });
  });
});

describe('instructions on every change', () => {
  const instructions = [
    { id: 'no-secret-logs', text: 'Never log webhook secrets.', block: ['console.log(secret', 'console.log(signature'], paths: ['src/**'] },
    { id: 'no-em-dashes', text: 'No em dashes in UI copy', block: ['—'], paths: ['public/**'] },
    { id: 'less-text', text: 'Less text' },
  ];

  it('finds added lines with a blocked string in the files an instruction covers, once per instruction and file', () => {
    const findings = instructionFindings([
      { path: 'src/sign.ts', before: 'console.log(secret);\n', after: 'console.log(secret);\nconst a = 1;\nconsole.log(signature, secret);\nconsole.log(secret.slice(0, 4));\n' },
      { path: 'public/status.html', before: null, after: '<h1>Relay</h1>\n<p>Delivery status — all good</p>\n' },
      { path: 'docs/notes.md', before: null, after: 'console.log(secret) — never do this\n' },
      { path: 'src/removed.ts', before: 'console.log(secret)\n', after: null },
      { path: 'AGENTS.md', before: null, after: '- Never log webhook secrets. Blocked: `console.log(secret`.\n' },
    ], instructions);
    expect(findings).toEqual([
      { kind: 'instructions', path: 'src/sign.ts', detail: 'Adds "console.log(signature" to src/sign.ts at line 3, against "Never log webhook secrets".' },
      { kind: 'instructions', path: 'public/status.html', detail: 'Adds "—" to public/status.html at line 2, against "No em dashes in UI copy".' },
    ]);
  });

  it('matches overlapping strings in one pass and stops at ten findings', () => {
    const overlapping = [{ id: 'a', text: 'A', block: ['he', 'she', 'his', 'hers'] }, { id: 'b', text: 'B', block: ['ushers'] }, { id: 'c', text: 'C', block: ['rs'] }];
    expect(instructionFindings([{ path: 'a.txt', before: null, after: 'ushers\n' }], overlapping).map(finding => finding.detail.split(' against')[0]))
      .toEqual(['Adds "she" to a.txt at line 1,', 'Adds "ushers" to a.txt at line 1,', 'Adds "rs" to a.txt at line 1,']);
    const files = Array.from({ length: 30 }, (_, index) => ({ path: `src/f${index}.ts`, before: null, after: 'console.log(secret)\n' }));
    expect(instructionFindings(files, instructions)).toHaveLength(10);
  });

  it('checks a large change against many instructions in linear time', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ id: `rule-${index}`, text: `Rule ${index}`, block: Array.from({ length: 8 }, (_, string) => `${'a'.repeat(50)}${index}-${string}`) }));
    const after = `${'a'.repeat(200)}\n`.repeat(15_000);
    const started = performance.now();
    expect(instructionFindings([{ path: 'big.txt', before: null, after }], many)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
