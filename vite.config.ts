import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import postcss, { type Container } from 'postcss';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { startupPreloads } from './scripts/startup-preloads';
import { iconWeights } from './scripts/icon-weights';

/** `\:` and `\[` become `:` and `[`; `\32 ` becomes `2`. The reverse of how Tailwind escapes a class in a selector. */
function unescapeClass(name: string): string {
  return name.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex: string | undefined, char: string | undefined) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : char ?? ''));
}

const CLASS_IN_SELECTOR = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/g;

/** Drops rules and at-rules the purge left empty; a `@layer a, b;` statement has no children to lose. */
function removeEmpty(container: Container) {
  container.each((node) => {
    if ((node.type === 'atrule' || node.type === 'rule') && node.nodes) {
      removeEmpty(node);
      if (!node.nodes.length) node.remove();
    }
  });
}

/**
 * Kumo's standalone stylesheet carries every Tailwind utility any Kumo component uses. Only the
 * utilities named somewhere in the emitted JavaScript can ever apply, so the rest leave the
 * `utilities` layer here. Nothing outside that layer is touched: Kumo's theme, base and component
 * styles and all of Braid's own stylesheets stay exactly as written.
 */
function purgeKumoUtilities(): Plugin {
  return {
    name: 'braid:purge-kumo-utilities',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const used = new Set<string>();
      for (const item of Object.values(bundle)) {
        const text = item.type === 'chunk' ? item.code : item.fileName.endsWith('.html') ? String(item.source) : null;
        if (!text) continue;
        for (const token of text.split(/[\s"'`]+/)) if (token) used.add(token);
      }
      for (const item of Object.values(bundle)) {
        if (item.type !== 'asset' || !item.fileName.endsWith('.css')) continue;
        const root = postcss.parse(String(item.source));
        let touched = false;
        root.walkAtRules('layer', (layer) => {
          if (!/^utilities\b/.test(layer.params) || !layer.nodes) return;
          layer.walkRules((rule) => {
            const keep = rule.selectors.filter((selector) => {
              for (const match of selector.matchAll(CLASS_IN_SELECTOR)) if (!used.has(unescapeClass(match[1]))) return false;
              return true;
            });
            if (keep.length === rule.selectors.length) return;
            touched = true;
            if (keep.length) rule.selectors = keep;
            else rule.remove();
          });
          removeEmpty(layer);
        });
        if (!touched) continue;
        // Registered custom properties only matter while a rule still reads them.
        const css = root.toString();
        root.walkAtRules('property', (rule) => {
          const name = rule.params.trim();
          if (css.indexOf(name) === css.lastIndexOf(name)) rule.remove();
        });
        item.source = root.toString();
      }
    },
  };
}

/** Preloads the local interface font in dev too; builds use Vite's hashed filename. */
function fontPreload(): Plugin {
  return {
    name: 'braid:font-preload',
    transformIndexHtml: {
      order: 'post',
      handler(_, context) {
        const file = context.bundle ? Object.keys(context.bundle).find((name) => /(^|\/)Geist-latin-[^/]*\.woff2$/.test(name)) : 'src/fonts/Geist-latin.woff2';
        if (!file) return [];
        return [{ tag: 'link', attrs: { rel: 'preload', href: `/${file}`, as: 'font', type: 'font/woff2', crossorigin: true }, injectTo: 'head' }];
      },
    },
  };
}

export default defineConfig({
  plugins: [
    { name: 'braid:served-cli', apply: 'build', configResolved() { execFileSync(fileURLToPath(new URL('./node_modules/.bin/rolldown', import.meta.url)), ['-c', 'cli/rolldown.config.ts'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'pipe' }); } },
    iconWeights(),
    react(),
    purgeKumoUtilities(),
    fontPreload(),
    startupPreloads(),
    cloudflare({
      remoteBindings: process.env.BRAID_REMOTE_DEV === '1',
      persistState: process.env.BRAID_DEV_STATE_PATH ? { path: process.env.BRAID_DEV_STATE_PATH } : true,
    }),
  ],
  resolve: {
    // The diff viewer's Shiki: only the grammars and themes in src/lib/shiki.ts, each a lazy chunk.
    alias: [{ find: /^shiki$/, replacement: fileURLToPath(new URL('./src/lib/shiki.ts', import.meta.url)) }],
  },
  // The highlighter worker as ES modules, so its optional WebAssembly engine stays a separate chunk that is never fetched.
  worker: { format: 'es' },
  build: {
    rolldownOptions: {
      output: {
        chunkFileNames: (chunk) => chunk.name.startsWith('ui~') ? 'assets/ui-[hash].js' : 'assets/[name]-[hash].js',
        codeSplitting: {
          groups: [
            { name: 'react', priority: 20, test: /node_modules\/(?:react|react-dom|scheduler)\// },
            // The bundler's actual static entry closure includes shared vendor modules and Vite's preload helper.
            // Claim it first so grouping deferred UI cannot pull those groups into the initial document.
            { name: 'shell', priority: 10, tags: ['$initial'] },
            // Higher-priority shell ownership wins. Only the deferred parts are combined here.
            { name: 'icons', priority: 5, test: /node_modules\/@phosphor-icons\/react\// },
            // Kumo grouped by the screens that use it. Subgroups under 75 KB join their nearest neighbour: on 2026-10-12
            // that kept every chunk between 5 and 17 KB gz and cut 14–38 KB from Code, Pull requests, Explore and the
            // task pages for one to three more files fetched in the same parallel wave. 105–300 KB merged them into
            // chunks most screens only partly use; 70–80 KB gave the same grouping, so the value is not on an edge.
            { name: 'ui', priority: 5, test: /node_modules\/(?:@cloudflare\/kumo|@base-ui(?:-components)?\/react|@floating-ui)\//, entriesAware: true, entriesAwareMergeThreshold: 75_000 },
          ],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
