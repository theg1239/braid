/*
 * Just enough TypeScript highlighting for the landing page's code: comments, keywords, strings, numbers,
 * types and called functions. Anything else stays plain.
 */

type Kind = 'comment' | 'kw' | 'str' | 'num' | 'type' | 'fn' | 'punct' | 'plain';

const KEYWORDS = new Set(['import', 'from', 'export', 'interface', 'async', 'function', 'const', 'let', 'for', 'try', 'catch', 'return', 'await', 'new', 'if', 'else', 'true', 'false', 'null']);
const TOKEN = /(\/\/.*$|\/\*.*?(?:\*\/|$))|('[^']*'|"[^"]*"|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d'"`]+)/g;

export function highlight(line: string): [Kind, string][] {
  const out: [Kind, string][] = [];
  for (const match of line.matchAll(TOKEN)) {
    const [text, comment, string, number, word, space] = match;
    if (comment) out.push(['comment', text]);
    else if (string) out.push(['str', text]);
    else if (number) out.push(['num', text]);
    else if (word) {
      const next = line.slice((match.index ?? 0) + text.length);
      if (KEYWORDS.has(word)) out.push(['kw', text]);
      else if (/^[A-Z]/.test(word)) out.push(['type', text]);
      else if (/^\s*\(/.test(next)) out.push(['fn', text]);
      else out.push(['plain', text]);
    } else if (space) out.push(['plain', text]);
    else out.push(['punct', text]);
  }
  return out;
}
