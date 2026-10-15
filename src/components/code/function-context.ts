import type { IGrammar, StateStack, StateStackImpl } from '@shikijs/vscode-textmate';
import type { Hunk } from '@pierre/diffs';

interface Declaration { start: number; end: number; signature: string }
export interface FunctionContext { before: Declaration[]; after: Declaration[] }
interface HunkContext { declaration: Declaration; side: 'additions' | 'deletions'; leading: number }
const CONTEXT_LIMIT = 40;

// These grammars scope the entire body. Python, Go and Rust currently scope only the signature.
export const contextLanguages = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'css']);

/** Enclosing ranges come exclusively from TextMate's body scopes, including its end-of-line state. */
export function grammarDeclarations(grammar: IGrammar, text: string, language: string): Declaration[] {
  if (!contextLanguages.has(language) || text.length > 250_000) return [];
  const lines = text.split('\n');
  if (lines.length > 6_000 || lines.some(line => line.length > 2_000)) return [];
  const declarations: Declaration[] = [];
  const active: { scope: string; start: number }[] = [];
  let state: StateStack | null = null;
  let selector: { start: number; parent: string } | null = null;
  const isBody = (scope: string) => language === 'css' ? scope === 'meta.property-list.css'
    : ['meta.function.', 'meta.arrow.', 'meta.method.declaration.', 'meta.class.'].some(prefix => scope.startsWith(prefix));
  const finish = (line: number) => {
    const entry = active.pop()!;
    if (line > entry.start) declarations.push({ start: entry.start, end: line, signature: lines[entry.start - 1].trim().slice(0, 240) });
  };
  const visit = (scopes: string[], line: number, closing = false) => {
    const bodies = scopes.filter(isBody);
    let common = 0;
    while (common < active.length && common < bodies.length && active[common].scope === bodies[common]) common++;
    while (active.length > common) finish(closing ? line : line - 1);
    const parent = bodies.join('/');
    if (language === 'css' && scopes.includes('meta.selector.css')) {
      if (!selector || selector.parent !== parent) selector = { start: line, parent };
    }
    for (let i = common; i < bodies.length; i++) {
      const start = language === 'css' && selector?.parent === bodies.slice(0, i).join('/') ? selector.start : line;
      active.push({ scope: bodies[i], start });
      selector = null;
    }
  };
  for (let index = 0; index < lines.length; index++) {
    // The client terminates this worker after five seconds, including a stalled grammar.
    const result = grammar.tokenizeLine(lines[index], state);
    // An incomplete tokenization cannot prove any enclosing range in this file.
    if (result.stoppedEarly) return [];
    for (const token of result.tokens) visit(token.scopes, index + 1);
    state = result.ruleStack;
    // StateStackImpl is TextMate's exported immutable state. Reading its scopes distinguishes
    // adjacent sibling declarations even when their final/first tokens have identical scopes.
    const scopes = (state as StateStackImpl).contentNameScopesList?.getScopeNames();
    if (!scopes) return [];
    visit(scopes, index + 1, true);
  }
  // Unclosed scopes are deliberately omitted rather than inventing a body boundary.
  return declarations.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function enclosingDeclaration(declarations: Declaration[], line: number): Declaration | undefined {
  let result: Declaration | undefined;
  for (const declaration of declarations) {
    if (declaration.start > line) break;
    if (declaration.end >= line && (!result || declaration.start >= result.start)) result = declaration;
  }
  return result;
}

export function hunkFunctionContext(hunk: Hunk, context: FunctionContext): HunkContext | undefined {
  const first = hunk.hunkContent.find(part => part.type === 'change');
  if (!first) return;
  const side = first.additions ? 'additions' : 'deletions';
  const line = side === 'additions' ? hunk.additionStart + first.additionLineIndex - hunk.additionLineIndex
    : hunk.deletionStart + first.deletionLineIndex - hunk.deletionLineIndex;
  const declaration = enclosingDeclaration(side === 'additions' ? context.after : context.before, line);
  if (!declaration) return;
  const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart;
  const distance = start - declaration.start;
  return { declaration, side, leading: distance > 0 && distance <= CONTEXT_LIMIT ? Math.min(distance, hunk.collapsedBefore) : 0 };
}
