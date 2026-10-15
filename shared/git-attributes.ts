import type { GuideFileAttributes } from './guide';

export interface AttributeFile { path: string; content: string }
export class AttributeLimitError extends Error {}
type Token = { accepts: (char: string) => boolean; repeat?: boolean; skip?: number };

/** Git wildmatch, as a small NFA. No inferred file categories, brace expansion, or implicit directory recursion. */
function matches(path: string, pattern: string): boolean {
  if (!pattern || pattern.length > 512 || pattern.startsWith('!') || pattern.endsWith('/')) return false;
  if (!pattern.includes('/')) path = path.slice(path.lastIndexOf('/') + 1);
  pattern = pattern.replace(/^\//, '');
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      const literal = pattern[++i]; if (!literal) return false;
      tokens.push({ accepts: c => c === literal });
    } else if (char === '*') {
      let end = i; while (pattern[end + 1] === '*') end++;
      const globstar = end > i && (i === 0 || pattern[i - 1] === '/') && (end === pattern.length - 1 || pattern[end + 1] === '/');
      // **/ matches zero directories, or anything ending in a slash.
      if (globstar && pattern[end + 1] === '/') {
        tokens.push({ accepts: () => false, skip: tokens.length + 3 }, { accepts: () => true, repeat: true }, { accepts: c => c === '/' });
        i = end + 1;
      } else { tokens.push({ accepts: c => globstar || c !== '/', repeat: true }); i = end; }
    } else if (char === '?') tokens.push({ accepts: c => c !== '/' });
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 1); if (end < 0) return false;
      const source = pattern.slice(i + 1, end);
      // POSIX character classes are intentionally left unspecified rather than misinterpreted.
      if (!source || source.includes('[') || source.includes('\\')) return false;
      let test: RegExp;
      try { test = new RegExp(`^[${source.replace(/^!/, '^')}]$`); } catch { return false; }
      tokens.push({ accepts: c => c !== '/' && test.test(c) }); i = end;
    } else tokens.push({ accepts: c => c === char });
  }
  const closure = (states: Set<number>) => {
    const queue = [...states];
    for (const at of queue) {
      const token = tokens[at];
      if (token?.repeat || token?.skip !== undefined) for (const next of [at + 1, ...(token.skip === undefined ? [] : [token.skip])]) {
        if (!states.has(next)) { states.add(next); queue.push(next); }
      }
    }
    return states;
  };
  let states = closure(new Set([0]));
  for (const char of path) {
    const next = new Set<number>();
    for (const at of states) if (tokens[at]?.accepts(char)) next.add(tokens[at].repeat ? at : at + 1);
    states = closure(next);
  }
  return states.has(tokens.length);
}

/** Attribute documents are ordered root first, then nearer directories; later declarations win per attribute. */
export function explicitGuideAttributes(paths: readonly string[], documents: readonly AttributeFile[]): GuideFileAttributes[] {
  if (documents.some(doc => doc.content.length > 64_000) || documents.reduce((sum, doc) => sum + doc.content.length, 0) > 256_000) throw new AttributeLimitError('The explicit attributes exceed the guide input limit.');
  const rules: { directory: string; pattern: string; values: { key: 'generated' | 'vendored'; value?: boolean }[] }[] = [];
  const macros = new Map<string, string[]>();
  for (const line of documents.find(doc => doc.path === '.gitattributes')?.content.split('\n') ?? []) {
    const match = line.trim().match(/^\[attr\]([\w-]+)\s+(.+)$/);
    if (match) macros.set(match[1], match[2].split(/\s+/));
  }
  const expanded = (attrs: string[], seen = new Set<string>(), budget = { left: 512 }): string[] => attrs.flatMap(attr => {
    if (--budget.left < 0) throw new AttributeLimitError('The explicit attribute macros exceed the guide expansion limit.');
    if (!macros.has(attr) || seen.has(attr) || seen.size >= 10) return [attr];
    return expanded(macros.get(attr)!, new Set([...seen, attr]), budget);
  });
  for (const doc of [...documents].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))) {
    const directory = doc.path.slice(0, -'.gitattributes'.length);
    for (const raw of doc.content.split('\n')) {
      const line = raw.trim(); if (!line || line.startsWith('#')) continue;
      const parts = line.match(/^("(?:[^"\\]|\\.)*"|\S+)\s+(.+)$/); if (!parts) continue;
      let pattern = parts[1];
      if (pattern.startsWith('"')) { try { pattern = JSON.parse(pattern) as string; } catch { continue; } }
      if (pattern.startsWith('[attr]')) continue;
      const values: typeof rules[number]['values'] = [];
      for (const attr of expanded(parts[2].split(/\s+/))) {
        const match = attr.match(/^([-!]?)(linguist-generated|linguist-vendored)(?:=(\S+))?$/);
        if (match) values.push({ key: match[2] === 'linguist-generated' ? 'generated' : 'vendored', value: match[1] === '!' || match[3] !== undefined && !['true', 'false'].includes(match[3]) ? undefined : match[1] !== '-' && match[3] !== 'false' });
      }
      if (values.length) rules.push({ directory, pattern, values });
      if (rules.length > 4096) throw new AttributeLimitError('The explicit attributes exceed the guide rule limit.');
    }
  }
  return paths.flatMap(path => {
    const result: GuideFileAttributes = { path };
    for (const rule of rules) if (path.startsWith(rule.directory) && matches(path.slice(rule.directory.length), rule.pattern)) {
      for (const { key, value } of rule.values) { if (value === undefined) delete result[key]; else result[key] = value; }
    }
    return result.generated === undefined && result.vendored === undefined ? [] : [result];
  });
}
