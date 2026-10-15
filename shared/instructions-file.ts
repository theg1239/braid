import * as v from 'valibot';
import { INSTRUCTIONS_PATH } from './policy';
import type { Instruction } from './types';

// The paths live in policy.ts, which screens import without this file's Valibot schemas.
export { AGENTS_PATH, INSTRUCTIONS_PATH } from './policy';
/** Braid's section of AGENTS.md lies between these markers. */
const START = '<!-- braid:instructions:start -->', END = '<!-- braid:instructions:end -->';
/** At most 100 instructions of 500 characters, each blocking up to 8 strings of 60 characters in up to 10 path patterns. */
const INSTRUCTION_LIMITS = { count: 100, text: 500, block: 8, blocked: 60, paths: 10 };

const TEXT = 'Write the instruction in 1–500 characters.';
const BLOCK = 'Block up to 8 strings of 1–60 characters, each on one line.';
const PATHS = 'Limit an instruction to up to 10 path patterns such as src/**.';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** What every agent should do, as one line. */
export const instructionText = v.pipe(v.string(TEXT), v.transform(text => text.replace(/\s+/g, ' ').trim()), v.nonEmpty(TEXT), v.maxLength(INSTRUCTION_LIMITS.text, TEXT));
/** Strings a change may not add, matched exactly as written; an empty list blocks nothing. */
export const blockedStrings = v.pipe(
  v.array(v.pipe(v.string(BLOCK), v.maxLength(INSTRUCTION_LIMITS.blocked, BLOCK), v.check(value => value.trim() !== '' && !/[\x00-\x08\x0a-\x1f\x7f]/.test(value), BLOCK)), BLOCK),
  v.maxLength(INSTRUCTION_LIMITS.block, BLOCK), v.transform(list => list.length ? list : undefined));
/** The files an instruction covers, matched as policy rules match paths; an empty list covers every file. */
export const instructionPaths = v.pipe(
  v.array(v.pipe(v.string(PATHS), v.trim(), v.nonEmpty(PATHS), v.maxLength(200, PATHS), v.check(value => !/[\x00-\x1f\x7f]/.test(value), PATHS)), PATHS),
  v.maxLength(INSTRUCTION_LIMITS.paths, PATHS), v.transform(list => list.length ? list : undefined));

const listed = v.pipe(v.string(), v.parseJson(), v.looseObject({ instructions: v.array(v.unknown()) }));
const entry = (label: string, errors: string[]) => v.object({
  id: v.pipe(v.string(), v.regex(SLUG)),
  text: instructionText,
  block: v.optional(v.fallback(v.optional(blockedStrings), () => { errors.push(`${label}.block must list up to 8 strings of 1–60 characters, each on one line.`); return undefined; })),
  paths: v.optional(v.fallback(v.optional(instructionPaths), () => { errors.push(`${label}.paths must list up to 10 path patterns, so it covers every file until fixed.`); return undefined; })),
});

/**
 * Reads `.braid/instructions.json`, `{"instructions": [...]}`. An instruction
 * without a valid id or text is left out; invalid blocked strings or paths are
 * dropped from the instruction that has them, so its paths widen to every
 * file rather than narrow. Each problem is reported in `errors`, and a file
 * that is not such JSON applies no instructions until it is fixed.
 */
export function parseInstructions(text: string | null): { instructions: Instruction[]; errors: string[] } {
  if (text === null) return { instructions: [], errors: [] };
  const file = v.safeParse(listed, text);
  if (!file.success) return { instructions: [], errors: ['The instructions file must be JSON with an "instructions" list; none apply until it is fixed.'] };
  const errors: string[] = [], instructions: Instruction[] = [], ids = new Set<string>();
  for (const [index, item] of file.output.instructions.entries()) {
    const label = `instructions[${index}]`;
    if (instructions.length === INSTRUCTION_LIMITS.count) { errors.push(`Only the first ${INSTRUCTION_LIMITS.count} instructions apply.`); break; }
    const parsed = v.safeParse(entry(label, errors), item);
    if (!parsed.success) {
      const key = parsed.issues[0].path?.[0].key;
      errors.push(key === 'id' ? `${label}.id must be a short slug such as "no-em-dashes".` : key === 'text' ? `${label}.text must contain 1–500 characters.` : `${label} must be an object with an id and a text.`);
      continue;
    }
    const { id, text: wording, block, paths } = parsed.output;
    if (ids.has(id)) { errors.push(`${label}.id repeats "${id}"; only the first applies.`); continue; }
    ids.add(id);
    instructions.push({ id, text: wording, ...(block ? { block } : {}), ...(paths ? { paths } : {}) });
  }
  return { instructions, errors };
}

