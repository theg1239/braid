import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { blameQuery, changeCursor, checkSize, LIMITS, ciStatus, localSubmission, modelOutput, optionalText, pageCursor, parse, provenanceQuery, review, revision, submission } from './schemas';
import { parsePolicy } from '../shared/policy-file';

const base = 'a'.repeat(40);
const change = (fields: Record<string, unknown> = {}) => ({ title: 'Add retries', summary: 'Retry failed deliveries.', baseCommit: base, files: [{ path: 'src/retry.ts', content: 'export {};\n' }], ...fields });
const error = (run: () => unknown) => { try { run(); } catch (caught) { return caught as { status: number; message: string }; } throw new Error('Expected an error.'); };

describe('request schemas', () => {
  it('reports a missing field with its own message', () => {
    const { title: _title, ...untitled } = change();
    expect(error(() => parse(submission.agent, untitled))).toMatchObject({ status: 400, message: 'Title must contain 1–120 characters.' });
    expect(error(() => parse(submission.agent, change({ files: undefined }))).message).toBe('Submit at least 1 changed file.');
    expect(error(() => parse(review, { verdict: 'approve', summary: 'Fine.' })).message).toBe('Review the current revision.');
    expect(error(() => parse(submission.agent, 'text')).message).toBe('Send a JSON change.');
  });

  it('takes the run behind a change: a tool with its version and session ids, nothing else', () => {
    expect(parse(submission.agent, change({ agent: { tool: 'claude-code/2.4.1', session: 's_42', parentSession: 'run-1' } })).agent).toEqual({ tool: 'claude-code/2.4.1', session: 's_42', parentSession: 'run-1' });
    expect(parse(submission.agent, change()).agent).toEqual({});
    expect(parse(revision.agent, { ...change({ agent: { tool: '@openai/codex+beta' } }), previousRevision: 1 }).agent).toEqual({ tool: '@openai/codex+beta' });
    expect(parse(localSubmission, { summary: 'S', rationale: 'R', files: [{ path: 'a.ts', content: '1' }], agent: { session: 'abc_DEF-1' } }).agent).toEqual({ session: 'abc_DEF-1' });
    expect(error(() => parse(submission.agent, change({ agent: { tool: 'claude code' } }))).message).toMatch(/Name the tool/);
    expect(error(() => parse(submission.agent, change({ agent: { tool: 'x'.repeat(81) } }))).message).toMatch(/Name the tool/);
    expect(error(() => parse(submission.agent, change({ agent: { session: 's.1' } }))).message).toMatch(/session ids/);
    expect(error(() => parse(submission.agent, change({ agent: { parentSession: 'x'.repeat(81) } }))).message).toMatch(/session ids/);
    expect(error(() => parse(submission.agent, change({ agent: 'claude' }))).message).toMatch(/Send agent as an object/);
  });

  it('takes up to five co-author lines as Name <email>, verbatim', () => {
    expect(parse(submission.agent, change({ coAuthors: ['Claude Opus 4.7 <noreply@anthropic.com>', 'Ada L. <ada@example.com>'] })).coAuthors).toEqual(['Claude Opus 4.7 <noreply@anthropic.com>', 'Ada L. <ada@example.com>']);
    expect(parse(submission.agent, change()).coAuthors).toEqual([]);
    expect(parse(localSubmission, { summary: 'S', rationale: 'R', files: [{ path: 'a.ts', content: '1' }], coAuthors: ['Bot <bot@example.com>'] }).coAuthors).toEqual(['Bot <bot@example.com>']);
    for (const bad of [['noreply@anthropic.com'], ['Claude <not an email>'], [' <a@b.c>'], ['Two\nLines <a@b.c>'], [`${'x'.repeat(190)} <a@example.com>`], Array.from({ length: 6 }, (_, i) => `P${i} <p${i}@example.com>`)])
      expect(error(() => parse(submission.agent, change({ coAuthors: bad }))).message).toBe('Send at most 5 co-authors, each as Name <email> in at most 200 characters.');
  });

  it('reads blame and provenance queries', () => {
    expect(parse(provenanceQuery, { commits: `${'A'.repeat(40)}, ${'b'.repeat(40)},${'a'.repeat(40)}` }).commits).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(error(() => parse(provenanceQuery, { commits: 'abc' })).message).toMatch(/full commit IDs/);
    expect(error(() => parse(provenanceQuery, { commits: Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(40, '0')).join(',') })).message).toMatch(/1–100/);
    expect(parse(blameQuery, { path: '.braid/policy.json' }).path).toBe('.braid/policy.json');
    expect(error(() => parse(blameQuery, { path: '../etc/passwd' })).message).toBe('Choose a file in the repository.');
  });

  it('treats missing, null and empty optional text alike, and trims what is given', () => {
    const intent = optionalText('Intent', 10);
    expect([undefined, null, ''].map(value => v.parse(intent, value))).toEqual([undefined, undefined, undefined]);
    expect(v.parse(intent, '  Retry  ')).toBe('Retry');
    expect(v.safeParse(intent, '   ').success).toBe(false);
    expect(v.safeParse(intent, 'x'.repeat(11)).success).toBe(false);
  });

  it('accepts only unique, unprotected text files, and keeps the task record to Braid', () => {
    const files = (list: unknown[]) => () => parse(submission.agent, change({ files: list }));
    expect(error(files([{ path: 'a.ts', content: '1' }, { path: 'a.ts', content: '2' }])).message).toMatch(/unique/);
    expect(error(files([{ path: '.env.production', content: 'SECRET=1' }])).message).toMatch(/protected paths/);
    expect(error(files([{ path: 'a.ts', content: 'binary\0' }])).message).toBe('Changes contain UTF-8 text only.');
    expect(error(files([{ path: 'a.ts', content: null, mode: '100755' }])).message).toBe('A deleted file has no mode.');
    const ledger = change({ files: [{ path: '.braid/missions/m1/atlas.md', content: '# Atlas\n' }] });
    expect(v.safeParse(submission.agent, ledger).success).toBe(false);
    expect(v.safeParse(submission.system, ledger).success).toBe(true);
    const instructions = change({ files: [{ path: '.braid/instructions.json', content: '{"instructions":[]}\n' }] });
    expect(v.safeParse(submission.agent, instructions).success).toBe(false);
    expect(v.safeParse(submission.system, instructions).success).toBe(true);
  });

  it('counts the size limit in UTF-8 bytes', () => {
    expect(() => checkSize([{ path: 'a.md', content: 'é'.repeat(Math.floor(LIMITS.bytes / 2)) }])).not.toThrow();
    expect(error(() => checkSize([{ path: 'a.md', content: 'é'.repeat(Math.floor(LIMITS.bytes / 2) + 1) }])).status).toBe(413);
  });

  it('reads a local proposal with its default model and remembers whether it named a previous commit', () => {
    const fields = { baseCommit: base, summary: 'Docs', rationale: 'Explain setup.', files: [{ path: 'docs/a.md', content: '# A\n' }] };
    const first = parse(localSubmission, fields);
    expect(first.model).toBe('Local coding agent');
    expect(first.evidence).toEqual([]);
    expect(parse(localSubmission, { ...fields, evidence: [{ kind: 'command', command: ' npm test ', exitCode: 2, output: 'a\x1b[1mb\x1b[0m\r\n' }] }).evidence).toEqual([{ kind: 'command', command: 'npm test', exitCode: 2, output: 'ab\n' }]);
    expect('previousCommit' in first).toBe(false);
    expect('previousCommit' in parse(localSubmission, { ...fields, previousCommit: null })).toBe(true);
  });
});

