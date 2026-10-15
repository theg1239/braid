import { base64url } from 'jose';
import { HttpError } from '../errors';
const encoder = new TextEncoder();
export const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
/** SHA-256, in hex. */
export async function digest(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
}
/** HMAC-SHA256 in hex, as GitHub signs `X-Hub-Signature-256`. */
export async function mac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
/** A code a person reads and types: eight characters, without the look-alikes I, O, 0 and 1. */
export const shortCode = () => [...crypto.getRandomValues(new Uint8Array(8))].map(byte => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte & 31]).join('');
/**
 * Seals text with AES-GCM under a key derived from the deployment secret for one `purpose`, bound to `context`, so a
 * value moved to another record or purpose no longer opens.
 */
export async function seal(secret: string, purpose: string, context: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await sealingKey(secret, purpose), encoder.encode(text));
  return `${base64url.encode(iv)}.${base64url.encode(new Uint8Array(sealed))}`;
}
/** What `seal` sealed, or null when it was sealed for another purpose, context or secret. */
export async function unseal(secret: string, purpose: string, context: string, sealed: string): Promise<string | null> {
  const [iv, ciphertext] = sealed.split('.');
  try {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(base64url.decode(iv)), additionalData: encoder.encode(context) }, await sealingKey(secret, purpose), new Uint8Array(base64url.decode(ciphertext)));
    return new TextDecoder().decode(bytes);
  } catch { return null; }
}
const sealingKey = async (secret: string, purpose: string) =>
  crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`${purpose}\0${secret}`)), 'AES-GCM', false, ['encrypt', 'decrypt']);
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
  const x = new Uint8Array(left), y = new Uint8Array(right);
  let different = 0; for (let i = 0; i < x.length; i++) different |= x[i] ^ y[i];
  return different === 0;
}
/** Standard base64 as bytes. */
export const base64Bytes = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
/** How long a session lasts from sign-in. */
export const SESSION_MS = 86_400_000;
export async function sessionToken(secret: string, expires = Date.now() + SESSION_MS): Promise<string> {
  const payload = `${expires}.${crypto.randomUUID()}`;
  return `${payload}.${await mac(secret, payload)}`;
}
export async function validSession(secret: string, token?: string): Promise<boolean> {
  if (!secret || !token || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || Number(parts[0]) <= Date.now() || Number(parts[0]) > Date.now() + SESSION_MS + 1000) return false;
  return equalSecret(parts[2], await mac(secret, `${parts[0]}.${parts[1]}`));
}
export function cookies(request: Request): Record<string, string> {
  const result = Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map(s => s.trim().split(/=(.*)/s)).filter(p => p.length > 1).map(([k, v]) => [k, v]));
  if (new URL(request.url).protocol === 'https:') for (const name of publicCookies) {
    delete result[name];
    if (result[`__Host-${name}`]) result[name] = result[`__Host-${name}`];
  }
  return result;
}
const publicCookies = ['braid-session', 'braid-oauth', 'braid-email', 'braid-passkey'];
/** An HTTP-only cookie. `Lax` is only for an OAuth flow's state, which GitHub's redirect back must carry. */
export function cookie(name: string, value: string, request: Request, maxAge = SESSION_MS / 1000, sameSite: 'Strict' | 'Lax' = 'Strict'): string {
  if (new URL(request.url).protocol === 'https:' && publicCookies.includes(name)) name = `__Host-${name}`;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export function assertOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site')
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  // This signed-link endpoint renders a plain HTML confirmation form. It still needs the origin check above.
  const unsubscribeForm = request.method === 'POST' && new URL(request.url).pathname === '/api/notifications/unsubscribe';
  if (!unsubscribeForm && ['POST', 'PUT', 'PATCH'].includes(request.method) && !request.headers.get('content-type')?.startsWith('application/json'))
    throw new HttpError(415, 'Send a JSON request.');
}
export async function jsonBody(request: Request, limit = 16_384, tooLarge = 'The request is too large.'): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, tooLarge);
  const reader = request.body?.getReader();
  if (!reader) return {};
  // Decoding as the body arrives holds one copy of a large submission, such as one with screenshots, rather than three.
  const decoder = new TextDecoder(), parts: string[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, tooLarge); }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  const text = parts.join('');
  parts.length = 0;
  try { const data = JSON.parse(text); if (!data || typeof data !== 'object' || Array.isArray(data)) throw 0; return data; }
  catch { throw new HttpError(400, 'Provide a valid JSON object.'); }
}
