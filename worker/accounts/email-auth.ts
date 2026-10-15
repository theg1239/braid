import { cookie, cookies, digest, jsonBody, SESSION_MS, sessionToken, shortCode } from '../http/auth';
import { HttpError, logFailure } from '../errors';
import { emailCode, emailStart, parse } from '../schemas';
import { publicOrigin, securityOf, type BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';
import type { AgentScope } from '../../shared/types';

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

/** A code for a browser's sign-in, or for a coding agent that connects as the person with one access. */
type CodeFor = { kind: 'email' } | { kind: 'agent'; scope: Exclude<AgentScope, 'fleet'> };
const AGENT_ACCESS: Record<Exclude<AgentScope, 'fleet'>, string> = {
  work: 'read one of your repositories and open pull requests there for seven days',
  read: 'read one of your repositories for one hour',
  setup: 'import a repository, add notes and create tasks in it for one hour',
};
function message(code: string, purpose: CodeFor): { subject: string; text: string } {
  if (purpose.kind === 'email') return { subject: `${code} is your Braid sign-in code`, text: `Your Braid sign-in code is ${code}. It expires in ten minutes.\n\nEnter it in the browser where you requested it. If you did not request this code, you can ignore this email.` };
  return { subject: `${code} is your Braid code for a coding agent`, text: `A coding agent asked to sign in to Braid as you. If you asked it to, give it this code: ${code}\n\nThe code expires in ten minutes. With it, the agent can ${AGENT_ACCESS[purpose.scope]}. It cannot approve or merge pull requests, and it cannot change who has access.\n\nIf you did not ask for this, ignore this email.` };
}
/** The digest a code is kept and checked as, bound to its flow. */
export const emailCodeDigest = (env: BraidEnv, flowId: string, code: string) => digest(`${env.SESSION_SECRET}:${flowId}:${code}`);

/**
 * Emails a ten-minute code and keeps only its digest. Browsers and agents share the limits: ten requests an hour for
 * each network address, three in ten minutes for each email address, and 500 a day in all.
 */
export async function sendEmailCode(env: BraidEnv, ip: string, email: string, purpose: CodeFor): Promise<{ flowId: string; expires: number }> {
  if (!env.EMAIL || !env.EMAIL_FROM) throw new HttpError(503, 'Email sign-in is not configured for this deployment.');
  const security = securityOf(env);
  for (const [key, limit, period] of [[`email-ip:${ip}`, 10, 3_600_000], [`email-address:${await digest(email)}`, 3, 600_000], ['email-global', 500, 86_400_000]] as const) {
    const budget = await security.consume(key, limit, period);
    if (!budget.allowed) throw new HttpError(429, 'Too many sign-in requests. Try again later.', budget.retryAfter);
  }
  const code = shortCode();
  const flowId = crypto.randomUUID();
  const expires = Date.now() + 600_000;
  await security.challenge(flowId, JSON.stringify({ ...purpose, email, digest: await emailCodeDigest(env, flowId, code) }), expires);
  try {
    await env.EMAIL.send({ from: env.EMAIL_FROM, to: email, ...message(code, purpose) });
  } catch (error) {
    logFailure('sign_in_email_failed', error);
    await security.takeChallenge(flowId);
    throw new HttpError(503, 'The sign-in email could not be sent. Try again shortly.');
  }
  return { flowId, expires };
}

export async function emailSignIn(request: Request, env: BraidEnv, ip: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== publicOrigin(env).origin) throw new HttpError(400, 'Use the configured application URL to sign in.');
  if (!env.EMAIL || !env.EMAIL_FROM) throw new HttpError(503, 'Email sign-in is not configured for this deployment.');
  const security = securityOf(env);
  const body = await jsonBody(request);
  if (url.pathname.endsWith('/start')) {
    const { email } = parse(emailStart, body);
    const { flowId, expires } = await sendEmailCode(env, ip, email, { kind: 'email' });
    return Response.json({ flowId, expiresAt: new Date(expires).toISOString() }, { headers: { 'set-cookie': cookie('braid-email', flowId, request, 600) } });
  }
  const { flowId, code } = parse(emailCode, body);
  if (cookies(request)['braid-email'] !== flowId) throw new HttpError(400, 'Enter the code in the browser where you requested it.');
  const email = await security.verifyEmail(flowId, await emailCodeDigest(env, flowId, code));
  if (!email) throw new HttpError(401, 'That code is invalid or expired. Request a new code after five attempts.');
  const user = await security.profile({ id: `email:${email}`, email, name: email.split('@')[0] });
  const response = await signedIn(request, env, user);
  response.headers.append('set-cookie', cookie('braid-email', '', request, 0));
  return response;
}
