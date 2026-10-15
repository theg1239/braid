import * as v from 'valibot';
import { accessClaims } from '../schemas';
import { base64url } from 'jose';
import type { BraidEnv } from '../env';

/**
 * Short-lived access tokens carry signed agent identity. The gateway verifies signatures
 * locally and rechecks current membership and connection revocation on each request.
 */
export type AccessClaims = v.InferOutput<typeof accessClaims>;
export const ACCESS_PREFIX = 'braid_at_';
export const ACCESS_LIFETIME = 5 * 60_000;
const encoder = new TextEncoder();

const keys = new WeakMap<BraidEnv, Promise<CryptoKey>>();
/** Derived once per isolate: every agent request verifies a token with it. */
function signingKey(env: BraidEnv): Promise<CryptoKey> {
  let key = keys.get(env);
  if (!key) {
    key = (async () => {
      const secret = env.SESSION_SECRET || env.ADMIN_TOKEN;
      if (!secret || secret.length < 32) throw new Error('Access tokens need a session secret.');
      const material = await crypto.subtle.digest('SHA-256', encoder.encode(`braid-access-v1\0${secret}`));
      return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })();
    keys.set(env, key);
  }
  return key;
}

export async function mintAccess(env: BraidEnv, claims: Omit<AccessClaims, 'v'>): Promise<string> {
  const payload = base64url.encode(encoder.encode(JSON.stringify({ v: 1, ...claims })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload)));
  return `${ACCESS_PREFIX}${payload}.${base64url.encode(signature)}`;
}

export async function verifyAccess(env: BraidEnv, token: string): Promise<AccessClaims | null> {
  if (!token.startsWith(ACCESS_PREFIX) || token.length > 4096) return null;
  const [payload, signature] = token.slice(ACCESS_PREFIX.length).split('.');
  if (!payload || !signature) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await signingKey(env), new Uint8Array(base64url.decode(signature)), encoder.encode(payload))) return null;
    const claims = v.safeParse(accessClaims, JSON.parse(new TextDecoder().decode(base64url.decode(payload))));
    return claims.success ? claims.output : null;
  } catch { return null; }
}

/** The identity of one agent under a fleet connection, stable for the same name, so trust and daily caps apply per agent. */
export function fleetAgent(grant: string, name: string): { id: string; name: string } {
  return { id: `fleet:${grant}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name };
}
