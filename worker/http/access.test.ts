import { expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { accessIdentity } from './access';
import type { BraidEnv } from '../env';

const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'audience', ACCESS_OWNER_EMAILS: 'Owner@Example.com' } as BraidEnv;
const { publicKey, privateKey } = await generateKeyPair('RS256');
const signed = (claims: Record<string, unknown>, issuedAt = Math.floor(Date.now() / 1000)) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256' })
  .setIssuer('https://team.cloudflareaccess.com').setAudience('audience').setSubject('person-1').setIssuedAt(issuedAt).setExpirationTime('5m').sign(privateKey);
const identity = async (token: string) => accessIdentity(new Request('https://braid.example', { headers: { 'cf-access-jwt-assertion': token } }), env, async () => publicKey);

it('reads a signed Access identity and names configured owners case-insensitively', async () => {
  expect(await identity(await signed({ email: 'OWNER@example.com' }))).toEqual({ id: 'person-1', email: 'owner@example.com', role: 'owner', provider: 'cloudflare-access' });
  expect(await identity(await signed({ email: 'someone@example.com' }))).toMatchObject({ role: 'viewer' });
});
it.each([
  ['without an email', () => signed({})],
  ['with an email that is not an address', () => signed({ email: 'nobody' })],
  ['issued in the future', () => signed({ email: 'someone@example.com' }, Math.floor(Date.now() / 1000) + 60)],
  ['for another audience', () => new SignJWT({ email: 'someone@example.com' }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://team.cloudflareaccess.com').setAudience('other').setSubject('person-1').setIssuedAt().setExpirationTime('5m').sign(privateKey)],
])('refuses a token %s', async (_case, token) => {
  await expect(identity(await token())).rejects.toMatchObject({ status: 401 });
});
it('logs a refused sign-in by its typed code, never its text', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const token = await new SignJWT({ email: 'someone@example.com' }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://team.cloudflareaccess.com').setAudience('other').setSubject('person-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await expect(identity(token)).rejects.toMatchObject({ status: 401 });
  const [logged] = warn.mock.calls.map(([line]) => JSON.parse(line as string));
  expect(logged).toMatchObject({ event: 'access_sign_in_refused', code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  expect(logged).not.toHaveProperty('message');
  warn.mockRestore();
});
