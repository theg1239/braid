type SearchQualifier = 'repo' | 'org' | 'user' | 'path' | 'language';
interface SearchQuery {
  terms: string[];
  qualifiers: { kind: SearchQualifier; value: string; start: number; end: number }[];
  error: string | null;
}

/** Extensions, including common GitHub language aliases. Unknown languages match no files. */
const LANGUAGES: Record<string, string[]> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'], javascript: ['js', 'jsx', 'mjs', 'cjs'],
  python: ['py', 'pyi', 'pyw'], ruby: ['rb', 'rake', 'gemspec'], rust: ['rs'], go: ['go'],
  java: ['java'], kotlin: ['kt', 'kts'], swift: ['swift'], c: ['c', 'h'], 'c++': ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  'c#': ['cs'], 'objective-c': ['m', 'mm', 'h'], php: ['php'], elixir: ['ex', 'exs'], erlang: ['erl', 'hrl'],
  shell: ['sh', 'bash', 'zsh', 'fish'], powershell: ['ps1', 'psm1'], lua: ['lua'], dart: ['dart'], scala: ['scala', 'sc'],
  html: ['html', 'htm'], css: ['css'], scss: ['scss'], less: ['less'], vue: ['vue'], svelte: ['svelte'],
  json: ['json', 'jsonc'], yaml: ['yaml', 'yml'], toml: ['toml'], xml: ['xml', 'svg'], markdown: ['md', 'mdx', 'markdown'],
  text: ['txt', 'text'], sql: ['sql'], graphql: ['graphql', 'gql'], protobuf: ['proto'], hcl: ['tf', 'hcl'],
  r: ['r'], julia: ['jl'], haskell: ['hs', 'lhs'], clojure: ['clj', 'cljs', 'cljc'], ocaml: ['ml', 'mli'],
};
const ALIASES: Record<string, string> = { ts: 'typescript', js: 'javascript', py: 'python', rb: 'ruby', rs: 'rust', cpp: 'c++', csharp: 'c#', bash: 'shell', sh: 'shell', yml: 'yaml', md: 'markdown', 'plain text': 'text' };

/** Quoted phrases stay together; other terms are literal AND terms. Repeated qualifiers are ORs. */
export function parseSearch(query: string): SearchQuery {
  const result: SearchQuery = { terms: [], qualifiers: [], error: null };
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) { i++; continue; }
    const start = i;
    const qualifier = /^(repo|org|user|path|language):/i.exec(query.slice(i));
    if (qualifier) i += qualifier[0].length;
    let value = '', quoted = false;
    while (i < query.length && (quoted || !/\s/.test(query[i]))) {
      const char = query[i++];
      if (char === '"') quoted = !quoted;
      else if (quoted && char === '\\' && (query[i] === '"' || query[i] === '\\')) value += query[i++];
      else value += char;
    }
    if (quoted) { result.error = 'Close the quoted phrase.'; return result; }
    if (!value) { result.error = 'Enter a value after each qualifier or quote.'; return result; }
    if (qualifier) {
      const kind = qualifier[1].toLowerCase() as SearchQualifier;
      if ((kind === 'repo' && !/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(value)) || ((kind === 'org' || kind === 'user') && !/^[a-z0-9-]+$/i.test(value))) {
        result.error = kind === 'repo' ? 'Use repo:owner/name.' : `Use ${kind}:owner.`;
        return result;
      }
      result.qualifiers.push({ kind, value: kind === 'path' ? value : value.toLowerCase(), start, end: i });
    } else result.terms.push(value);
  }
  if (!result.terms.length && !result.qualifiers.length) result.error = 'Enter a search query.';
  return result;
}

export const qualifierValues = (query: SearchQuery, kind: SearchQualifier) => query.qualifiers.filter(item => item.kind === kind).map(item => item.value);

/** Simple wildcard matching without a user-controlled regular expression or exponential backtracking. */
function segmentMatches(text: string, pattern: string): boolean {
  let at = 0, part = 0, star = -1, retry = 0;
  while (at < text.length) {
    if (pattern[part] === '?' || pattern[part] === text[at]) { at++; part++; }
    else if (pattern[part] === '*') { star = part++; retry = at; }
    else if (star >= 0) { part = star + 1; at = ++retry; }
    else return false;
  }
  while (pattern[part] === '*') part++;
  return part === pattern.length;
}

function pathMatches(path: string, pattern: string): boolean {
  pattern = pattern.replace(/^\//, '');
  if (!/[?*]/.test(pattern)) return path.startsWith(pattern);
  if (!pattern.includes('/')) return segmentMatches(path.split('/').at(-1)!, pattern);
  const parts = path.split('/');
  let matches = Array<boolean>(parts.length + 1).fill(false); matches[0] = true;
  for (const part of pattern.split('/')) {
    const next = Array<boolean>(parts.length + 1).fill(false);
    for (let i = 0; i <= parts.length; i++) next[i] = part === '**'
      ? matches[i] || (i > 0 && next[i - 1])
      : i > 0 && matches[i - 1] && segmentMatches(parts[i - 1], part);
    matches = next;
  }
  return matches[parts.length];
}

export function searchFileFilter(query: SearchQuery): (path: string) => boolean {
  const paths = qualifierValues(query, 'path'), languages = qualifierValues(query, 'language');
  const extensions = new Set(languages.flatMap(name => LANGUAGES[ALIASES[name] ?? name] ?? []));
  return path => (!paths.length || paths.some(pattern => pathMatches(path, pattern)))
    && (!languages.length || extensions.has(path.split('.').at(-1)!.toLowerCase()));
}
