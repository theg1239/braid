import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import * as v from 'valibot';
import type { BraidEnv } from '../env';
import { HttpError, logFailure } from '../errors';
import { cloudflareAccessClaims } from '../schemas';

export interface Identity { id: string; email?: string; role: 'owner' | 'viewer'; provider: 'owner-key' | 'cloudflare-access' | 'github' }
const resolvers = new Map<string, JWTVerifyGetKey>();

/** The issuer and audience come from deployment configuration, never from the JWT. */
function accessConfiguration(env: Pick<BraidEnv, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ACCESS_OWNER_EMAILS'>) {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.ACCESS_AUD?.trim();
  const owners = (env.ACCESS_OWNER_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !audience)
    throw new HttpError(503, 'Team sign-in is not configured. Ask the workspace owner to finish Cloudflare Access setup.');
  return { issuer: `https://${domain}`, audience, owners };
}

export async function accessIdentity(request: Request, env: BraidEnv, getKey?: JWTVerifyGetKey): Promise<Identity> {
  const { issuer, audience, owners } = accessConfiguration(env);
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16_384) throw new HttpError(401, 'Sign in through Cloudflare Access to open this workspace.');
  if (!getKey) {
    getKey = resolvers.get(issuer);
    if (!getKey) {
      getKey = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
      resolvers.set(issuer, getKey);
    }
  }
  let claims: v.InferOutput<typeof cloudflareAccessClaims>;
  try { claims = v.parse(cloudflareAccessClaims, (await jwtVerify(token, getKey, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'], clockTolerance: 5 })).payload); }
  catch (error) { logFailure('access_sign_in_refused', error); throw new HttpError(401, 'Your sign-in could not be verified. Sign in through Cloudflare Access again.'); }
  return { id: claims.sub, email: claims.email, role: owners.includes(claims.email) ? 'owner' : 'viewer', provider: 'cloudflare-access' };
}
