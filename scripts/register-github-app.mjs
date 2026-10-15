import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export function githubAppManifest(origin, redirectUrl) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Use the public HTTPS Braid origin.');
  const redirect = new URL(redirectUrl);
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash
    || !redirect.hostname.includes('.') || /^(?:127\.|\[|localhost(?:\.|$))/.test(redirect.hostname)) throw new Error('GitHub App registration requires a public HTTPS callback URL without query parameters.');
  return { name: 'Braid Git Workspace', url: url.origin, redirect_url: redirect.href, public: true,
    description: 'Connect selected repositories to your Braid agent workspace.',
    callback_urls: [`${url.origin}/api/github/callback`], setup_url: `${url.origin}/api/github/installed`,
    setup_on_update: true, request_oauth_on_install: false,
    hook_attributes: { url: `${url.origin}/api/github/webhook`, active: true },
    // Write access lets Braid push landing branches, open and merge pull requests and mirror trunk;
    // checks, statuses and reviews let GitHub's own CI and review apps gate each landing.
    default_permissions: { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read' },
    default_events: ['push', 'pull_request', 'pull_request_review', 'check_suite', 'check_run', 'status'] };
}
function privateEnv(path) {
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Configuration must be an ordinary private file.');
  return parseEnv(readFileSync(path, 'utf8'));
}
function writeEnv(path, values) {
  const text = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes("'") || value.includes('\0')) throw new Error('An existing configuration value cannot be serialized safely. Files were not replaced.');
    return `${key}='${value.replaceAll('\r\n', '\n').replaceAll('\n', '\\n')}'`;
  }).join('\n') + '\n';
  const temporary = `${path}.pending-${randomBytes(8).toString('hex')}`;
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path); chmodSync(path, 0o600);
}
export function saveGitHubApp(app, configurationPath, secretsPath) {
  if (!Number.isSafeInteger(app?.id) || typeof app.slug !== 'string' || !/^[a-z0-9-]+$/.test(app.slug)
    || typeof app.client_id !== 'string' || !app.client_id || typeof app.client_secret !== 'string' || !app.client_secret
    || typeof app.pem !== 'string' || !app.pem.includes('PRIVATE KEY')) throw new Error('GitHub did not return a complete App registration.');
  const configuration = privateEnv(configurationPath), secrets = privateEnv(secretsPath);
  if (configuration.BRAID_GITHUB_APP_ID && configuration.BRAID_GITHUB_APP_ID !== String(app.id)) throw new Error('A different GitHub App is already configured. Existing credentials were preserved.');
  writeEnv(secretsPath, { ...secrets, GITHUB_APP_CLIENT_SECRET: app.client_secret, GITHUB_APP_PRIVATE_KEY: app.pem, ...(typeof app.webhook_secret === 'string' && app.webhook_secret ? { GITHUB_APP_WEBHOOK_SECRET: app.webhook_secret } : {}) });
  writeEnv(configurationPath, { ...configuration, BRAID_GITHUB_APP_ID: String(app.id), BRAID_GITHUB_APP_SLUG: app.slug, BRAID_GITHUB_APP_CLIENT_ID: app.client_id });
}
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export async function registerGitHubApp(args = process.argv.slice(2)) {
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const configurationPath = resolve(option('--env-file', '.env.production')), secretsPath = resolve(option('--secrets-file', '.dev.vars.production'));
  const config = privateEnv(configurationPath);
  if (config.BRAID_GITHUB_APP_ID) throw new Error('A GitHub App is already configured. Use its installation flow in Braid.');
  const origin = option('--origin', config.BRAID_PUBLIC_ORIGIN);
  const redirectUrl = option('--redirect-url');
  if (!redirectUrl) throw new Error('Provide --redirect-url with the public HTTPS setup callback that returns to this local helper.');
  githubAppManifest(origin, redirectUrl);
  const owner = option('--organization', '');
  if (owner && !/^[a-z0-9-]+$/i.test(owner)) throw new Error('Invalid GitHub organization.');
  const nonce = randomBytes(32).toString('hex');
  let registration, busy = false, completed = false;
  const server = createServer(async (request, response) => {
    const address = server.address(), localOrigin = `http://127.0.0.1:${address.port}`;
    response.setHeader('cache-control', 'no-store'); response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'");
    const url = new URL(request.url, localOrigin);
    if (request.headers.host !== new URL(localOrigin).host || request.method !== 'GET') { response.writeHead(403); response.end('Forbidden'); return; }
    if (url.pathname === `/${nonce}`) {
      registration = githubAppManifest(origin, redirectUrl);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Braid to GitHub</title><style>body{background:#111;color:#eee;font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px}button{font:inherit;padding:12px 18px;border-radius:6px;border:0;cursor:pointer}p{line-height:1.6;color:#aaa}</style><h1>Register Braid on GitHub</h1><p>GitHub will ask you to create an App with read access to repositories you select. Its credentials are saved directly into this deployment’s private configuration.</p><form method="post" action="https://github.com/${owner ? `organizations/${owner}/settings` : 'settings'}/apps/new?state=${nonce}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(registration))}"><button>Create GitHub App</button></form>`);
      return;
    }
    if (url.pathname !== '/callback' || url.searchParams.get('state') !== nonce || !registration || completed || busy) { response.writeHead(400); response.end('This setup link is invalid or already used.'); return; }
    const code = url.searchParams.get('code');
    if (!code || !/^[a-z0-9_\-]+$/i.test(code) || code.length > 1000) { response.writeHead(400); response.end('GitHub did not return a valid registration code.'); return; }
    busy = true;
    try {
      const result = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/vnd.github+json', 'user-agent': 'Braid-App-Setup', 'x-github-api-version': '2026-03-10' } });
      if (!result.ok) throw new Error('GitHub could not finish registration. Restart setup if the code expired.');
      const app = await result.json();
      saveGitHubApp(app, configurationPath, secretsPath);
      completed = true;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>Braid GitHub App saved</title><h1>GitHub App configured</h1><p>The credentials were saved privately. You can return to Braid.</p>');
      console.log(`GitHub App configured: ${app.slug}. Credentials saved privately; no secret values were printed.`);
      server.close();
    } catch (error) { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Registration failed.'); }
    finally { busy = false; }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/${nonce}`;
  console.log(`GitHub App setup: ${url}`);
  const timer = setTimeout(() => server.close(), 3_600_000); timer.unref();
  return { server, url };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) registerGitHubApp().catch(error => { console.error(error.message); process.exitCode = 1; });
