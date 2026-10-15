import { run } from '@stricli/core';
import { realpathSync } from 'node:fs';
import { basename, delimiter, dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { app } from './app';

if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('braid needs Node.js 22 or newer.\n');
  process.exit(1);
}

// A closed pipe, as in `braid log | head`, ends the output quietly.
process.stdout.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw error; });

const invoked = process.argv[1] ?? '';
let script = '';
try { script = realpathSync(invoked); } catch { /* Not started from a file. */ }
const onPath = (folder: string) => (process.env.PATH ?? '').split(delimiter).some(entry => entry && resolve(entry) === resolve(folder));
/** The commands braid prints start the way braid was started, so an agent can paste them as they are. */
const self = /[\\/]_npx[\\/]/.test(script) ? ['npx', 'braid-git'] : basename(invoked) === 'braid' && onPath(dirname(invoked)) ? ['braid'] : ['node', script];

const input = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

await run(app, process.argv.slice(2), {
  process, env: process.env, cwd: process.cwd(), fetch: globalThis.fetch, now: Date.now,
  sleep: ms => pause(ms), signals: process, parentPid: process.ppid, self, script, input,
});
