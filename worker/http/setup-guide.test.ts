import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { braid, cleanup, repository, temporary } from '../../cli/test/helpers';
import api from './api';
import type { BraidEnv } from '../env';
import { handleMcp, type ApiCall } from './mcp';
import { parse, submission } from '../schemas';
import { setupGuide } from './setup-guide';

const origin = 'https://braid.example';
const paths = ['/llms.txt', '/setup.md', '/auth.md', '/changes.md', '/local-agents.md'];
const guide = (path: string) => setupGuide(path, origin)!;

afterEach(cleanup);

describe('Braid coding skill', () => {
  const path = '/skills/braid/SKILL.md';

  it('serves Markdown anonymously with valid skill frontmatter and public links', async () => {
    const publicOrigin = 'https://braid-git.acmvit.workers.dev';
    const response = await api.fetch(new Request(`${origin}${path}`), { PUBLIC_ORIGIN: publicOrigin } as BraidEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const text = await response.text();
    expect(text).toBe(setupGuide(path, publicOrigin));
    // JSON strings are valid YAML double-quoted scalars. Require this small,
    // unambiguous frontmatter format without adding a YAML parser dependency.
    const frontmatter = /^---\nname: ("[^\n]+")\ndescription: ("[^\n]+")\n---\n/.exec(text);
    expect(frontmatter).not.toBeNull();
    expect(JSON.parse(frontmatter![1])).toBe('braid');
    expect(JSON.parse(frontmatter![2])).toMatch(/repository hosted on Braid.*remote is a Braid URL/);
    expect(text.trimEnd().split('\n').length).toBeGreaterThanOrEqual(40);
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(70);
    const links = [...text.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map(match => new URL(match[1]));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.origin).toBe(publicOrigin);
      expect(setupGuide(link.pathname, publicOrigin), link.href).not.toBeNull();
    }
  });

  it('names only MCP tools present in the live catalog', async () => {
    const call = vi.fn<ApiCall>();
    const catalog = await handleMcp({ id: 1, method: 'tools/list' }, call, false) as { result: { tools: { name: string }[] } };
    const names = catalog.result.tools.map(tool => tool.name);
    const mentioned = [...new Set([...guide(path).matchAll(/`([a-z]+_[a-z_]+)`/g)].map(match => match[1]))];
    expect(mentioned).toEqual(expect.arrayContaining(['get_rules', 'get_blame', 'files_in_progress', 'get_pull_request', 'create_pull_request', 'update_pull_request', 'report_problem']));
    expect(guide(path)).toContain('If you get stuck, call `report_problem`.');
    for (const name of mentioned) expect(names, name).toContain(name);
    expect(call).not.toHaveBeenCalled();
  });

  it('uses a real Git push command with a valid pull request ref', () => {
    const commands: string[] = [];
    marked.walkTokens(marked.lexer(guide(path)), token => {
      if (token.type === 'code') commands.push(...token.text.split('\n'));
    });
    expect(commands).toEqual(['git push braid HEAD:refs/for/main']);
    const repo = repository();
    repo.commit({ 'README.md': '# Skill command fixture\n' }, 'Initial fixture');
    const remote = join(repo.home, 'remote.git');
    repo.git(['init', '--bare', remote]);
    repo.git(['remote', 'add', 'braid', remote]);
    for (const command of commands) {
      const [program, action, ...args] = command.split(' ');
      expect(program).toBe('git');
      expect(repo.git([action, '--dry-run', '--porcelain', ...args])).toContain('HEAD:refs/for/main');
    }
  });

  it('discovers the skill and saves it with the documented curl commands', () => {
    const discovery = guide('/llms.txt');
    const commands = [...discovery.matchAll(/`(curl [^`]+\/skills\/braid\/SKILL\.md)`/g)].map(match => match[1]);
    expect(commands).toHaveLength(2);
    expect(discovery).toContain(`[Braid skill](${origin}${path})`);
    const folder = temporary(), source = join(folder, 'source.md');
    writeFileSync(source, guide(path));
    for (const [index, command] of commands.entries()) {
      const [program, ...args] = command.split(' ');
      expect(args).toEqual(['-o', `~/${index === 0 ? '.claude' : '.codex'}/skills/braid/SKILL.md`, '--create-dirs', `${origin}${path}`]);
      // Exercise curl and directory creation entirely in scratch space.
      const destination = join(folder, args[1].slice(2));
      args[1] = destination;
      args[3] = pathToFileURL(source).href;
      execFileSync(program, args, { stdio: 'pipe' });
      expect(readFileSync(destination, 'utf8')).toBe(guide(path));
    }
  });
});

describe('agent documentation', () => {
  it.each(paths)('serves %s without an account or an unpublished npm command', async path => {
    const response = await api.fetch(new Request(`${origin}${path}`), { PUBLIC_ORIGIN: origin } as BraidEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe(path === '/local-agents.md' ? 'no-store' : 'public, max-age=300');
    const text = await response.text();
    expect(text).toBe(guide(path));
    expect(text).not.toMatch(/npx braid-git|npm install (?:-g|--global) braid-git/);
    expect(text).toContain('/cli/braid.mjs');
  });

  it('starts discovery and setup with the downloadable CLI and repository addresses', () => {
    for (const path of ['/llms.txt', '/setup.md']) {
      const text = guide(path);
      expect(text).toContain(`curl -fsSL --create-dirs -o ~/.braid/braid.mjs "${origin}/cli/braid.mjs"`);
      expect(text).toContain('braid-git is not published on npm');
      expect(text).toContain('pull request');
      expect(text).toContain('username');
      expect(text.replace(/\/[^\s)]+/g, '')).not.toMatch(/\b(?:land|landed|lands|missions|workspace|workspaces)\b/);
    }
    expect(guide('/setup.md')).toContain('/<owner>/<repo>/tasks/<missionId>');
    expect(guide('/setup.md')).toContain('bare /tasks/<missionId> can select the wrong repository');
  });

  it('documents commands the downloadable CLI actually exposes', () => {
    const help = execFileSync(process.execPath, [new URL('../../public/cli/braid.mjs', import.meta.url).pathname, '--help'], { encoding: 'utf8' });
    const commands = [...paths.flatMap(path => [...guide(path).matchAll(/node ~\/\.braid\/braid\.mjs ((?:change )?[a-z]+)\b/g)].map(match => match[1]))];
    expect(commands).toContain('resume');
    expect(commands).toContain('change submit');
    expect(commands).toContain('change wait');
    for (const command of new Set(commands)) expect(help, command).toContain(`node braid.mjs ${command} `);
    for (const path of ['/changes.md', '/local-agents.md']) {
      expect(guide(path)).toContain('--proof');
      expect(guide(path)).toContain('--retry');
    }
  });

  it('documents public MCP reads and keeps writes authorized', async () => {
    for (const path of ['/llms.txt', '/setup.md']) {
      const text = guide(path);
      expect(text).toContain('X-Braid-Workspace: demo');
      expect(text).toContain('/api/repository/commits');
      expect(text).toContain(`${origin}/cli/braid-git.mjs`);
      expect(text).toContain('Read tools work on public repositories without a token.');
      expect(text).toContain('report_problem({summary,details?,tool?,pull_request?})');
      expect(text).toContain('no Git clone address');
    }
    expect(guide('/setup.md')).toContain('HTTP 409, "Create or import a repository first."');
    const request = (method: string) => new Request(`${origin}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-braid-workspace': 'demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'report_problem', arguments: { summary: 'Missing tool' } } }),
    });
    const listing = await api.fetch(request('tools/list'), {} as BraidEnv);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'get_repository' })]) } });
    const write = await api.fetch(request('tools/call'), {} as BraidEnv);
    expect(write.status).toBe(401);
    expect(await write.json()).toMatchObject({ error: expect.stringContaining('See /auth.md') });
  });

  it('documents full CLI commands supported by the current source', async () => {
    const docs = readFileSync(new URL('../../docs/AGENT-ONBOARDING.md', import.meta.url), 'utf8');
    for (const command of ['blame', 'log', 'agent list', 'stats', 'login', 'init', 'agent run', 'submit', 'status', 'wait', 'sync', 'restack', 'task start', 'task resume', 'task update', 'task progress', 'task submit', 'task wait']) {
      expect(docs, command).toContain(`braid ${command}`);
      const result = await braid([...command.split(' '), '--help'], { cwd: import.meta.dirname, env: {} });
      expect(result.exitCode, `${command}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(`braid ${command}`);
    }
  });

  it('names registered MCP tools and runs the documented comment examples through their schemas', async () => {
    const call = vi.fn<ApiCall>(async (method, path) => {
      if (path.endsWith('/comments') && method === 'GET') return { status: 200, data: [] };
      return { status: 200, data: { id: 'ch_0123456789abc', number: 22, title: 'Validate endpoints', revision: 2, status: 'open', checks: [], reviews: [], conflicts: [], comments: [] } };
    });
    const catalog = await handleMcp({ id: 1, method: 'tools/list' }, call, false) as { result: { tools: { name: string }[] } };
    const names = catalog.result.tools.map(tool => tool.name);
    const text = guide('/changes.md');
    const mentioned = [...text.matchAll(/\b(?:get_|list_|compare_|create_|update_|review_|restack_|add_reply_to_)[a-z_]+\b|\bfiles_in_progress\b/g)].map(match => match[0]);
    for (const name of new Set(mentioned)) expect(names).toContain(name);
    for (const name of ['list_pull_request_review_comments', 'add_reply_to_pull_request_comment']) {
      const example = new RegExp(`${name}\\((\\{[^\\n]+\\})\\)`).exec(text)![1];
      const args = JSON.parse(example);
      const answer = await handleMcp({ id: 2, method: 'tools/call', params: { name, arguments: args } }, call, true);
      expect(answer).toMatchObject({ result: { content: expect.any(Array) } });
      expect(answer).not.toMatchObject({ result: { isError: true } });
    }
    expect(call).toHaveBeenCalledWith('GET', '/api/changes/22/comments');
    expect(call).toHaveBeenCalledWith('POST', '/api/changes/ch_0123456789abc/comments', { revision: 2, inReplyTo: 'rc_from_the_read', body: 'What changed and what was checked' }, '2f0332f8-6793-40e3-9b28-49a8b75e4d12');
  });

  it('submits the documented MCP example through the tool and API schemas', async () => {
    const example = /For create_pull_request, use arguments like (\{[^\n]+\})\. Replace/.exec(guide('/changes.md'))![1];
    const args = { ...JSON.parse(example), base_commit: 'a'.repeat(40), depends_on: [21] };
    const call = vi.fn<ApiCall>(async (method, path, body) => {
      expect([method, path]).toEqual(['POST', '/api/changes']);
      const input = parse(submission.agent, body);
      expect(input).toMatchObject({
        model: 'gpt-6', baseCommit: args.base_commit, dependsOn: [21],
        files: [{ path: 'docs/setup.md', content: '# Setup\nAsk the owner to approve the connection.\n' }],
      });
      return { status: 201, data: { id: 'ch_0123456789abc', number: 22, title: input.title, revision: 1, status: 'open', checks: [], reviews: [], conflicts: [], comments: [] } };
    });
    const answer = await handleMcp({ id: 1, method: 'tools/call', params: { name: 'create_pull_request', arguments: args } }, call, true);
    expect(answer).toMatchObject({ result: { content: expect.any(Array) } });
    expect(answer).not.toMatchObject({ result: { isError: true } });
    expect(call).toHaveBeenCalledOnce();
  });

  it('explains how task instructions and review feedback reach an agent', () => {
    const local = guide('/local-agents.md');
    expect(local).toContain('node ~/.braid/braid.mjs resume --dir DIRECTORY');
    expect(local).toContain('reread .braid/TASK.md');
    expect(local).toContain('file does not update itself');
    expect(local).toContain('Cloudflare agents read owner instructions at their next checkpoint');
    for (const path of ['/llms.txt', '/changes.md', '/local-agents.md']) {
      expect(guide(path)).toContain('list_pull_request_review_comments');
      expect(guide(path)).toContain('add_reply_to_pull_request_comment');
    }
    expect(guide('/auth.md')).toContain('only people start or resolve conversations');
    expect(guide('/auth.md')).toContain('Read and setup connections cannot reply');
    expect(guide('/changes.md')).toContain('A comment alone does not request changes or stop the merge queue');
  });
});
