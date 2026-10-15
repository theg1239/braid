import { describe, expect, it } from 'vitest';
import { secretFindings } from './secrets';
import { guardFindings } from './guards';
import { DEFAULT_POLICY, evaluatePolicy, revisionRequested } from './policy';
import { questionFor } from './questions';

// Built at runtime so no credential-shaped literal sits in the source.
const aws = ['AK', 'IA', 'Q3EGRZ7V5X2N4JTL'].join('');
const github = ['gh', 'p_', 'R8sJ2kLm4Np6Qr8St0Uv2Wx4Yz6Ab8Cd0Ef2'].join('');
const braid = ['braid', '_agent_', 'k'.repeat(40)].join('');
const pem = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');

describe('secret scanning', () => {
  it('finds credentials on added lines without echoing them', () => {
    const findings = secretFindings([{ path: 'src/config.ts', before: 'export const region = "us";\n', after: `export const region = "us";\nexport const key = "${aws}";\nconst token = "${github}";\n` }]);
    expect(findings).toEqual([
      { rule: 'aws-access-key', label: 'AWS access key', path: 'src/config.ts', line: 2 },
      { rule: 'github-token', label: 'GitHub token', path: 'src/config.ts', line: 3 },
    ]);
    expect(JSON.stringify(guardFindings([{ path: 'src/config.ts', before: '', after: `x = "${aws}"\n` }]))).not.toContain(aws);
  });

  it('ignores lines that were already there, deletions and documented placeholders', () => {
    expect(secretFindings([{ path: 'a.ts', before: `k = "${braid}"\n`, after: `k = "${braid}"\nmore\n` }])).toEqual([]);
    expect(secretFindings([{ path: 'a.pem', before: pem, after: null }])).toEqual([]);
    expect(secretFindings([{ path: 'docs/aws.md', before: '', after: 'AKIAIOSFODNN7EXAMPLE\n' }])).toEqual([]);
    expect(secretFindings([{ path: 'keys/id', before: '', after: `${pem}\nMIIE\n` }])).toMatchObject([{ rule: 'private-key', line: 1 }, { rule: 'private-key', line: 2 }]);
  });

  it('sends the change back by default and never offers to merge it', () => {
    const guards = guardFindings([{ path: 'src/config.ts', before: '', after: `export const key = "${braid}";\n` }]);
    expect(guards).toEqual([{ kind: 'secrets', path: 'src/config.ts', detail: 'Adds what looks like a Braid token to src/config.ts at line 1.' }]);
    const subject = { paths: ['src/config.ts'], additions: 1, deletions: 0, revision: 1, author: { kind: 'agent', id: 'agent:a' }, reviews: [], checks: [], approved: false, guards };
    expect(revisionRequested(subject, DEFAULT_POLICY)).toEqual([{ from: 'guard', text: 'Adds what looks like a Braid token to src/config.ts at line 1.' }]);
    // When a policy asks a person instead, merging is not one of the answers.
    const policy = { ...DEFAULT_POLICY, guards: { ...DEFAULT_POLICY.guards, secrets: 'attention' as const } };
    const question = questionFor({ status: 'attention', revision: 1, author: subject.author as never, reviews: [], guards, duplicates: [], files: [], next: '', policy: evaluatePolicy(policy, subject) }, policy)!;
    expect(question).toMatchObject({ label: 'Secret found', heading: 'It adds a token or private key' });
    expect(question.answers.map(answer => answer.action)).toEqual(['send-back', 'close']);
  });

  it.each(['+', '/'])('detects quoted JSON AWS secret keys ending in %s on arbitrarily long lines', ending => {
    const secret = 'aB2cD3eF4gH5'.repeat(3) + 'aB2' + ending;
    expect(secretFindings([{ path: 'config.json', before: null, after: JSON.stringify({ pad: 'p'.repeat(500000), AWS_SECRET_ACCESS_KEY: secret }) }]))
      .toMatchObject([{ rule: 'aws-secret-key', path: 'config.json', line: 1 }]);
  });
});

describe('OpenAI marker scanning', () => {
  it.each(['', 'proj-', 'svcacct-', 'admin-'])('detects and fully redacts %s keys at scan-window boundaries', async prefix => {
    const { redactPublicText } = await import('./privacy');
    const key = 'sk-' + prefix + 'aB2cD3eF4gH5'.repeat(5) + 'T3BlbkFJ' + 'jK6lM7nO8pQ9'.repeat(5);
    const content = ' '.repeat(8190) + key + ' done';
    expect(secretFindings([{ path: 'keys.txt', before: null, after: content }])).toMatchObject([{ rule: 'openai-key' }]);
    expect(redactPublicText(content)).toBe(' '.repeat(8190) + '[redacted] done');
  });
});
