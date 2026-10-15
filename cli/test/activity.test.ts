import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activityCommand } from '../../shared/activity-privacy';
import { hookModel, hookObservation, installActivityHooks, localPath } from '../src/activity-hooks';
import { activityStatus, attachActivity, beginActivity, finishActivity, flushActivity, queueActivity, recordActivityHook, uploadActivity } from '../src/activity';
import { saveCredentials, writeLink } from '../src/config';
import { branchFiles, writeState } from '../src/repository';
import { braid, cleanup, repository, server, testContext } from './helpers';

afterEach(cleanup);
const origin = 'https://braid.example';
function connected() {
  const repo = repository();
  writeLink(repo.root, { url: origin, workspaceId: 'ws_local' });
  saveCredentials(repo.env, { origin, workspaceId: 'ws_local', accessToken: 'braid_agent_old', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  return { ...repo, link: { url: origin, workspaceId: 'ws_local' } };
}
const names = (folder: string) => readdirSync(folder).filter(name => name.startsWith('event-'));

describe('session activity hooks', () => {
  it('installs async Claude hooks for this session, preserves supplied settings, and cleans up', () => {
    const repo = repository(), { context } = testContext({ cwd: repo.root, env: repo.env });
    const original = join(repo.root, 'settings.json');
    const settings = { permissions: { deny: ['Bash(rm *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-person' }] }] } };
    writeFileSync(original, JSON.stringify(settings));
    const hooks = installActivityHooks({ ...context, script: '/private/braid.mjs' }, ['claude', '--settings', original, '-p', 'private prompt'], 'claude-code');
    const file = hooks.command[2], installed = JSON.parse(readFileSync(file, 'utf8'));
    expect(installed.permissions).toEqual(settings.permissions);
    for (const name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SessionStart']) expect(installed.hooks[name].at(-1).hooks[0]).toMatchObject({ type: 'command', async: true });
    expect(installed.hooks.Stop[0]).toEqual(settings.hooks.Stop[0]);
    expect(readFileSync(original, 'utf8')).toBe(JSON.stringify(settings));
    hooks.cleanup();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(original, 'utf8')).toBe(JSON.stringify(settings));
  });
  it('uses a Codex command-line notify override without modifying persistent configuration', () => {
    const repo = repository(), { context } = testContext({ cwd: repo.root, env: repo.env });
    const hooks = installActivityHooks({ ...context, script: '/private/braid.mjs' }, ['codex', '--model', 'gpt-6'], 'codex');
    expect(hooks.command.slice(0, 2)).toEqual(['codex', '-c']);
    expect(hooks.command[2]).toContain('notify=');
    expect(hookObservation({ type: 'agent-turn-complete', 'last-assistant-message': 'SECRET' }, repo.root, 'codex-notify')).toEqual({ source: 'codex-notify', kind: 'waiting' });
    expect(hookObservation({ type: 'made-up' }, repo.root, 'codex-notify')).toBeUndefined();
    hooks.cleanup();
  });
  it('reports only known tool observations, numeric exit status and repo-relative paths', () => {
    const repo = repository();
    expect(hookObservation({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo.root, 'src/a.ts'), old_string: 'secret', new_string: 'secret' } }, repo.root, 'claude-hook')).toEqual({ source: 'claude-hook', kind: 'editing', path: 'src/a.ts' });
    expect(hookObservation({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'API_KEY=secret npm test --token private' }, tool_response: { stdout: 'SECRET', stderr: 'SECRET', exit_code: 1 } }, repo.root, 'claude-hook')).toEqual({ source: 'claude-hook', kind: 'command', command: 'npm test', exitCode: 1 });
    expect(hookObservation({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 2\nprivate output' }, repo.root, 'claude-hook')).toMatchObject({ exitCode: 2 });
    expect(hookObservation({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'private' }, repo.root, 'claude-hook')).toEqual({ source: 'claude-hook', kind: 'waiting' });
    expect(hookObservation({ hook_event_name: 'Stop' }, repo.root, 'claude-hook')).toEqual({ source: 'claude-hook', kind: 'waiting' });
    expect(hookObservation({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'passed' } }, repo.root, 'claude-hook')).toMatchObject({ completed: true });
    expect(hookObservation({ hook_event_name: 'PreToolUse', cwd: join(repo.root, 'src'), tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }, repo.root, 'claude-hook')).toMatchObject({ path: 'src/a.ts' });
    expect(hookModel({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5', transcript_path: '/private' })).toBe('claude-opus-5-5');
    expect(hookModel({ hook_event_name: 'SessionStart', model: '/Users/private' })).toBeUndefined();
  });
  it('redacts outside paths, symlink escapes, assignments, scripts and command arguments', () => {
    const repo = repository();
    symlinkSync(repo.home, join(repo.root, 'outside'));
    for (const path of ['/etc/passwd', '../private', 'outside/secret', '~/.ssh/key']) expect(localPath(repo.root, path)).toBe('[outside repository]');
    expect(activityCommand('node -e "console.log(process.env.SECRET)"')).toBe('node [arguments omitted]');
    expect(activityCommand('curl -H "Authorization: Bearer secret" https://private.example')).toBe('curl [arguments omitted]');
    expect(activityCommand('echo mySecret')).toBe('[command omitted]');
  });
});

describe('durable local activity', () => {
  it('caps a batch at 40, rate limits sends, and deletes only acknowledged files', async () => {
    const repo = connected(); let now = Date.now();
    const remote = server({ 'POST /api/local-activity': request => Response.json({ accepted: (request.body as { events: { id: string }[] }).events.map(e => e.id) }) });
    const { context } = testContext({ cwd: repo.root, env: repo.env, fetch: remote.fetch, now: () => now });
    const { folder } = beginActivity(context, repo, 's_batch');
    for (let i = 0; i < 44; i++) queueActivity(folder, { source: 'claude-hook', kind: 'working' }, now + i);
    await flushActivity(context, folder);
    expect((remote.sent[0].body as { events: unknown[] }).events).toHaveLength(40);
    expect(remote.sent[0].headers.authorization).toBe('Bearer braid_agent_old');
    expect(names(folder)).toHaveLength(5);
    await flushActivity(context, folder);
    expect(remote.sent).toHaveLength(1);
    now += 2000; await flushActivity(context, folder);
    expect(names(folder)).toHaveLength(0);
  });
  it('retries uncertain batches with identical event IDs, obeys backoff and reconnects without losing events', async () => {
    const repo = connected(); let now = Date.now();
    const remote = server({ 'POST /api/local-activity': [() => new Response(null, { status: 429, headers: { 'retry-after': '12' } }), request => Response.json({ accepted: (request.body as { events: { id: string }[] }).events.map(e => e.id) })] });
    const { context } = testContext({ cwd: repo.root, env: repo.env, fetch: remote.fetch, now: () => now });
    const { folder } = beginActivity(context, repo, 's_retry');
    await flushActivity(context, folder);
    expect(names(folder)).toHaveLength(1);
    now += 11_000; await flushActivity(context, folder);
    expect(remote.sent).toHaveLength(1);
    saveCredentials(repo.env, { origin, workspaceId: 'ws_local', accessToken: 'braid_agent_new', expiresAt: new Date(now + 86_400_000).toISOString() });
    now += 1000; await flushActivity(context, folder);
    expect(remote.sent[1].headers.authorization).toBe('Bearer braid_agent_new');
    expect((remote.sent[1].body as { events: unknown[] }).events).toEqual((remote.sent[0].body as { events: unknown[] }).events);
    expect(names(folder)).toHaveLength(0);
  });
  it('bounds UTF-8 payload bytes when repository paths contain multibyte characters', async () => {
    const repo = connected();
    const remote = server({ 'POST /api/local-activity': request => Response.json({ accepted: (request.body as { events: { id: string }[] }).events.map(e => e.id) }) });
    const { context } = testContext({ cwd: repo.root, env: repo.env, fetch: remote.fetch });
    const { folder } = beginActivity(context, repo, 's_unicode');
    for (let i = 0; i < 40; i++) queueActivity(folder, { source: 'claude-hook', kind: 'editing', path: '界'.repeat(240) });
    await flushActivity(context, folder);
    expect(Buffer.byteLength(JSON.stringify(remote.sent[0].body))).toBeLessThan(32_768);
    expect(names(folder).length).toBeGreaterThan(1);
  });
  it('keeps reporting long sessions and exits the sender after the final event is acknowledged', async () => {
    const repo = connected(); let now = Date.now(), sleeps = 0;
    const remote = server({ 'POST /api/local-activity': request => Response.json({ accepted: (request.body as { events: { id: string }[] }).events.map(e => e.id) }) });
    const { context } = testContext({ cwd: repo.root, env: repo.env, fetch: remote.fetch, now: () => now });
    const { folder } = beginActivity(context, repo, 's_long');
    const sleeping = { ...context, sleep: async () => { now += 7 * 60 * 60_000; if (++sleeps === 2) finishActivity(folder, 0, now); } };
    await uploadActivity(sleeping, repo.root);
    expect(sleeps).toBe(2);
    expect(names(folder)).toHaveLength(0);
    expect(existsSync(join(folder, '..', 'upload.lock'))).toBe(false);
    expect((remote.sent.at(-1)!.body as { events: { kind: string }[] }).events.at(-1)?.kind).toBe('finished');
  });
  it('keeps failed deliveries, gives actionable status even before a pull request, and never stores credentials', async () => {
    const repo = connected();
    const { context } = testContext({ cwd: repo.root, env: repo.env, fetch: async () => new Response(null, { status: 401 }) });
    const { folder } = beginActivity(context, repo, 's_expired');
    await flushActivity(context, folder);
    expect(activityStatus(context, repo)).toMatchObject({ queued: 1, lastError: expect.stringContaining('run braid login') });
    const result = await braid(['status'], { cwd: repo.root, env: repo.env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Queued activity: 1');
    expect(result.stdout).toContain('Token expiry:');
    for (const name of readdirSync(folder)) expect(readFileSync(join(folder, name), 'utf8')).not.toContain('braid_agent_old');
  });
  it('attaches a completed run when its branch submits later', async () => {
    const repo = connected(), { context } = testContext({ cwd: repo.root, env: repo.env });
    const { folder } = beginActivity(context, repo, 's_submit');
    finishActivity(folder, 3);
    attachActivity(context, repo.root, origin, 'ws_local', { id: 'ch_0123456789abc', number: 12 });
    expect(JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8'))).toMatchObject({ closed: true, changeId: 'ch_0123456789abc', changeNumber: 12 });
    expect(names(folder).map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')))).toContainEqual(expect.objectContaining({ source: 'process', kind: 'failed', exitCode: 3 }));
  });
  it('keeps the canonical pull request link and the model reported by the real session', async () => {
    const repo = connected();
    const remote = server({ 'POST /api/local-activity': request => Response.json({ accepted: (request.body as { events: { id: string }[] }).events.map(e => e.id) }) });
    const { context } = testContext({ cwd: repo.root, env: repo.env, fetch: remote.fetch });
    writeState(branchFiles(context, repo.root), { origin, workspaceId: 'ws_local', base: 'a'.repeat(40), change: { id: 'ch_0123456789abc', number: 12, revision: 1, status: 'open', html_url: `${origin}/owner/repo/pull/12` } });
    const { folder, run } = beginActivity(context, repo, 's_model');
    expect(run.changeUrl).toBe(`${origin}/owner/repo/pull/12`);
    await recordActivityHook({ ...context, env: { ...context.env, BRAID_ACTIVITY_DIR: folder } }, 'claude', JSON.stringify({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5', transcript_path: '/private' }));
    await flushActivity(context, folder);
    expect(remote.sent[0].body).toMatchObject({ model: 'claude-opus-5-5' });
    expect(JSON.stringify(remote.sent[0].body)).not.toContain('/private');
  });
  it('names the remote fix and does not report to the wrong repository', () => {
    const repo = connected(), { context } = testContext({ cwd: repo.root, env: repo.env });
    repo.git(['remote', 'add', 'braid', 'https://wrong.example/git/another.git']);
    expect(() => beginActivity(context, repo, 's_wrong')).toThrow('git remote set-url braid https://braid.example/git/ws_local.git');
  });
  it('ignores damaged hooks and keeps only redacted observations', async () => {
    const repo = connected(), { context } = testContext({ cwd: repo.root, env: repo.env });
    const { folder } = beginActivity(context, repo, 's_hook');
    const hooked = { ...context, env: { ...repo.env, BRAID_ACTIVITY_DIR: folder } };
    await recordActivityHook(hooked, 'claude', 'bad json');
    await recordActivityHook(hooked, 'claude', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node -e SECRET' } }));
    expect(names(folder)).toHaveLength(2);
    expect(names(folder).map(name => readFileSync(join(folder, name), 'utf8')).join('')).not.toContain('SECRET');
  });
});