/** A short, readable id for a new instruction from its first words, unique among `taken`. */
export function instructionId(text: string, taken: ReadonlySet<string>): string {
  const words = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? [];
  let base = words[0]?.slice(0, 32) ?? 'instruction';
  for (const word of words.slice(1)) {
    if (base.length + 1 + word.length > 32) break;
    base += `-${word}`;
  }
  for (let n = 2, id = base; ; id = `${base}-${n++}`) if (!taken.has(id)) return id;
}

export type InstructionEdit = { add: Omit<Instruction, 'id'> } | { remove: string };
/**
 * The instructions file after adding or removing one instruction. Everything
 * else in it stays as it was, including entries Braid could not read, so an
 * edit never drops someone's instruction because of a typo in it.
 */
export function editInstructions(text: string | null, edit: InstructionEdit): { file: string; instruction: { id: string; text: string } } | { status: 404 | 409; error: string } {
  const parsed = v.safeParse(listed, text ?? '{"instructions":[]}');
  if (!parsed.success) return { status: 409, error: `${INSTRUCTIONS_PATH} on main is not JSON with an "instructions" list. Fix it before changing instructions here.` };
  const file = parsed.output, items = file.instructions;
  const fields = items.map(item => v.safeParse(v.looseObject({ id: v.string(), text: v.optional(v.string()) }), item)).map(result => result.success ? result.output : null);
  const serialize = (instructions: unknown[]) => `${JSON.stringify({ ...file, instructions }, null, 2)}\n`;
  if ('remove' in edit) {
    const index = fields.findIndex(item => item?.id === edit.remove), removed = fields[index];
    if (!removed) return { status: 404, error: `There is no instruction "${edit.remove}" on main.` };
    return { file: serialize(items.filter((_, other) => other !== index)), instruction: { id: removed.id, text: removed.text ?? removed.id } };
  }
  if (items.length >= INSTRUCTION_LIMITS.count) return { status: 409, error: `This repository already has ${INSTRUCTION_LIMITS.count} instructions. Remove one before adding another.` };
  const id = instructionId(edit.add.text, new Set(fields.flatMap(item => item ? [item.id] : [])));
  const { text: wording, block, paths } = edit.add;
  return { file: serialize([...items, { id, text: wording, ...(block ? { block } : {}), ...(paths ? { paths } : {}) }]), instruction: { id, text: wording } };
}

/** Inline code that survives backticks in the value. */
function code(value: string) {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1), pad = longest ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}
/** An instruction as one line: what it asks, and where it blocks which strings. */
export function describeInstruction(instruction: Instruction): string {
  const text = /[.!?]$/.test(instruction.text) ? instruction.text : `${instruction.text}.`;
  const paths = instruction.paths?.map(code).join(', ');
  if (instruction.block) return `${text} Blocked${paths ? ` in ${paths}` : ''}: ${instruction.block.map(code).join(', ')}.`;
  return paths ? `${text} Applies to ${paths}.` : text;
}

/** Where a marker starts on a line of its own, from `from`, or -1. */
function marker(text: string, value: string, from: number) {
  for (let at = text.indexOf(value, from); at >= 0; at = text.indexOf(value, at + 1)) {
    const end = at + value.length;
    if ((at === 0 || text[at - 1] === '\n') && (end === text.length || text[end] === '\n' || text.startsWith('\r\n', end))) return at;
  }
  return -1;
}
/**
 * AGENTS.md with Braid's section listing these instructions: replaced where
 * it is, appended when absent, or the whole file when there is none, and
 * every other byte kept as it was. Without instructions the section goes,
 * with the blank line Braid put before it; a file left empty is deleted (null).
 */
export function withInstructions(agents: string | null, instructions: Instruction[]): string | null {
  const newline = agents?.includes('\r\n') ? '\r\n' : '\n';
  const section = [START, '## Instructions from Braid', '', ...instructions.map(instruction => `- ${describeInstruction(instruction)}`), END].join(newline);
  const start = agents === null ? -1 : marker(agents, START, 0), end = agents === null || start < 0 ? -1 : marker(agents, END, start);
  if (agents === null || start < 0 || end < 0) {
    if (!instructions.length) return agents;
    return agents ? `${agents}${agents.endsWith('\n') ? '' : newline}${newline}${section}${newline}` : `${section}${newline}`;
  }
  const before = agents.slice(0, start), after = agents.slice(end + END.length);
  if (instructions.length) return before + section + after;
  return before.replace(/(\r?\n)\r?\n$/, '$1') + after.replace(/^\r?\n/, '') || null;
}
