import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLink } from '../src/config';
import { parseDependsOn } from '../src/commands/submit';
import { braid, cleanup, json, repository, server, session } from './helpers';

const helper = await import(new URL('../../public/cli/braid.mjs', import.meta.url).href);
afterEach(cleanup);
const origin = 'https://braid.example', id = 'ch_0123456789abc';
const dependency = { id: 'ch_1123456789abc', number: 51, status: 'open' };
const changed = { id, number: 73, title: 'Stacked feature', revision: 1, status: 'open', next: 'Waiting on #51', dependsOn: [dependency], waitingOn: [dependency] };
function workspace() {
  const repo = repository();
  const base = repo.commit({ 'README.md': '# Test\n' }, 'Base');
  repo.commit({ 'feature.ts': 'export const value = 1;\n' }, 'Stacked feature');
  writeLink(repo.root, { url: origin, workspaceId: 'ws_1' });
  return { ...repo, base, env: { ...repo.env, BRAID_ACCESS_TOKEN: `braid_agent_${'a'.repeat(64)}`, BRAID_WORKSPACE_ID: 'ws_1' } };
}

describe('dependency flags and feedback', () => {
  it.each([parseDependsOn, helper.parseDependsOn])('parses bounded numbers and ids; none explicitly clears the stack', parse => {
    expect(parse(`51,${id}`)).toEqual([51, id]);
    expect(parse('none')).toEqual([]);
    for (const value of ['0', '-1', '1.5', '', 'garbage', '9007199254740992', Array(17).fill('1').join(',')]) expect(() => parse(value)).toThrow();
  });

  it('sends dependencies on submit, preserves exact retries, and clears them on revision', async () => {
    const repo = workspace();
    const api = server({ 'POST /api/agent/session': session(), 'POST /api/changes/checkout': () => json({ head: repo.base, remote: 'https://git.example/repo.git', token: 'read-token', branch: 'main' }),
      'POST /api/changes': [() => json({ error: 'Offline' }, 503), () => json(changed, 201)],
      [`GET /api/changes/${id}`]: () => json(changed), [`POST /api/changes/${id}/revisions`]: () => json({ ...changed, revision: 2, dependsOn: [], waitingOn: [] }),
    });
    const options = { cwd: repo.root, env: repo.env, fetch: api.fetch };
    expect((await braid(['submit', '--depends-on', '51'], options)).exitCode).toBe(1);
    const retried = await braid(['submit', '--retry'], options);
    expect(retried.exitCode).toBe(0); expect(retried.stdout).toContain('Waiting on #51');
    const submissions = api.sent.filter(request => request.path === '/api/changes');
    expect(submissions[0].body).toMatchObject({ dependsOn: [51] });
    expect(submissions[1].body).toEqual(submissions[0].body);
    expect(submissions[1].headers['idempotency-key']).toBe(submissions[0].headers['idempotency-key']);
    expect((await braid(['submit', '--depends-on', 'none'], options)).exitCode).toBe(0);
    expect(api.sent.at(-1)?.body).toMatchObject({ dependsOn: [], previousRevision: 1 });
  });

  it('prints the prerequisite while wait continues, before the final merge result', async () => {
    const repo = workspace(), output: string[] = [];
    const api = server({ 'POST /api/agent/session': session(), [`GET /api/changes/${id}`]: [() => json(changed), () => json({ ...changed, status: 'landed', next: undefined, waitingOn: [] })] });
    const result = await braid(['wait', '--change', id], { cwd: repo.root, env: repo.env, fetch: api.fetch, sleep: async () => { output.push('waited'); } });
    expect(result.exitCode).toBe(0); expect(result.stdout.startsWith('Waiting on #51\n')).toBe(true); expect(output).toHaveLength(1);
  });

  it('the downloadable helper sends and retries depends-on with the saved proposal', async () => {
    const repo = workspace();
    writeFileSync(join(repo.root, '.git/info/exclude'), '.braid/\n');
    mkdirSync(join(repo.root, '.braid'), { recursive: true, mode: 0o700 });
    writeFileSync(join(repo.root, '.braid/change.json'), JSON.stringify({ origin, workspaceId: 'ws_1', base: repo.base }), { mode: 0o600 });
    const api = server({ 'POST /api/agent/session': session(), 'POST /api/changes': [() => json({ error: 'Offline' }, 503), () => json(changed, 201)] });
    const options = { env: repo.env, fetch: api.fetch, log: () => {} };
    await expect(helper.main(['change', 'submit', '--dir', repo.root, '--title', 'Stacked feature', '--summary', 'Stacked feature', '--depends-on', '51'], options)).rejects.toThrow(/unconfirmed/);
    await helper.main(['change', 'submit', '--dir', repo.root, '--retry'], options);
    const submissions = api.sent.filter(request => request.path === '/api/changes');
    expect(submissions[0].body).toMatchObject({ dependsOn: [51] }); expect(submissions[1].body).toEqual(submissions[0].body);
    expect(submissions[1].headers['idempotency-key']).toBe(submissions[0].headers['idempotency-key']);
  });
});

