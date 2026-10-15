import { diffLines } from './diff';

/**
 * The lines that make each version different from the others, so a choice can
 * be made on the actual difference rather than on two whole files. Callers pass
 * the loaded text of every version, in lane order.
 */
export function distinctLines(versions: { agentId: string; after: string }[]): Map<string, { lines: string[]; more: number }> {
  const result = new Map<string, { lines: string[]; more: number }>();
  if (versions.length < 2) return result;
  const [first, ...rest] = versions;
  const pick = (lines: string[]) => {
    const clean = lines.map((line) => line.trim()).filter((line) => line && !/^[{}()[\];,]+$/.test(line));
    return { lines: clean.slice(0, 3), more: Math.max(0, clean.length - 3) };
  };
  const firstOnly = new Set<string>();
  for (const other of rest) {
    const ops = diffLines(first.after, other.after);
    for (const op of ops) if (op.type === 'remove') firstOnly.add(op.text);
    result.set(other.agentId, pick(ops.filter((op) => op.type === 'add').map((op) => op.text)));
  }
  result.set(first.agentId, pick([...firstOnly]));
  return result;
}
