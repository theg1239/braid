// The shell: the JavaScript and CSS the built index.html loads before anything else, gzipped.
// Usage: node scripts/braid-shell.mjs [assets dir]
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
const root = process.argv[2] ?? '.cloudflare/output/v0/workers/default/assets';
const html = readFileSync(join(root, 'index.html'), 'utf8');
const files = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(match => match[1]))];
const sizes = files.map(file => [basename(file).replace(/-[\w-]{8}\.(js|css)$/, '.$1'), gzipSync(readFileSync(join(root, file)), { level: 9 }).length]);
const total = sizes.reduce((sum, [, size]) => sum + size, 0);
console.log(`shell ${(total / 1024).toFixed(1)} KB gz (${files.length} files): ${sizes.map(([name, size]) => `${name}=${(size / 1024).toFixed(1)}`).join(' ')}`);
