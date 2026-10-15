import { describe, expect, it } from 'vitest';
import { agentKey, provenanceOf } from './provenance';

const human = { name: 'Example Owner', email: '101+example-owner@users.noreply.github.com' };
const bot = (login: string) => ({ name: login, email: `101+${login}@users.noreply.github.com` });
const facts = (author = human, message = 'Update dependencies') => ({ id: 'a'.repeat(40), at: '2026-10-13T00:00:00Z', author, message });

describe('automation is separate from coding agents', () => {
  it.each([
    ['dependabot[bot]', 'Dependabot'], ['renovate[bot]', 'Renovate'], ['github-actions[bot]', 'GitHub Actions'],
    ['release-please[bot]', 'Release Please'], ['acme-release[bot]', 'acme-release'], ['constructor[bot]', 'constructor'],
  ])('classifies %s as a bot with its tool, from its name or GitHub address', (login, name) => {
    for (const author of [bot(login), { ...bot(login), name: 'Automation' }, { name: login, email: 'automation@example.org' }]) {
      expect(provenanceOf(facts(author))).toMatchObject({ kind: 'bot', agent: { name, tool: login }, confidence: 'inferred' });
      expect(provenanceOf(facts(author)).owner).toBeUndefined();
    }
  });

  it.each([
    'copilot-swe-agent[bot]', 'codex[bot]', 'chatgpt-codex-connector[bot]', 'claude[bot]', 'cursor[bot]',
    'devin-ai-integration[bot]', 'google-labs-jules[bot]', 'gemini-code-assist[bot]', 'sweep-ai[bot]',
    'amazon-q-developer[bot]', 'posthog-eu[bot]', 'seer-by-sentry[bot]', 'coderabbitai[bot]', 'greptile-apps[bot]',
  ])('keeps the coding identity %s an agent', login => {
    expect(provenanceOf(facts(bot(login))).kind).toBe('agent');
  });

  it('recognises explicit release automation without labelling similarly named people', () => {
    expect(provenanceOf(facts({ name: 'gemini-cli-robot', email: 'gemini-cli-robot@google.com' })))
      .toMatchObject({ kind: 'bot', agent: { tool: 'gemini-cli-robot' } });
    expect(provenanceOf(facts({ name: 'Renovate Bot', email: 'bot@renovateapp.com' })))
      .toMatchObject({ kind: 'bot', agent: { name: 'Renovate', tool: 'renovate[bot]' } });
    expect(provenanceOf(facts({ name: 'Dependabot', email: 'person@example.org' })).kind).toBe('human');
  });

  it('records a bot co-author without counting its human owner as an agent', () => {
    const made = provenanceOf(facts(human, 'Bump dependencies\n\nCo-authored-by: renovate[bot] <101+renovate[bot]@users.noreply.github.com>'));
    expect(made).toMatchObject({ kind: 'bot', agent: { name: 'Renovate', tool: 'renovate[bot]' }, owner: { github: 'example-owner' } });
    expect(agentKey({ kind: made.kind, tool: made.agent?.tool, owner: made.owner })).toBeNull();
  });

  it.each([
    ['Co-authored-by: Cursor Agent <cursoragent@cursor.com>', 'cursor'],
    ['Co-authored-by: Claude Opus 4.7 <noreply@anthropic.com>', 'claude-code'],
    ['Co-authored-by: coderabbitai[bot] <101+coderabbitai[bot]@users.noreply.github.com>', 'coderabbitai[bot]'],
    ['Generated with Codex', 'codex'],
  ])('prefers coding evidence over a transporting bot: %s', (credit, tool) => {
    const made = provenanceOf(facts(bot('github-actions[bot]'), `Fix a bug\n\n${credit}`));
    expect(made).toMatchObject({ kind: 'agent', agent: { tool } });
    expect(made.owner).toBeUndefined();
  });

  it('keeps note precedence and legacy agent claims readable', () => {
    const note = { v: 1 as const, agent: { name: 'Dependabot', tool: 'dependabot[bot]' } };
    expect(provenanceOf(facts(bot('dependabot[bot]')), note)).toMatchObject({ kind: 'agent', confidence: 'trailers', agent: note.agent });
    expect(provenanceOf(facts(bot('dependabot[bot]'))).kind).toBe('bot');
  });
});
