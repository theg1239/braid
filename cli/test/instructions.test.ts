import { afterEach, describe, expect, it } from 'vitest';
import { saveCredentials, writeLink } from '../src/config';
import { braid, cleanup, json, repository, server, session } from './helpers';

afterEach(cleanup);

const origin = 'https://braid.example';
function linked() {
  const repo = repository();
  repo.commit({ 'a.txt': 'a\n' }, 'Start');
  saveCredentials(repo.env, { origin, accessToken: `braid_agent_${'c'.repeat(64)}`, workspaceId: 'ws_1', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  writeLink(repo.root, { url: origin, workspaceId: 'ws_1' });
  return repo;
}

describe('braid instructions', () => {
  it('lists the instructions every agent follows, with what they block and where', async () => {
    const repo = linked();
    const braidServer = server({
      'POST /api/agent/session': session(),
      'GET /api/instructions': () => json({ instructions: [{ id: 'use-the-logger', text: 'Use the logger.', block: ['console.log'], paths: ['src/**'] }, { id: 'small-changes', text: 'Keep changes small.' }], errors: ['instructions[2].id must be a short slug such as "no-em-dashes".'], head: 'a'.repeat(40) }),
    });
    const result = await braid(['instructions'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch });
    expect(result.stdout).toBe('use-the-logger  Use the logger.\n  blocks "console.log" in src/**\nsmall-changes  Keep changes small.\n');
    expect(result.stderr).toBe('Warning: instructions[2].id must be a short slug such as "no-em-dashes".\n');
  });

  it('proposes an instruction as a pull request, and says where a person adds it when an agent may not', async () => {
    const repo = linked();
    const braidServer = server({
      'POST /api/agent/session': session(),
      'POST /api/instructions': [() => json({ id: 'ch_0000000000001', number: 9, html_url: 'https://braid.example/acme/relay/pull/9', title: 'Add an instruction', status: 'open', revision: 1 }, 201), () => json({ error: 'This agent connection cannot perform that operation.' }, 403)],
    });
    const added = await braid(['instructions', 'add', 'Use the logger.', '--block', 'console.log', '--block', 'debugger', '--path', 'src/**'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch });
    expect(added.stdout).toBe('Opened pull request #9 to add the instruction; it lands under the repository\'s rules.\nhttps://braid.example/acme/relay/pull/9\n');
    const [sent] = braidServer.sent.filter(request => request.path === '/api/instructions');
    expect(sent.body).toEqual({ text: 'Use the logger.', block: ['console.log', 'debugger'], paths: ['src/**'] });
    expect(sent.headers['idempotency-key']).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
    const refused = await braid(['instructions', 'add', 'Use the logger.'], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch });
    expect(refused.stderr).toContain('Only a person can add instructions, and braid signs in as an agent. Add it in Braid at https://braid.example/settings/agents.');
  });

  it('checks an instruction before sending it', async () => {
    const repo = linked();
    const braidServer = server({ 'POST /api/agent/session': session() });
    const result = await braid(['instructions', 'add', 'Too many', ...Array.from({ length: 9 }, (_, index) => ['--block', `word${index}`]).flat()], { cwd: repo.root, env: repo.env, fetch: braidServer.fetch });
    expect(result.stderr).toContain('Block up to 8 strings of 1–60 characters, each on one line.');
    expect(braidServer.sent).toHaveLength(0);
  });
});
