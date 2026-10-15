import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { constants as system, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import * as v from 'valibot';
import { readRegularFile } from './config';
import { fail, note, type BraidContext } from './context';
import { git } from './git';
import type { Payload } from './schemas';
import { assertNoSecrets, hasSecret } from './secrets';
import { count, screenText } from './terminal';

/*
 * --proof runs .braid/proof.json in the repository and attaches what happened: each check's exit code and the end of
 * its output, failing or not, so Braid can send the change back with them, and screenshots of a local preview at
 * desktop and phone size taken by a local Playwright. Checks run with CI=true and without BRAID_ variables, each in
 * its own process group so stopping it stops everything it started, and must leave HEAD and tracked files alone.
 * Output that looks like a credential stops the submission.
 */

type Evidence = NonNullable<Payload['evidence']>[number];
const OUTPUT_LIMIT = 8000;
const IMAGE_LIMIT = 600_000;
const IMAGES_LIMIT = 4_000_000;
const RETAINED = 65_536;
const VIEWPORTS = [{ viewport: 'desktop', width: 1280, height: 800 }, { viewport: 'mobile', width: 390, height: 844 }] as const;
const LOCAL_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})\/?$/;
const PAGE = /^\/(?!\/)[^\s\\\x00-\x1f\x7f]{0,199}$/;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const NO_PLAYWRIGHT = /Executable doesn't exist|playwright install|npx canceled|missing packages/i;
const SCREENSHOTS_SKIPPED = 'Screenshots skipped: Playwright or its browser is not installed here. Enable them with: npx playwright install chromium';
const PROOF_FILE = '.braid/proof.json';

/* ---------- .braid/proof.json ---------- */

const line = (label: string) => {
  const message = `${label} in ${PROOF_FILE} is one line of at most 300 characters.`;
  return v.pipe(v.string(message), v.maxLength(300, message), v.check(value => !/[\x00-\x1f\x7f]/.test(value), message), v.trim(), v.nonEmpty(message));
};
const seconds = (label: string, fallback: number, max: number) => {
  const message = `${label} in ${PROOF_FILE} is a whole number of seconds from 1 to ${max}.`;
  return v.optional(v.pipe(v.number(message), v.integer(message), v.minValue(1, message), v.maxValue(max, message)), fallback);
};
const URL_MESSAGE = 'preview.url must be http://127.0.0.1, http://localhost or http://[::1] with a port, such as http://127.0.0.1:4319.';
const PAGES = `List 1 to 6 preview pages in ${PROOF_FILE}, each a path such as /settings starting with a single slash.`;
const CHECKS = `List at most 10 checks in ${PROOF_FILE}.`;
/** One-line shell checks, and optionally a preview served on a local port with the pages to screenshot. Unknown fields are refused. */
export const proofSchema = v.pipe(
  v.strictObject({
    checks: v.optional(v.pipe(v.array(line('Each check'), CHECKS), v.maxLength(10, CHECKS)), []),
    timeoutSeconds: seconds('timeoutSeconds', 600, 3600),
    preview: v.optional(v.strictObject({
      command: line('The preview command'),
      url: v.pipe(v.string(URL_MESSAGE), v.regex(LOCAL_URL, URL_MESSAGE), v.check(url => Number(LOCAL_URL.exec(url)?.[1]) <= 65_535, URL_MESSAGE), v.transform(url => new URL(url).origin)),
      pages: v.optional(v.pipe(v.array(v.pipe(v.string(PAGES), v.regex(PAGE, PAGES)), PAGES), v.minLength(1, PAGES), v.maxLength(6, PAGES)), ['/']),
      timeoutSeconds: seconds('preview.timeoutSeconds', 120, 600),
    }, `preview in ${PROOF_FILE} is an object with command, url, pages and timeoutSeconds.`)),
  }, `${PROOF_FILE} is an object with checks, timeoutSeconds and preview.`),
  v.check(proof => proof.checks.length > 0 || proof.preview !== undefined, `List checks or a preview in ${PROOF_FILE}.`),
  v.check(proof => !proof.preview || proof.checks.length <= 9, `List at most 9 checks with a preview in ${PROOF_FILE}; a preview that does not start is reported as the tenth.`),
);
type Proof = v.InferOutput<typeof proofSchema>;

