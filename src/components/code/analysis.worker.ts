import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { grammarDeclarations, contextLanguages } from './function-context';
import { detectMoves, type MoveFile } from './moves';

const grammars = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  css: () => import('@shikijs/langs/css'),
};
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
export type AnalysisInput = { kind: 'context'; language: string; before: string; after: string } | { kind: 'moves'; files: MoveFile[] };
self.onmessage = async ({ data }: MessageEvent<AnalysisInput & { id: number }>) => {
  try {
    if (data.kind === 'moves') {
      self.postMessage({ id: data.id, value: detectMoves(data.files) });
      return;
    }
    if (!contextLanguages.has(data.language)) {
      self.postMessage({ id: data.id, value: { before: [], after: [] } });
      return;
    }
    const high = await (highlighter ??= createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine() }));
    await high.loadLanguage(await grammars[data.language as keyof typeof grammars]());
    const grammar = high.getLanguage(data.language);
    self.postMessage({ id: data.id, value: { before: grammarDeclarations(grammar, data.before, data.language), after: grammarDeclarations(grammar, data.after, data.language) } });
  } catch {
    self.postMessage({ id: data.id, error: true });
  }
};
