import * as oauth from 'oauth4webapi';
import * as v from 'valibot';
import { directoryOf, publicOrigin, securityOf, type BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';
import { cookie, cookies, digest, equalSecret, validSession } from '../http/auth';
import { HttpError } from '../errors';
import { githubApi } from '../github/client';
import { sessionCookie } from './email-auth';
import type { GitHubIdentity } from '../repositories/provenance';

const github = {
  issuer: 'https://github.com/login/oauth', authorization_endpoint: 'https://github.com/login/oauth/authorize', token_endpoint: 'https://github.com/login/oauth/access_token',
} satisfies oauth.AuthorizationServer;
function configuration(env: BraidEnv) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new HttpError(503, 'GitHub sign-in is not configured for this deployment.');
  const origin = publicOrigin(env);
  return { client: { client_id: env.GITHUB_CLIENT_ID } satisfies oauth.Client, redirect: `${origin.origin}/api/auth/github/callback`, origin: origin.origin };
}
const stateCookie = (value: string, request: Request, age = 600) => cookie('braid-oauth', value, request, age, 'Lax');

export async function githubLogin(request: Request, env: BraidEnv): Promise<Response> {
  const config = configuration(env);
  if (new URL(request.url).origin !== config.origin) throw new HttpError(400, 'Sign in from the configured application URL.');
  const security = securityOf(env);
  const state = oauth.generateRandomState(), verifier = oauth.generateRandomCodeVerifier();
  await security.beginOAuth(await digest(state), verifier);
  const url = new URL(github.authorization_endpoint);
  url.searchParams.set('client_id', config.client.client_id);
  url.searchParams.set('redirect_uri', config.redirect);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return new Response(null, { status: 302, headers: { location: url.toString(), 'set-cookie': stateCookie(state, request) } });
}

/** The signed-in GitHub account and its email addresses, as GitHub's user API returns them. */
const account = v.object({
  user: v.object({ id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), login: v.pipe(v.string(), v.regex(/^[a-z\d](?:[a-z\d-]{0,38})$/i)), name: v.nullish(v.string()) }),
  emails: v.array(v.object({ email: v.pipe(v.string(), v.toLowerCase()), verified: v.boolean(), primary: v.boolean() })),
});
/** The account a GitHub sign-in names, and the GitHub id and login that give it a no-reply address in commits. */
export function githubProfile(profile: unknown, addresses: unknown, allowMissingEmail = false): { identity: AccountIdentity; github: GitHubIdentity } {
  const parsed = v.safeParse(account, { user: profile, emails: addresses });
  if (!parsed.success) throw new HttpError(401, 'GitHub did not return a valid account.');
  const { user, emails } = parsed.output;
  const email = emails.find(entry => entry.verified && entry.primary);
  if (!email && !allowMissingEmail) throw new HttpError(403, 'Verify your primary email address on GitHub before signing in.');
  return { identity: { id: `github:${user.id}`, email: email?.email ?? '', name: user.name ? user.name.slice(0, 120) : user.login }, github: { id: user.id, login: user.login } };
}

export async function githubCallback(request: Request, env: BraidEnv): Promise<Response> {
  const config = configuration(env);
  const url = new URL(request.url);
  if (url.origin !== config.origin) throw new HttpError(400, 'This callback URL does not match the application.');
  const state = cookies(request)['braid-oauth'];
  const returned = url.searchParams.get('state');
  if (!state || !returned || state.length > 128 || !await equalSecret(state, returned)) throw new HttpError(400, 'The sign-in request expired or did not originate in this browser.');
  const security = securityOf(env);
  const verifier = await security.takeOAuth(await digest(state));
  if (!verifier) throw new HttpError(400, 'This sign-in request expired or has already been used.');
  let parameters: URLSearchParams;
  try {
    parameters = oauth.validateAuthResponse(github, config.client, url, state);
  } catch {
    throw new HttpError(400, 'The GitHub sign-in response could not be verified. Start a new sign-in.');
  }
  const response = await oauth.authorizationCodeGrantRequest(github, config.client, oauth.ClientSecretPost(env.GITHUB_CLIENT_SECRET), parameters, config.redirect, verifier, { signal: AbortSignal.timeout(10_000) });
  const tokens = await oauth.processAuthorizationCodeResponse(github, config.client, response);
  const [profile, emails] = await Promise.all([githubApi('/user', tokens.access_token), githubApi('/user/emails', tokens.access_token)]);
  const { identity: external, github: account } = githubProfile(profile, emails);
  const identity = await security.profile(external);
  await security.recordGitHubIdentity(identity.id, account, 'sign-in');
  await directoryOf(env).account(identity, account, true);
  const result = new Response(null, { status: 303, headers: { location: `${config.origin}/`, 'set-cookie': await sessionCookie(request, env, identity) } });
  result.headers.append('set-cookie', stateCookie('', request, 0));
  // The GitHub access token is deliberately not retained or returned to the browser.
  return result;
}

export async function githubSession(request: Request, env: BraidEnv): Promise<AccountIdentity | null> {
  const token = cookies(request)['braid-session'];
  if (!await validSession(env.SESSION_SECRET, token)) return null;
  const user = await securityOf(env).identity(await digest(token));
  return user && env.DIRECTORY ? directoryOf(env).identity(user) : user;
}
