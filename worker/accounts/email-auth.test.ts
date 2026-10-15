import { expect, it } from 'vitest';
import { emailSignIn } from './email-auth';
import { Security } from './security';
import { storageFixture } from '../test/storage';
import { digest, sessionToken } from '../http/auth';
import { passkeyRoute } from './passkeys';
import type { BraidEnv } from '../env';
it('sends a bounded email challenge and issues a session only once in its originating browser', async () => {
  const db = storageFixture(), security = new Security(db.ctx, {} as BraidEnv);
  let sent: { text: string; to: string } | undefined;
  const env = { PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', EMAIL_FROM: 'login@braid.example', EMAIL: { async send(message: { text: string; to: string }) { sent = message; return { messageId: 'fixture' }; } }, SECURITY: { idFromName: (v: string) => v, get: () => security } } as unknown as BraidEnv;
  const request = (route: string, body: unknown, cookie = '') => new Request(`https://braid.example/api/auth/email/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const response = await emailSignIn(request('start', { email: 'OWNER@example.com' }), env, 'test-ip');
  const { flowId } = await response.json() as { flowId: string };
  expect(sent!.to).toBe('owner@example.com');
  const code = sent!.text.match(/code is ([A-Z2-9]{8})/)![1];
  expect(JSON.stringify(db.db.prepare('SELECT value FROM challenges WHERE id = ?').get(flowId))).not.toContain(code);
  await expect(emailSignIn(request('verify', { flowId, code }), env, 'test-ip')).rejects.toThrow(/browser/);
  const signed = await emailSignIn(request('verify', { flowId, code }, `__Host-braid-email=${flowId}`), env, 'test-ip');
  const cookie = signed.headers.getSetCookie().find(value => value.startsWith('__Host-braid-session='))!;
  const token = cookie.split(';')[0].split('=')[1];
  expect(security.identity(await digest(token))?.email).toBe('owner@example.com');
  await expect(emailSignIn(request('verify', { flowId, code }, `__Host-braid-email=${flowId}`), env, 'test-ip')).rejects.toThrow(/invalid or expired/);
});

it('refuses a fourth code for one address within ten minutes and says when to ask again', async () => {
  const db = storageFixture(), security = new Security(db.ctx, {} as BraidEnv);
  let sent = 0;
  const env = { PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', EMAIL_FROM: 'login@braid.example', EMAIL: { async send() { sent++; } }, SECURITY: { idFromName: (v: string) => v, get: () => security } } as unknown as BraidEnv;
  const start = (ip: string) => emailSignIn(new Request('https://braid.example/api/auth/email/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) }), env, ip);
  for (const ip of ['a', 'b', 'c']) expect((await start(ip)).status).toBe(200);
  await expect(start('d')).rejects.toMatchObject({ status: 429, message: 'Too many sign-in requests. Try again later.', retryAfter: expect.any(Number) });
  expect(sent).toBe(3);
  db.db.close();
});

it('reconfirms an email-only account with a fresh session that can manage passkeys', async () => {
  const db = storageFixture(), security = new Security(db.ctx, {} as BraidEnv);
  let code = '';
  const env = { PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', EMAIL_FROM: 'login@braid.example', EMAIL: { async send(message: { text: string }) { code = message.text.match(/code is ([A-Z2-9]{8})/)![1]; } }, SECURITY: { idFromName: (v: string) => v, get: () => security } } as unknown as BraidEnv;
  const user = security.profile({ id: 'email:owner@example.com', email: 'owner@example.com', name: 'Owner' });
  const expiry = Date.now() + 21 * 3_600_000;
  const stale = await sessionToken(env.SESSION_SECRET, expiry);
  security.issue(await digest(stale), expiry, user);
  const staleCookie = `__Host-braid-session=${stale}`;
  const request = (path: string, body: unknown, cookie: string) => new Request(`https://braid.example/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  await expect(passkeyRoute(request('passkeys/register/options', {}, staleCookie), env, user)).rejects.toMatchObject({ status: 401 });

  const start = await emailSignIn(request('email/start', { email: user.email }, staleCookie), env, 'test-ip');
  const { flowId } = await start.json() as { flowId: string };
  const verified = await emailSignIn(request('email/verify', { flowId, code }, `${staleCookie}; __Host-braid-email=${flowId}`), env, 'test-ip');
  const freshCookie = verified.headers.getSetCookie().find(value => value.startsWith('__Host-braid-session='))!.split(';')[0];
  const token = freshCookie.split('=')[1];
  expect(token).not.toBe(stale);
  expect(security.identity(await digest(token))?.id).toBe(user.id);
  expect((await passkeyRoute(request('passkeys/register/options', {}, freshCookie), env, user)).status).toBe(200);
  await expect(passkeyRoute(request('passkeys/register/options', {}, staleCookie), env, user)).rejects.toMatchObject({ status: 401 });
  db.db.close();
});
