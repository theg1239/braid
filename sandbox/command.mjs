// Trusted supervisor, passed inline by the Worker so it does not depend on a new image.
// Receipts are root-owned. Repository code only runs in the unprivileged child.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, statfsSync } from 'node:fs';
import { constants } from 'node:os';
const job = JSON.parse(process.argv[1]);
const directory = '/var/lib/braid-commands';
const receipt = `${directory}/${job.id}.json`;
const pending = `${directory}/${job.id}.pending`;
const emit = result => process.stdout.write(JSON.stringify(result));
const empty = { stdout: '', stderr: '', outputTail: '', exitCode: 1, truncated: false };
try {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { const cached = readFileSync(receipt, 'utf8'); process.stdout.write(cached); process.exit(0); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { writeFileSync(pending, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') { emit({ ...empty, code: 'BRAID_COMMAND_INCOMPLETE' }); process.exit(0); } throw error; }
} catch (error) { emit({ ...empty, code: error.code }); process.exit(0); }
const oomCount = () => {
  try { const data = readFileSync('/sys/fs/cgroup/memory.events', 'utf8'); return Number(/^oom_kill (\d+)$/m.exec(data)?.[1] ?? 0); }
  catch { return undefined; }
};
const oomBefore = oomCount();
let tail = [];
const pendingLines = { stdout: '', stderr: '' }, inKey = { stdout: false, stderr: false };
const oversized = { stdout: false, stderr: false };
const markers = { stdout: '', stderr: '' }, keyLine = { stdout: false, stderr: false };
const rules = job.redaction.map(([source, flags]) => new RegExp(source, flags));
function redact(text) {
  for (const secret of job.secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w-]*)["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]');
  for (const rule of rules) text = text.replace(rule, '[redacted]');
  return text;
}
function line(channel, text) {
  tail.push(inKey[channel] || keyLine[channel] || oversized[channel] ? '[redacted]' : redact(text));
  tail = tail.slice(-40);
  oversized[channel] = false; keyLine[channel] = false; markers[channel] = '';
}
const started = Date.now();
const result = { stdout: '', stderr: '', exitCode: 0, truncated: false, outputTail: '', timeoutMs: job.timeout, elapsedMs: 0 };
const child = spawn(job.argv[0], job.argv.slice(1), { cwd: job.cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const channel of ['stdout', 'stderr']) {
  child[channel].setEncoding('utf8');
  child[channel].on('data', text => {
    const limit = channel === 'stdout' ? job.limit : 16384;
    result.truncated ||= result[channel].length + text.length > limit;
    result[channel] = (result[channel] + text).slice(0, limit);
    const pieces = text.split('\n');
    for (let index = 0; index < pieces.length; index++) {
      const scan = markers[channel] + pieces[index];
      for (const marker of scan.matchAll(/-----(BEGIN|END) (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/g)) {
        keyLine[channel] = true; inKey[channel] = marker[1] === 'BEGIN';
      }
      markers[channel] = scan.slice(-100);
      if (!oversized[channel]) pendingLines[channel] += pieces[index].slice(0, Math.max(0, 8192 - pendingLines[channel].length));
      if (pendingLines[channel].length === 8192) oversized[channel] = true;
      if (index < pieces.length - 1) { line(channel, pendingLines[channel]); pendingLines[channel] = ''; }
    }
  });
}
let killTimer;
const killGroup = signal => { try { process.kill(-child.pid, signal); } catch {} };
const timer = setTimeout(() => {
  result.timedOut = true; killGroup('SIGTERM');
  killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
}, job.timeout);
child.on('error', error => { result.code = error.code; });
child.on('close', (exitCode, signal) => {
  result.elapsedMs = Date.now() - started;
  clearTimeout(timer); clearTimeout(killTimer);
  result.exitCode = exitCode ?? -1;
  if (signal) result.signal = constants.signals[signal];
  const oomAfter = oomCount();
  if (oomBefore !== undefined && oomAfter !== undefined && oomAfter > oomBefore) result.oomKilled = true;
  if (result.exitCode !== 0) {
    try { if (statfsSync(job.cwd).bavail === 0) result.diskFull = true; } catch {}
  }
  for (const channel of ['stdout', 'stderr']) if (pendingLines[channel]) line(channel, pendingLines[channel]);
  result.outputTail = tail.map(text => text.length > 390 ? text.slice(0, 377) + ' [truncated]' : text).join('\n');
  try { writeFileSync(`${receipt}.tmp`, JSON.stringify(result), { mode: 0o600 }); renameSync(`${receipt}.tmp`, receipt); }
  catch (error) { result.code = error.code; result.exitCode = result.exitCode || 1; }
  emit(result);
});
