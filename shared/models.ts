import type { ChangeAuthor, Provenance } from './types';

/*
 * Models and tools as people read them, and the roster key built from them. They live apart from provenance.ts,
 * which parses Git notes with Valibot, so the screens that name agents never load the validator.
 */

const ACRONYMS: Record<string, string> = { gpt: 'GPT', glm: 'GLM', cli: 'CLI', ai: 'AI', api: 'API', llm: 'LLM', bge: 'BGE', fp8: 'FP8', awq: 'AWQ', ide: 'IDE' };
/** A model id or tool name as people read it: `claude-opus-5-5` is Claude Opus 5.5, `@cf/zai-org/glm-5.3-flash` GLM 5.3 Flash. */
export function modelName(id: string): string {
  // Workers AI ids (@cf/org/model) and provider-prefixed ids name the model last.
  const model = id.trim().replace(/\s*(?:\(\d+(?:\.\d+)?[km] context\)|\[\d+(?:\.\d+)?[km]\])$/i, '');
  const tokens = (model.split('/').filter(Boolean).at(-1) ?? model).split(/[-_\s]+/).filter(token => token && !/^\d{8}$/.test(token));
  const words: string[] = [];
  for (const token of tokens) {
    const previous = words.at(-1);
    // Consecutive version numbers join: opus-5-5 is Opus 5.5.
    if (/^\d+$/.test(token) && previous && /^\d+(\.\d+)*$/.test(previous)) words[words.length - 1] = `${previous}.${token}`;
    else words.push(token);
  }
  const named = words.map(word => ACRONYMS[word.toLowerCase()] ?? (/^\d/.test(word) || /^o\d/i.test(word) ? word.replace(/b$/i, 'B') : word[0].toUpperCase() + word.slice(1)));
  // GPT joins its version with a hyphen: GPT-6.1 Sol.
  if (named[0] === 'GPT' && /^\d/.test(named[1] ?? '')) named.splice(0, 2, `GPT-${named[1]}`);
  return named.join(' ') || 'Agent';
}
/** A credit names a model only when it supplies one; "Claude" and "Claude Code" just identify the tool. */
export function modelFromCredit(credit: string): string | undefined {
  // Aider explicitly encloses its configured model id, including provider prefixes, in parentheses.
  const aider = /^aider \(([^()]+)\)$/i.exec(credit.trim());
  if (aider) return /^[\w./:@-]+$/.test(aider[1]) && !/^(?:unknown(?:-model)?|default)$/i.test(aider[1]) ? modelName(aider[1]) : undefined;
  const name = modelName(credit);
  return /^(?:Claude (?:(?:Opus|Sonnet|Haiku|Fable) )?\d+(?:\.\d+)*(?: (?:Opus|Sonnet|Haiku|Fable))?|GPT-\d[\w. -]*|o\d[\w. -]*|Gemini \d[\w. -]*)$/.test(name) ? name : undefined;
}
/** A tool without its version: `claude-code/2.4.1` is `claude-code`. */
export const toolBase = (tool: string) => tool.split('/').filter(part => part && !/^v?\d/.test(part)).join('/');
/** A tool such as `claude-code/2.4.1` or `@openai/codex/1.8.0` by name, without its scope or version. */
export function toolName(tool: string): string {
  return modelName((toolBase(tool).split('/').at(-1) || tool).replace(/^@/, ''));
}
/** Commit rows preserve the provenance kind; only a recorded simulated agent gets the extra presentation label. */
export function provenanceAuthorKind(provenance: Pick<Provenance, 'kind' | 'agent'>): ChangeAuthor['kind'] {
  return provenance.kind === 'agent' && provenance.agent?.id?.startsWith('sim:') ? 'simulated' : provenance.kind;
}
/**
 * The fleet roster's identity for a change's author: its model, its owner and its tool, as `GET /api/agents` keys
 * its records and `GET /api/changes?agent=` filters, on the server and in the browser alike. People and bots have no record.
 */
export function agentKey(author: Pick<ChangeAuthor, 'kind' | 'model' | 'owner' | 'tool'>): string | null {
  return author.kind === 'agent' || author.kind === 'simulated' ? JSON.stringify([author.model ?? '', author.owner?.id ?? author.owner?.name ?? '', author.tool ? toolBase(author.tool) : '']) : null;
}
