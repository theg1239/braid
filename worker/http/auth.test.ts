import { describe, expect, it } from 'vitest';
import { assertOrigin, equalSecret, jsonBody, sessionToken, validSession } from './auth';

describe('workspace boundary', () => {
  it('accepts a signed session and rejects forgery, expiry, and a different owner key', async () => {
    const token = await sessionToken('test-secret');
    expect(await validSession('test-secret', token)).toBe(true);
    expect(await validSession('different-secret', token)).toBe(false);
    expect(await validSession('test-secret', `${token}f`)).toBe(false);
    expect(await validSession('test-secret', await sessionToken('test-secret', Date.now() - 1000))).toBe(false);
    expect(await validSession('', token)).toBe(false);
    expect(await equalSecret('a', 'a')).toBe(true);
    expect(await equalSecret('a', 'b')).toBe(false);
  });
  it('rejects cross-origin and non-JSON mutations', () => {
    expect(() => assertOrigin(new Request('https://braid.example/api/missions', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }))).toThrow(/Cross-site/);
    expect(() => assertOrigin(new Request('https://braid.example/api/missions', { method: 'POST', headers: { 'content-type': 'text/plain' } }))).toThrow(/JSON/);
  });
  it('bounds request bodies even without a content-length header', async () => {
    await expect(jsonBody(new Request('https://example.com', { method: 'POST', body: JSON.stringify({ body: 'x'.repeat(20_000) }) }))).rejects.toThrow(/too large/);
    await expect(jsonBody(new Request('https://example.com', { method: 'POST', body: '[]' }))).rejects.toThrow(/JSON object/);
  });
});
