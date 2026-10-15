import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { repositoryInspection, SandboxCheckError } from './preparation';
import { runAgentLoop, type SandboxTask } from './loop';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = readFileSync(new URL('../../sandbox/inspect.py', import.meta.url), 'utf8');
function inspect(files: Record<string, string>, link?: string) {
  const root = mkdtempSync(join(tmpdir(), 'braid-manifests-')); roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  if (link) symlinkSync(link, join(root, 'package.json'));
  execFileSync('git', ['add', '.'], { cwd: root });
  return v.parse(repositoryInspection, JSON.parse(execFileSync('python3', ['-I', '-c', source, 'go'], { cwd: root, encoding: 'utf8', timeout: 30_000 })));
}

describe('real repository manifest parsers', () => {
  it.each([['npm', 'package-lock.json'], ['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lock']])('reads %s scripts and package-manager declarations without choosing commands', (manager, lock) => {
    const pkg = { packageManager: `${manager}@1.0.0`, engines: { node: '>=22' }, scripts: { verify: 'node --test', build: 'node build.mjs' }, workspaces: ['packages/*'] };
    const data = inspect({ 'package.json': JSON.stringify(pkg), [lock]: '', 'packages/web/package.json': '{"scripts":{"check":"node check.mjs"}}' });
    expect(data.manifests).toContainEqual({ path: 'package.json', data: pkg });
    expect(data.manifests).toContainEqual({ path: 'packages/web/package.json', data: { scripts: { check: 'node check.mjs' } } });
    expect(data.lockfiles).toEqual([lock]); expect(data).not.toHaveProperty('setup');
  });
  it('keeps pip requirements as declarations and leaves installation to the agent', () => {
    expect(inspect({ 'requirements.txt': 'requests==2.32.5\n-r requirements/dev.txt\n', '.python-version': '3.13' }).manifests).toEqual([
      { path: '.python-version', text: '3.13' }, { path: 'requirements.txt', text: 'requests==2.32.5\n-r requirements/dev.txt\n' },
    ]);
  });
  it.each(['uv', 'poetry'])('parses %s TOML tables, quoted keys and multiline values', manager => {
    const data = inspect({ 'pyproject.toml': `[project]\n"requires-python" = ">=3.12"\ndependencies = [\n "requests>=2",\n]\n[tool.${manager}]\npackage-mode = false\n[tool.poetry.dependencies]\npython = "^3.12"\n[tool.example]\nrequires-python = "NOT A RUNTIME"\n`, [`${manager}.lock`]: '' });
    expect(data.manifests[0].data).toMatchObject({ project: { 'requires-python': '>=3.12', dependencies: ['requests>=2'] }, tool: { poetry: { dependencies: { python: '^3.12' } } } });
    expect(data.lockfiles).toEqual([`${manager}.lock`]);
  });
  it('uses Go’s parser for modules and workspaces, including comments and toolchains', () => {
    const data = inspect({ 'go.mod': 'module example.com/fixture\n\ngo 1.24.0 // version\ntoolchain go1.24.1\nrequire (\n example.com/dep v1.0.0 // indirect\n)\n', 'go.work': 'go 1.24.0\nuse (\n .\n ./nested\n)\n' });
    expect(data.manifests[0].data).toMatchObject({ Module: { Path: 'example.com/fixture' }, Go: '1.24.0', Toolchain: 'go1.24.1', Require: [{ Path: 'example.com/dep', Version: 'v1.0.0', Indirect: true }] });
    expect(data.manifests[1].data).toMatchObject({ Go: '1.24.0', Use: [{ DiskPath: '.' }, { DiskPath: './nested' }] });
  });
  it('parses Rust workspace declarations and member manifests', () => {
    const data = inspect({ 'Cargo.toml': '[workspace]\nmembers = ["crates/api"]\n[workspace.package]\nrust-version = "1.85"\n', 'crates/api/Cargo.toml': '[package]\nname="api"\nversion="0.1.0"\nrust-version.workspace = true\n', 'Cargo.lock': '' });
    expect(data.manifests[0].data).toEqual({ workspace: { members: ['crates/api'], package: { 'rust-version': '1.85' } } });
    expect(data.manifests[1].data).toMatchObject({ package: { 'rust-version': { workspace: true } } });
    expect(data.lockfiles).toEqual(['Cargo.lock']);
  });
  it('inventories a mixed monorepo including nested instructions without guessing one root package manager', () => {
    const data = inspect({ 'apps/web/package.json': '{"scripts":{"test":"node --test"}}', 'services/api/pyproject.toml': '[project]\nrequires-python=">=3.12"', 'services/api/AGENTS.md': 'Use uv.', 'README.md': 'Workspace instructions.', '.github/workflows/ci.yml': 'name: CI' });
    expect(data.manifests.map(m => m.path)).toEqual(['apps/web/package.json', 'services/api/pyproject.toml']);
    expect(data.instructions).toEqual(['.github/workflows/ci.yml', 'README.md', 'services/api/AGENTS.md']);
  });
  it.each<Record<string, string>>([{ 'index.html': '<title>Static site</title>' }, { 'package.json': '{"name":"no-tests"}', 'README.md': 'Documentation only' }])('permits a repository without declared tests: %j', files => {
    const data = inspect(files); expect(data.manifests.every(m => !m.error)).toBe(true); expect(data).not.toHaveProperty('checks');
  });
  it('reports malformed manifests and refuses symlink reads explicitly', () => {
    expect(inspect({ 'pyproject.toml': '[project\n', 'Cargo.toml': '[package]\nversion = nope' }).manifests.every(m => m.error === 'invalid_manifest')).toBe(true);
    expect(inspect({}, '/etc/passwd').manifests).toEqual([{ path: 'package.json', error: 'not_regular_file' }]);
  });
  it('preserves valid TOML timestamps and special numbers as explicit JSON facts', () => {
    expect(inspect({ 'pyproject.toml': '[tool.example]\nreleased=2026-10-14T12:30:00Z\nday=2026-10-14\nlimit=inf\nmissing=nan\n' }).manifests[0].data)
      .toEqual({ tool: { example: { released: '2026-10-14T12:30:00+00:00', day: '2026-10-14', limit: 'inf', missing: 'nan' } } });
  });
  it('bounds a large monorepo inventory and tells the model that more manifests remain', () => {
    const files = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`packages/${index}/package.json`, JSON.stringify({ scripts: { check: 'node check.cjs' } })]));
    const data = inspect(files);
    expect(data.manifests).toHaveLength(256); expect(data.omitted).toBe(44);
    expect(JSON.stringify(data).length).toBeLessThan(48 * 1024);
  });
});

