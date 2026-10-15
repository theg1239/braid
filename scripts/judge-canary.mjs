#!/usr/bin/env node
/** Signed-out deploy canary. Node 22+, optional playwright-core + Chromium. See docs/VERIFICATION.md.
 * node scripts/judge-canary.mjs [origin] [--mirrors] [--require-mirrors]
 * --mirrors-only runs just mirror API + Chromium checks (useful locally).
 * Mirrors are checked by default; BRAID_CANARY_MIRRORS=0 skips them.
 * --no-mirrors overrides that default. --require-mirrors fails a legacy-deploy skip.
 * No cookie jar, HTTP-error retries, tour sessions, or credentials.
 * EXCEPTION: --mirrors GET resolution may create/refresh octocat/Hello-World.
 * Do not enable against production until the integrator has deployed mirrors.
 * Only successful, explicitly pending import/blame responses are polled.
 * The only POSTs are MCP initialize/tools/list (protocol discovery, never tools/call).
 */
import { chromium } from 'playwright-core';
import { inflateRawSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { MirrorFailure as Failure, PUBLIC_MIRROR, NOT_FOUND, NOT_FOUND_CODE, RESERVED, validateMirror, githubReference } from './mirror-checks.mjs';

const started = performance.now();
const REQUEST_MS = 12_000, PAGE_MS = 8_000;
const abort = new AbortController();
const groups = [], failures = new Set();
let browser, finished = false, requests = 0;
function need(condition, reason) { if (!condition) throw new Failure(reason); }
function reason(error) {
  // Never dump response bodies, headers, cookies, console payloads, or launch environments.
  return error instanceof Failure ? error.message : `${error?.name || 'Error'} (check could not complete)`;
}
function group(name) {
  const value = { name, checks: 0, failures: new Set(), warnings: [], done: false };
  groups.push(value);
  return value;
}
function fail(g, label, message) {
  const line = `${g.name}: ${label}: ${message}`.replace(/[\r\n\t]+/g, ' ');
  g.failures.add(line);
  failures.add(line);
}
async function check(g, label, run) {
  g.checks++;
  try { return await run(); }
  catch (error) { fail(g, label, reason(error)); }
}
function complete(g, detail = '') {
  if (g.done || finished) return;
  g.done = true;
  console.log(`${g.failures.size ? 'FAIL' : g.skipped ? 'SKIP' : g.warnings.length ? 'WARN' : 'PASS'} ${g.name}: ${g.checks} checks${g.failures.size ? `; ${g.failures.size} failures` : ''}${detail ? `; ${detail}` : ''}${g.skipped ? `; ${g.skipped}` : ''}${g.warnings.length ? `; ${g.warnings.join('; ')}` : ''}`);
}
function finish() {
  if (finished) return;
  for (const g of groups.filter(g => !g.done)) {
    fail(g, 'incomplete', 'run deadline reached before all checks completed');
    complete(g);
  }
  finished = true;
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  const warnings = groups.reduce((n, g) => n + g.warnings.length, 0);
  console.log(`${failures.size ? 'FAIL' : 'PASS'} canary: ${((performance.now() - started) / 1000).toFixed(1)}s, ${requests} HTTP reads, ${warnings} warnings${failures.size ? `, ${failures.size} failures` : ''}; signed out; ${mirrorsEnabled ? 'GET mirror resolution may create/refresh the mirror; all other checks read-only' : 'read-only'}`);
  process.exitCode = failures.size ? 1 : 0;
}
let origin, mirrorsEnabled = process.env.BRAID_CANARY_MIRRORS !== '0', mirrorsOnly = false, requireMirrors = false;
try {
  const args = process.argv.slice(2), addresses = args.filter(arg => !arg.startsWith('--'));
  const usage = 'usage: node scripts/judge-canary.mjs [origin] [--mirrors|--no-mirrors|--mirrors-only] [--require-mirrors]';
  if (args.includes('--help')) { console.log(`${usage}\n--mirrors first visit may create/refresh a mirror. Enable only after deployment.\nMirrors are on by default; --no-mirrors skips them. --require-mirrors prevents legacy skips.`); process.exit(0); }
  need(addresses.length <= 1 && args.filter(arg => arg.startsWith('--')).every(arg => ['--mirrors', '--no-mirrors', '--mirrors-only', '--require-mirrors'].includes(arg)), usage);
  need(!(args.includes('--no-mirrors') && args.some(arg => ['--mirrors', '--mirrors-only', '--require-mirrors'].includes(arg))), usage);
  mirrorsOnly = args.includes('--mirrors-only');
  requireMirrors = args.includes('--require-mirrors');
  mirrorsEnabled = args.includes('--no-mirrors') ? false : mirrorsEnabled || mirrorsOnly || requireMirrors || args.includes('--mirrors');
  const url = new URL(addresses[0] || 'https://braid-git.acmvit.workers.dev');
  need(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', usage);
  origin = url.origin;
} catch (error) {
  console.log(`FAIL canary: ${error instanceof Failure ? error.message : 'invalid origin'}`);
  process.exit(1);
}
const RUN_MS = mirrorsEnabled ? 180_000 : 110_000;
if (mirrorsEnabled) console.log(`INFO mirrors: first GET visit to /${PUBLIC_MIRROR} may create the mirror; later visits may refresh it. All other checks remain read-only.`);
const watchdog = setTimeout(async () => {
  abort.abort();
  finish();
  await Promise.race([browser?.close().catch(() => {}), delay(1500)]);
  process.exit(1);
}, RUN_MS);

async function pool(items, count, run) {
  let index = 0;
  await Promise.allSettled(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (index < items.length && !abort.signal.aborted) await run(items[index++]);
  })).then(results => { for (const result of results) if (result.status === 'rejected') throw result.reason; });
}
let inFlight = 0;
const waiting = [];
async function limited(run) {
  if (inFlight >= 6) await new Promise(resolve => waiting.push(resolve));
  else inFlight++;
  try { return await run(); }
  finally { if (waiting.length) waiting.shift()(); else inFlight--; }
}
const sha = value => typeof value === 'string' && /^[a-f\d]{40}$/i.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const query = (path, values = {}) => {
  const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined));
  return `${path}${params.size ? `?${params}` : ''}`;
};
function checkSession(headers) {
  need(!/\bbraid-(?:demo|demo-shared|session|owner)=/i.test(headers.get('set-cookie') || ''), 'read unexpectedly issued a session cookie');
}
async function fetchRead(path, { workspace, rpc, kind = 'json', crawler = false, timeoutMs, acceptedStatuses = [200], withStatus = false } = {}) {
  return limited(async () => {
    need(!abort.signal.aborted, 'run deadline reached');
    const url = new URL(path, origin);
    need(url.origin === origin, 'refused an off-origin request');
    need(!rpc || url.pathname === '/mcp' && ['initialize', 'tools/list'].includes(rpc.method), 'refused a write request');
    const method = rpc ? 'POST' : 'GET';
    const timeout = timeoutMs ?? (kind === 'zip' ? 20_000 : REQUEST_MS);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]);
    requests++;
    try {
      const response = await fetch(url, {
        method, credentials: 'omit', redirect: 'manual', signal,
        headers: {
          Accept: rpc ? 'application/json, text/event-stream' : kind === 'json' ? 'application/json' : '*/*',
          ...(workspace ? { 'X-Braid-Workspace': workspace } : {}),
          ...(rpc ? { 'Content-Type': 'application/json' } : {}),
          ...(crawler ? { 'User-Agent': 'Twitterbot/1.0' } : {}),
        },
        ...(rpc ? { body: JSON.stringify(rpc) } : {}),
      });
      checkSession(response.headers);
      if (!acceptedStatuses.includes(response.status)) {
        await response.body?.cancel();
        throw new Failure(`HTTP ${response.status} ${method} ${path}`);
      }
      const cap = kind === 'zip' ? 64 * 1024 * 1024 : 8 * 1024 * 1024;
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        need(bytes <= cap, `response exceeds ${cap / 1024 / 1024} MiB: ${path}`);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const type = response.headers.get('content-type') || '';
      if (kind === 'json') {
        need(/application\/json/i.test(type), `expected JSON: ${path}`);
        try { const data = JSON.parse(body.toString('utf8')); return withStatus ? { status: response.status, data } : data; }
        catch { throw new Failure(`invalid JSON: ${path}`); }
      }
      if (kind === 'html') need(/text\/html/i.test(type), `expected HTML: ${path}`);
      if (kind === 'text') need(/text\/(plain|markdown)/i.test(type), `expected text: ${path}`);
      if (kind === 'png') need(/image\/png/i.test(type), `expected PNG: ${path}`);
      return kind === 'png' || kind === 'zip' ? body : body.toString('utf8');
    } catch (error) {
      if (signal.aborted) throw new Failure(`request exceeded ${timeout / 1000}s: ${method} ${path}`);
      if (error instanceof Failure) throw error;
      throw new Failure(`network/body read failed: ${method} ${path}`);
    }
  });
}
async function read(g, label, path, workspace, validate) {
  return check(g, label, async () => {
    const value = await fetchRead(path, { workspace });
    validate(value);
    return value;
  });
}
function state(value, mode) {
  const p = value?.project;
  need(p && typeof p.id === 'string' && typeof p.head === 'string' && text(p.branch), 'missing project identity, head or default branch');
  need(value.capabilities?.mode === mode && value.capabilities?.authenticated === false, 'expected a signed-out workspace');
  // The tour advertises editable controls before a first write creates a session.
  // We never exercise those controls; public live repositories must be read-only.
  need(mode === 'demo' || value.capabilities?.canWrite === false, 'public workspace unexpectedly permits writes');
  need(!value.importing, 'repository is importing; cannot certify its reads');
}
function tree(value, populated = true) {
  need(value && typeof value.ref === 'string' && Array.isArray(value.entries) && (value.nextCursor === null || typeof value.nextCursor === 'string'), 'invalid tree response');
  need(!populated || sha(value.ref) && value.entries.length > 0, 'tree has no commit or entries');
  need(value.entries.every(entry => text(entry.path) && text(entry.name) && ['dir', 'file', 'symlink', 'submodule'].includes(entry.kind)), 'invalid tree entry');
}
function history(value, populated = true) {
  need(value && Array.isArray(value.items) && typeof value.ref === 'string', 'invalid history response');
  need(!populated || sha(value.ref) && value.items.length > 0, 'history has no commit or entries');
  need(value.items.every(item => sha(item.hash) && text(item.title) && text(item.author?.name)), 'invalid commit content');
}
function file(value, path, requireContent = false) {
  need(value?.path === path && sha(value.ref) && typeof value.content === 'string', 'invalid file response');
  need(!requireContent || text(value.content), 'file has no source content');
  need(!value.kind || ['text', 'binary', 'large', 'symlink'].includes(value.kind), 'expected a file, received a directory or submodule');
}
function blame(value, path, populated = true) {
  need(value?.path === path && sha(value.ref) && Number.isInteger(value.lines) && value.lines >= 0 && Array.isArray(value.ranges), 'invalid blame response');
  need(!populated || value.lines > 0 && value.ranges.length > 0, 'blame has no line attribution');
  need(value.ranges.every(range => range.start >= 1 && range.lines > 0 && sha(range.provenance?.commit) && text(range.provenance?.kind)), 'invalid blame attribution');
}
async function readBlame(g, label, path, ref, workspace) {
  return check(g, label, async () => {
    const url = query('/api/blame', { ref, path });
    let value = await fetchRead(url, { workspace });
    const deadline = performance.now() + 8000;
    // Public cold blame is prepared asynchronously. HTTP errors still fail on
    // their first occurrence; an empty 200 never masquerades as attribution.
    while (value?.pending === true && value.ranges?.length === 0) {
      need(performance.now() + 500 < deadline, 'blame still preparing after 8s');
      await delay(500, undefined, { signal: abort.signal });
      value = await fetchRead(url, { workspace, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) });
    }
    blame(value, path, false);
    return value;
  });
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function sourceZip(bytes) {
  // Inspect the ZIP central directory, then decompress and CRC-check just the two
  // required documents in memory. No shell, extraction, install, or archive writes.
  need(bytes.length >= 22 && bytes.readUInt32LE(0) === 0x04034b50, 'source download is not a ZIP');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && !(bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length)) end--;
  need(end >= Math.max(0, bytes.length - 65557), 'ZIP end directory is missing');
  need(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, 'unsupported multipart ZIP');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  need(count > 0 && count < 65535 && offset + size === end, 'invalid ZIP directory bounds');
  const found = new Set();
  for (let i = 0; i < count; i++) {
    need(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, 'invalid ZIP directory entry');
    const length = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    need(next <= end, 'truncated ZIP directory');
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
    if (/^(?:braid\/)?(?:LICENSE|README(?:\.md)?)$/.test(name)) {
      const method = bytes.readUInt16LE(offset + 10), packed = bytes.readUInt32LE(offset + 20), unpacked = bytes.readUInt32LE(offset + 24);
      const local = bytes.readUInt32LE(offset + 42);
      need(!(bytes.readUInt16LE(offset + 8) & 1) && [0, 8].includes(method) && unpacked > 0 && unpacked <= 2 * 1024 * 1024, 'invalid required ZIP document');
      need(local + 30 <= offset && bytes.readUInt32LE(local) === 0x04034b50, 'missing ZIP local entry');
      const begin = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      need(begin + packed <= offset, 'truncated ZIP document');
      const content = method === 8 ? inflateRawSync(bytes.subarray(begin, begin + packed), { maxOutputLength: 2 * 1024 * 1024 }) : bytes.subarray(begin, begin + packed);
      need(content.length === unpacked && crc32(content) === bytes.readUInt32LE(offset + 16) && text(content.toString('utf8')), 'corrupt or empty ZIP document');
      found.add(name.split('/').at(-1).split('.')[0]);
    }
    offset = next;
  }
  need(offset === end && found.has('LICENSE') && found.has('README'), 'ZIP must contain LICENSE and README');
}
function tags(html) {
  const result = new Map();
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(([, name, , value]) => [name.toLowerCase(), value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")]));
    if (attrs.property || attrs.name) result.set(attrs.property || attrs.name, attrs.content);
  }
  return result;
}
const httpGroup = group('HTTP / docs / downloads / MCP');
const ogGroup = group('crawler Open Graph');
const tourGroup = group('tour API');
const directoryGroup = group('public discovery');
const browserGroups = [group('Chromium 1440x900'), group('Chromium 390x844')];
const mirrorGroup = mirrorsEnabled ? group('GitHub mirrors') : null;

async function mirrorChecks() {
  const g = mirrorGroup, path = `/api/repos/${PUBLIC_MIRROR}`;
  const response = await check(g, 'resolve public mirror', () => fetchRead(path, { acceptedStatuses: [200, 202, 404], withStatus: true }));
  if (!response) { complete(g); return; }
  if (response.status === 404 && response.data?.error === 'Repository not found.') {
    if (requireMirrors) fail(g, 'deployment', 'mirrors not deployed (--require-mirrors forbids skipping)');
    else g.skipped = 'mirrors not deployed';
    complete(g);
    return;
  }
  const address = await check(g, 'mirror metadata / import completion', async () => {
    need(response.status !== 404, `public mirror returned HTTP 404 (${response.data?.error || 'missing error'})`);
    let value = validateMirror(response.data);
    const id = value.workspaceId, deadline = performance.now() + 60_000;
    while (value.mirror.importing) {
      need(performance.now() + 1000 < deadline, 'mirror still importing after 60s');
      await delay(1000, undefined, { signal: abort.signal });
      value = validateMirror(await fetchRead(path, { acceptedStatuses: [200, 202], timeoutMs: Math.max(1, Math.min(REQUEST_MS, Math.ceil(deadline - performance.now()))) }));
      need(value.workspaceId === id, 'import polling resolved to a different workspace');
    }
    need(value.mirror.syncedAt !== null, 'readable mirror has no syncedAt');
    return value;
  });
  // These are bounded negative reads even if the public import failed. The
  // reserved routes must keep the local 404, never GitHub's error or a mirror.
  await pool([
    ['nonexistent repository', '/api/repos/octocat/braid-canary-missing-7b204bc6d3a9', NOT_FOUND],
    ...RESERVED.map(owner => [`reserved /${owner}/x`, `/api/repos/${owner}/x`, 'Repository not found.']),
  ], 2, ([label, url, error]) => check(g, label, async () => {
    const value = await fetchRead(url, { acceptedStatuses: [404] });
    need(value?.error === error && !value.mirror && !value.workspaceId, `expected 404 ${error}`);
    if (error === NOT_FOUND) need(value.code === NOT_FOUND_CODE, `expected code ${NOT_FOUND_CODE}`);
  }));
  if (!address) { complete(g); return; }
  const upstream = await check(g, 'GitHub HEAD + README oracle', () => githubReference(PUBLIC_MIRROR, { signal: abort.signal, onRequest: () => requests++ }));
  if (!upstream) { complete(g); return; }
  const workspace = address.workspaceId;
  await read(g, 'state matches GitHub', '/api/state', workspace, value => {
    state(value, 'live');
    need(value.project.head === upstream.head, `mirror HEAD ${value.project.head} differs from GitHub ${upstream.head}`);
    need(value.project.branch === upstream.branch, 'mirror default branch differs from GitHub');
  });
  const refs = [['default (omitted)', undefined], [`branch ${upstream.branch}`, upstream.branch], [`SHA ${upstream.head.slice(0, 7)}`, upstream.head]];
  await pool(refs, 2, async ([label, ref]) => {
    await read(g, `${label} tree`, query('/api/repository/tree', { ref }), workspace, value => {
      tree(value);
      need(value.ref === upstream.head && value.entries.some(entry => entry.path === upstream.path && entry.kind === 'file'), 'tree differs from GitHub HEAD or omits README');
    });
    await read(g, `${label} README`, query('/api/repository', { ref, path: upstream.path }), workspace, value => {
      file(value, upstream.path, true);
      need(value.ref === upstream.head && value.content === upstream.readme, 'README bytes or commit differ from GitHub at HEAD');
    });
    await read(g, `${label} history`, query('/api/repository/commits', { ref }), workspace, value => {
      history(value);
      need(value.ref === upstream.head && value.items[0].hash === upstream.head, 'history does not start at GitHub HEAD');
    });
    const b = await readBlame(g, `${label} blame`, upstream.path, ref, workspace);
    if (b) await check(g, `${label} blame coverage`, () => {
      blame(b, upstream.path);
      need(b.ref === upstream.head, 'blame returned a different commit');
      const lines = upstream.readme.replace(/\n$/, '').split('\n').length;
      need(b.lines === lines, 'blame line count differs from GitHub README');
      let next = 1;
      for (const range of [...b.ranges].sort((a, z) => a.start - z.start)) { need(range.start === next, 'blame has a gap or overlapping attribution'); next += range.lines; }
      need(next === lines + 1, 'blame does not cover the complete README');
    });
  });
  complete(g, `GitHub HEAD ${upstream.head}; default / branch / SHA`);
  return { name: PUBLIC_MIRROR, path: `/${PUBLIC_MIRROR}`, readme: upstream.readme.trim() };
}

async function httpChecks() {
  await pool(['/', '/explore', '/llms.txt', '/setup.md', '/source/braid-source.zip', '/og.png', '/mcp'], 4, path => check(httpGroup, path, async () => {
    if (path === '/mcp') {
      const init = await fetchRead(path, { rpc: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'braid-canary', version: '1' } } } });
      need(init.id === 1 && init.result?.serverInfo?.name === 'braid' && init.result?.capabilities?.tools, 'MCP initialize has no Braid tool capability');
      const catalog = await fetchRead(path, { rpc: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
      const tools = catalog.result?.tools;
      need(catalog.id === 2 && Array.isArray(tools) && tools.length > 0, 'MCP has no tool catalog');
      for (const name of ['get_rules', 'get_repository', 'files_in_progress', 'create_pull_request', 'get_pull_request', 'list_pull_request_review_comments', 'add_reply_to_pull_request_comment']) need(tools.some(tool => tool.name === name && tool.inputSchema?.type === 'object'), `MCP is missing documented tool ${name}`);
    } else if (path.endsWith('.zip')) sourceZip(await fetchRead(path, { kind: 'zip' }));
    else if (path.endsWith('.png')) {
      const png = await fetchRead(path, { kind: 'png' });
      need(png.length > 100 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.toString('ascii', 12, 16) === 'IHDR' && png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630, 'og.png is not a 1200x630 PNG');
    } else if (path.endsWith('.txt') || path.endsWith('.md')) {
      const body = await fetchRead(path, { kind: 'text' });
      need(body.startsWith('# ') && body.includes('Braid'), 'missing guide content');
      if (path === '/llms.txt') for (const word of ['/setup.md', '/source/braid-source.zip', '/mcp', 'initialize', 'tools/list', 'X-Braid-Workspace: demo']) need(body.includes(word), `llms.txt is missing ${word}`);
    } else need(/<html\b/i.test(await fetchRead(path, { kind: 'html' })), 'missing HTML document');
  }));
  complete(httpGroup);
}
async function ogChecks() {
  await pool([
    ['/', /Braid/i],
    ['/example/relay/pull/23', /Pull request #23.*example\/relay/i],
    ['/example/relay/blob/main/src/delivery.ts', /src\/delivery\.ts.*example\/relay/i],
  ], 3, ([path, title]) => check(ogGroup, path, async () => {
    const meta = tags(await fetchRead(path, { kind: 'html', crawler: true }));
    for (const property of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:image', 'og:image:alt']) need(text(meta.get(property)), `missing ${property}`);
    need(title.test(meta.get('og:title')), 'Open Graph title does not describe this route');
    need(meta.get('og:image') === `${origin}/og.png` && meta.get('og:image:width') === '1200' && meta.get('og:image:height') === '630', 'incorrect Open Graph image or dimensions');
    need(meta.get('twitter:card') === 'summary_large_image', 'missing large Twitter card');
  }));
  complete(ogGroup);
}
async function tourChecks() {
  const checks = [
    ['state', '/api/state', value => { state(value, 'demo'); need(sha(value.project.head) && text(value.project.id), 'tour has no project/head'); }],
    ['tree', '/api/repository/tree', value => tree(value)],
    ['file', '/api/repository?path=src%2Fdelivery.ts', value => file(value, 'src/delivery.ts', true)],
    ['history', '/api/repository/commits', value => history(value)],
    ['blame', '/api/blame?path=src%2Fdelivery.ts', value => blame(value, 'src/delivery.ts')],
    ['queue', '/api/queue', value => need(text(value?.branch) && sha(value.head) && Array.isArray(value.recent) && value.recent.length > 0 && typeof value.queued === 'number', 'queue has no branch, head or recorded batches')],
    ['pull requests', '/api/changes?limit=5', value => need(value?.items?.length > 0 && value.items.every(item => item.number > 0 && text(item.title)), 'pull request list has no real items')],
    ['pull request #23', '/api/changes/23', value => need(value?.number === 23 && text(value.title) && value.files?.length > 0 && value.html_url?.endsWith('/example/relay/pull/23'), 'pull request has no title, files or browser URL')],
    ['compare', '/api/repository/compare?base=main&head=refund-rounding', value => need(value?.status === 'ready' && sha(value.base) && sha(value.head) && value.commits?.length > 0 && value.files?.length > 0, 'comparison has no commits/files')],
    ['search', '/api/repository/search?q=delivery', value => need(sha(value?.ref) && value.matchCount > 0 && value.results?.some(result => result.matches?.some(match => text(match.content) && match.line > 0)), 'search has no source matches')],
  ];
  await pool(checks, 4, ([label, path, validate]) => read(tourGroup, label, path, 'demo', validate));
  complete(tourGroup);
}
async function discover() {
  const repos = [], cursors = new Set();
  let cursor;
  do {
    const page = await read(directoryGroup, `page ${cursors.size + 1}`, query('/api/repos', { limit: '100', cursor }), undefined, value => {
      need(Array.isArray(value?.items) && (value.nextCursor === null || text(value.nextCursor)), 'invalid repository directory');
      need(value.items.every(item => /^[a-z0-9-]+$/.test(item.owner?.slug) && /^[a-z0-9-]+$/.test(item.repo?.slug)), 'invalid repository address');
      need(!value.nextCursor || !cursors.has(value.nextCursor), 'repository directory repeats its cursor');
    });
    if (!page) break;
    for (const item of page.items) {
      const name = `${item.owner.slug}/${item.repo.slug}`;
      if (!repos.some(repo => repo.name === name)) repos.push({ name, path: `/${name}` });
    }
    cursor = page.nextCursor;
    if (cursor) cursors.add(cursor);
  } while (cursor && !abort.signal.aborted);
  if (!repos.length) fail(directoryGroup, 'coverage', 'no public repositories discovered');
  complete(directoryGroup, `${repos.length} repositories`);
  return repos;
}
async function chooseFile(repo, root) {
  const pending = [{ path: '', value: root }], visited = new Set();
  for (let i = 0; pending.length && i < 16; i++) {
    const next = pending.shift();
    const value = next.value || await fetchRead(query('/api/repository/tree', { ref: repo.project.head, path: next.path, cursor: next.cursor }), { workspace: repo.workspace });
    tree(value, false);
    const files = value.entries.filter(entry => entry.kind === 'file');
    const found = files.find(entry => /^readme(?:\.(md|markdown|txt|rst))?$/i.test(entry.name)) || files[0];
    if (found) return found.path;
    if (value.nextCursor) pending.unshift({ path: next.path, cursor: value.nextCursor });
    for (const entry of value.entries.filter(entry => entry.kind === 'dir' && !visited.has(entry.path))) {
      visited.add(entry.path);
      pending.push({ path: entry.path });
    }
  }
  throw new Failure('no readable file found within 16 tree pages; file/blame coverage incomplete');
}
async function repositoryChecks(repo) {
  const g = group(`public ${repo.name}`);
  const address = await read(g, 'resolve', `/api/repos${repo.path}`, undefined, value => need(text(value?.workspaceId) && value.visibility === 'public' && value.canWrite === false, 'expected public read-only repository address'));
  if (!address) { complete(g); return; }
  repo.workspace = address.workspaceId;
  const snapshot = await read(g, 'state', '/api/state', repo.workspace, value => state(value, 'live'));
  if (!snapshot) { complete(g); return; }
  repo.project = snapshot.project;
  if (!repo.project.head) {
    const [t, h] = await Promise.all([
      read(g, 'empty tree', '/api/repository/tree', repo.workspace, value => { tree(value, false); need(value.ref === '' && value.entries.length === 0 && value.nextCursor === null, 'headless repository has tree content'); }),
      read(g, 'empty history', '/api/repository/commits', repo.workspace, value => { history(value, false); need(value.ref === '' && value.items.length === 0 && value.nextCursor === null, 'headless repository has history'); }),
    ]);
    if (t && h && !Object.keys(snapshot.files || {}).length) {
      repo.empty = true;
      g.warnings.push('genuinely empty (state, tree and history agree); no file/blame refs');
    } else fail(g, 'empty detection', 'could not establish a genuinely empty repository');
    complete(g);
    return;
  }
  if (!sha(repo.project.head)) { fail(g, 'state', 'head is not a full commit SHA'); complete(g); return; }
  const refs = [['default (omitted)', undefined], [`branch ${repo.project.branch}`, repo.project.branch], [`SHA ${repo.project.head.slice(0, 7)}`, repo.project.head]];
  const trees = new Map();
  await pool(refs.flatMap(([label, ref]) => [
    async () => {
      const t = await read(g, `${label} tree`, query('/api/repository/tree', { ref }), repo.workspace, value => {
        tree(value, false);
        need(sha(value.ref), 'tree has no pinned commit');
        need(ref !== repo.project.head || value.ref === ref, 'SHA tree returned a different commit');
      });
      if (t) trees.set(label, t);
    },
    () => read(g, `${label} history`, query('/api/repository/commits', { ref }), repo.workspace, value => {
      history(value);
      need(ref !== repo.project.head || value.ref === ref, 'SHA history returned a different commit');
    }),
  ]), 4, run => run());
  // Discover the path at the SHA even if the named/default tree is broken. Do not
  // accidentally skip file and blame probes when a branch lookup returns 404.
  const root = trees.get(refs[2][0]) || trees.get(refs[0][0]) || trees.get(refs[1][0]);
  if (!root) { fail(g, 'file/blame coverage', 'all trees failed; no file can be selected'); complete(g); return; }
  if (root.entries.length === 0 && root.nextCursor === null) {
    repo.empty = true;
    g.warnings.push('empty committed tree; history checked, no files to blame');
    complete(g);
    return;
  }
  const path = await check(g, 'select README/first file', () => chooseFile(repo, root));
  if (path) await pool(refs, 3, async ([label, ref]) => {
    const [f, b] = await Promise.all([
      read(g, `${label} file ${path}`, query('/api/repository', { ref, path }), repo.workspace, value => file(value, path)),
      readBlame(g, `${label} blame ${path}`, path, ref, repo.workspace),
    ]);
    if (f && b && text(f.content) && (!f.kind || f.kind === 'text') && (!b.lines || !b.ranges.length)) fail(g, `${label} blame`, 'nonempty source has no line attribution');
    if (ref === repo.project.head && f && b && (f.ref !== ref || b.ref !== ref)) fail(g, `${label} pin`, 'file or blame returned a different commit');
  });
  complete(g, 'default / branch / SHA');
}

function pageReady({ kind, empty, readme }) {
  const shown = node => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden';
  // Pierre renders extensionless README code inside an open shadow root.
  const visibleText = node => (node?.innerText || '') + [...(node?.querySelectorAll('*') || [])].filter(child => child.shadowRoot).map(child => visibleText(child.shadowRoot)).join('') + (node instanceof ShadowRoot ? node.textContent : '');
  const main = document.querySelector('main');
  if (!shown(main) || [...main.querySelectorAll('[aria-busy="true"], .skeleton-line, .code--pending')].some(shown)) return false;
  if (kind === 'landing') return shown(main.querySelector('h1')) && /agent fleets/i.test(main.innerText);
  if (kind === 'pull') return shown(main.querySelector('.pull-head__title')) && /#23\b/.test(main.innerText) && shown(main.querySelector('.pull-body'));
  if (kind === 'blame') return shown(main.querySelector('.blame__line')) && shown(main.querySelector('.blame__name')) && /DeliveryResult/.test(main.innerText);
  if (kind === 'mirror') return shown(main.querySelector('.listing__row')) && [...main.querySelectorAll('.listing__name')].some(node => shown(node) && node.textContent === 'README') && shown(main.querySelector('.readme')) && visibleText(main.querySelector('.readme')).includes(readme);
  if (empty) return /This repository is empty|No files/i.test(main.innerText);
  return shown(main.querySelector('.listing__row'));
}
async function browserPage(g, target, viewport) {
  await check(g, target.label, async () => {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    let closing = false;
    const label = target.label;
    try {
      await context.route('**/*', async route => {
        const request = route.request();
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          fail(g, label, `blocked attempted ${request.method()} ${new URL(request.url()).pathname}; no write sent`);
          await route.abort('blockedbyclient');
          return;
        }
        const headers = { ...request.headers() };
        delete headers.cookie;
        delete headers.authorization;
        await route.continue({ headers });
      });
      await context.routeWebSocket('**/*', socket => {
        const base = new URL(origin), url = new URL(socket.url());
        if (['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && url.host === base.host && url.pathname === '/' && url.searchParams.has('token')) {
          // Keep Vite's local-only HMR client quiet without connecting to the
          // server. No messages are forwarded and no product socket is allowed.
          socket.onMessage(() => {});
          return;
        }
        fail(g, label, 'blocked unexpected WebSocket; no messages sent'); socket.close();
      });
      const page = await context.newPage();
      // boot.js reads README.md beside the file list before it knows one exists; a repository without one answers 404,
      // which the browser also logs. That read is expected to miss, so it is neither a failed request nor a console error.
      const speculative = (url) => url.pathname === '/api/repository' && url.searchParams.get('ref') === '' && url.searchParams.get('path') === 'README.md';
      page.on('console', message => {
        if (message.type() === 'error') {
          const source = message.location();
          let path = 'page';
          try { const url = new URL(source.url); if (speculative(url)) return; path = url.pathname; } catch {}
          fail(g, label, `console.error at ${path}:${(source.lineNumber || 0) + 1} (payload omitted)`);
        }
      });
      page.on('pageerror', () => fail(g, label, 'uncaught JavaScript error'));
      page.on('response', response => {
        const url = new URL(response.url()), status = response.status();
        if (status >= 500 || status === 404 && url.pathname.startsWith('/api/') && !speculative(url)) fail(g, label, `HTTP ${status} ${url.pathname}${url.search}`);
        if (/\bbraid-(?:demo|demo-shared|session|owner)=/i.test(response.headers()['set-cookie'] || '')) fail(g, label, 'read unexpectedly issued a session cookie');
      });
      page.on('requestfailed', request => {
        const error = request.failure()?.errorText;
        if (!closing && error !== 'net::ERR_ABORTED') fail(g, label, `failed ${request.method()} ${new URL(request.url()).pathname} (${error || 'transport error'})`);
      });
      const deadline = performance.now() + PAGE_MS;
      try {
        const response = await page.goto(`${origin}${target.path}`, { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
        need(response?.status() === 200, `document HTTP ${response?.status() || 'missing'}`);
        await page.waitForFunction(pageReady, target, { timeout: Math.max(1, deadline - performance.now()), polling: 100 });
      } catch (error) {
        if (error instanceof Failure) throw error;
        throw new Failure('main content not ready within 8s (missing content, error page or stuck skeleton)');
      }
      // Briefly observe late hydration/API errors; no unbounded networkidle wait.
      await page.waitForTimeout(500);
      need(await page.evaluate(pageReady, target), 'main content regressed to missing/loading after rendering');
      if (target.kind === 'landing') need(!/\bexample\b/i.test(await page.locator('body').innerText()), 'landing page contains the word "example"');
      need((await context.cookies()).every(cookie => !/^braid-(?:demo|demo-shared|session|owner)$/.test(cookie.name)), 'browser received a session cookie');
    } finally { closing = true; await context.close(); }
  });
}
async function browserChecks(repos, mirror) {
  const targets = mirrorsOnly ? [] : [
    { label: 'landing', path: '/', kind: 'landing' },
    { label: 'tour Code', path: '/example/relay', kind: 'code' },
    { label: 'tour file + blame', path: '/example/relay/blame/main/src/delivery.ts', kind: 'blame' },
    { label: 'tour pull #23', path: '/example/relay/pull/23', kind: 'pull' },
  ];
  if (mirror) targets.push({ label: `${PUBLIC_MIRROR} mirror`, path: mirror.path, kind: 'mirror', readme: mirror.readme });
  if (mirrorsOnly && !mirror) {
    for (const g of browserGroups) {
      if (mirrorGroup.skipped) g.skipped = 'mirrors not deployed';
      else fail(g, 'mirror coverage', 'mirror API prerequisites failed; browser cannot be certified');
      complete(g);
    }
    return;
  }
  if (repos[0]) targets.push({ label: `${repos[0].name} Code`, path: repos[0].path, kind: 'code', empty: repos[0].empty });
  // The first listing may be legitimately empty. Still exercise a populated Code page.
  const populated = repos.find(repo => repo.project?.head && !repo.empty);
  if (repos[0]?.empty && populated) targets.push({ label: `${populated.name} Code`, path: populated.path, kind: 'code' });
  try {
    browser = await chromium.launch({ headless: true, timeout: 10_000, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  } catch {
    for (const g of browserGroups) { fail(g, 'launch', 'Chromium unavailable; run npx --no-install playwright-core install chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'); complete(g); }
    return;
  }
  await pool(browserGroups, 2, async g => {
    const viewport = g === browserGroups[0] ? { width: 1440, height: 900 } : { width: 390, height: 844 };
    for (const target of targets) await browserPage(g, target, viewport);
    if (!repos.length && !mirrorsOnly) fail(g, 'public Code coverage', 'no repository available');
    complete(g, `${targets.length} fresh contexts; 8s content deadline`);
  });
}

try {
  if (mirrorsOnly) for (const g of [httpGroup, ogGroup, tourGroup, directoryGroup]) { g.skipped = '--mirrors-only'; complete(g); }
  const mirrorWork = mirrorsEnabled ? mirrorChecks() : Promise.resolve();
  const work = [...(mirrorsOnly ? [] : [httpChecks(), ogChecks(), tourChecks()]), (async () => {
    const repos = mirrorsOnly ? [] : await discover();
    await pool(repos, 3, repositoryChecks);
    await browserChecks(repos, await mirrorWork);
  })()];
  for (const result of await Promise.allSettled(work)) if (result.status === 'rejected') {
    const g = group('runner'); fail(g, 'unexpected error', reason(result.reason)); complete(g);
  }
} finally {
  abort.abort();
  if (browser) await browser.close().catch(() => {
    const g = group('runner'); fail(g, 'cleanup', 'Chromium could not close cleanly'); complete(g);
  });
  clearTimeout(watchdog);
  finish();
}
