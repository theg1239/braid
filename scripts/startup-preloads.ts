import { gzipSync } from 'node:zlib';
import type { OutputBundle, OutputChunk } from 'rolldown';
import type { Plugin } from 'vite';
import { RESERVED_OWNERS } from '../shared/routes';

type Chunk = OutputChunk & { viteMetadata?: { importedCss: Set<string> } };

const ROUTE_MODULES = {
  landing: '/src/screens/LandingScreen.tsx',
  explore: '/src/screens/ExploreScreen.tsx',
  agents: '/src/screens/AgentsScreen.tsx',
  code: '/src/screens/CodeScreen.tsx',
  pulls: '/src/screens/PullsScreen.tsx',
  pull: '/src/screens/PullScreen.tsx',
  compare: '/src/screens/CompareScreen.tsx',
  search: '/src/screens/SearchScreens.tsx',
  files: '/src/components/pulls/Files.tsx',
  viewer: '/src/components/code/pierre.tsx',
  markdown: '/src/components/code/markdown.tsx',
} as const;

// Only small, commonly used grammars. Unknown extensions retain the viewer's normal lazy loading.
const GRAMMARS: Record<string, string[]> = {
  typescript: ['ts', 'mts', 'cts'], tsx: ['tsx'], javascript: ['js', 'mjs', 'cjs'], jsx: ['jsx'],
  json: ['json'], jsonc: ['jsonc'], yaml: ['yaml', 'yml'], toml: ['toml'], css: ['css'],
  python: ['py'], go: ['go'], rust: ['rs'], shellscript: ['sh', 'bash', 'zsh'],
};

/** Follow static imports and extracted styles, never a dynamic import or a worker's optional grammars. The reserved words let boot tell an address from an app path. */
export function startupManifest(bundle: OutputBundle, base = '/') {
  const chunks = Object.values(bundle).filter((item): item is Chunk => item.type === 'chunk');
  const closure = (roots: string[]) => {
    const files = new Set<string>();
    const visit = (name: string) => {
      const item = bundle[name];
      if (files.has(name) || item?.type !== 'chunk') return;
      files.add(name);
      for (const css of (item as Chunk).viteMetadata?.importedCss ?? []) files.add(css);
      for (const dependency of item.imports) visit(dependency);
    };
    for (const root of roots) visit(root);
    return files;
  };
  const shell = closure(chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName));
  const assets = (chunk: Chunk | undefined) => chunk ? [...closure([chunk.fileName])].filter((name) => !shell.has(name)).map((name) => `${base}${name}`) : [];
  const moduleChunk = (suffix: string) => chunks.find((chunk) => Object.keys(chunk.modules).some((id) => id.replaceAll('\\', '/').endsWith(suffix)));
  const screens = Object.fromEntries(Object.entries(ROUTE_MODULES).map(([key, suffix]) => [key, assets(moduleChunk(suffix))])) as Record<keyof typeof ROUTE_MODULES, string[]>;
  const grammars: Record<string, string[]> = {};
  for (const [language, extensions] of Object.entries(GRAMMARS)) {
    const chunk = moduleChunk(`/@shikijs/langs/dist/${language}.mjs`);
    if (!chunk) continue;
    const bytes = [...closure([chunk.fileName])].reduce((total, name) => {
      const item = bundle[name];
      return total + (item?.type === 'chunk' && !shell.has(name) ? gzipSync(item.code).length : 0);
    }, 0);
    if (bytes > 24 * 1024) continue;
    for (const extension of extensions) grammars[extension] = assets(chunk);
  }
  const worker = Object.keys(bundle).find(name => /^assets\/worker-[^/]+\.js$/.test(name));
  // Code's typeface, for pages whose first content is code: text drawn before it arrives is drawn again once it does.
  const mono = Object.keys(bundle).filter(name => /(^|\/)GeistMono-latin-[^/]*\.woff2$/.test(name)).map(name => `${base}${name}`);
  return { ...screens, ...(worker ? { worker: `${base}${worker}` } : {}), mono, grammars, reserved: [...RESERVED_OWNERS] };
}

/** Boot reads build-owned URLs from inert metadata, compatible with the site's script-src 'self' policy. */
export function startupPreloads(): Plugin {
  let base = '/';
  return {
    name: 'braid:startup-preloads',
    apply: 'build',
    configResolved(config) { base = config.base; },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.bundle) return html;
        const content = JSON.stringify(startupManifest(context.bundle, base)).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        return html.replace('<!-- braid:preloads -->', `<meta name="braid-preloads" content="${content}">`);
      },
    },
  };
}
