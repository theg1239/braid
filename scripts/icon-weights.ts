import { parseAst, type Plugin } from 'vite';

/** The interface uses these three weights, including Kumo's bundled Phosphor icons. */
const USED_WEIGHTS = new Set(['regular', 'bold', 'fill']);
const ALL_WEIGHTS = new Set([...USED_WEIGHTS, 'duotone', 'light', 'thin']);

/**
 * Kumo bundles several Phosphor definitions into each component module. Trim every
 * weight map, preserving the used entries verbatim. Ordinary Maps are left alone.
 */
export function pruneIconWeights(code: string): string | null {
  const edits: { start: number; end: number; text: string }[] = [];
  let cursor = 0;
  while (cursor < code.length) {
    const start = code.indexOf('new Map([', cursor);
    if (start < 0) break;
    const open = start + 'new Map('.length;
    const entries: [number, number][] = [];
    let depth = 0;
    let quote: string | null = null;
    let entryStart = -1;
    let end = -1;
    for (let i = open; i < code.length; i++) {
      const char = code[i];
      if (quote) {
        if (char === '\\') i++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '[' || char === '(' || char === '{') {
        depth++;
        if (depth === 2 && char === '[') entryStart = i;
      } else if (char === ']' || char === ')' || char === '}') {
        if (depth === 2 && char === ']' && entryStart >= 0) {
          entries.push([entryStart, i + 1]);
          entryStart = -1;
        }
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return null;
    cursor = end + 1;
    const names = entries.map(([from, to]) => /^\[\s*"([a-z]+)"/.exec(code.slice(from, to))?.[1]);
    // Requiring all six weights also protects unrelated maps in prebundled code.
    if (names.length !== ALL_WEIGHTS.size || new Set(names).size !== ALL_WEIGHTS.size || names.some(name => !name || !ALL_WEIGHTS.has(name))) continue;
    const kept = entries.filter((_, i) => USED_WEIGHTS.has(names[i]!));
    edits.push({ start: open + 1, end, text: `\n${kept.map(([from, to]) => code.slice(from, to)).join(',\n')}\n` });
  }
  if (!edits.length) return null;
  let next = code;
  for (const edit of edits.reverse()) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  try {
    parseAst(next);
  } catch {
    return null;
  }
  return next;
}

export function iconWeights(): Plugin {
  return {
    name: 'braid:icon-weights',
    transform(code, id) {
      const phosphor = id.includes('@phosphor-icons/react/dist/defs/');
      const bundled = id.includes('@cloudflare/kumo/dist/chunks/') && code.includes('@phosphor-icons/react/dist/defs/');
      if (!phosphor && !bundled) return null;
      const next = pruneIconWeights(code);
      return next === null ? null : { code: next, map: null };
    },
  };
}
