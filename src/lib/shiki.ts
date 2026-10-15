/*
 * The Shiki the diff viewer bundles. `@pierre/diffs` imports `shiki`, whose default entry
 * carries every grammar and theme as its own lazy chunk; vite.config.ts points that import
 * here instead, with the grammars repositories commonly hold and the themes the interface
 * uses. A grammar loads the first time a file of its language is on screen; anything not
 * listed highlights as plain text.
 */
import {
  createCssVariablesTheme,
  createSingletonShorthands,
  createBundledHighlighter,
  getTokenStyleObject,
  stringifyTokenStyle,
  type BundledHighlighterOptions,
  type DynamicImportLanguageRegistration,
  type DynamicImportThemeRegistration,
  type HighlighterGeneric,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

export * from 'shiki/core';
export { createCssVariablesTheme, createJavaScriptRegexEngine, createOnigurumaEngine, getTokenStyleObject, stringifyTokenStyle };

// Let the renderer paint its themed plain rows before a grammar compiles on the main thread.
const grammar = (load: DynamicImportLanguageRegistration): DynamicImportLanguageRegistration => () => {
  if (typeof requestAnimationFrame === 'undefined') return load();
  return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))).then(load);
};

export const bundledLanguages: Record<string, DynamicImportLanguageRegistration> = {
  typescript: grammar(() => import('@shikijs/langs/typescript')),
  tsx: grammar(() => import('@shikijs/langs/tsx')),
  javascript: grammar(() => import('@shikijs/langs/javascript')),
  jsx: grammar(() => import('@shikijs/langs/jsx')),
  json: grammar(() => import('@shikijs/langs/json')),
  jsonc: grammar(() => import('@shikijs/langs/jsonc')),
  json5: grammar(() => import('@shikijs/langs/json5')),
  jsonl: grammar(() => import('@shikijs/langs/jsonl')),
  markdown: grammar(() => import('@shikijs/langs/markdown')),
  mdx: grammar(() => import('@shikijs/langs/mdx')),
  css: grammar(() => import('@shikijs/langs/css')),
  scss: grammar(() => import('@shikijs/langs/scss')),
  sass: grammar(() => import('@shikijs/langs/sass')),
  less: grammar(() => import('@shikijs/langs/less')),
  postcss: grammar(() => import('@shikijs/langs/postcss')),
  html: grammar(() => import('@shikijs/langs/html')),
  vue: grammar(() => import('@shikijs/langs/vue')),
  svelte: grammar(() => import('@shikijs/langs/svelte')),
  astro: grammar(() => import('@shikijs/langs/astro')),
  xml: grammar(() => import('@shikijs/langs/xml')),
  yaml: grammar(() => import('@shikijs/langs/yaml')),
  yml: grammar(() => import('@shikijs/langs/yaml')),
  toml: grammar(() => import('@shikijs/langs/toml')),
  ini: grammar(() => import('@shikijs/langs/ini')),
  properties: grammar(() => import('@shikijs/langs/properties')),
  dotenv: grammar(() => import('@shikijs/langs/dotenv')),
  python: grammar(() => import('@shikijs/langs/python')),
  ruby: grammar(() => import('@shikijs/langs/ruby')),
  go: grammar(() => import('@shikijs/langs/go')),
  rust: grammar(() => import('@shikijs/langs/rust')),
  java: grammar(() => import('@shikijs/langs/java')),
  kotlin: grammar(() => import('@shikijs/langs/kotlin')),
  kts: grammar(() => import('@shikijs/langs/kotlin')),
  swift: grammar(() => import('@shikijs/langs/swift')),
  'objective-c': grammar(() => import('@shikijs/langs/objective-c')),
  c: grammar(() => import('@shikijs/langs/c')),
  cpp: grammar(() => import('@shikijs/langs/cpp')),
  csharp: grammar(() => import('@shikijs/langs/csharp')),
  php: grammar(() => import('@shikijs/langs/php')),
  shellscript: grammar(() => import('@shikijs/langs/shellscript')),
  zsh: grammar(() => import('@shikijs/langs/shellscript')),
  fish: grammar(() => import('@shikijs/langs/fish')),
  powershell: grammar(() => import('@shikijs/langs/powershell')),
  sql: grammar(() => import('@shikijs/langs/sql')),
  graphql: grammar(() => import('@shikijs/langs/graphql')),
  dockerfile: grammar(() => import('@shikijs/langs/dockerfile')),
  makefile: grammar(() => import('@shikijs/langs/makefile')),
  cmake: grammar(() => import('@shikijs/langs/cmake')),
  lua: grammar(() => import('@shikijs/langs/lua')),
  dart: grammar(() => import('@shikijs/langs/dart')),
  zig: grammar(() => import('@shikijs/langs/zig')),
  hcl: grammar(() => import('@shikijs/langs/hcl')),
  tf: grammar(() => import('@shikijs/langs/terraform')),
  tfvars: grammar(() => import('@shikijs/langs/terraform')),
  prisma: grammar(() => import('@shikijs/langs/prisma')),
  diff: grammar(() => import('@shikijs/langs/diff')),
  csv: grammar(() => import('@shikijs/langs/csv')),
  protobuf: grammar(() => import('@shikijs/langs/protobuf')),
  elixir: grammar(() => import('@shikijs/langs/elixir')),
  erlang: grammar(() => import('@shikijs/langs/erlang')),
  scala: grammar(() => import('@shikijs/langs/scala')),
  haskell: grammar(() => import('@shikijs/langs/haskell')),
  r: grammar(() => import('@shikijs/langs/r')),
  perl: grammar(() => import('@shikijs/langs/perl')),
  nix: grammar(() => import('@shikijs/langs/nix')),
  tex: grammar(() => import('@shikijs/langs/tex')),
  wasm: grammar(() => import('@shikijs/langs/wasm')),
  wgsl: grammar(() => import('@shikijs/langs/wgsl')),
  glsl: grammar(() => import('@shikijs/langs/glsl')),
  http: grammar(() => import('@shikijs/langs/http')),
  'git-commit': grammar(() => import('@shikijs/langs/git-commit')),
  'git-rebase': grammar(() => import('@shikijs/langs/git-rebase')),
  codeowners: grammar(() => import('@shikijs/langs/codeowners')),
  'ssh-config': grammar(() => import('@shikijs/langs/ssh-config')),
  nginx: grammar(() => import('@shikijs/langs/nginx')),
  log: grammar(() => import('@shikijs/langs/log')),
};

export const bundledThemes: Record<string, DynamicImportThemeRegistration> = {
  vesper: () => import('@shikijs/themes/vesper'),
  'github-light': () => import('@shikijs/themes/github-light'),
  'github-dark': () => import('@shikijs/themes/github-dark'),
};

export const createHighlighter: (options: BundledHighlighterOptions<string, string>) => Promise<HighlighterGeneric<string, string>> = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
});

export const { codeToHtml } = createSingletonShorthands(createHighlighter);