describe('CI statuses', () => {
  it('parses a status, keeps HTTPS links only and shortens long descriptions', () => {
    const status = (value: unknown) => v.safeParse(ciStatus, JSON.stringify(value));
    expect(status({ state: 'success', context: 'ci/test', description: 'x'.repeat(400), target_url: 'https://ci.example/1' }).output).toMatchObject({ description: 'x'.repeat(300), target_url: 'https://ci.example/1' });
    expect(status({ state: 'success', context: 'ci/test', target_url: 'http://ci.example/1' }).output).toMatchObject({ target_url: undefined });
    expect(status({ state: 'done', context: 'ci/test' }).issues?.[0].message).toMatch(/pending, success, failure or error/);
    expect(v.safeParse(ciStatus, '{nope').issues?.[0].message).toBe('Send JSON.');
  });
});

describe('model output', () => {
  it('reads a structured answer however Workers AI returns it', () => {
    const answer = modelOutput(v.object({ verdict: v.picklist(['approve', 'revise']) }));
    for (const response of [{ verdict: 'approve' }, '{"verdict":"approve"}', '```json\n{"verdict":"approve"}\n```', { response: '{"verdict":"approve"}' }, { choices: [{ message: { content: '{"verdict":"approve"}' } }] }])
      expect(v.parse(answer, response)).toEqual({ verdict: 'approve' });
    expect(v.safeParse(answer, '{"verdict":').success).toBe(false);
    expect(v.safeParse(answer, { choices: [] }).success).toBe(false);
  });
});

