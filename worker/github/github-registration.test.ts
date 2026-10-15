import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
const { githubAppManifest, saveGitHubApp } = await import(new URL('../../scripts/register-github-app.mjs', import.meta.url).href);

it('requests landing and gate permissions with signed webhooks and the production setup callbacks', () => {
  const manifest = githubAppManifest('https://braid.example', 'https://setup.braid.example/callback');
  // Exactly these permissions: a widened grant must fail here, not pass as a superset.
  expect(manifest.default_permissions).toEqual({ contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read' });
  expect(manifest).toMatchObject({
    url: 'https://braid.example', public: true,
    default_events: ['push', 'pull_request', 'pull_request_review', 'check_suite', 'check_run', 'status'],
    redirect_url: 'https://setup.braid.example/callback',
    hook_attributes: { url: 'https://braid.example/api/github/webhook', active: true },
    callback_urls: ['https://braid.example/api/github/callback'], setup_url: 'https://braid.example/api/github/installed', request_oauth_on_install: false,
  });
  expect(() => githubAppManifest('http://braid.example', 'callback')).toThrow();
  expect(() => githubAppManifest('https://braid.example', 'http://127.0.0.1:4321/callback')).toThrow('public HTTPS');
  expect(() => githubAppManifest('https://braid.example', 'https://setup.braid.example/callback?state=duplicate')).toThrow('without query');
});
it('preserves existing sign-in/session configuration and saves App credentials in private files', () => {
  const root = mkdtempSync(join(tmpdir(), 'braid-app-registration-'));
  try {
    const configuration = join(root, '.env.production'), secrets = join(root, '.dev.vars.production');
    writeFileSync(configuration, 'BRAID_GITHUB_CLIENT_ID=identity-app\nBRAID_SIGNUP_ENABLED=true\n');
    writeFileSync(secrets, 'SESSION_SECRET=existing-session-secret\nGITHUB_CLIENT_SECRET=identity-secret\n');
    const app = { id: 42, slug: 'braid-workspace', client_id: 'app-client', client_secret: 'private-app-secret', pem: ['fake PRIVATE KEY', 'test-only', 'end'].join('\n') };
    saveGitHubApp(app, configuration, secrets);
    expect(parseEnv(readFileSync(configuration, 'utf8'))).toMatchObject({ BRAID_GITHUB_CLIENT_ID: 'identity-app', BRAID_SIGNUP_ENABLED: 'true', BRAID_GITHUB_APP_ID: '42' });
    const stored = parseEnv(readFileSync(secrets, 'utf8'));
    expect(stored.SESSION_SECRET).toBe('existing-session-secret');
    expect(stored.GITHUB_APP_PRIVATE_KEY!.replaceAll('\\n', '\n')).toBe(app.pem);
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    expect(() => saveGitHubApp({ ...app, id: 43 }, configuration, secrets)).toThrow('already configured');
    expect(readFileSync(configuration, 'utf8')).not.toContain('private-app-secret');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
