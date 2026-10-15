import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rootFiles = new Set(['.env.example', '.gitignore', '.dockerignore', 'AGENTS.md', 'LICENSE', 'README.md', 'cloudflare.config.ts', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts']);
const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const files = [...new Set(candidates)].filter(path => (rootFiles.has(path) || /^(?:src|shared|worker|cli|scripts|docs|public|sandbox)\//.test(path))
  && !path.startsWith('public/source/') && !/(?:^|\/)(?:\.env(?!\.example$)|\.dev\.vars|\.cloudflare|node_modules|dist|coverage)(?:[./]|$)/.test(path)
  && !/\.(?:pem|key|p12|pfx|log)$/.test(path)
  // The index can still list files deleted from the working tree; only package what exists.
  && existsSync(path)).sort();
if (!files.includes('LICENSE') || !files.includes('README.md')) throw new Error('Source must include the README and MIT license.');
for (const path of files) {
  if (!lstatSync(path).isFile()) throw new Error(`Source archives require ordinary files: ${path}`);
  if (!/\.(?:woff2?|png|jpe?g|webp|ico)$/.test(path) && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(readFileSync(path, 'utf8'))) throw new Error(`Credential material found in ${path}; no archive was produced.`);
}
mkdirSync('public/source', { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'braid-source-'));
try {
  const manifest = join(directory, 'files.json');
  writeFileSync(manifest, JSON.stringify(files));
  execFileSync('python3', ['-c', `import json, sys, zipfile\nfrom pathlib import Path\nfiles=json.loads(Path(sys.argv[1]).read_text())\nwith zipfile.ZipFile('public/source/braid-source.zip','w',zipfile.ZIP_DEFLATED) as z:\n for file in files: z.write(file, 'braid/'+file)\nprint(f'Packaged {len(files)} source files with MIT license.')`, manifest], { stdio: 'inherit' });
} finally { rmSync(directory, { recursive: true, force: true }); }
