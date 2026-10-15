import * as v from 'valibot';
import { accessClaims, mcpAccessClaims } from '../schemas';
import { base64url } from 'jose';
import type { BraidEnv } from '../env';

/**
 * Short-lived access tokens carry signed agent identity. The gateway verifies signatures
 * locally and rechecks current membership and connection revocation on each request.
 */
export type AccessClaims = v.InferOutput<typeof accessClaims>;
export const ACCESS_PREFIX = 'braid_at_';
export const ACCESS_LIFETIME = 5 * 60_000;
/**
 * An OAuth access token for one MCP resource. Its own key keeps it out of the rest of the API: only /mcp verifies it,
 * and the prefix stays inside the pattern the credential scan finds.
 */
export type McpAccessClaims = v.InferOutput<typeof mcpAccessClaims>;
export const MCP_ACCESS_PREFIX = `${ACCESS_PREFIX}mcp_`;
export const MCP_ACCESS_LIFETIME = 60 * 60_000;
const encoder = new TextEncoder();

const keys = new WeakMap<BraidEnv, Map<string, Promise<CryptoKey>>>();
/** Derived once per isolate and purpose: every agent request verifies a token with one. */
function signingKey(env: BraidEnv, purpose: string): Promise<CryptoKey> {
  let derived = keys.get(env);
  if (!derived) keys.set(env, derived = new Map());
  let key = derived.get(purpose);
  if (!key) {
    key = (async () => {
      const secret = env.SESSION_SECRET || env.ADMIN_TOKEN;
      if (!secret || secret.length < 32) throw new Error('Access tokens need a session secret.');
      const material = await crypto.subtle.digest('SHA-256', encoder.encode(`${purpose}\0${secret}`));
      return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })();
    derived.set(purpose, key);
  }
  return key;
}

async function mint(env: BraidEnv, purpose: string, prefix: string, claims: object): Promise<string> {
  const payload = base64url.encode(encoder.encode(JSON.stringify({ v: 1, ...claims })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env, purpose), encoder.encode(payload)));
  return `${prefix}${payload}.${base64url.encode(signature)}`;
}

async function verify<S extends v.GenericSchema>(env: BraidEnv, purpose: string, prefix: string, schema: S, token: string): Promise<v.InferOutput<S> | null> {
  if (!token.startsWith(prefix) || token.length > 4096) return null;
  const [payload, signature] = token.slice(prefix.length).split('.');
  if (!payload || !signature) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await signingKey(env, purpose), new Uint8Array(base64url.decode(signature)), encoder.encode(payload))) return null;
    const claims = v.safeParse(schema, JSON.parse(new TextDecoder().decode(base64url.decode(payload))));
    return claims.success ? claims.output : null;
  } catch { return null; }
}

export const mintAccess = (env: BraidEnv, claims: Omit<AccessClaims, 'v'>) => mint(env, 'braid-access-v1', ACCESS_PREFIX, claims);
export const verifyAccess = (env: BraidEnv, token: string) => verify(env, 'braid-access-v1', ACCESS_PREFIX, accessClaims, token);
/** `aud` is the MCP resource the token was issued for; a token for another resource fails at /mcp. */
export const mintMcpAccess = (env: BraidEnv, claims: Omit<McpAccessClaims, 'v'>) => mint(env, 'braid-mcp-access-v1', MCP_ACCESS_PREFIX, claims);
export const verifyMcpAccess = (env: BraidEnv, token: string) => verify(env, 'braid-mcp-access-v1', MCP_ACCESS_PREFIX, mcpAccessClaims, token);

/** The identity of one agent under a fleet connection, stable for the same name, so trust and daily caps apply per agent. */
export function fleetAgent(grant: string, name: string): { id: string; name: string } {
  return { id: `fleet:${grant}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name };
}
