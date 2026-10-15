import { afterEach, describe, expect, it } from 'vitest';
import type { FileBlame } from '../../shared/types';
import { braid, cleanup, repository } from './helpers';

afterEach(cleanup);

const address = (name: string, domain = 'example.test') => [name, domain].join('@');
const owner = { name: 'Sample Owner', email: address('sample-owner') };
const copilot = address('copilot', 'github.com');

describe('the real-clone CLI sample', () => {
  it('recognises the Copilot CLI credit in blame and stats without changing the commit', async () => {
    const repo = repository(owner);
    repo.commit({ 'layout.tsx': 'human\n' }, 'Start');
    const message = `Add toaster\n\nCo-authored-by: Copilot <${copilot}>`;
    repo.commit({ 'layout.tsx': 'human\ntoaster\n' }, message);
    const options = { cwd: repo.root, env: repo.env };
    const result = await braid(['blame', 'layout.tsx', '--json'], options);
    expect(result.exitCode).toBe(0);
    const blame = JSON.parse(result.stdout) as FileBlame;
    expect(blame.ranges[1].provenance).toMatchObject({
      kind: 'agent', agent: { name: 'Copilot', tool: 'github-copilot' },
      owner: { name: owner.name }, subject: 'Add toaster', confidence: 'inferred',
    });
    const stats = await braid(['stats', '--json'], options);
    expect(stats.exitCode).toBe(0);
    expect(JSON.parse(stats.stdout)).toMatchObject({ lines: 2, rows: expect.arrayContaining([
      { kind: 'agent', name: 'Copilot for Sample Owner', owner: owner.name, tool: 'github-copilot', lines: 1, share: 0.5 },
      { kind: 'human', name: 'people', lines: 1, share: 0.5 },
    ]) });
    expect(repo.git(['log', '-1', '--format=%B'])).toBe(message);
  });

  it('recognises a Copilot author without treating its bot identity as an owner', async () => {
    const repo = repository(owner);
    repo.commit({ 'file.ts': 'agent\n' }, 'Fix', { author: { name: 'Copilot', email: copilot } });
    const result = await braid(['blame', 'file.ts', '--json'], { cwd: repo.root, env: repo.env });
    const provenance = (JSON.parse(result.stdout) as FileBlame).ranges[0].provenance;
    expect(provenance).toMatchObject({ kind: 'agent', agent: { name: 'Copilot' }, confidence: 'inferred' });
    expect(provenance.owner).toBeUndefined();
  });

  it('keeps mixed-tool credits ambiguous and gives a Braid note precedence', async () => {
    const repo = repository(owner);
    const commit = repo.commit({ 'file.ts': 'agent\n' }, `Fix\n\nCo-authored-by: Copilot <${copilot}>\nCo-authored-by: Codex <${address('codex', 'openai.com')}>`);
    const options = { cwd: repo.root, env: repo.env };
    const first = await braid(['blame', 'file.ts', '--json'], options);
    expect((JSON.parse(first.stdout) as FileBlame).ranges[0].provenance.agent).toEqual({ name: 'Agent' });
    repo.git(['notes', '--ref=refs/notes/braid', 'add', '-m', JSON.stringify({ v: 1, kind: 'human', owner: { name: owner.name } }), commit]);
    const noted = await braid(['blame', 'file.ts', '--json'], options);
    expect((JSON.parse(noted.stdout) as FileBlame).ranges[0].provenance).toMatchObject({ kind: 'human', confidence: 'trailers' });
  });

  it.each([
    `Explain a credit\n\n\`\`\`text\nCo-authored-by: Copilot <${copilot}>\n\`\`\``,
    `Co-authored-by: Copilot <${copilot}>`,
    `Fix\n\nCo-authored-by: Copilot <${address('copilot')}>`,
  ])('does not infer an agent from a quoted credit, a subject or an unrelated address (%#)', async message => {
    const repo = repository(owner);
    repo.commit({ 'file.ts': 'human\n' }, message);
    const result = await braid(['blame', 'file.ts', '--json'], { cwd: repo.root, env: repo.env });
    expect((JSON.parse(result.stdout) as FileBlame).ranges[0].provenance.kind).toBe('human');
  });

  it('keeps emails out of blame text and JSON, log, stats and error messages', async () => {
    const repo = repository({ name: owner.email, email: owner.email });
    repo.commit({ 'file.ts': `const contact = "${owner.email}";\n` }, `Contact ${owner.email}\n\nCo-authored-by: Copilot <${copilot}>`);
    const options = { cwd: repo.root, env: repo.env };
    for (const command of [
      ['blame', 'file.ts'], ['blame', 'file.ts', '--json'],
      ['log'], ['log', '--json'], ['stats'], ['stats', '--json'],
    ]) {
      const result = await braid(command, options);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes(owner.email)).toBe(false);
      expect(result.stdout.includes(copilot)).toBe(false);
      expect(result.stdout).toContain('[private email]');
      if (command.includes('--json')) expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
    const error = await braid(['blame', 'file.ts', '--rev', owner.email], options);
    expect(error.exitCode).toBe(1);
    expect(error.stderr.includes(owner.email)).toBe(false);
    expect(error.stderr).toContain('[private email]');
  });
});
