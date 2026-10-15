import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'rolldown';

const output = join(import.meta.dirname, 'dist/braid.mjs');
const read = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8').trim();

/**
 * Builds the `braid` command into one executable file. The CLI, @stricli/core, valibot and the shared provenance and
 * type modules are bundled in, so the published package has no runtime dependencies; only Node's own modules stay
 * outside.
 */
export default defineConfig({
  cwd: import.meta.dirname,
  input: join(import.meta.dirname, 'src/main.ts'),
  platform: 'node',
  output: { file: output, format: 'esm', banner: '#!/usr/bin/env node\n// Bundled and transformed by Braid. License notices: ./LICENSE', codeSplitting: false },
  plugins: [{
    name: 'package-files',
    generateBundle() {
      this.emitFile({
        type: 'asset', fileName: 'LICENSE',
        source: [
          'Braid\n\n' + read('../LICENSE'),
          'Bundled dependency: @stricli/core (Apache-2.0)\nhttps://github.com/bloomberg/stricli\n\n' + read('scripts/licenses/stricli.txt'),
          'Bundled dependency: valibot (MIT)\nhttps://github.com/open-circle/valibot\n\n' + read('../node_modules/valibot/LICENSE.md'),
        ].join('\n\n---\n\n') + '\n',
      });
    },
    writeBundle() {
      chmodSync(output, 0o755);
      const served = join(import.meta.dirname, '../public/cli');
      mkdirSync(served, { recursive: true });
      copyFileSync(output, join(served, 'braid-git.mjs'));
      copyFileSync(join(import.meta.dirname, 'dist/LICENSE'), join(served, 'LICENSE'));
    },
  }],
});
