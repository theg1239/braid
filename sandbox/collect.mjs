// Trusted collector. Refusals have an explicit protocol code; stderr is evidence, never a classifier.
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { assertFullCheckout, validPath, decodeText, assertNoSecrets } from '/opt/braid/braid.mjs';
const base = process.argv[2];
const cwd = '/workspace/repository';
class CollectionFailure extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}
const refuse = code => { throw new CollectionFailure(code); };
const run = args => {
  const child = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.status !== 0) throw new CollectionFailure('command', { exitCode: child.status ?? -1, ...(child.signal ? { signal: constants.signals[child.signal] } : {}), ...(child.error?.code ? { code: child.error.code } : {}) });
  return child.stdout;
};
const text = args => new TextDecoder('utf-8', { fatal: true }).decode(run(args));
const tree = commit => new Map(text(['ls-tree', '-r', '-z', '-l', '--full-tree', commit]).split('\0').filter(Boolean).map(record => {
  const match = /^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
  if (!match) refuse('invalid');
  return [match[5], { mode: match[1], hash: match[3], size: match[4] === '-' ? 0 : Number(match[4]) }];
}));
const state = () => ({ head: text(['rev-parse', '--verify', 'HEAD']).trim(), index: run(['ls-files', '--stage', '-z']).toString('base64'), dirty: run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).length > 0 });
try {
  if (!/^[a-f0-9]{40}$/.test(base ?? '')) refuse('invalid');
  assertFullCheckout(cwd);
  run(['add', '--all', '--']);
  run(['-c', 'commit.gpgsign=false', '-c', 'user.name=Braid', '-c', 'user.email=agents@braid.local', 'commit', '--allow-empty', '-m', 'Prepare Braid proposal']);
  run(['merge-base', '--is-ancestor', base, 'HEAD']);
  const before = state();
  if (before.dirty) refuse('race');
  const priorTree = tree(base), nextTree = tree(before.head), files = [];
  let bytes = 0;
  for (const path of [...new Set([...priorTree.keys(), ...nextTree.keys()])].sort()) {
    const prior = priorTree.get(path), next = nextTree.get(path);
    if (prior && next && prior.hash === next.hash && prior.mode === next.mode) continue;
    if ([prior, next].some(entry => entry && !['100644', '100755'].includes(entry.mode)) || !validPath(path)) refuse('protected');
    if (files.length >= 256 || bytes + (next?.size ?? 0) > 3 * 1024 * 1024) refuse('limit');
    if (!next) { files.push({ path, content: null }); continue; }
    const data = run(['cat-file', 'blob', next.hash]);
    let content;
    try { content = decodeText(data); } catch { refuse('binary'); }
    try { assertNoSecrets(content, []); } catch { refuse('credential'); }
    files.push({ path, content, ...(next.mode !== (prior?.mode ?? '100644') ? { mode: next.mode } : {}) });
    bytes += data.length;
  }
  const after = state();
  if (after.dirty || after.head !== before.head || after.index !== before.index) refuse('race');
  if (!files.length) refuse('empty');
  process.stdout.write(JSON.stringify(files));
} catch (error) {
  process.stdout.write(JSON.stringify({ collectionFailure: error instanceof CollectionFailure ? { reason: error.code, ...error.detail } : { reason: 'command' } }));
  process.exitCode = 1;
}
