import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLink } from '../src/config';
import { taskLink } from '../src/task';
import { braid, cleanup, json, repository, server, session } from './helpers';

const helper = await import(new URL('../../public/cli/braid.mjs', import.meta.url).href);
afterEach(cleanup);
const origin = 'https://braid.example', id = 'ch_0123456789abc';
const html_url = `${origin}/acme/relay/pull/12`;
const change = { id, number: 12, title: 'Linked feature', revision: 1, status: 'attention', html_url };

it.each([taskLink, helper.taskLink])('parses browser and legacy task URLs while rejecting unsafe inputs', parse => {
  expect(parse(`${origin}/acme/relay/tasks/mission-one`)).toMatchObject({ origin, repository: 'acme/relay', missionId: 'mission-one' });
  expect(parse(`${origin}/alice/notes/tasks/mission-one/?agent=coder`)).toMatchObject({ repository: 'alice/notes', missionId: 'mission-one', agentId: 'coder' });
  expect(parse(`${origin}/example/relay/tasks/mission-example`)).toMatchObject({ repository: 'example/relay', missionId: 'mission-example' });
  expect(parse(`${origin}/tasks/mission-one?workspace=ws_1&agent=coder`)).toEqual({ origin, missionId: 'mission-one', workspaceId: 'ws_1', agentId: 'coder' });
  for (const link of [`${origin}/acme/relay/tasks/mission-one?workspace=a&workspace=b`, `${origin}/acme/relay/tasks/mission-one?next=elsewhere`, `${origin}/acme/relay/tasks/mission-one#fragment`, `${origin}/acme/relay/tasks/mission-one/extra`, `${origin}/acme/relay/tasks/%2f`, `${origin}/acme/%2f/tasks/mission-one`, 'https://token@braid.example/acme/relay/tasks/mission-one', 'file:///acme/relay/tasks/mission-one']) expect(() => parse(link)).toThrow();
});

describe.each([false, true])('browser links in CLI commands (downloadable=%s)', downloadable => {
  it.each(['submit', 'status', 'wait', 'restack'])('%s prints the API URL without inventing a flat pull request address', async command => {
    const repo = repository();
    const base = repo.commit({ 'README.md': '# Repository\n' }, 'Base');
    repo.commit({ 'feature.ts': 'export const value = 1;\n' }, 'Feature');
    const env = { ...repo.env, BRAID_ACCESS_TOKEN: `braid_agent_${'a'.repeat(64)}`, BRAID_WORKSPACE_ID: 'ws_1' };
    writeLink(repo.root, { url: origin, workspaceId: 'ws_1' });
    writeFileSync(join(repo.root, '.git/info/exclude'), '.braid/\n');
    mkdirSync(join(repo.root, '.braid'), { recursive: true, mode: 0o700 });
    writeFileSync(join(repo.root, '.braid/change.json'), JSON.stringify({ origin, workspaceId: 'ws_1', base, ...(command === 'submit' ? {} : { changeId: id, revision: 1 }) }), { mode: 0o600 });
    const api = server({ 'POST /api/agent/session': session(), 'POST /api/changes/checkout': () => json({ head: base, remote: 'https://git.example/repo.git', token: 'read-token', branch: 'main' }),
      'POST /api/changes': () => json(change, 201), [`GET /api/changes/${id}`]: () => json(change), 'GET /api/changes/12': () => json(change), 'POST /api/changes/12/restack': () => json(change),
    });
    let output: string;
    if (downloadable) {
      const lines: string[] = [];
      const args = command === 'restack' ? ['restack', '12'] : ['change', command];
      await helper.main([...args, '--dir', repo.root, ...(command === 'submit' ? ['--title', change.title, '--summary', change.title] : [])], { env, fetch: api.fetch, log: (line: string) => lines.push(line) });
      output = lines.join('\n');
    } else {
      const args = command === 'restack' ? ['restack', '12'] : [command, ...(['status', 'wait'].includes(command) ? ['--change', id] : [])];
      const result = await braid(args, { cwd: repo.root, env, fetch: api.fetch });
      expect(result.stderr).toBe('');
      output = result.stdout;
    }
    expect(output).toContain(html_url);
    expect(output).not.toContain(`${origin}/pull/`);
  });
});