const task: SandboxTask = { workspaceId: 'w', missionId: 'm', agentId: 'a', repo: 'r', remote: '', baseCommit: 'a'.repeat(40), model: 'fixture', title: 'Update docs', intent: 'Clarify usage', role: 'Coding agent', task: 'Update docs', scope: ['*'], context: [], repository: { manifests: [], lockfiles: [], instructions: ['README.md'] } };
const call = (name: string, args: unknown) => ({ choices: [{ message: { tool_calls: [{ id: name, function: { name, arguments: JSON.stringify(args) } }] } }] });
const plan = { decision: 'This repository contains a static page; use a focused HTML check.', sources: ['README.md', 'index.html'], setup: [], checks: ['node check.mjs'] };
const finish = call('finish', { summary: 'Updated docs', rationale: 'Clarifies usage.' });
const result = { stdout: '', stderr: '', exitCode: 0, truncated: false };
it('requires and persists the model’s preparation decision, including its no-tests reason', async () => {
  const ai = { run: vi.fn().mockResolvedValueOnce(call('exec', { command: 'cat README.md', purpose: 'work', timeout: 10 })).mockResolvedValueOnce(finish)
    .mockResolvedValueOnce(call('prepare', { ...plan, checks: [], noTestsReason: 'Only documentation exists; there is no test runner.' })).mockResolvedValueOnce(finish) };
  const save = vi.fn(), checkpoint = vi.fn(async () => {}), collect = vi.fn(async (_id?: string, _checks?: string[]) => [{ path: 'README.md', content: 'Updated' }]);
  const output = await runAgentLoop(task, ai as unknown as Ai, { exec: async () => result, collect, checkpoint, save }, Date.now() + 60_000);
  expect(collect).toHaveBeenCalledTimes(1); expect(save.mock.lastCall![0].preparation).toMatchObject({ sources: ['README.md', 'index.html'], noTestsReason: expect.stringContaining('no test runner') });
  expect(output.rationale).toContain('Environment decision:'); expect(output.checks).toEqual([{ kind: 'runtime', label: 'Runtime checks', status: 'warning', detail: expect.stringContaining('No test execution is claimed') }]);
  expect(checkpoint).toHaveBeenCalledWith(expect.stringContaining('Environment plan:'));
});
it('returns a short command timeout to the agent while task time remains', async () => {
  const ai = { run: vi.fn().mockResolvedValueOnce(call('prepare', plan)).mockResolvedValueOnce(call('exec', { command: 'node check.mjs', purpose: 'check', timeout: 1 }))
    .mockResolvedValueOnce(call('exec', { command: 'node check.mjs', purpose: 'check', timeout: 30 })).mockResolvedValueOnce(finish) };
  const exec = vi.fn().mockResolvedValueOnce({ ...result, exitCode: 124, timedOut: true }).mockResolvedValue(result);
  const output = await runAgentLoop(task, ai as unknown as Ai, { exec, collect: async () => [{ path: 'README.md', content: 'Updated' }], checkpoint: async () => {} }, Date.now() + 60_000);
  expect(exec).toHaveBeenCalledTimes(2); expect(output.checks[0].status).toBe('passed');
});
it('accepts an explicit long installation timeout while preserving the overall task deadline', async () => {
  const ai = { run: vi.fn().mockResolvedValueOnce(call('prepare', plan)).mockResolvedValueOnce(call('exec', { command: 'mise use -g rust@1.89.0', purpose: 'setup', timeout: 600 })).mockResolvedValueOnce(finish) };
  const exec = vi.fn(async () => result), deadline = Date.now() + 500_000;
  await runAgentLoop(task, ai as unknown as Ai, { exec, collect: async () => [{ path: 'README.md', content: 'Updated' }], checkpoint: async () => {} }, deadline);
  expect(exec).toHaveBeenCalledWith('mise use -g rust@1.89.0', expect.any(Number), expect.any(String));
  const duration = (exec.mock.calls as unknown as [string, number][])[0][1];
  expect(duration).toBeGreaterThan(180_000); expect(duration).toBeLessThanOrEqual(500_000);
});
it('lets the agent repair final verification without publishing the failing checkout', async () => {
  const ai = { run: vi.fn().mockResolvedValueOnce(call('prepare', plan)).mockResolvedValueOnce(call('exec', { command: 'edit', purpose: 'work', timeout: 10 })).mockResolvedValueOnce(finish)
    .mockResolvedValueOnce(call('exec', { command: 'repair', purpose: 'work', timeout: 10 })).mockResolvedValueOnce(finish) };
  const collect = vi.fn(async (_id?: string, _checks?: string[]) => [{ path: 'README.md', content: 'Updated' }]).mockRejectedValueOnce(new SandboxCheckError([{ label: 'node check.mjs', status: 'failed', detail: 'Expected heading' }], 'node check.mjs', 1, 'Expected heading'));
  await runAgentLoop(task, ai as unknown as Ai, { exec: async () => result, collect, checkpoint: async () => {} }, Date.now() + 60_000);
  expect(collect).toHaveBeenCalledTimes(2); expect(collect.mock.calls[0][1]).toEqual(['node check.mjs']);
  expect(JSON.stringify(ai.run.mock.calls[3])).toContain('Verification failed on the final checkout');
});
it('records a corrected invocation and verifies the replacement instead of trapping the agent on an obsolete command', async () => {
  const initial = { ...plan, checks: ['pytest'], sources: ['pyproject.toml'] };
  const corrected = { ...initial, decision: 'pyproject.toml uses uv; the bare pytest command has no project environment. Run it through uv.', checks: ['uv run pytest'] };
  const ai = { run: vi.fn().mockResolvedValueOnce(call('prepare', initial)).mockResolvedValueOnce(call('exec', { command: 'pytest', purpose: 'check', timeout: 10 }))
    .mockResolvedValueOnce(call('prepare', corrected)).mockResolvedValueOnce(call('exec', { command: 'uv run pytest', purpose: 'check', timeout: 10 })).mockResolvedValueOnce(finish) };
  const exec = vi.fn().mockResolvedValueOnce({ ...result, exitCode: 127 }).mockResolvedValue(result), collect = vi.fn(async (_id?: string, _checks?: string[]) => [{ path: 'README.md', content: 'Updated' }]);
  const output = await runAgentLoop(task, ai as unknown as Ai, { exec, collect, checkpoint: async () => {} }, Date.now() + 60_000);
  expect(collect.mock.calls[0][1]).toEqual(['uv run pytest']);
  expect(output.checks).toEqual([expect.objectContaining({ label: 'uv run pytest', status: 'passed' })]);
  expect(output.rationale).toContain(corrected.decision);
});
