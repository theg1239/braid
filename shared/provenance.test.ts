import { describe, expect, it } from 'vitest';
import { agentKey, coAuthor, fileProvenance, formatNote, modelName, NOTES_REF, parseNote, parsePerson, parseTrailers, provenanceOf, toolBase, toolName } from './provenance';

const at = '2026-10-08T12:00:00Z';
const ishaan = { name: 'Ishaan', email: '12345+theg1239@users.noreply.github.com' };
const commit = (message: string, author = ishaan) => ({ id: 'a'.repeat(40), at, author, message });

describe('models and tools by name', () => {
  it('names models as people read them', () => {
    expect(modelName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelName('claude-fable-5-1')).toBe('Claude Fable 5.1');
    expect(modelName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelName('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(modelName('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelName('gemini-3-pro')).toBe('Gemini 3 Pro');
    expect(modelName('@cf/zai-org/glm-5.3-flash')).toBe('GLM 5.3 Flash');
    expect(modelName('@cf/meta/llama-3.1-8b-instruct')).toBe('Llama 3.1 8B Instruct');
    expect(modelName('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet');
    expect(modelName('simulated')).toBe('Simulated');
    expect(toolName('claude-code/2.4.1')).toBe('Claude Code');
    expect(toolName('@openai/codex/1.8.0')).toBe('Codex');
    expect(toolName('gemini-cli/0.9.2')).toBe('Gemini CLI');
  });

  it('keys the roster by model, owner and tool, the same in every place it is used', () => {
    const owner = { id: 'user:u1', name: 'Ishaan' };
    expect(agentKey({ kind: 'agent', model: 'claude-opus-5-5', owner, tool: 'claude-code/2.4.1' })).toBe(JSON.stringify(['claude-opus-5-5', 'user:u1', 'claude-code']));
    expect(agentKey({ kind: 'simulated', model: 'simulated', owner: { name: 'Maya' } })).toBe(JSON.stringify(['simulated', 'Maya', '']));
    expect(agentKey({ kind: 'human', owner })).toBeNull();
    expect(toolBase('@openai/codex/1.8.0')).toBe('@openai/codex');
  });

  it("co-authors with Anthropic's no-reply address for Claude and a stable Braid address otherwise", () => {
    expect(coAuthor('claude-opus-5-5')).toEqual({ name: 'Claude Opus 5.5', email: 'noreply@anthropic.com' });
    expect(coAuthor('gpt-6.1-sol')).toEqual({ name: 'GPT-6.1 Sol', email: 'gpt-6.1-sol@agents.braid.local' });
    expect(coAuthor('@cf/zai-org/glm-5.3-flash')).toEqual({ name: 'GLM 5.3 Flash', email: 'cf-zai-org-glm-5.3-flash@agents.braid.local' });
    // Without a model, the tool names the agent.
    expect(coAuthor(undefined, 'claude-code/2.4.1')).toEqual({ name: 'Claude Code', email: 'noreply@anthropic.com' });
    expect(coAuthor(undefined, 'codex/1.8.0')).toEqual({ name: 'Codex', email: 'codex@agents.braid.local' });
    expect(coAuthor()).toEqual({ name: 'Agent', email: 'agent@agents.braid.local' });
  });
});

describe('public-history attribution regressions', () => {
  const person = { name: 'Example Owner', email: '101+example-owner@users.noreply.github.com' };
  const facts = (message: string, author = person) => commit(message, author);

  it.each(['Claude', 'Codex', 'Copilot', 'cursoragent'])('does not identify a person named %s as a tool', name => {
    expect(provenanceOf(facts('Fix a typo', { name, email: 'writer@example.org' })).kind).toBe('human');
  });

  it.each(['claude', 'codex'])('does not identify an ordinary GitHub login %s as an agent', name => {
    expect(provenanceOf(facts('Fix a typo', { name: 'Example Writer', email: `101+${name}@users.noreply.github.com` })).kind).toBe('human');
  });

  it('recognises Jules by the address it actually authors with', () => {
    expect(provenanceOf(facts('Fix lint', { name: 'Google Labs Jules', email: 'jules@google.com' })).agent)
      .toEqual({ name: 'Jules', tool: 'jules' });
  });

  it.each([
    ['Sweep', 'sweep', 'sweep-ai[bot]', '101+sweep-ai[bot]@users.noreply.github.com'],
    ['Amazon Q', 'amazon-q', 'amazon-q-developer[bot]', '101+amazon-q-developer[bot]@users.noreply.github.com'],
    ['Gemini', 'gemini-cli', 'gemini-cli', '101+gemini-cli@users.noreply.github.com'],
    ['Cursor Bugbot', 'cursor-bugbot', 'Cursor Bugbot', 'bugbot@cursor.com'],
  ])('names %s from its explicit identity without inventing a model', (name, tool, authorName, email) => {
    expect(provenanceOf(facts(`Fix handling\n\nCo-authored-by: ${authorName} <${email}>`)).agent).toEqual({ name, tool });
  });

  it('does not confuse Gemini release automation with Gemini CLI code authorship', () => {
    expect(provenanceOf(facts('Changelog for v1.0', { name: 'gemini-cli-robot', email: 'gemini-cli-robot@google.com' })))
      .toMatchObject({ kind: 'bot', agent: { tool: 'gemini-cli-robot' } });
  });

  it('reads an explicit credit immediately after the subject in Gemini CLI history', () => {
    expect(provenanceOf(facts("Merge branch 'main'\nCo-Authored-By: gemini-cli <101+gemini-cli@users.noreply.github.com>")).agent)
      .toEqual({ name: 'Gemini', tool: 'gemini-cli' });
    expect(parseTrailers('Co-Authored-By: Claude <noreply@anthropic.com>').size).toBe(0);
    expect(provenanceOf(facts('Discuss credits\nUse this example:\nCo-Authored-By: Claude <noreply@anthropic.com>')).kind).toBe('human');
  });

  it.each([
    ['openhands', 'openhands@all-hands.dev'],
    ['OpenHands Bot', 'contact@all-hands.dev'],
  ])('recognises the explicit OpenHands identity %s', (name, email) => {
    expect(provenanceOf(facts('Fix handling', { name, email })).agent).toEqual({ name: 'OpenHands', tool: 'openhands' });
    expect(provenanceOf(facts(`Fix handling\n\nCo-authored-by: ${name} <${email}>`)))
      .toMatchObject({ agent: { name: 'OpenHands', tool: 'openhands' }, owner: { github: 'example-owner' } });
  });

  it('reads Aider model trailers and preserves the person who owns the work', () => {
    expect(provenanceOf(facts('Fix cache\n\nCo-authored-by: aider (openai/gpt-4.1) <aider@aider.chat>')))
      .toMatchObject({ kind: 'agent', agent: { name: 'GPT-4.1', model: 'GPT-4.1', tool: 'aider' }, owner: { github: 'example-owner' }, confidence: 'inferred' });
  });

  it('reads Aider author suffixes without keeping the tool in the owner name', () => {
    expect(provenanceOf(facts('Fix cache', { ...person, name: 'Example Owner (aider)' })))
      .toMatchObject({ kind: 'agent', agent: { name: 'Aider', tool: 'aider' }, owner: { name: 'Example Owner', github: 'example-owner' } });
  });

  it('does not manufacture a Claude model version from a generic tool credit', () => {
    for (const name of ['Claude', 'Claude Code']) {
      expect(provenanceOf(facts(`Fix cache\n\nCo-authored-by: ${name} <noreply@anthropic.com>`)).agent)
        .toEqual({ name: 'Claude', tool: 'claude-code' });
    }
    expect(provenanceOf(facts('Fix cache\n\nCo-authored-by: aider (unknown-model) <aider@aider.chat>')).agent)
      .toEqual({ name: 'Aider', tool: 'aider' });
  });

  it('keeps an explicit model and the tool separate in Aider credits', () => {
    expect(provenanceOf(facts('Fix cache\n\nCo-authored-by: aider (gemini/gemini-2.5-pro) <noreply@aider.chat>')).agent)
      .toEqual({ name: 'Gemini 2.5 Pro', model: 'Gemini 2.5 Pro', tool: 'aider' });
    expect(provenanceOf(facts('Fix cache\n\nCo-authored-by: aider (<model>) <aider@aider.chat>')).agent)
      .toEqual({ name: 'Aider', tool: 'aider' });
  });

  it('recovers a bot-authored change owner only from one unambiguous human coauthor', () => {
    const bot = { name: 'copilot-swe-agent[bot]', email: '101+Copilot@users.noreply.github.com' };
    const message = `Fix cache\n\nCo-authored-by: ${person.name} <${person.email}>`;
    expect(provenanceOf(facts(message, bot)).owner).toEqual({ ...person, github: 'example-owner' });
    expect(provenanceOf(facts(`${message}\nCo-authored-by: Second Owner <second@example.org>`, bot)).owner).toBeUndefined();
    expect(provenanceOf(facts('Fix cache', bot)).owner).toBeUndefined();
  });

  it.each([
    'Remove Generated with Claude Code from the template',
    'Document credits\n\nThe text Generated by Codex is an example.',
    'Document credits\n\n```\nGenerated with Claude Code\nCo-authored-by: Claude <noreply@anthropic.com>\n```',
    'Document credits\n\n> Generated with Cursor',
    'Document credits\n\nGenerated with Cursorless',
  ])('ignores quoted or mentioned credit text: %s', message => {
    expect(provenanceOf(facts(message)).kind).toBe('human');
  });

  it('does not attribute a merge to the tool named only by the destination branch', () => {
    expect(provenanceOf(facts("Merge branch 'main' into codex/fix-cache")).kind).toBe('human');
    expect(provenanceOf(facts('Merge documentation from sample/codex/examples')).kind).toBe('human');
  });

  it('recognises the explicit generated-with footer used by Devin', () => {
    expect(provenanceOf(facts('Fix routing\n\nGenerated with [Devin](https://devin.ai)')))
      .toMatchObject({ agent: { name: 'Devin', tool: 'devin' }, owner: { github: 'example-owner' }, confidence: 'inferred' });
  });

  it('prefers an explicit coding coauthor over the bot that transports the commit', () => {
    const bot = { name: 'github-actions[bot]', email: '101+github-actions[bot]@users.noreply.github.com' };
    expect(provenanceOf(facts('Fix cache\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>', bot)).agent)
      .toEqual({ name: 'Cursor', tool: 'cursor' });
    expect(provenanceOf(facts('Fix cache\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>', bot)).owner).toBeUndefined();
  });

  it('leaves conflicting coding credits unknown instead of choosing one tool or model', () => {
    const message = 'Combined changes\n\nCo-authored-by: Claude Sonnet 4.7 <noreply@anthropic.com>\nCo-authored-by: Cursor <cursoragent@cursor.com>';
    expect(provenanceOf(facts(message))).toMatchObject({ kind: 'agent', agent: { name: 'Agent' }, owner: { github: 'example-owner' }, confidence: 'inferred' });
    expect(provenanceOf(facts(message)).agent).toEqual({ name: 'Agent' });
    expect(provenanceOf(facts(message.replace('Cursor <cursoragent@cursor.com>', 'Claude Opus 4.7 <noreply@anthropic.com>'))).agent).toEqual({ name: 'Agent' });
    expect(provenanceOf(facts(message), { v: 1, agent: { name: 'Codex', tool: 'codex' } }).agent).toEqual({ name: 'Codex', tool: 'codex' });
    expect(provenanceOf(facts('Legacy work\n\nCo-authored-by: Codex <codex@openai.com>\nCo-authored-by: Cursor <cursoragent@cursor.com>\nBraid-Author: Recorded model (agent, recorded-model)')))
      .toMatchObject({ agent: { name: 'Recorded model', model: 'recorded-model' }, confidence: 'trailers' });
  });
});

describe('commit trailers and people', () => {
  it('reads the last paragraph as git does, never the subject', () => {
    expect(parseTrailers('fix: typo').size).toBe(0);
    const trailers = parseTrailers('Add retries\n\nBody text.\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nSigned-off-by: Ishaan <i@example.com>\n  continued');
    expect(trailers.get('co-authored-by')).toEqual(['Claude Opus 5.5 <noreply@anthropic.com>']);
    expect(trailers.get('signed-off-by')).toEqual(['Ishaan <i@example.com> continued']);
  });

  it('keeps only known keys in a paragraph that also holds prose', () => {
    const trailers = parseTrailers('Subject\n\nThis change adds retries.\nNote: not a trailer here\nSigned-off-by: A <a@example.com>');
    expect([...trailers.keys()]).toEqual(['signed-off-by']);
  });

  it('reads people and GitHub no-reply logins', () => {
    expect(parsePerson('Ishaan <12345+theg1239@users.noreply.github.com>')).toEqual({ name: 'Ishaan', email: '12345+theg1239@users.noreply.github.com', github: 'theg1239' });
    expect(parsePerson('Just a name')).toEqual({ name: 'Just a name' });
  });
});

describe('notes', () => {
  it('round-trips per-file claims, keeps the combined commit byline, and never borrows another run', () => {
    const note = parseNote(formatNote({ v: 1, agent: { name: 'Claude Opus 5.5 and GPT-6.1 Sol', session: 'combined' }, owner: { name: 'Maya', github: 'maya-chen' },
      files: {
        'src/limits.ts': { agent: { name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.4.1', session: 's_claude' }, owner: { name: 'Maya', github: 'maya-chen' } },
        'docs/receivers.md': { agent: { name: 'GPT-6.1 Sol' } },
        '.braid/decision.json': { kind: 'bot', agent: { name: 'Braid', tool: 'braid' } },
      } }));
    const record = provenanceOf(commit('Limit deliveries'), note);
    expect(record.agent?.name).toBe('Claude Opus 5.5 and GPT-6.1 Sol');
    expect(fileProvenance(record, 'src/limits.ts')).toMatchObject({ kind: 'agent', confidence: 'trailers', agent: { name: 'Claude Opus 5.5', tool: 'claude-code/2.4.1', session: 's_claude' }, owner: { github: 'maya-chen' } });
    const docs = fileProvenance(record, 'docs/receivers.md');
    expect(docs.owner).toBeUndefined(); expect(docs.agent?.session).toBeUndefined(); expect(docs.files).toBeUndefined();
    expect(fileProvenance(record, '.braid/decision.json')).toMatchObject({ kind: 'bot', agent: { name: 'Braid' } });
    expect(fileProvenance(record, 'other.txt').agent).toEqual(record.agent);
    expect(fileProvenance(record, 'constructor').agent).toEqual(record.agent);
    expect(parseNote(JSON.stringify({ v: 1, files: { 'src/limits.ts': { agent: { name: 42 } } } }))).toBeNull();
  });
  const note = { v: 1 as const, agent: { id: 'agent:conn-1', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.4.1', session: 's_9', parentSession: 's_1', fleet: 'nightly' },
    owner: { name: 'Ishaan', github: 'theg1239' }, change: { id: 'ch_1abcdefabcdef', number: 12, revision: 2 }, task: { id: 't_4', title: 'Limit deliveries' }, approvedBy: 'Maya' };

  it('round-trips a note and rejects anything else', () => {
    expect(NOTES_REF).toBe('refs/notes/braid');
    expect(parseNote(formatNote(note))).toEqual(note);
    expect(parseNote('not json')).toBeNull();
    expect(parseNote(JSON.stringify({ v: 2 }))).toBeNull();
    expect(parseNote(JSON.stringify({ v: 1, change: { id: 'x', number: 0, revision: 1 } }))).toBeNull();
  });
});

describe('who made a commit', () => {
  it('reads Braid\'s co-author as the agent, its author as the owner, and lets the note fill in the rest', () => {
    const message = 'Limit deliveries\n\nWhy.\n\nCo-authored-by: GPT-6.1 Sol <gpt-6.1-sol@agents.braid.local>';
    expect(provenanceOf(commit(message))).toEqual({
      commit: 'a'.repeat(40), at, subject: 'Limit deliveries', kind: 'agent', confidence: 'trailers',
      agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' }, owner: { name: 'Ishaan', email: ishaan.email, github: 'theg1239' },
    });
    const note = parseNote(JSON.stringify({ v: 1, agent: { id: 'agent:conn-1', name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8.0', session: 's_9' }, owner: { name: 'Ishaan', github: 'theg1239' },
      change: { id: 'ch_1abcdefabcdef', number: 12, revision: 2 }, task: { id: 't_4', title: 'Limit deliveries' } }))!;
    expect(provenanceOf(commit(message), note)).toEqual({
      commit: 'a'.repeat(40), at, subject: 'Limit deliveries', kind: 'agent', confidence: 'trailers',
      agent: { id: 'agent:conn-1', name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8.0', session: 's_9' },
      owner: { name: 'Ishaan', github: 'theg1239', email: ishaan.email }, change: { id: 'ch_1abcdefabcdef', number: 12 }, task: { id: 't_4', title: 'Limit deliveries' },
    });
  });

  it('makes the author the owner of a co-authoring Claude model, as Claude Code writes it', () => {
    const made = provenanceOf(commit('Add page\n\nGenerated with Claude Code\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>'));
    expect(made).toMatchObject({ kind: 'agent', agent: { name: 'Claude Opus 4.7', model: 'Claude Opus 4.7', tool: 'claude-code' }, owner: { github: 'theg1239' }, confidence: 'inferred' });
  });

  it("reads Braid's earlier Braid-Author and Braid-Change trailers", () => {
    expect(provenanceOf(commit('Sign payloads\n\nBraid-Change: #11 c1\nBraid-Author: Sable (agent, gpt-6-sol)'))).toMatchObject({ agent: { name: 'Sable', model: 'gpt-6-sol' }, change: { id: 'c1', number: 11 }, confidence: 'trailers' });
  });

  it('reads a model from a co-author only when it names a version', () => {
    const cursor = provenanceOf(commit('Fix nav\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>'));
    expect(cursor.agent).toEqual({ name: 'Cursor', tool: 'cursor' });
    const autofix = provenanceOf(commit('Fix XSS\n\nCo-authored-by: Copilot Autofix powered by AI <62310815+github-advanced-security[bot]@users.noreply.github.com>'));
    expect(autofix.agent?.model).toBeUndefined();
  });

  it('recognises agents that commit as bots', () => {
    const made = provenanceOf(commit('Fix flaky test', { name: 'copilot-swe-agent[bot]', email: '198982749+Copilot@users.noreply.github.com' }));
    expect(made).toMatchObject({ kind: 'agent', agent: { name: 'Copilot', tool: 'github-copilot' }, confidence: 'inferred' });
  });

  it('never counts a GitHub App as a person, and names the AI ones as people know them', () => {
    const bot = (login: string, name = login) => provenanceOf(commit('Fix the dashboard query', { name, email: `1234+${login}@users.noreply.github.com` }));
    expect(bot('posthog-eu[bot]')).toEqual({ commit: 'a'.repeat(40), at, subject: 'Fix the dashboard query', kind: 'agent', agent: { name: 'PostHog AI', tool: 'posthog' }, confidence: 'inferred' });
    for (const login of ['posthog[bot]', 'posthog-us[bot]']) expect(bot(login).agent).toEqual({ name: 'PostHog AI', tool: 'posthog' });
    for (const login of ['seer-by-sentry[bot]', 'sentry[bot]']) expect(bot(login).agent).toEqual({ name: 'Sentry Seer', tool: 'sentry' });
    expect(bot('coderabbitai[bot]').agent).toEqual({ name: 'CodeRabbit', tool: 'coderabbitai[bot]' });
    expect(bot('greptile-apps[bot]').agent).toEqual({ name: 'Greptile', tool: 'greptile-apps[bot]' });
    // Plain automation is not a person either.
    expect([bot('dependabot[bot]'), bot('renovate[bot]'), bot('github-actions[bot]')].map(made => [made.kind, made.agent?.name])).toEqual([['bot', 'Dependabot'], ['bot', 'Renovate'], ['bot', 'GitHub Actions']]);
    // Any other app goes by its login, whether its name or only its address carries [bot].
    expect(bot('acme-release[bot]', 'Acme Release').agent).toEqual({ name: 'acme-release', tool: 'acme-release[bot]' });
    expect(provenanceOf(commit('Bump deps', { name: 'acme-release[bot]', email: 'releases@acme.example' })).agent).toEqual({ name: 'acme-release', tool: 'acme-release[bot]' });
    // A co-authoring app works for the commit's author.
    expect(provenanceOf(commit('Apply review\n\nCo-authored-by: coderabbitai[bot] <136622811+coderabbitai[bot]@users.noreply.github.com>'))).toMatchObject({ kind: 'agent', agent: { name: 'CodeRabbit' }, owner: { github: 'theg1239' }, confidence: 'inferred' });
  });

  it('reads generated-with notes and agent branch names', () => {
    expect(provenanceOf(commit('Tidy\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')).agent?.name).toBe('Claude');
    expect(provenanceOf(commit('Merge pull request #12 from theg1239/codex/fix-upload\n\nFix upload')).agent?.name).toBe('Codex');
  });

  it('reads model co-authors before a second trailer block without making a bot the owner', () => {
    const message = 'Fix the viewer\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\nGenerated-By: PostHog Code\nTask-Id: task-1';
    const bot = { name: 'posthog-eu[bot]', email: '226701856+posthog-eu[bot]@users.noreply.github.com' };
    expect(provenanceOf(commit(message, bot))).toMatchObject({ kind: 'agent', agent: { name: 'Claude Opus 4.8', model: 'Claude Opus 4.8', tool: 'posthog' }, confidence: 'inferred' });
    expect(provenanceOf(commit(message, bot)).owner).toBeUndefined();
    expect(parseTrailers(message).get('co-authored-by')).toEqual(['Claude Opus 4.8 <noreply@anthropic.com>']);
    expect(parseTrailers('Subject\n\nCo-authored-by: Claude <noreply@anthropic.com>\n\nThis is a quoted example, not a credit.').size).toBe(0);
  });

  it('keeps the model separate from its context-window label and recognises namespaced agent branches', () => {
    expect(provenanceOf(commit('Fix\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')).agent)
      .toEqual({ name: 'Claude Opus 4.7', model: 'Claude Opus 4.7', tool: 'claude-code' });
    expect(provenanceOf(commit('Merge pull request #47 from ACM-VIT:codex/pr-41')).agent?.name).toBe('Codex');
    expect(provenanceOf(commit('Merge pull request #13 from theg1239/9m60sk-codex/create-helper')).agent?.name).toBe('Codex');
    expect(provenanceOf(commit('Document the codex/example API')).kind).toBe('human');
  });

  it('uses the note as the authority for a human change and the model as an agent name', () => {
    const facts = commit('Write docs\n\nCo-authored-by: Claude <noreply@anthropic.com>');
    expect(provenanceOf(facts, { v: 1, owner: { name: 'Ishaan', github: 'theg1239' } })).toMatchObject({ kind: 'human', confidence: 'trailers', owner: { github: 'theg1239' } });
    expect(provenanceOf(facts, { v: 1, agent: { name: 'Laptop', model: 'claude-opus-5-5' } }).agent?.name).toBe('Claude Opus 5.5');
  });

  it('leaves everything else to the person who committed it', () => {
    expect(provenanceOf(commit('Refactor auth\n\nSmaller.'))).toMatchObject({ kind: 'human', owner: { name: 'Ishaan', github: 'theg1239' }, confidence: 'inferred' });
  });
});
