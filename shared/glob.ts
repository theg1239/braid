type Edge = { to: number; kind: 'empty' | 'literal' | 'segment' | 'any'; value?: string };
type Pattern = { edges: Edge[][]; end: number };
const cache = new Map<string, Pattern>();

/** Thompson-style glob automaton: matching work is bounded by pattern length times path length. */
function globPattern(glob: string): Pattern {
  const cached = cache.get(glob);
  if (cached) return cached;
  const anchored = glob.includes('/') ? glob.replace(/^\//, '') : `**/${glob}`;
  const edges: Edge[][] = [[]];
  let current = 0;
  const node = () => edges.push([]) - 1;
  const empty = (from: number, to: number) => edges[from].push({ to, kind: 'empty' });
  const literal = (value: string) => { const to = node(); edges[current].push({ to, kind: 'literal', value }); current = to; };
  const repeat = (kind: 'segment' | 'any') => { const to = node(); edges[current].push({ to: current, kind }); empty(current, to); current = to; };
  const optional = (build: () => void) => {
    const start = current, end = node(), branch = node();
    empty(start, end); empty(start, branch); current = branch;
    build(); empty(current, end); current = end;
  };
  const groups: { start: number; end: number }[] = [];
  for (let i = 0; i < anchored.length; i++) {
    const char = anchored[i];
    if (char === '*' && anchored[i + 1] === '*') {
      if (anchored[i + 2] === '/') { optional(() => { repeat('any'); literal('/'); }); i += 2; }
      else { repeat('any'); i++; }
    } else if (char === '*') repeat('segment');
    else if (char === '?') { const to = node(); edges[current].push({ to, kind: 'segment' }); current = to; }
    else if (char === '{') {
      const start = current, end = node(), branch = node();
      empty(start, branch); groups.push({ start, end }); current = branch;
    } else if (char === '}' && groups.length) { const group = groups.pop()!; empty(current, group.end); current = group.end; }
    else if (char === ',' && groups.length) {
      const group = groups.at(-1)!, branch = node();
      empty(current, group.end); empty(group.start, branch); current = branch;
    } else literal(char);
  }
  if (groups.length) throw new SyntaxError('Unclosed glob alternatives.');
  if (anchored.endsWith('/')) repeat('any');
  else optional(() => { literal('/'); repeat('any'); });
  const pattern = { edges, end: current };
  if (cache.size > 2000) cache.clear();
  cache.set(glob, pattern);
  return pattern;
}

export function validGlob(glob: string): boolean {
  try { globPattern(glob); return true; } catch { return false; }
}

export function matchesGlob(path: string, glob: string): boolean {
  const { edges, end } = globPattern(glob);
  const closure = (seeds: Set<number>) => {
    const todo = [...seeds];
    for (let index = 0; index < todo.length; index++) for (const edge of edges[todo[index]]) {
      if (edge.kind === 'empty' && !seeds.has(edge.to)) { seeds.add(edge.to); todo.push(edge.to); }
    }
    return seeds;
  };
  let active = closure(new Set([0]));
  for (let index = 0; index < path.length; index++) {
    const char = path[index], next = new Set<number>();
    for (const state of active) for (const edge of edges[state]) {
      if (edge.kind === 'literal' ? edge.value === char : edge.kind === 'segment' ? char !== '/' : edge.kind === 'any' && !'\n\r\u2028\u2029'.includes(char)) next.add(edge.to);
    }
    if (!next.size) return false;
    active = closure(next);
  }
  return active.has(end);
}
export const matchesAny = (path: string, globs: readonly string[] | undefined) => !!globs?.some(glob => matchesGlob(path, glob));
