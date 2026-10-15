// UI regression checks over a local dev server or preview. All API replies are
// synthetic, including attribution; this never imports or writes a live repository.
// BRAID_URL=http://127.0.0.1:5173 node src/test/mirror-ui.browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.BRAID_PLAYWRIGHT ?? '../../.cloudflare/tools/node_modules/playwright-core/index.mjs');
const base = process.env.BRAID_URL ?? 'http://127.0.0.1:5173';
const out = '.cloudflare/design/screenshots/mirror-ui';
const head = 'a'.repeat(40), at = '2026-10-14T10:00:00Z';
const first = 'codex-cli/bin/codex.js', next = 'codex-cli/bin/next.js', missing = 'codex-cli/bin/missing.js', short = 'codex-cli/bin/short.js';
const content = path => path === short ? 'export const shortFile = true;\n' : `// ${path} — synthetic UI fixture\n` + Array.from({ length: path === next ? 180 : 120 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n');
const names = ['.github', 'codex-cli', 'codex-rs', 'docs', '.gitignore', 'AGENTS.md', 'Cargo.toml', 'LICENSE', 'README.md', 'package.json', 'pnpm-lock.yaml'];
const rootEntries = names.map((name, i) => ({ name, path: name, kind: i < 4 ? 'dir' : 'file', hash: head, mode: i < 4 ? '040000' : '100644' }));
const entry = (path, kind = 'file') => ({ name: path.split('/').at(-1), path, kind, hash: head, mode: kind === 'dir' ? '040000' : '100644' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { base, fixtures: 'Synthetic API responses; no live repository writes', checks: [], captures: [], errors: [] };

async function fixture(viewport, { historyDelay = 1500, fileDelay = 1500, blameDelay = 2300, mirror = true } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark', deviceScaleFactor: 1 });
  const requests = [], unknown = [];
  await context.addInitScript(() => {
    window.uiShifts = [];
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) window.uiShifts.push({ value: e.value, recent: e.hadRecentInput, at: e.startTime, sources: e.sources.map(s => ({ node: s.node?.className ?? s.node?.nodeName, before: s.previousRect.toJSON(), after: s.currentRect.toJSON() })) });
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await context.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const repo = req.headers()['x-braid-workspace']?.replace('mirror-', '') ?? 'codex';
    requests.push(p + url.search);
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET') return send({ error: 'Fixture blocks writes' }, 405);
    if (p === '/api/account') return send({ user: null, organizations: [], personalOwner: null, provider: 'github', signupEnabled: true, methods: { github: true, email: false, passkeys: false } });
    if (p.startsWith('/api/repos/openai/')) {
      const name = p.split('/').at(-1);
      await pause(100);
      return send({ workspaceId: `mirror-${name}`, owner: { slug: 'openai', name: 'openai', kind: 'organization' }, repo: { slug: name, name }, visibility: 'public', canWrite: false, ...(mirror ? { mirror: { source: `https://github.com/openai/${name}`, syncedAt: at, importing: false, claimable: false } } : {}) });
    }
    if (p === '/api/state') {
      await pause(150);
      return send({ project: { id: repo, name: repo, description: '', branch: 'main', branches: ['main'], head, stack: [] }, missions: [], context: [], activity: [], files: {}, capabilities: { mode: 'live', artifacts: true, ai: false, storage: 'durable-object', authenticated: false, model: '', namespace: '', canWrite: false } });
    }
    if (p === '/api/repository/tree') {
      const path = url.searchParams.get('path') ?? '';
      await pause(200);
      return send({ ref: head, path, entries: path === '' ? rootEntries : path === 'codex-cli' ? [entry('codex-cli/bin', 'dir')] : [first, next, missing, short].map(path => entry(path)), nextCursor: null });
    }
    if (p === '/api/repository') {
      const path = url.searchParams.get('path');
      await pause(path === 'README.md' ? 200 : fileDelay);
      if (path === missing) return send({ error: 'File not found' }, 404);
      return send({ ref: head, path, kind: 'text', content: path === 'README.md' ? '# Codex\n\nA synthetic mirror fixture for UI verification.\n' : content(path) });
    }
    if (p === '/api/repository/commits') {
      await pause(historyDelay);
      return send({ ref: head, path: '', nextCursor: null, items: Array.from({ length: 100 }, (_, i) => ({ hash: i ? i.toString(16).padStart(40, '0') : head, title: 'Preserve the remote cwd filter in the resume picker', at, author: { kind: i % 3 ? 'human' : 'agent', id: `fixture-${i}`, name: i % 3 ? 'Test contributor' : 'Codex' } })) });
    }
    if (p === '/api/blame') {
      const path = url.searchParams.get('path');
      await pause(blameDelay);
      return send({ path, ref: head, lines: content(path).split('\n').length, ranges: [] });
    }
    if (p === '/api/changes/touching') return send({});
    if (p === '/api/changes') return send({ items: [], nextCursor: null, counts: { attention: 0, revise: 0, open: 0, queued: 0, landing: 0, landed: 0, closed: 0 } });
    if (p === '/api/agents' || p === '/api/coordination') return send([]);
    if (p === '/api/queue') return send({ enabled: false, paused: null, merging: [], waiting: [], history: [], stacks: [] });
    if (p.endsWith('/claim')) return send({ claimable: false });
    unknown.push(p); return send({ error: `Unexpected fixture endpoint: ${p}` }, 404);
  });
  // Make the lazy source line arrive after the header has already painted.
  await context.route(/\/(?:src\/components\/repo\/MirrorSource\.tsx|assets\/MirrorSource-[^/]+\.js)/, async route => { await pause(1000); await route.continue(); });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(error.message));
  return { context, page, requests, unknown };
}

async function metrics(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const node = document.querySelector(selector); if (!node) return null;
      const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    };
    return { cls: window.uiShifts.filter(e => !e.recent).reduce((total, e) => total + e.value, 0), shifts: window.uiShifts, overflow: document.documentElement.scrollWidth > innerWidth, header: rect('.global-head'), owner: rect('.global-head__owner'), source: rect('.mirror-source'), commit: rect('.commit-bar, .loading-commit'), listing: rect('.listing, .loading-files'), file: rect('.repo__file, .loading-file-layout > section'), toolbar: rect('.file-bar, .loading-file-head'), body: rect('.file-body'), viewport: innerHeight };
  });
}

