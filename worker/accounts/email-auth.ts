import { cookie, cookies, digest, jsonBody, SESSION_MS, sessionToken, shortCode } from '../http/auth';
import { HttpError, logFailure } from '../errors';
import { emailCode, emailStart, parse } from '../schemas';
import { publicOrigin, securityOf, type BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';

/** A day's session for this person, as the cookie that carries it. */
export async function sessionCookie(request: Request, env: BraidEnv, user: AccountIdentity): Promise<string> {
  const expires = Date.now() + SESSION_MS;
  const token = await sessionToken(env.SESSION_SECRET, expires);
  await securityOf(env).issue(await digest(token), expires, user);
  return cookie('braid-session', token, request);
}
export async function signedIn(request: Request, env: BraidEnv, user: AccountIdentity) {
  return Response.json({ ok: true }, { headers: { 'set-cookie': await sessionCookie(request, env, user) } });
}
export async function emailSignIn(request: Request, env: BraidEnv, ip: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== publicOrigin(env).origin) throw new HttpError(400, 'Use the configured application URL to sign in.');
  if (!env.EMAIL || !env.EMAIL_FROM) throw new HttpError(503, 'Email sign-in is not configured for this deployment.');
  const security = securityOf(env);
  const body = await jsonBody(request);
  if (url.pathname.endsWith('/start')) {
    const { email } = parse(emailStart, body);
    for (const [key, limit, period] of [[`email-ip:${ip}`, 10, 3_600_000], [`email-address:${await digest(email)}`, 3, 600_000], ['email-global', 500, 86_400_000]] as const) {
      const budget = await security.consume(key, limit, period);
      if (!budget.allowed) throw new HttpError(429, 'Too many sign-in requests. Try again later.', budget.retryAfter);
    }
    const code = shortCode();
    const flowId = crypto.randomUUID();
    const expires = Date.now() + 600_000;
    const codeDigest = await digest(`${env.SESSION_SECRET}:${flowId}:${code}`);
    await security.challenge(flowId, JSON.stringify({ kind: 'email', email, digest: codeDigest }), expires);
    try {
      await env.EMAIL.send({ from: env.EMAIL_FROM, to: email, subject: `${code} is your Braid sign-in code`, text: `Your Braid sign-in code is ${code}. It expires in ten minutes.\n\nEnter it in the browser where you requested it. If you did not request this code, you can ignore this email.` });
    } catch (error) {
      logFailure('sign_in_email_failed', error);
      await security.takeChallenge(flowId);
      throw new HttpError(503, 'The sign-in email could not be sent. Try again shortly.');
    }
    return Response.json({ flowId, expiresAt: new Date(expires).toISOString() }, { headers: { 'set-cookie': cookie('braid-email', flowId, request, 600) } });
  }
  const { flowId, code } = parse(emailCode, body);
  if (cookies(request)['braid-email'] !== flowId) throw new HttpError(400, 'Enter the code in the browser where you requested it.');
  const email = await security.verifyEmail(flowId, await digest(`${env.SESSION_SECRET}:${flowId}:${code}`));
  if (!email) throw new HttpError(401, 'That code is invalid or expired. Request a new code after five attempts.');
  const user = await security.profile({ id: `email:${email}`, email, name: email.split('@')[0] });
  const response = await signedIn(request, env, user);
  response.headers.append('set-cookie', cookie('braid-email', '', request, 0));
  return response;
}
