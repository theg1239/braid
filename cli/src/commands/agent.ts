import { buildCommand, buildRouteMap, numberParser } from '@stricli/core';
import { spawn } from 'node:child_process';
import { accessSync, constants as files, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { constants as system, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { modelName, toolBase, toolName } from '../../../shared/provenance';
import type { AgentRecord } from '../../../shared/types';
import { CliError, fail, note, print, type BraidContext } from '../context';
import { beginActivity, finishActivity, startActivityUpload } from '../activity';
import { installActivityHooks } from '../activity-hooks';
import { hasCommit, streamCommits } from '../git';
import { fromCommand, fromEnvironment, MODEL, newSession, SESSION, TOOL } from '../identity';
import { agentLabel, personLabel, provenances } from '../present';
import { findRepository, maybeConnect, openRepository } from '../repository';
import { agentRecords } from '../schemas';
import { age, columns, colours, shellCommand } from '../terminal';

export const parseModel = (value: string) => MODEL.test(value.trim()) ? value.trim() : fail('Name the model in at most 120 characters, such as claude-opus-5-5.');
export const parseTool = (value: string) => TOOL.test(value) ? value : fail('Name the tool with at most 80 letters, digits and . _ / @ + - characters, such as claude-code/2.4.1.');
export const parseSession = (value: string) => SESSION.test(value) ? value : fail('A session id has at most 80 letters, digits, _ and - characters.');

/** The post-commit hook calls `braid`; when it is not on PATH, as under `node braid.mjs`, a launcher for this file goes first on the agent's PATH. */
function launcher(context: BraidContext, env: NodeJS.ProcessEnv) {
  if (process.platform === 'win32' || !context.script) return undefined;
  const found = (env.PATH ?? '').split(delimiter).some(folder => {
    try { accessSync(join(folder || '.', 'braid'), files.X_OK); return true; } catch { return false; }
  });
  if (found) return undefined;
  const folder = mkdtempSync(join(tmpdir(), 'braid-bin-'));
  writeFileSync(join(folder, 'braid'), `#!/bin/sh\nexec ${shellCommand([process.execPath, context.script])} "$@"\n`, { mode: 0o755 });
  env.PATH = `${folder}${delimiter}${env.PATH ?? ''}`;
  return folder;
}

async function run(this: BraidContext, flags: { model?: string; tool?: string }, ...command: string[]) {
  if (!command.length) fail('Give the command to run after --, such as braid agent run -- claude.');
  const env: NodeJS.ProcessEnv = { ...this.env };
  const detected = fromCommand(command);
  const tool = flags.tool ?? detected.tool ?? env.BRAID_TOOL;
  const sameTool = !detected.tool || !env.BRAID_TOOL || toolName(env.BRAID_TOOL) === toolName(detected.tool);
  const model = flags.model ?? detected.model ?? (detected.tool === 'claude-code' ? env.ANTHROPIC_MODEL : undefined) ?? (sameTool ? env.BRAID_MODEL : undefined);
  const parent = [env.BRAID_SESSION, fromEnvironment(this.env).session].find(value => value && SESSION.test(value));
  const agentId = env.BRAID_AGENT_ID;
  // Flags were checked as they were parsed; detected and inherited values that would not be accepted are left out.
  const values = { BRAID_MODEL: model && MODEL.test(model.trim()) ? model.trim() : undefined, BRAID_TOOL: tool && TOOL.test(tool) ? tool : undefined, BRAID_SESSION: newSession(this.now()), BRAID_PARENT_SESSION: parent, BRAID_AGENT_ID: agentId };
  for (const [key, value] of Object.entries(values)) if (value) env[key] = value; else delete env[key];
  delete env.BRAID_AGENT;
  const folder = launcher(this, env);
  let activity: ReturnType<typeof beginActivity> | undefined;
  let reportingError: string | undefined;
  try {
    const repository = findRepository(this);
    if (repository) activity = beginActivity(this, repository, values.BRAID_SESSION, values.BRAID_MODEL, values.BRAID_TOOL);
  } catch (error) { reportingError = error instanceof CliError ? error.message : 'Activity could not be queued. Check local Braid file permissions.'; }
  const hooks = activity ? installActivityHooks(this, command, detected.tool) : { command, description: 'start, exit and commits', cleanup() {} };
  if (activity) {
    env.BRAID_ACTIVITY_DIR = activity.folder;
    startActivityUpload(this, activity.run.root);
    note(this, `Braid · ${activity.run.origin} / ${activity.run.workspaceId} · ${model ? modelName(model) : tool ? toolName(tool) : 'local agent'} · reporting ${hooks.description}${activity.run.changeNumber ? ` · ${activity.run.changeUrl ?? `${activity.run.origin}/pull/${activity.run.changeNumber}?workspace=${activity.run.workspaceId}`}` : ''}${activity.error ? ` · ${activity.error} Work continues; events are queued.` : ''}`);
  } else {
    delete env.BRAID_ACTIVITY_DIR;
    note(this, `Braid · activity disconnected · ${reportingError ?? 'Run braid login, then braid init to report activity.'} Work continues.`);
  }
  const child = spawn(hooks.command[0], hooks.command.slice(1), { cwd: this.cwd, stdio: 'inherit', env });
  // An interrupt from the terminal reaches the agent directly; braid waits for it, and passes on what only braid got.
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, () => { if (signal !== 'SIGINT') child.kill(signal); }] as const);
  for (const [signal, handler] of handlers) this.signals.on(signal, handler);
  let exitCode = 1;
  try {
    this.process.exitCode = exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new CliError(`${command[0]} was not found on PATH.`) : error));
      child.once('exit', (code, signal) => resolve(code ?? 128 + (signal ? system.signals[signal] ?? 0 : 0)));
    });
  } finally {
    if (activity) {
      try { finishActivity(activity.folder, exitCode, this.now()); startActivityUpload(this, activity.run.root); } catch { /* Preserve the coding tool's exit status. */ }
    }
    hooks.cleanup();
    for (const [signal, handler] of handlers) this.signals.off(signal, handler);
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
}

