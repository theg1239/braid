import { expect, it, vi } from 'vitest';
import { encodeCBOR, type CBORType } from '@levischuck/tiny-cbor';
import { passkeyRoute } from './passkeys';
import { Security } from './security';
import { storageFixture } from '../test/storage';
import { digest, sessionToken } from '../http/auth';
import type { BraidEnv } from '../env';

const bytes = (text: string) => new TextEncoder().encode(text);
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const concat = (...values: Uint8Array[]) => new Uint8Array(Buffer.concat(values));
const sha = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource));
function der(raw: Uint8Array) {
  const integer = (part: Uint8Array) => { let start = 0; while (part[start] === 0 && start < part.length - 1) start++; const value = part.slice(start); const padded = value[0] & 128 ? concat(new Uint8Array([0]), value) : value; return concat(new Uint8Array([2, padded.length]), padded); };
  const value = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([48, value.length]), value);
}
it('registers and authenticates a real passkey signature while rejecting a different origin and replay', async () => {
  const db = storageFixture(), security = new Security(db.ctx, {} as BraidEnv);
  const user = security.profile({ id: 'email:owner@example.com', email: 'owner@example.com', name: 'Owner' });
  const env = { PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', SECURITY: { idFromName: (v: string) => v, get: () => security } } as unknown as BraidEnv;
  const ownerToken = await sessionToken(env.SESSION_SECRET);
  const request = (path: string, body: unknown, cookie = '') => new Request(`https://braid.example/api/auth/passkeys/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const options = await passkeyRoute(request('register/options', {}, `__Host-braid-session=${ownerToken}`), env, user);
  const register = await options.json() as { flowId: string; options: { challenge: string } };
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))]]);
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const rpHash = await sha(bytes('braid.example'));
  const attestation = concat(rpHash, new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, credentialId.length]), credentialId, encodeCBOR(cose));
  const registerResponse = { id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', clientExtensionResults: {}, response: {
    clientDataJSON: b64(bytes(JSON.stringify({ type: 'webauthn.create', challenge: register.options.challenge, origin: 'https://braid.example' }))),
    attestationObject: b64(encodeCBOR(new Map<string, CBORType>([['fmt', 'none'], ['authData', attestation], ['attStmt', new Map()]]))), transports: ['internal'],
  } };
  const registered = await passkeyRoute(request('register/verify', { flowId: register.flowId, response: registerResponse }, `__Host-braid-session=${ownerToken}; __Host-braid-passkey=${register.flowId}`), env, user);
  expect(registered.status).toBe(200);
  expect(security.passkeys(user.id)).toHaveLength(1);
  const authenticate = async (origin: string, counter: number) => {
    const start = await passkeyRoute(request('authenticate/options', {}), env, null);
    const flow = await start.json() as { flowId: string; options: { challenge: string } };
    const clientData = bytes(JSON.stringify({ type: 'webauthn.get', challenge: flow.options.challenge, origin }));
    const authData = concat(rpHash, new Uint8Array([5, 0, 0, 0, counter]));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, concat(authData, await sha(clientData))));
    const body = { flowId: flow.flowId, response: { id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(der(signature)), userHandle: b64(bytes(user.id)) } } };
    const call = () => passkeyRoute(request('authenticate/verify', body, `__Host-braid-passkey=${flow.flowId}`), env, null);
    return { call };
  };
  await expect((await authenticate('https://evil.example', 1)).call()).rejects.toThrow(/could not be verified/);
  // A failure behind a verified passkey is not the passkey's fault, so it is not answered as one.
  const unavailable = new Error('Security is unavailable.');
  vi.spyOn(security, 'profileById').mockImplementationOnce(() => { throw unavailable; });
  await expect((await authenticate('https://braid.example', 1)).call()).rejects.toBe(unavailable);
  const valid = await authenticate('https://braid.example', 2);
  const signed = await valid.call();
  expect(signed.status).toBe(200);
  const token = signed.headers.get('set-cookie')!.split(';')[0].split('=')[1];
  expect(security.identity(await digest(token))?.id).toBe(user.id);
  await expect(valid.call()).rejects.toThrow(/already been used/);
}, 10_000);

it('lets a sign-in from the last two hours manage passkeys, and asks an older one to confirm it is the person', async () => {
  const db = storageFixture(), security = new Security(db.ctx, {} as BraidEnv);
  const user = security.profile({ id: 'email:owner@example.com', email: 'owner@example.com', name: 'Owner' });
  const env = { PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', SECURITY: { idFromName: (v: string) => v, get: () => security } } as unknown as BraidEnv;
  // A session lasts a day from sign-in, so its expiry tells when the person signed in.
  const signedInAgo = async (milliseconds: number) => `__Host-braid-session=${await sessionToken(env.SESSION_SECRET, Date.now() - milliseconds + 86_400_000)}`;
  const options = async (cookie: string) => passkeyRoute(new Request('https://braid.example/api/auth/passkeys/register/options', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' }), env, user);
  expect((await options(await signedInAgo(90 * 60_000))).status).toBe(200);
  await expect(options(await signedInAgo(3 * 3_600_000))).rejects.toMatchObject({ status: 401, message: 'Confirm it’s you to add or remove a passkey.' });
  db.db.close();
});

it('refuses to remove a passkey whose id is a malformed escape', async () => {
  const db = storageFixture(), security = new Security(db.ctx, {} as BraidEnv);
  const user = security.profile({ id: 'email:owner@example.com', email: 'owner@example.com', name: 'Owner' });
  const env = { PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', SECURITY: { idFromName: (v: string) => v, get: () => security } } as unknown as BraidEnv;
  const cookie = `__Host-braid-session=${await sessionToken(env.SESSION_SECRET)}`;
  const remove = (id: string) => passkeyRoute(new Request(`https://braid.example/api/auth/passkeys/${id}`, { method: 'DELETE', headers: { cookie } }), env, user);
  await expect(remove('%E0%A4%A')).rejects.toMatchObject({ status: 400, message: 'Choose a passkey.' });
  expect((await remove('a%2Bb')).status).toBe(200);
  db.db.close();
});

it('refuses an answer the WebAuthn library never accepts, before using up the request', async () => {
  const db = storageFixture(), security = new Security(db.ctx, {} as BraidEnv);
  const env = { PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', SECURITY: { idFromName: (v: string) => v, get: () => security } } as unknown as BraidEnv;
  const call = (path: string, body: unknown, cookie = '') => passkeyRoute(new Request(`https://braid.example/api/auth/passkeys/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }), env, null);
  const flow = await (await call('authenticate/options', {})).json() as { flowId: string };
  const id = b64(bytes('credential'));
  const assertion = { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(bytes('{}')), authenticatorData: b64(bytes('data')), signature: b64(bytes('signature')) } };
  for (const response of [
    { ...assertion, rawId: b64(bytes('another credential')) },
    { ...assertion, type: 'password' },
    { ...assertion, response: { ...assertion.response, signature: undefined } },
    { ...assertion, response: { ...assertion.response, clientDataJSON: '{"type":"webauthn.get"}' } },
    { ...assertion, clientExtensionResults: undefined },
    { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(bytes('{}')), attestationObject: b64(bytes('attestation')) } },
  ]) await expect(call('authenticate/verify', { flowId: flow.flowId, response }, `__Host-braid-passkey=${flow.flowId}`)).rejects.toMatchObject({ status: 400, message: 'Send the passkey response.' });
  // The request is still open: a well-formed answer reaches the library, which finds no such passkey.
  await expect(call('authenticate/verify', { flowId: flow.flowId, response: assertion }, `__Host-braid-passkey=${flow.flowId}`)).rejects.toMatchObject({ status: 401 });
  db.db.close();
});