describe('page cursors', () => {
  it('round-trips the last item and rejects anything else', () => {
    const item = { updatedAt: '2026-10-08T10:00:00.000Z', id: 'ch_1abc' };
    expect(v.parse(pageCursor, changeCursor(item))).toEqual(item);
    for (const cursor of ['%%%', btoa('[]'), btoa('{"u":1,"i":"x"}')]) expect(v.safeParse(pageCursor, cursor).issues?.[0].message).toBe('Invalid page cursor.');
  });
});

describe('policy file', () => {
  it('keeps the valid fields of a section when one of its fields is invalid', () => {
    const { policy, errors } = parsePolicy(JSON.stringify({ verify: { minutes: 0, required: ['ci/test'], checks: ['npm test'] }, checks: ['ignored'] }));
    expect(policy.verify).toEqual({ minutes: 20, retries: 1, parallel: 3, required: ['ci/test'] });
    expect(policy.checks).toEqual(['npm test']);
    expect(errors).toEqual(['verify.minutes must be a whole number from 1 to 60.']);
  });

  it('keeps a rule whose autonomy is invalid, drops one without paths, and names each by index', () => {
    const { policy, errors } = parsePolicy(JSON.stringify({ rules: [{ paths: ['vendor/**'], autonomy: 'never', protected: true }, { paths: [] }, 'docs/**'] }));
    expect(policy.rules).toEqual([{ paths: ['vendor/**'], protected: true }]);
    expect(errors).toEqual(['rules[0].autonomy must be "auto", "review" or "human".', 'rules[1].paths must be a list of path patterns.', 'rules[2] must be an object.']);
  });

  it('expands review app names and treats a non-object file like invalid JSON', () => {
    expect(parsePolicy(JSON.stringify({ github: { reviewers: ['copilot', 'octocat'] } })).policy.github.reviewers).toEqual(['copilot-pull-request-reviewer[bot]', 'octocat']);
    expect(parsePolicy('[]')).toMatchObject({ policy: { autonomy: 'human', error: expect.stringContaining('wait for a person') }, errors: ['The policy file must be a valid JSON object.'] });
    expect(parsePolicy(JSON.stringify({ merge: { json: false, union: ['CHANGELOG.md'] } })).policy.merge).toEqual({ union: ['CHANGELOG.md'], json: false });
  });
});

describe('team settings boundary', () => {
  it('accepts a trimmed name or slug and rejects empty, unknown and reserved updates', async () => {
    const { teamUpdate } = await import('./schemas');
    expect(parse(teamUpdate, { name: '  ACM VIT  ' })).toEqual({ name: 'ACM VIT' });
    expect(parse(teamUpdate, { slug: 'acmvit' })).toEqual({ slug: 'acmvit' });
    for (const input of [{}, { name: ' ' }, { name: 'a'.repeat(61) }, { role: 'owner' }, { slug: 'example' }]) {
      expect(() => parse(teamUpdate, input)).toThrow();
    }
  });
});
