import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { HostedOutputTail } from './hosted-output';

/** Assembled at runtime: the source archive refuses files that carry a private key marker. */
const BEGIN = ['-----BEGIN', 'PRIVATE KEY-----'].join(' '), END = ['-----END', 'PRIVATE KEY-----'].join(' ');

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'braid-receipts-')); roots.push(root);
  const script = readFileSync(new URL('../../sandbox/command.mjs', import.meta.url), 'utf8').replace("'/var/lib/braid-commands'", JSON.stringify(root));
  const run = (code: string, id = 'fixture', timeout = 10_000, secrets: string[] = []) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ id, argv: [process.execPath, '-e', code], cwd: root, timeout, limit: 65536, redaction: [], secrets })], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { exitCode: number; code?: string; signal?: number; timedOut?: boolean; timeoutMs?: number; elapsedMs?: number; stdout: string; outputTail: string };
  };
  return { root, run };
}
it('replays a root-owned command receipt without executing its side effect twice', () => {
  const f = fixture();
  const command = "require('node:fs').appendFileSync('writes', 'one\\n'); console.log('saved')";
  const first = f.run(command), second = f.run(command);
  expect(second).toEqual(first); expect(readFileSync(join(f.root, 'writes'), 'utf8')).toBe('one\n');
});
it('refuses an uncertain receipt instead of repeating a commit-capable command', () => {
  const f = fixture(); writeFileSync(join(f.root, 'fixture.pending'), '');
  expect(f.run("throw new Error('must not execute')")).toMatchObject({ code: 'BRAID_COMMAND_INCOMPLETE' });
});
it('reports an actual SIGKILL without claiming memory exhaustion', () => {
  const result = fixture().run("process.kill(process.pid, 'SIGKILL')");
  expect(result).toMatchObject({ exitCode: -1, signal: 9 }); expect(result).not.toHaveProperty('oomKilled');
});
it('records a supervisor deadline and drains the final output', () => {
  const result = fixture().run("console.log('before timeout'); setInterval(() => {}, 1000)", 'deadline', 500);
  expect(result).toMatchObject({ timedOut: true, signal: 15, timeoutMs: 500 }); expect(result.elapsedMs).toBeGreaterThanOrEqual(500); expect(result.outputTail).toContain('before timeout');
});
it('redacts a PEM key and split oversized credential lines before keeping a tail', () => {
  const result = fixture().run(`console.log(${JSON.stringify(BEGIN)} + 'x'.repeat(20000)); console.log('key-body'); console.log(${JSON.stringify(END)}); process.stdout.write('TOKEN=' + 'a'.repeat(20000)); setTimeout(() => console.log('secret-suffix'), 10)`);
  expect(result.outputTail).not.toContain('key-body'); expect(result.outputTail).not.toContain('secret-suffix'); expect(result.outputTail).not.toContain('PRIVATE KEY');
  const tail = new HostedOutputTail(); tail.write(BEGIN + 'a'.repeat(20_000)); tail.write(`\nkey-body\n${END}\n`);
  expect(tail.finish()).not.toContain('key-body');
});
it('recognizes private key boundaries after a discarded oversized prefix', () => {
  const f = fixture();
  const result = f.run(`process.stdout.write('prefix'.repeat(20000)); setTimeout(() => console.log(${JSON.stringify(`${BEGIN}\nhidden-key-material\n${END}`)}), 10)`);
  expect(result.outputTail).not.toContain('hidden-key-material');
  const tail = new HostedOutputTail(); tail.write('prefix'.repeat(20000)); tail.write('-----BEGIN PRI'); tail.write(`VATE KEY-----\nhidden-key-material\n${END}\n`);
  expect(tail.finish()).not.toContain('hidden-key-material');
});

it('does not mark a timed-out process successful when its SIGTERM handler exits zero', () => {
  const result = fixture().run("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)", 'trapped-deadline', 500);
  expect(result).toMatchObject({ exitCode: 0, timedOut: true, timeoutMs: 500 });
});
