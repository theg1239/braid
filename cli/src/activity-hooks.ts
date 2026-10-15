import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as v from 'valibot';
import type { LocalActivityEvent } from '../../shared/agent-activity';
import { activityCommand, activityRelativePath, safeActivityIdentity } from '../../shared/activity-privacy';
import type { BraidContext } from './context';
import { shellCommand } from './terminal';

const hook = v.object({
  hook_event_name: v.optional(v.string()), type: v.optional(v.string()), cwd: v.optional(v.string()),
  tool_name: v.optional(v.string()), notification_type: v.optional(v.string()),
  tool_input: v.optional(v.object({ file_path: v.optional(v.string()), notebook_path: v.optional(v.string()), command: v.optional(v.string()) })),
  tool_response: v.optional(v.unknown()), error: v.optional(v.string()),
});
const result = v.object({ exit_code: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255))), exitCode: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255))) });
export const activityModel = v.pipe(v.string(), v.check(safeActivityIdentity));
const sessionModel = v.object({ hook_event_name: v.literal('SessionStart'), model: activityModel });
export function hookModel(raw: unknown): string | undefined {
  const parsed = v.safeParse(sessionModel, raw);
  return parsed.success ? parsed.output.model : undefined;
}
type Observation = Omit<LocalActivityEvent, 'id' | 'at' | 'sequence'>;

/** Resolve existing ancestors too: a symlink inside the checkout may point outside it. */
export function localPath(root: string, path: string): string {
  let target = resolve(root, path), ancestor = target;
  try {
    for (;;) {
      try { target = resolve(realpathSync(ancestor), relative(ancestor, target)); break; }
      catch { const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
    }
    const local = relative(realpathSync(root), target);
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return '[outside repository]';
    return activityRelativePath(local.split(sep).join('/'));
  } catch { return '[outside repository]'; }
}

/** Parses only known fields, discarding prompts, content, stdout, stderr and notification prose immediately. */
export function hookObservation(raw: unknown, root: string, source: 'claude-hook' | 'codex-notify'): Observation | undefined {
  const parsed = v.safeParse(hook, raw);
  if (!parsed.success) return;
  const value = parsed.output;
  if (source === 'codex-notify') return value.type === 'agent-turn-complete' ? { source, kind: 'waiting' } : undefined;
  const event = value.hook_event_name;
  if (event === 'SessionStart' || event === 'UserPromptSubmit') return { source, kind: 'working' };
  if (event === 'Stop') return { source, kind: 'waiting' }; // Stop ends a turn, not the process.
  if (event === 'Notification') return ['permission_prompt', 'idle_prompt', 'elicitation_dialog'].includes(value.notification_type ?? '') ? { source, kind: 'waiting' } : undefined;
  if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event ?? '')) return;
  const input = value.tool_input;
  if (value.tool_name === 'AskUserQuestion') return { source, kind: 'waiting' };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(value.tool_name ?? '')) return { source, kind: 'editing', ...(input?.file_path || input?.notebook_path ? { path: localPath(root, resolve(value.cwd ?? root, input.file_path ?? input.notebook_path!)) } : {}) };
  if (value.tool_name === 'Bash' && input?.command) {
    const response = v.safeParse(result, value.tool_response);
    // Numeric status comes from the tool, or its explicit failure marker, never from guessed success.
    const explicit = response.success ? response.output.exit_code ?? response.output.exitCode : undefined;
    const failure = event === 'PostToolUseFailure' ? /(?:Exit code|exit code|exited with (?:code|status))[: ]+(\d{1,3})\b/.exec(value.error ?? '') : null;
    const exitCode = explicit ?? (failure && Number(failure[1]) <= 255 ? Number(failure[1]) : undefined);
    return { source, kind: event === 'PostToolUseFailure' && exitCode === undefined ? 'failed' : 'command', command: activityCommand(input.command), ...(exitCode === undefined ? event === 'PostToolUse' ? { completed: true } : {} : { exitCode }) };
  }
  return event === 'PreToolUse' ? { source, kind: 'working' } : undefined;
}

/** Session-only configuration. No user or repository settings file is modified. */
export function installActivityHooks(context: BraidContext, command: string[], tool: string | undefined) {
  const unchanged = { command, description: 'start, exit and commits', cleanup() {} };
  if (!context.script || !['claude-code', 'codex'].includes(tool ?? '')) return unchanged;
  let folder: string | undefined;
  const cleanup = () => { try { if (folder) rmSync(folder, { recursive: true, force: true }); } catch { /* Never change the wrapped command's outcome. */ } };
  // A Node launcher needs its script before the flags; native CLIs take them after the executable.
  const offset = /^(node|nodejs|bun)(?:\.exe)?$/.test(basename(command[0])) ? 2 : 1;
  try {
    folder = mkdtempSync(join(tmpdir(), 'braid-activity-'));
    if (tool === 'codex') {
      const notify = [process.execPath, context.script, 'hook', 'activity', 'codex'];
      return { command: [...command.slice(0, offset), '-c', `notify=${JSON.stringify(notify)}`, ...command.slice(offset)], description: 'turn completion, start, exit and commits', cleanup };
    }
    const args = [...command];
    let settings: Record<string, unknown> = {};
    for (let i = offset; i < args.length; i++) {
      if (args[i] !== '--settings' && !args[i].startsWith('--settings=')) continue;
      const inline = args[i].startsWith('--settings='), supplied = inline ? args[i].slice(11) : args[i + 1];
      if (!supplied) { cleanup(); return unchanged; }
      const parsed = v.safeParse(v.record(v.string(), v.unknown()), JSON.parse(supplied.trim().startsWith('{') ? supplied : readFileSync(resolve(context.cwd, supplied), 'utf8')));
      if (!parsed.success) { cleanup(); return unchanged; }
      settings = { ...settings, ...parsed.output };
      args.splice(i, inline ? 1 : 2); i--;
    }
    const existing = v.safeParse(v.record(v.string(), v.array(v.unknown())), settings.hooks ?? {});
    if (!existing.success || settings.disableAllHooks === true || args.includes('--bare') || args.includes('--safe-mode')) { cleanup(); return unchanged; }
    const hooks = existing.output;
    for (const name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'UserPromptSubmit']) {
      hooks[name] = [...(hooks[name] ?? []), { hooks: [{ type: 'command', command: shellCommand([process.execPath, context.script, 'hook', 'activity', 'claude']), async: true }] }];
    }
    const file = join(folder, 'settings.json');
    writeFileSync(file, JSON.stringify({ ...settings, hooks }), { mode: 0o600 });
    return { command: [...args.slice(0, offset), '--settings', file, ...args.slice(offset)], description: 'steps, files, commands, waiting, exit and commits', cleanup, file };
  } catch { /* Hooks are optional: the command then runs exactly as given. */ cleanup(); return unchanged; }
}