describe('restacking from the CLIs', () => {
  const outdated = { ...changed, status: 'revise', next: '#51 changed since this was built. Restack this pull request.', outdated: [dependency] };
  function metadata(repo: ReturnType<typeof workspace>, task: boolean) {
    writeFileSync(join(repo.root, '.git/info/exclude'), '.braid/\n');
    mkdirSync(join(repo.root, '.braid'), { recursive: true, mode: 0o700 });
    writeFileSync(join(repo.root, '.braid', task ? 'task.json' : 'change.json'), JSON.stringify(task
      ? { url: origin, workspaceId: 'ws_1', missionId: 'mission-1', agentId: 'coder', baseCommit: repo.base, scope: [] }
      : { origin, workspaceId: 'ws_1', base: repo.base }), { mode: 0o600 });
  }
  it.each([false, true])('retries the exact revision and key, then starts a fresh operation (task=%s)', async task => {
    const repo = workspace(); metadata(repo, task);
    const head = repo.git(['rev-parse', 'HEAD']);
    const api = server({ 'POST /api/agent/session': session(), 'GET /api/changes/73': () => json(outdated),
      'POST /api/changes/73/restack': [() => json({ error: 'Lost response' }, 503), () => json({ ...outdated, conflicts: [{ path: 'feature.ts', kind: 'content' }] }), () => json({ ...changed, revision: 2, outdated: [] })] });
    const options = { cwd: repo.root, env: repo.env, fetch: api.fetch };
    expect((await braid(['restack', '73'], options)).exitCode).toBe(1);
    expect((await braid(['restack', '73'], options)).stdout).toContain('Conflict (content)');
    expect((await braid(['restack', '73'], options)).stdout).toContain('revision 2');
    const sent = api.sent.filter(item => item.path.endsWith('/restack'));
    expect(sent.map(item => item.body)).toEqual(Array(3).fill({ previousRevision: 1 }));
    expect(sent[0].headers['idempotency-key']).toBe(sent[1].headers['idempotency-key']);
    expect(sent[2].headers['idempotency-key']).not.toBe(sent[1].headers['idempotency-key']);
    expect(api.sent.filter(item => item.method === 'GET')).toHaveLength(2);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(repo.git(['status', '--porcelain'])).toBe('');
  });
  it.each([false, true])('the downloadable helper persists exact restack retries (task=%s)', async task => {
    const repo = workspace(); metadata(repo, task);
    const api = server({ 'POST /api/agent/session': session(), 'GET /api/changes/73': () => json(outdated),
      'POST /api/changes/73/restack': [() => json({ error: 'Lost response' }, 503), () => json({ ...changed, revision: 2, outdated: [] })] });
    const output: string[] = [], options = { env: repo.env, fetch: api.fetch, log: (text: string) => output.push(text) };
    await expect(helper.main(['restack', '73', '--dir', repo.root], options)).rejects.toThrow('Lost response');
    await helper.main(['restack', '73', '--dir', repo.root], options);
    const sent = api.sent.filter(item => item.path.endsWith('/restack'));
    expect(sent[0].body).toEqual({ previousRevision: 1 }); expect(sent[1].body).toEqual(sent[0].body);
    expect(sent[0].headers['idempotency-key']).toBe(sent[1].headers['idempotency-key']);
    expect(api.sent.filter(item => item.method === 'GET')).toHaveLength(1);
    expect(output.join('\n')).toContain('Local commits and files are unchanged.');
  });
  it.each([false, true])('forwards and retries dependencies from task results (downloadable=%s)', async downloadable => {
    const repo = workspace(); metadata(repo, true);
    const path = '/api/missions/mission-1/agents/coder/submit';
    const api = server({ 'POST /api/agent/session': session(), [`POST ${path}`]: [() => json({ error: 'Offline' }, 503), () => json({ commit: 'b'.repeat(40) })] });
    if (downloadable) {
      const options = { env: repo.env, fetch: api.fetch, log: () => {} };
      await expect(helper.main(['submit', '--dir', repo.root, '--summary', 'Done', '--depends-on', '51'], options)).rejects.toThrow();
      await helper.main(['submit', '--dir', repo.root, '--retry'], options);
    } else {
      const options = { cwd: repo.root, env: repo.env, fetch: api.fetch };
      expect((await braid(['task', 'submit', '--summary', 'Done', '--depends-on', '51'], options)).exitCode).toBe(1);
      expect((await braid(['task', 'submit', '--retry'], options)).exitCode).toBe(0);
    }
    const sent = api.sent.filter(item => item.path === path);
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toMatchObject({ dependsOn: [51] }); expect(sent[1].body).toEqual(sent[0].body);
    expect(sent[0].headers['idempotency-key']).toBe(sent[1].headers['idempotency-key']);
  });
});

it('maps both GitHub noreply address forms to handles in both CLIs', async () => {
  const { personHandle, personLabel } = await import('../src/present');
  for (const format of [personHandle, helper.personHandle]) {
    expect(format('12345+theg1239@users.noreply.github.com')).toBe('@theg1239');
    expect(format('maya-dev@users.noreply.github.com')).toBe('@maya-dev');
    expect(format('maya@example.com')).toBe('maya@example.com');
    expect(format('Maya')).toBe('Maya');
  }
  expect(personLabel({ name: 'Maya', email: '42+maya@users.noreply.github.com' })).toBe('@maya');
  expect(personLabel({ name: 'Maya', email: 'maya@example.com' })).toBe('Maya');
});

it('runs the downloadable helper through a symlinked entrypoint', () => {
  const repo = repository(), path = join(repo.home, 'braid.mjs');
  symlinkSync(fileURLToPath(new URL('../../public/cli/braid.mjs', import.meta.url)), path);
  expect(execFileSync(process.execPath, [path, '--help'], { encoding: 'utf8' })).toContain('node braid.mjs connect');
});