/** One agent in the history; models are kept by display name, as their raw id when any commit's note gives it. */
interface Seen { name: string; owner: string; models: Map<string, string>; tools: Set<string>; sessions: Set<string>; commits: number; last: string }

/** The agents in this repository's recent history, by model and owner, and Braid's roster for it when Braid has one. */
async function list(this: BraidContext, flags: { json?: boolean; limit: number }) {
  const repository = openRepository(this), { root } = repository;
  const commits = [];
  if (hasCommit(this, root, 'HEAD')) for await (const commit of streamCommits(this, root, ['-n', String(flags.limit), 'HEAD'])) commits.push(commit);
  const seen = new Map<string, Seen>();
  for (const provenance of provenances(this, root, commits)) {
    if (provenance.kind !== 'agent' || !provenance.agent) continue;
    const name = agentLabel(provenance.agent), owner = personLabel(provenance.owner), key = `${name}\0${owner}`;
    const entry = seen.get(key) ?? { name, owner, models: new Map(), tools: new Set(), sessions: new Set(), commits: 0, last: provenance.at };
    entry.commits++;
    const model = provenance.agent.model, display = model && modelName(model);
    if (model && display && (!entry.models.has(display) || model !== display)) entry.models.set(display, model);
    if (provenance.agent.tool) entry.tools.add(provenance.agent.tool);
    if (provenance.agent.session) entry.sessions.add(provenance.agent.session);
    if (provenance.at > entry.last) entry.last = provenance.at;
    seen.set(key, entry);
  }
  const local = [...seen.values()].sort((a, b) => b.last.localeCompare(a.last));
  for (const entry of local) {
    const versioned = new Set([...entry.tools].filter(tool => tool !== toolBase(tool)).map(toolBase));
    for (const base of versioned) entry.tools.delete(base);
  }
  let roster: AgentRecord[] | undefined;
  const braid = maybeConnect(this, repository);
  // Braid's roster is extra: offline, or from a Braid without it, the local history stands alone.
  if (braid) try { roster = await braid.get('/api/agents', agentRecords); } catch (error) { if (!(error instanceof CliError)) throw error; }
  const origin = braid?.origin ?? '';
  if (flags.json) {
    print(this, JSON.stringify({ local: local.map(entry => ({ ...entry, models: [...entry.models.values()], tools: [...entry.tools], sessions: entry.sessions.size })), braid: roster ?? null }, null, 2));
    return;
  }
  const paint = colours(this), now = this.now();
  if (!local.length && !roster?.length) { print(this, `No agents in the last ${flags.limit} commits.`); return; }
  if (local.length) {
    const rows = [['Agent', 'Owner', 'Commits', 'Runs', 'Last', 'Tools'], ...local.map(entry => [entry.name, entry.owner, String(entry.commits), entry.sessions.size ? String(entry.sessions.size) : '', age(entry.last, now), [...entry.tools].join(', ')])];
    for (const row of columns(rows, (cell, column, index) => index === 0 ? paint.dim(cell) : column === 0 ? paint.cyan(cell) : column === 1 ? paint.dim(cell) : cell)) print(this, row);
  }
  if (roster?.length) {
    print(this);
    print(this, paint.bold(`On ${origin}`));
    const rows = [['Agent', 'Owner', 'Landed', 'Sent back', 'Reverted', 'Lines alive', 'Models'],
      ...roster.map(record => [`${record.name}${record.simulated ? ' (simulated)' : ''}`, personLabel(record.owner), String(record.changes.landed), String(record.changes.sentBack), String(record.changes.reverted), record.lines.added ? `${record.lines.alive}/${record.lines.added}` : '', record.models.join(', ')])];
    for (const row of columns(rows, (cell, column, index) => index === 0 ? paint.dim(cell) : column === 0 ? paint.cyan(cell) : cell)) print(this, row);
  }
}

