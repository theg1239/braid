import { organizationWithRepository } from './organization';
import api from '../http/api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { storageFixture } from './storage';
import { edgeCache } from './edge-cache';
import { changeHarness } from './changes-harness';
import type { BraidEnv } from '../env';
export async function publicRepository() {
  // The gateway keeps public trees and files in the data center's cache.
  edgeCache();
  const h = await changeHarness();
  const base = h.git.commitTree({ 'src/router.ts': 'export const routes = [];\n', 'README.md': '# Relay\n' });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
  const alice = { id: 'email:alice@corp.example', email: 'alice@corp.example', name: 'Alice' };
  const team = organizationWithRepository(directory, alice, 'Public team', 'public');
  db.db.prepare('UPDATE teams SET id = ?').run('t');
  db.db.prepare('UPDATE members SET team_id = ?').run('t');
  db.db.prepare('UPDATE audit SET team_id = ?').run('t');
  db.db.prepare('UPDATE workspaces SET id = ?, team_id = ?').run('w', 't');
  db.db.prepare('UPDATE team_addresses SET team_id = ?').run('t');
  db.db.prepare('UPDATE repository_addresses SET workspace_id = ?, team_id = ?').run('w', 't');
  const securityDb = storageFixture(), security = new Security(securityDb.ctx, h.env);
  const env = { ...h.env, AUTH_MODE: 'github', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', LIVE_ENABLED: 'true', PUBLIC_ORIGIN: 'https://braid.example',
    IP_LIMITER: { limit: async () => ({ success: true }) }, ANONYMOUS_LIMITER: { limit: async () => ({ success: true }) },
    DIRECTORY: { idFromName: (n: string) => n, get: () => directory },
    SECURITY: { idFromName: (n: string) => n, get: () => security },
    WORKSPACES: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }), getByName: () => h.workspace },
    ASSETS: { fetch: () => new Response('asset') },
  } as unknown as BraidEnv;
  Object.assign(h.env, { DIRECTORY: env.DIRECTORY, SECURITY: env.SECURITY, SESSION_SECRET: env.SESSION_SECRET });
  const anonymous = (path: string, headers?: Record<string, string>) => api.fetch(new Request(`https://braid.example${path}`, { headers: { 'x-braid-workspace': 'w', 'cf-connecting-ip': '198.51.100.7', ...headers } }), env);
  return { h, base, team, anonymous, alice, env, directory, db, security, securityDb, close: async () => { await h.close(); db.db.close(); securityDb.db.close(); } };
}