async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const value = await metrics(page), path = `${out}/${name}.png`;
  await page.screenshot({ path });
  report.captures.push({ name, path, ...value });
  assert.equal(value.overflow, false, `${name}: horizontal overflow`);
  console.log(JSON.stringify({ name, cls: value.cls, fileBottom: value.file?.bottom, commitHeight: value.commit?.height }));
  return value;
}

async function ready(page, path) {
  await page.locator(`.repo__file[aria-label="${path}"] .code--view:not(.code--pending)`).waitFor();
  await page.waitForTimeout(200);
}

async function openFile(page, path, phone) {
  if (phone) await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator(`.repo__tree a[href$="/${path}"]`).click();
  await page.locator('.file-body[data-pending]').waitFor();
}

try {
  for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
    const phone = size === 'phone';
    for (const repo of ['codex', 'symphony']) {
      const { page, context, requests, unknown } = await fixture(viewport);
      await page.goto(`${base}/openai/${repo}`);
      await page.locator('.repo-box .loading-commit').waitFor();
      const pending = await capture(page, `after-${size}-${repo}-history-pending`);
      await page.locator('.commit-bar__title').waitFor();
      await page.locator('.mirror-source').waitFor();
      const loaded = await capture(page, `after-${size}-${repo}`);
      assert.equal(loaded.commit.height, phone ? 113 : 46);
      assert.equal(loaded.listing.y, pending.listing.y, 'history moves the file list');
      assert.equal(loaded.header.height, pending.header.height, 'lazy source moves the header');
      assert.equal(loaded.source.x, loaded.owner.x, 'mirror source must align with owner');
      assert.equal(await page.locator('.mirror-source').innerText(), `mirrored from github.com/openai/${repo}`);
      assert.equal(await page.locator('.mirror-source svg, .mirror-authorship').count(), 0);
      assert.match(await page.locator('.global-head__details').innerText(), /Public mirror/);
      assert.equal(requests.filter(p => p.startsWith('/api/repository/commits')).length, 1);
      assert.deepEqual(unknown, []);
      report.checks.push(`${size} ${repo}: source alignment, stable header/listing, regular commit height, one history request`);
      await context.close();
    }

    const { page, context, unknown } = await fixture(viewport);
    await page.goto(`${base}/openai/codex/blob/main/${first}`);
    await page.locator('.file-body > .code-skeleton').waitFor();
    const cold = await capture(page, `after-${size}-file-cold`);
    assert(cold.file.bottom >= viewport.height, 'cold file panel must fill the viewport');
    await ready(page, first);
    const loaded = await capture(page, `after-${size}-file-loaded`);
    assert.equal(loaded.toolbar.y, cold.toolbar.y);
    assert.equal(loaded.body.y, cold.body.y, 'cold load moves the file body');
    const originalHeader = await page.locator('.file-bar').innerText();
    await page.evaluate(() => { window.uiShifts = []; });
    await openFile(page, next, phone);
    assert.equal(await page.locator('.file-bar').innerText(), originalHeader, 'pending header disagrees with the retained file');
    assert.equal(await page.locator('.repo__file').getAttribute('aria-label'), first);
    assert.equal(await page.locator('.file-body .code-skeleton').count(), 0);
    await capture(page, `after-${size}-file-navigation-pending`);
    await ready(page, next);
    await capture(page, `after-${size}-file-navigation-loaded`);
    assert.match(await page.locator('.file-bar').innerText(), /next\.js/);

    await openFile(page, missing, phone);
    assert.equal(await page.locator('.repo__file').getAttribute('aria-label'), next);
    await page.getByText('File not found', { exact: true }).waitFor();
    assert.equal(await page.locator('.file-body .code--view').count(), 0, 'failed read retains stale code');
    assert.match(await page.locator('.file-bar').innerText(), /missing\.js/);
    assert.equal(await page.locator('.file-bar [role="tab"]:not(:disabled)').count(), 0);
    await capture(page, `after-${size}-file-navigation-error`);
    report.checks.push(`${size}: cold file fills viewport, file header/body retained together, successful swap, failed read clears stale content`);
    // Cached history navigation should restore its matching panel immediately.
    await page.goBack();
    await ready(page, next);
    assert.match(await page.locator('.file-bar').innerText(), /next\.js/);
    await page.goBack();
    await ready(page, first);
    assert.match(await page.locator('.file-bar').innerText(), /codex\.js/);
    report.checks.push(`${size}: back navigation restores the matching cached file`);
    assert.deepEqual(unknown, []);
    await context.close();

    const blame = await fixture(viewport);
    await blame.page.goto(`${base}/openai/codex/blame/main/${first}`);
    await blame.page.locator('.file-body > .blame-skeleton').waitFor();
    const coldBlame = await capture(blame.page, `after-${size}-blame-cold`);
    assert(coldBlame.file.bottom >= viewport.height, 'cold blame must fill the viewport');
    await blame.page.locator('.blame__hunk').waitFor();
    const loadedBlame = await capture(blame.page, `after-${size}-blame-loaded`);
    assert.equal(loadedBlame.toolbar.y, coldBlame.toolbar.y);
    assert.equal(loadedBlame.body.y, coldBlame.body.y);
    report.checks.push(`${size}: cold blame fills viewport and preserves the toolbar position`);
    await blame.context.close();

    const small = await fixture(viewport);
    await small.page.goto(`${base}/openai/codex/blob/main/${short}`);
    await small.page.locator('.file-body > .code-skeleton').waitFor();
    const shortCold = await capture(small.page, `after-${size}-short-file-cold`);
    await ready(small.page, short);
    const shortLoaded = await capture(small.page, `after-${size}-short-file-loaded`);
    assert(shortLoaded.file.height < shortCold.file.height, 'short files should shrink from the bottom');
    assert.equal(shortLoaded.toolbar.y, shortCold.toolbar.y);
    assert.equal(shortLoaded.body.y, shortCold.body.y);
    report.checks.push(`${size}: short files shrink from the bottom without moving the toolbar`);
    await small.context.close();
  }
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.stack;
  console.error(error);
} finally {
  await writeFile(`${out}/after-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
if (!report.ok) process.exitCode = 1;