const runCommand = buildCommand({
  func: run,
  parameters: {
    flags: {
      model: { kind: 'parsed', parse: parseModel, brief: 'Model id, such as claude-opus-5-5; read from the command\'s own --model when not given', placeholder: 'id', optional: true },
      tool: { kind: 'parsed', parse: parseTool, brief: 'Tool and version, such as claude-code/2.4.1; detected from the command when not given', placeholder: 'name', optional: true },
    },
    positional: { kind: 'array', parameter: { brief: 'The coding tool to run and its arguments, after --', parse: String, placeholder: 'command' } },
  },
  docs: {
    brief: 'Run a coding tool as an agent',
    customUsage: [{ input: '[--model id] [--tool name] -- <command...>', brief: 'For example: braid agent run -- claude --model claude-opus-5-5' }],
    fullDescription: 'Runs the command with its model, tool and a new session. Claude Code hooks report tool activity; Codex notify reports turn completion. Other tools report start, exit and commits only. Events queue locally while offline; braid status shows the backlog. With the post-commit hook from braid init, each commit carries the run in a refs/notes/braid note. Exits with the command\'s exit code.',
  },
});

const listCommand = buildCommand({
  func: list,
  parameters: {
    flags: {
      json: { kind: 'boolean', brief: 'Print JSON', optional: true },
      limit: { kind: 'parsed', parse: numberParser, brief: 'How many recent commits to read', placeholder: 'n', default: '2000' },
    },
    aliases: { n: 'limit' },
  },
  docs: { brief: 'List the agents in recent commits, and on Braid' },
});

export const agentRoutes = buildRouteMap({
  routes: { run: runCommand, list: listCommand },
  docs: { brief: 'Run coding tools as agents, and see which ones wrote this repository' },
});