/** Reads and checks the repository's proof file: a regular file of at most 16 KB, never followed through a symlink. */
export function readProof(root: string, secrets: readonly string[]): Proof {
  let bytes: Buffer | undefined;
  try { bytes = readRegularFile(join(root, PROOF_FILE), 16_384); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') fail(`Add ${PROOF_FILE} to use --proof; braid submit --help shows its format.`);
    if (code !== 'ELOOP') throw error;
  }
  const text = bytes?.toString('utf8') ?? fail(`${PROOF_FILE} must be a regular file of at most 16 KB.`);
  assertNoSecrets(text, secrets, `${PROOF_FILE} looks like it contains a credential. Keep secrets out of it; checks can read them from the environment.`);
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(undefined, `${PROOF_FILE} is not valid JSON.`), proofSchema), text);
  return parsed.success ? parsed.output : fail(parsed.issues[0].message);
}

/* ---------- output ---------- */

const withNote = (output: string, extra?: string) => !extra ? output : !output ? extra : `${output}${output.endsWith('\n') ? '' : '\n'}${extra}`;
const lastLine = (value: string) => screenText(value).split('\n').map(row => row.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? 'the screenshot tool failed.';

/** The end of what a command printed, as plain text. Output that looks like a credential stops the submission. */
function proofOutput(raw: string, command: string, secrets: readonly string[]) {
  const text = screenText(raw);
  if (hasSecret(text.slice(-(OUTPUT_LIMIT + 512)), secrets)) fail(`The output of ${command} looks like it contains a credential, so nothing was submitted. Stop it printing secrets, then submit again.`);
  const output = text.slice(-OUTPUT_LIMIT);
  return /^[\uDC00-\uDFFF]/.test(output) ? output.slice(1) : output;
}

/** The type and size of a PNG or JPEG from its header, or null for anything else. */
function imageInfo(bytes: Buffer): { contentType: 'image/png' | 'image/jpeg'; width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a && bytes.toString('latin1', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width && height ? { contentType: 'image/png', width, height } : null;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let offset = 2; offset + 9 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    // Start-of-frame segments carry the size; 0xc4, 0xc8 and 0xcc share the range but are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7);
      return width && height ? { contentType: 'image/jpeg', width, height } : null;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

/** A regular file the screenshot tool wrote, never followed through a symlink. */
function readImage(path: string) {
  try { return readRegularFile(path, 64 * 1024 * 1024); } catch { /* No file is a missing screenshot, which the caller reports. */ return undefined; }
}

/* ---------- processes ---------- */

interface Exit { code: number | null; signal: NodeJS.Signals | null; error?: Error }
interface Running { child: ChildProcess; ended: boolean; text(): string; closed: Promise<unknown>; exited: Promise<Exit> }
const exitStatus = ({ code, signal, error }: Exit) => error ? 127 : code ?? 128 + (signal ? system.signals[signal] ?? 0 : 0);

/**
 * The processes one proof starts. Each runs in its own process group (its process tree on Windows), so stopping it
 * stops everything it started. A signal to braid stops them all, and close stops whatever is left.
 */
function processSession(context: BraidContext) {
  const running = new Set<Running>(), windows = process.platform === 'win32';
  let stopped: string | undefined;
  const send = (run: Running, signal: NodeJS.Signals) => {
    try {
      if (windows) execFileSync('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-run.child.pid!, signal);
    } catch { /* Already gone. */ }
  };
  const alive = (run: Running) => {
    if (!run.child.pid) return false;
    if (windows) return !run.ended;
    try { process.kill(-run.child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  const stop = async (run: Running) => {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!alive(run)) return;
      send(run, signal);
      for (let waited = 0; waited < 2000 && alive(run); waited += 50) await pause(50);
    }
  };
  const listeners = SIGNALS.map(signal => [signal, () => { stopped ??= signal; for (const run of running) void stop(run); }] as const);
  for (const [signal, listener] of listeners) context.signals.on(signal, listener);
  const session = {
    check() { if (stopped) fail(`Stopped by ${stopped}. The checks and preview were stopped and nothing was submitted.`); },
    start(file: string, args: string[], options: SpawnOptions): Running {
      session.check();
      const child = spawn(file, args, { ...options, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const kept: Buffer[] = [];
      let size = 0;
      const keep = (chunk: Buffer) => {
        kept.push(chunk);
        size += chunk.length;
        if (size > 2 * RETAINED) { const recent = Buffer.concat(kept).subarray(-RETAINED); kept.splice(0, kept.length, recent); size = recent.length; }
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      const run: Running = {
        child, ended: false,
        text: () => Buffer.concat(kept).subarray(-RETAINED).toString('utf8'),
        closed: new Promise(resolve => child.once('close', resolve)),
        exited: new Promise<Exit>(resolve => {
          child.once('exit', (code, signal) => resolve({ code, signal }));
          child.once('error', error => resolve({ code: null, signal: null, error }));
        }).then(result => { run.ended = true; return result; }),
      };
      running.add(run);
      return run;
    },
    halt(run: Running) { void stop(run); },
    stop,
    /** Waits for the process, stops anything it left behind in its group and collects the rest of its output. */
    async finish(run: Running) {
      const result = await run.exited;
      await stop(run);
      await Promise.race([run.closed, pause(2000, undefined, { ref: false })]);
      run.child.stdout?.destroy();
      run.child.stderr?.destroy();
      running.delete(run);
      return result;
    },
    async close() {
      for (const [signal, listener] of listeners) context.signals.off(signal, listener);
      await Promise.all([...running].map(stop));
    },
  };
  return session;
}
type Session = ReturnType<typeof processSession>;

async function runCheck(context: BraidContext, session: Session, root: string, env: NodeJS.ProcessEnv, command: string, timeout: number, secrets: readonly string[]): Promise<Evidence> {
  const started = performance.now(), run = session.start(command, [], { cwd: root, env, shell: true });
  let late = false;
  const timer = setTimeout(() => { late = true; session.halt(run); }, timeout * 1000);
  const result = await session.finish(run);
  clearTimeout(timer);
  session.check();
  const exitCode = late ? 124 : exitStatus(result), durationMs = Math.round(performance.now() - started);
  const output = proofOutput(withNote(run.text(), late ? `Stopped after ${timeout} s.` : result.error?.message), command, secrets);
  note(context, `Proof: ${command} ${late ? `timed out after ${timeout} s` : `exited ${exitCode} after ${Math.round(durationMs / 1000)} s`}.`);
  return { kind: 'command', command, exitCode, output, durationMs };
}

/** Whether anything answers HTTP at the url, whatever the status. */
async function answering(context: BraidContext, url: string) {
  try {
    const response = await context.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return true;
  } catch { return false; }
}

/** The local Playwright command line, which npx finds without installing anything: playwright, or else playwright-core. */
async function playwright(session: Session, root: string, env: NodeJS.ProcessEnv) {
  // On Windows npx is a .cmd script that only a shell runs; its JavaScript entry point runs without one.
  const npx = process.platform === 'win32' ? [process.execPath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')] : ['npx'];
  if (npx.length > 1 && !existsSync(npx[1])) return undefined;
  for (const name of ['playwright', 'playwright-core']) {
    const [file, ...prefix] = npx, args = [...prefix, '--no-install', name];
    const run = session.start(file, [...args, '--version'], { cwd: root, env });
    const timer = setTimeout(() => session.halt(run), 60_000);
    const result = await session.finish(run);
    clearTimeout(timer);
    session.check();
    if (result.code === 0) return { file, args };
  }
  return undefined;
}

/** Screenshots every page at desktop and phone size; without Playwright or its browser they are skipped with one line on enabling them. */
async function screenshots(context: BraidContext, session: Session, root: string, env: NodeJS.ProcessEnv, preview: NonNullable<Proof['preview']>, folder: string) {
  const tool = await playwright(session, root, env), shots: Evidence[] = [];
  let total = 0;
  if (!tool) { note(context, SCREENSHOTS_SKIPPED); return shots; }
  for (const [index, page] of preview.pages.entries()) for (const view of VIEWPORTS) {
    // A .jpg name makes Playwright write a JPEG, which keeps each image far below the 600 KB limit.
    const file = join(folder, `${index}-${view.viewport}.jpg`);
    const run = session.start(tool.file, [...tool.args, 'screenshot', `--viewport-size=${view.width},${view.height}`, '--wait-for-timeout=1000', new URL(page, preview.url).href, file], { cwd: root, env });
    const timer = setTimeout(() => session.halt(run), 90_000);
    const result = await session.finish(run);
    clearTimeout(timer);
    session.check();
    const image = result.code === 0 ? readImage(file) : undefined, info = image && imageInfo(image);
    if (!info && NO_PLAYWRIGHT.test(run.text())) { note(context, SCREENSHOTS_SKIPPED); return shots; }
    if (!image || !info) note(context, `Proof: no ${view.viewport} screenshot of ${page}: ${lastLine(run.text())}`);
    else if (image.length > IMAGE_LIMIT) note(context, `Proof: the ${view.viewport} screenshot of ${page} is over 600 KB, so it is not attached.`);
    else if ((total += image.length) > IMAGES_LIMIT) note(context, `Proof: the ${view.viewport} screenshot of ${page} would take the screenshots past 4 MB, so it is not attached.`);
    else shots.push({ kind: 'screenshot', page, viewport: view.viewport, width: info.width, height: info.height, contentType: info.contentType, data: image.toString('base64') });
  }
  note(context, `Proof: ${count(shots.length, 'screenshot')} of ${preview.url}.`);
  return shots;
}

/** Starts the preview, waits for it to answer and screenshots its pages. A preview that never answers is reported as a failed command. */
async function previewEvidence(context: BraidContext, session: Session, root: string, env: NodeJS.ProcessEnv, preview: NonNullable<Proof['preview']>, folder: string, secrets: readonly string[]): Promise<Evidence[]> {
  if (await answering(context, preview.url)) fail(`Something already answers at ${preview.url}. Stop it so the screenshots show this checkout, then submit again.`);
  const started = performance.now(), run = session.start(preview.command, [], { cwd: root, env: { BROWSER: 'none', ...env }, shell: true });
  try {
    const deadline = context.now() + preview.timeoutSeconds * 1000;
    let ready = false;
    while (!ready && !run.ended && context.now() < deadline) {
      ready = await answering(context, preview.url);
      session.check();
      if (!ready) await Promise.race([context.sleep(250), run.exited]);
    }
    session.check();
    if (ready) return await screenshots(context, session, root, env, preview, folder);
    const early = run.ended;
    await session.stop(run);
    const result = await session.finish(run);
    const how = result.error ? result.error.message : result.code !== null ? `code ${result.code}` : result.signal;
    const reason = early ? `It exited with ${how} before ${preview.url} answered.` : `${preview.url} did not answer within ${preview.timeoutSeconds} s.`;
    note(context, `Proof: the preview did not start. ${reason}`);
    return [{ kind: 'command', command: preview.command, exitCode: early ? exitStatus(result) || 1 : 124, output: proofOutput(withNote(run.text(), reason), preview.command, secrets), durationMs: Math.round(performance.now() - started) }];
  } finally { await session.stop(run); }
}

/**
 * Runs a checked proof file in the repository and returns the evidence to attach; a failing check is evidence too.
 * Checks must leave HEAD and tracked files as they were, or the proof would not describe what is submitted.
 */
export async function runProof(context: BraidContext, root: string, proof: Proof, secrets: readonly string[]): Promise<Evidence[]> {
  const env: NodeJS.ProcessEnv = { CI: 'true', ...Object.fromEntries(Object.entries(context.env).filter(([key]) => !/^BRAID_/i.test(key))) };
  const state = () => [['rev-parse', '--verify', 'HEAD'], ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none']].map(args => git(context, args, { cwd: root }).toString('utf8')).join('\0');
  const before = state(), folder = mkdtempSync(join(tmpdir(), 'braid-proof-')), session = processSession(context);
  try {
    chmodSync(folder, 0o700);
    const evidence: Evidence[] = [];
    for (const command of proof.checks) evidence.push(await runCheck(context, session, root, env, command, proof.timeoutSeconds, secrets));
    if (proof.preview) evidence.push(...await previewEvidence(context, session, root, env, proof.preview, folder, secrets));
    if (state() !== before) fail('A check changed HEAD or tracked files, so its proof would not describe this submission. Undo or commit those changes, keep checks from editing tracked files, and submit again.');
    return evidence;
  } finally {
    await session.close();
    rmSync(folder, { recursive: true, force: true });
  }
}
