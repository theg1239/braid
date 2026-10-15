import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { toolName } from '../../shared/provenance';
import type { BraidContext } from './context';

/*
 * Who is running braid. The coding tool is found by walking up the processes that started it (claude, codex,
 * cursor-agent, gemini, opencode); its version, model and session come from what the tool leaves in the environment
 * or on its own command line. BRAID_* variables, which `braid agent run` sets, always win.
 */

/** Coding tools by the executable or package they run as. */
const TOOLS: { tool: string; name: RegExp; path?: RegExp }[] = [
  { tool: 'claude-code', name: /^claude$/, path: /@anthropic-ai\/claude-code\b/ },
  { tool: 'codex', name: /^codex(?:-[\w-]+)?$/, path: /@openai\/codex\b/ },
  { tool: 'cursor', name: /^cursor-agent$/, path: /\/cursor-agent\// },
  { tool: 'gemini', name: /^gemini$/, path: /@google\/gemini-cli\b/ },
  { tool: 'opencode', name: /^opencode$/, path: /\bopencode-ai\b/ },
  { tool: 'github-copilot', name: /^copilot$/, path: /@github\/copilot\b/ },
];
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python3?)(?:\.exe)?$/;

export interface Run { tool?: string; model?: string; session?: string; parentSession?: string; agentId?: string }
/** What Braid accepts as a model, a tool (`claude-code/2.4.1`) and a session id. */
export const MODEL = /^[^\x00-\x1f\x7f]{1,120}$/;
export const TOOL = /^[A-Za-z0-9._/@+-]{1,80}$/;
export const SESSION = /^[A-Za-z0-9_-]{1,80}$/;

/** A command line's tool, and the model it was told to use, from `--model X`, `--model=X` or `-m X`. */
export function fromCommand(words: readonly string[]): Run {
  const program = words.findIndex((word, index) => index > 0 || !INTERPRETERS.test(basename(word)));
  const executable = words[program] ?? '';
  const known = TOOLS.find(entry => entry.name.test(basename(executable).replace(/\.(?:c?js|mjs|exe|cmd)$/, '')) || entry.path?.test(executable));
  if (!known) return {};
  let model: string | undefined;
  for (const [index, word] of words.entries()) {
    if (index <= program) continue;
    const inline = /^--model=(.+)$/.exec(word)?.[1];
    if (inline) { model = inline; break; }
    if ((word === '--model' || word === '-m') && words[index + 1] && !words[index + 1].startsWith('-')) { model = words[index + 1]; break; }
  }
  // Claude Code marks a context-window variant as `claude-opus-5-5[1m]`; the model is the same.
  return { tool: known.tool, ...(model ? { model: model.replace(/\[[^\]]*\]$/, '') } : {}) };
}

/** What a tool says about itself in the environment of the commands it runs. */
export function fromEnvironment(env: BraidContext['env']): Run {
  // A shared convention: AI_AGENT=claude-code_2-1-291_agent names the tool and its version.
  const declared = /^([a-z][a-z0-9-]*?)_(\d+(?:-\d+)*)(?:_|$)/.exec(env.AI_AGENT ?? '');
  const claude = env.CLAUDECODE === '1' ? /\/versions\/(\d[\w.+-]*)\/?$/.exec(env.CLAUDE_CODE_EXECPATH ?? '')?.[1] : undefined;
  const tool = declared ? `${declared[1]}/${declared[2].replaceAll('-', '.')}` : env.CLAUDECODE === '1' ? `claude-code${claude ? `/${claude}` : ''}` : undefined;
  const session = env.CLAUDECODE === '1' ? env.CLAUDE_CODE_SESSION_ID : undefined;
  return { ...(tool ? { tool } : {}), ...(session ? { session } : {}) };
}

/** The command lines of this process's ancestors, nearest first, from `ps`. Windows has no `ps`, so nothing is found there. */
function ancestors(start: number): string[][] {
  if (!start || process.platform === 'win32') return [];
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 2000 });
  if (table.status !== 0) return [];
  const processes = new Map<number, { parent: number; args: string }>();
  for (const line of table.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) processes.set(Number(match[1]), { parent: Number(match[2]), args: match[3] });
  }
  const chain: string[][] = [];
  for (let pid = start, steps = 0; pid > 1 && steps < 16; steps++) {
    const entry = processes.get(pid);
    if (!entry) break;
    chain.push(entry.args.split(/\s+/).filter(Boolean));
    pid = entry.parent;
  }
  return chain;
}

/**
 * The run braid is part of: flags first, then BRAID_* variables, then the nearest ancestor process that is a known
 * coding tool. A tool's environment is inherited by every tool it starts, so it only adds its version and session
 * when it names that same tool, or when no tool shows in the process tree.
 */
export function resolveRun(flags: Run, env: BraidContext['env'], ancestor: Run): Run {
  const hinted = fromEnvironment(env);
  const environment = !ancestor.tool || (hinted.tool && toolName(hinted.tool) === toolName(ancestor.tool)) ? hinted : {};
  // Values Braid would refuse are skipped, so one odd variable never stops a submission.
  const pick = (valid: RegExp, ...values: (string | undefined)[]) => values.map(value => value?.trim()).find(value => value && valid.test(value));
  return {
    tool: pick(TOOL, flags.tool, env.BRAID_TOOL, environment.tool ?? ancestor.tool),
    model: pick(MODEL, flags.model, env.BRAID_MODEL, ancestor.model),
    session: pick(SESSION, flags.session, env.BRAID_SESSION, environment.session, ancestor.session),
    parentSession: pick(SESSION, flags.parentSession, env.BRAID_PARENT_SESSION, ancestor.parentSession),
    agentId: pick(/^[^\x00-\x1f\x7f]{1,200}$/, env.BRAID_AGENT_ID),
  };
}

/** The run for this process, looking up the process tree only when flags and BRAID_* variables leave something out. */
export function detectRun(context: BraidContext, flags: Run = {}): Run {
  const needsChain = !(flags.tool ?? context.env.BRAID_TOOL) || !(flags.model ?? context.env.BRAID_MODEL);
  return resolveRun(flags, context.env, needsChain ? ancestors(context.parentPid).map(fromCommand).find(found => found.tool) ?? {} : {});
}

const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';
/** A new session id, `s_` and 26 characters: the time in milliseconds, then 80 random bits, so ids sort by when they began. */
export function newSession(now: number) {
  let time = '';
  for (let value = now, index = 0; index < 10; index++, value = Math.floor(value / 32)) time = BASE32[value % 32] + time;
  return `s_${time}${[...randomBytes(16)].map(byte => BASE32[byte % 32]).join('')}`;
}
