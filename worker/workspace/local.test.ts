import { describe, expect, it } from 'vitest';
import { localProposal } from './local';
import { LIMITS, localSubmission, parse } from '../schemas';

const baseCommit = 'a'.repeat(40);
const body = (overrides: Record<string, unknown> = {}) => ({
  baseCommit,
  summary: 'Clarify local setup',
  rationale: 'Explain how to connect a local coding agent.',
  files: [{ path: 'docs/local.md', content: '# Local setup\n' }],
  ...overrides,
});

const propose = (input: Record<string, unknown>) => localProposal(parse(localSubmission, input), baseCommit);
function rejected(overrides: Record<string, unknown>, status = 400) {
  expect(() => propose(body(overrides))).toThrowError(expect.objectContaining({ status }));
}

describe('local proposal validation', () => {
  it.each([undefined, '', 'b'.repeat(40), baseCommit.toUpperCase()])('rejects a mismatched base commit: %s', supplied => {
    rejected({ baseCommit: supplied }, 409);
  });
  it('rejects a base commit that is not text', () => rejected({ baseCommit: 42 }));

  it('accepts documentation paths and records local execution without claiming runtime tests ran', () => {
    const result = propose(body({ summary: '  Clarify setup  ', rationale: '  Explain the workflow.  ' }));
    expect(result.proposal).toEqual({ summary: 'Clarify setup', rationale: 'Explain the workflow.', files: [{ path: 'docs/local.md', content: '# Local setup\n' }] });
    expect(result.model).toBe('Local coding agent');
    expect(result.checks).toContainEqual(expect.objectContaining({ label: 'Declared scope', status: 'passed' }));
    expect(result.checks).toContainEqual({ kind: 'local', label: 'Local execution', status: 'warning', detail: 'Code and test reports came from a local agent. Braid did not execute project commands.' });
    expect(result.checks.some(check => check.label === 'Runtime tests')).toBe(false);
  });

  it.each(['Codex', 'Claude Code'])('preserves the agent-reported model %s', model => {
    expect(propose(body({ model: ` ${model} ` })).model).toBe(model);
  });

  it.each([
    { summary: '' }, { summary: ' '.repeat(3) }, { summary: 's'.repeat(1201) }, { summary: 42 },
    { rationale: '' }, { rationale: 'r'.repeat(6001) }, { rationale: null },
    { model: '' }, { model: 'm'.repeat(121) }, { model: null },
  ])('rejects invalid proposal metadata case %#', fields => rejected(fields));

  it.each([
    '/etc/config', '../README.md', 'docs/../README.md', 'docs/./setup.md', 'docs//setup.md',
    '.git/config', 'nested/.GIT/config', '.braid/missions/forged.md', 'nested/.braid/state',
    '.env', 'config/.env.production', '.dev.vars', '.dev.vars.production',
    'config/credentials.json', 'keys/id_rsa', 'keys/id_ed25519', 'docs\\setup.md',
    'docs/line\nbreak.md', 'docs/tab\tname.md', 'docs/del\u007fname.md', 'docs/\ud800.md', '', 'a'.repeat(241),
  ])('rejects unsafe path %j', path => rejected({ files: [{ path, content: 'text' }] }));

  it.each([
    [], null, 'files', [null], [{ path: 'README.md' }], [{ path: 'README.md', content: 42 }],
    [{ path: 'README.md', content: 'one' }, { path: 'README.md', content: 'two' }],
  ])('rejects invalid file sets: %j', files => rejected({ files }));

  it('accepts 1,000 unique files, including empty text files', () => {
    const files = Array.from({ length: 1000 }, (_, i) => ({ path: `docs/${i}.md`, content: i ? 'text' : '' }));
    expect(propose(body({ files })).proposal.files).toEqual(files);
  });

  it('accepts deletions and executable changes but rejects coerced or special modes', () => {
    const files = [{ path: 'old.ts', content: null }, { path: 'run.sh', content: '#!/bin/sh\n', mode: '100755' }];
    expect(propose(body({ files })).proposal.files).toEqual(files);
    for (const mode of [['100755'], 100755, '120000', '160000', null]) rejected({ files: [{ path: 'a', content: 'text', mode }] });
    rejected({ files: [{ path: 'old', content: null, mode: '100644' }] });
  });

  it.each(['text\0binary', '\ud800', 'text\udfff', '\ud800X\udc00'])('rejects binary or malformed Unicode content %j', content => {
    rejected({ files: [{ path: 'docs/local.md', content }] });
  });

  it('enforces the Artifacts blob boundary in UTF-8 bytes without an aggregate content cap', () => {
    expect(LIMITS.bytes).toBe(31_998_976);
    const content = `${'😀'.repeat(LIMITS.bytes / 4 - 1)}éx`;
    expect(new TextEncoder().encode(content).length).toBe(LIMITS.bytes - 1);
    const files = [{ path: 'docs/a.md', content }, { path: 'docs/b.md', content: 'é' }];
    expect(propose(body({ files })).proposal.files).toEqual(files);
    expect(() => propose(body({ files: [{ path: 'docs/a.md', content: `${content}xx` }] })))
      .toThrowError(expect.objectContaining({ status: 413, message: 'Cloudflare Artifacts limits each Git blob to 32 MB. Split this file before submitting.' }));
  });
});

describe('local test report provenance', () => {
  it('keeps passed and not-run reports unverified while preserving failed checks', () => {
    const result = propose(body({ tests: [
      { command: ' npm test ', result: 'passed', detail: ' 12 tests reported passing. ' },
      { command: 'npm run build', result: 'failed', detail: 'Compilation failed.' },
      { command: 'npm run typecheck', result: 'not-run' },
    ] }));
    expect(result.checks.filter(check => check.label.startsWith('Local report:'))).toEqual([
      { kind: 'report', label: 'Local report: npm test', status: 'warning', detail: 'Agent-reported passed; not independently verified by Braid. 12 tests reported passing.' },
      { kind: 'report', label: 'Local report: npm run build', status: 'failed', detail: 'Agent-reported failed; not independently verified by Braid. Compilation failed.' },
      { kind: 'report', label: 'Local report: npm run typecheck', status: 'warning', detail: 'Agent-reported not-run; not independently verified by Braid.' },
    ]);
  });

  it('accepts ten reports and rejects an eleventh', () => {
    const tests = Array.from({ length: 10 }, (_, i) => ({ command: `check-${i}`, result: 'not-run' }));
    expect(propose(body({ tests })).checks.filter(check => check.label.startsWith('Local report:'))).toHaveLength(10);
    rejected({ tests: [...tests, tests[0]] });
  });

  it.each([
    null, {}, 'npm test', [null], [42], [[]],
    [{ command: 'npm test', result: 'success' }], [{ command: 'npm test', result: true }],
    [{ command: 'npm test', result: ['passed'] }], [{ command: 'npm test', result: ['failed'] }],
    [{ command: '', result: 'passed' }], [{ command: 'x'.repeat(401), result: 'passed' }],
    [{ command: 'npm test', result: 'passed', detail: '' }],
    [{ command: 'npm test', result: 'passed', detail: 'x'.repeat(2001) }],
    [{ command: 'npm test', result: 'passed', detail: 42 }],
  ])('rejects malformed test report case %#', tests => rejected({ tests }));
});
