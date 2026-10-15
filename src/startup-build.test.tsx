import type { OutputBundle, OutputChunk } from 'rolldown';
import { describe, expect, it } from 'vitest';
import { startupManifest } from '../scripts/startup-preloads';

function chunk(fileName: string, module: string, imports: string[] = [], css: string[] = [], isEntry = false) {
  return { type: 'chunk', fileName, modules: { [module]: {} }, imports, dynamicImports: ['optional.js'], isEntry, code: 'export default {};', viteMetadata: { importedCss: new Set(css) } } as unknown as OutputChunk;
}

describe('build-owned startup URLs', () => {
  it('includes transitive static dependencies and CSS, excluding the shell and dynamic imports', () => {
    const bundle: OutputBundle = {
      'entry.js': chunk('entry.js', '/app/src/main.tsx', ['react.js'], ['shell.css'], true),
      'react.js': chunk('react.js', '/node_modules/react/index.js'),
      'landing-NEW.js': chunk('landing-NEW.js', '/app/src/screens/LandingScreen.tsx', ['react.js', 'icons-NEW.js'], ['landing-NEW.css', 'shell.css']),
      'icons-NEW.js': chunk('icons-NEW.js', '/node_modules/icon.js', ['react.js']),
      'optional.js': chunk('optional.js', '/node_modules/optional.js'),
    };
    expect(startupManifest(bundle).landing).toEqual(['/landing-NEW.js', '/landing-NEW.css', '/icons-NEW.js']);
  });

  it('takes the grammar URL from its source module, including shared imports and the deployment base', () => {
    const bundle: OutputBundle = {
      'lang-NEW.js': chunk('lang-NEW.js', '/app/node_modules/@shikijs/langs/dist/typescript.mjs', ['shared-NEW.js']),
      'shared-NEW.js': chunk('shared-NEW.js', '/app/node_modules/grammar-helper.js'),
    };
    const manifest = startupManifest(bundle, '/braid/');
    expect(manifest.grammars.ts).toEqual(['/braid/lang-NEW.js', '/braid/shared-NEW.js']);
    expect(manifest.grammars.mts).toEqual(manifest.grammars.ts);
    expect(manifest.grammars.py).toBeUndefined();
  });

  it('names the compare and code search screens and code\'s typeface, which boot warms with their reads', () => {
    const bundle = {
      'entry.js': chunk('entry.js', '/app/src/main.tsx', [], [], true),
      'compare-NEW.js': chunk('compare-NEW.js', '/app/src/screens/CompareScreen.tsx', ['code-NEW.js'], ['branches-NEW.css']),
      'code-NEW.js': chunk('code-NEW.js', '/app/src/components/code/index.tsx'),
      'search-NEW.js': chunk('search-NEW.js', '/app/src/screens/SearchScreens.tsx'),
      'assets/GeistMono-latin-NEW.woff2': { type: 'asset', fileName: 'assets/GeistMono-latin-NEW.woff2' },
      'assets/Geist-latin-NEW.woff2': { type: 'asset', fileName: 'assets/Geist-latin-NEW.woff2' },
    } as unknown as OutputBundle;
    const manifest = startupManifest(bundle, '/braid/');
    expect(manifest.compare).toEqual(['/braid/compare-NEW.js', '/braid/branches-NEW.css', '/braid/code-NEW.js']);
    expect(manifest.search).toEqual(['/braid/search-NEW.js']);
    expect(manifest.mono).toEqual(['/braid/assets/GeistMono-latin-NEW.woff2']);
  });

  it('handles shared dependency cycles without adding a module twice', () => {
    const bundle: OutputBundle = {
      'code.js': chunk('code.js', '/app/src/screens/CodeScreen.tsx', ['shared.js']),
      'shared.js': chunk('shared.js', '/app/helper.ts', ['code.js']),
    };
    expect(startupManifest(bundle).code).toEqual(['/code.js', '/shared.js']);
  });
});
