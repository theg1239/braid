import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, repository } from '../../cli/test/helpers';
import { saveCredentials } from '../../cli/src/config';
import type { LocalActivityPage } from '../../shared/agent-activity';
import api from '../http/api';
import { localActivityFixture } from '../test/local-activity';

const project = join(import.meta.dirname, '../..'), bundle = join(project, 'cli/dist/braid.mjs');
beforeAll(() => execFileSync('npm', ['run', 'build:cli'], { cwd: project, stdio: 'pipe' }), 60_000);
afterEach(cleanup);

async function execute(args: string[], root: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [bundle, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}

describe('local CLI through an authenticated local development API', () => {
  it.each(['node', 'claude'])('reports a real %s process, preserves its exit code and removes its session hooks', async tool => {
    const fixture = await localActivityFixture(), repo = repository();
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const result = await api.fetch(new Request(`https://braid.test${request.url}`, { method: request.method, headers, ...(body.length ? { body } : {}) }), fixture.env);
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
      } catch { response.writeHead(500); response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      saveCredentials(repo.env, { origin, workspaceId: fixture.workspace, accessToken: fixture.token, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      expect((await execute(['init', '--url', origin, '--workspace', fixture.workspace], repo.root, repo.env)).code).toBe(0);
      let command = [process.execPath, '-e', 'setTimeout(() => process.exit(0), 100)'];
      if (tool === 'claude') {
        const bin = join(repo.home, 'bin'); mkdirSync(bin);
        const fake = join(bin, 'claude');
        writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const file = process.argv[process.argv.indexOf('--settings') + 1];
fs.writeFileSync('settings-used.txt', file);
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
const event = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test --token PRIVATE' }, tool_response: { exit_code: 1, stdout: 'PRIVATE CONTENT' } };
cp.execSync(settings.hooks.PostToolUse.at(-1).hooks[0].command, { input: JSON.stringify(event), stdio: ['pipe', 'ignore', 'ignore'] });
process.exit(3);
`, { mode: 0o755 });
        command = [fake, '--model', 'claude-opus-5-5'];
      }
      const result = await execute(['agent', 'run', '--', ...command], repo.root, repo.env);
      expect(result.code).toBe(tool === 'claude' ? 3 : 0);
      expect(result.stderr).toContain(fixture.workspace);
      let page: LocalActivityPage = { items: [] };
      for (let i = 0; i < 100; i++) {
        page = await (await fixture.call(undefined, { token: null, cookie: fixture.cookie })).json() as LocalActivityPage;
        if (page.items[0]?.events.some(e => e.source === 'process' && ['finished', 'failed'].includes(e.kind))) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const events = page.items[0]?.events ?? [];
      expect(events).toContainEqual(expect.objectContaining({ source: 'process', kind: 'started' }));
      expect(events).toContainEqual(expect.objectContaining({ source: 'process', kind: tool === 'claude' ? 'failed' : 'finished', exitCode: tool === 'claude' ? 3 : 0 }));
      if (tool === 'claude') {
        expect(events).toContainEqual(expect.objectContaining({ kind: 'command', command: 'npm test', exitCode: 1 }));
        expect(existsSync(readFileSync(join(repo.root, 'settings-used.txt'), 'utf8'))).toBe(false);
      } else expect(events.map(e => e.kind).sort()).toEqual(['finished', 'started']);
      expect(JSON.stringify(page)).not.toContain('PRIVATE');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fixture.close();
    }
  });
});
