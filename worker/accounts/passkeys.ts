import { base64url } from 'jose';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { publicOrigin, securityOf, type BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';
import { cookie, cookies, jsonBody, SESSION_MS } from '../http/auth';
import { HttpError } from '../errors';
import { parse, passkeyAuthentication, passkeyId, passkeyRegistration } from '../schemas';
import { signedIn } from './email-auth';
import { now } from '../workspace/domain';

/** How recent a sign-in must be to add or remove a passkey. */
const PASSKEY_SIGN_IN_WINDOW = 7_200_000;

export async function passkeyRoute(request: Request, env: BraidEnv, user: AccountIdentity | null): Promise<Response> {
  const origin = publicOrigin(env);
  const url = new URL(request.url);
  if (url.origin !== origin.origin) throw new HttpError(400, 'Use the configured application URL for passkeys.');
  const security = securityOf(env);
  const path = url.pathname;
  const registration = path.includes('/register/');
  if (registration || request.method === 'DELETE') {
    if (!user) throw new HttpError(401, 'Sign in before managing passkeys.');
    // As GitHub's sudo mode: a sign-in from the last two hours, after which the page asks the person to confirm it's them.
    const issued = Number(cookies(request)['braid-session']?.split('.')[0]) - SESSION_MS;
    if (!Number.isFinite(issued) || Date.now() - issued > PASSKEY_SIGN_IN_WINDOW) throw new HttpError(401, 'Confirm it’s you to add or remove a passkey.');
  }
  if (request.method === 'GET') {
    if (!user) throw new HttpError(401, 'Sign in to view your passkeys.');
    return Response.json((await security.passkeys(user.id)).map(key => ({ id: key.id, createdAt: key.createdAt })));
  }
  if (request.method === 'DELETE') {
    await security.removePasskey(user!.id, parse(passkeyId, path.split('/').at(-1)));
    return Response.json({ ok: true });
  }
  if (path.endsWith('/options')) {
    const options = registration
      ? await generateRegistrationOptions({ rpName: 'Braid', rpID: origin.hostname, userName: user!.email, userID: new TextEncoder().encode(user!.id), userDisplayName: user!.name, attestationType: 'none', supportedAlgorithmIDs: [-7, -257], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: (await security.passkeys(user!.id)).map(key => ({ id: key.id, transports: key.transports })) })
      : await generateAuthenticationOptions({ rpID: origin.hostname, userVerification: 'required' });
    const flowId = crypto.randomUUID();
    await security.challenge(flowId, JSON.stringify({ kind: registration ? 'register' : 'authenticate', userId: user?.id, challenge: options.challenge }), Date.now() + 300_000);
    return Response.json({ flowId, options }, { headers: { 'set-cookie': cookie('braid-passkey', flowId, request, 300) } });
  }
  const raw = await jsonBody(request);
  const answer = registration ? { kind: 'register' as const, ...parse(passkeyRegistration, raw) } : { kind: 'authenticate' as const, ...parse(passkeyAuthentication, raw) };
  if (cookies(request)['braid-passkey'] !== answer.flowId) throw new HttpError(400, 'Start a new passkey request in this browser.');
  const saved = await security.takeChallenge(answer.flowId);
  if (!saved) throw new HttpError(400, 'This passkey request expired or has already been used.');
  const flow = JSON.parse(saved) as { kind: string; userId?: string; challenge: string };
  if (flow.kind !== answer.kind || (answer.kind === 'register' && flow.userId !== user?.id)) throw new HttpError(400, 'This passkey request does not match your sign-in.');
  const unverified = new HttpError(401, 'The passkey could not be verified. Try again or sign in with your email.');
  // The WebAuthn library throws on every answer it refuses, with no typed reason, so each refusal reads as unverified.
  if (answer.kind === 'register') {
    const result = await verifyRegistrationResponse({ response: answer.response, expectedChallenge: flow.challenge, expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] }).catch(() => null);
    if (!result?.verified) throw unverified;
    const key = result.registrationInfo.credential;
    const stored = await security.addPasskey({ id: key.id, userId: user!.id, publicKey: base64url.encode(key.publicKey), counter: key.counter, transports: key.transports ?? [], createdAt: now() });
    if (!stored) throw new HttpError(409, 'This passkey is already registered, or the account has reached its ten-passkey limit.');
    return Response.json({ ok: true });
  }
  const { response } = answer;
  const key = await security.passkey(response.id);
  if (!key) throw unverified;
  const result = await verifyAuthenticationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: origin.origin, expectedRPID: origin.hostname, credential: { id: key.id, publicKey: new Uint8Array(base64url.decode(key.publicKey)), counter: key.counter }, requireUserVerification: true }).catch(() => null);
  if (!result?.verified || !await security.advancePasskey(key.id, key.counter, result.authenticationInfo.newCounter)) throw unverified;
  const identity = await security.profileById(key.userId);
  if (!identity) throw unverified;
  return signedIn(request, env, identity);
}
