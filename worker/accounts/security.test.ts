import { describe, expect, it } from 'vitest';
import { Security } from './security';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';
describe('durable authentication state', () => {
  it('revokes sessions and retains request budgets after eviction', async () => {
    const db = storageFixture(), first = new Security(db.ctx, {} as BraidEnv);
    await first.issue('hash', Date.now() + 60_000, { id: 'a', email: 'a@example.com', name: 'A' });
    await first.consume('ip', 1, 60_000);
    const next = new Security(db.ctx, {} as BraidEnv);
    expect(next.identity('hash')?.id).toBe('a');
    expect((await next.consume('ip', 1, 60_000)).allowed).toBe(false);
    next.revoke('hash');
    expect(next.valid('hash')).toBe(false); expect(next.identity('hash')).toBeNull();
  });
  it('consumes OAuth and email challenges once, with bounded attempts and expiration', async () => {
    const db = storageFixture(), auth = new Security(db.ctx, {} as BraidEnv);
    await auth.beginOAuth('state', 'verifier');
    expect(auth.takeOAuth('state')).toBe('verifier'); expect(auth.takeOAuth('state')).toBeNull();
    await auth.challenge('expired', 'secret', Date.now() - 1);
    expect(auth.takeChallenge('expired')).toBeNull();
    await auth.challenge('email', JSON.stringify({ kind: 'email', email: 'a@example.com', digest: 'right' }), Date.now() + 600_000);
    for (let i = 0; i < 5; i++) expect(auth.verifyEmail('email', 'wrong')).toBeNull();
    expect(auth.verifyEmail('email', 'right')).toBeNull();
    await auth.challenge('fresh', JSON.stringify({ kind: 'email', email: 'a@example.com', digest: 'right' }), Date.now() + 600_000);
    expect(auth.verifyEmail('fresh', 'right')).toBe('a@example.com'); expect(auth.verifyEmail('fresh', 'right')).toBeNull();
  });
  it('links verified sign-in methods while keeping passkeys bound to their account', () => {
    const db = storageFixture(), auth = new Security(db.ctx, {} as BraidEnv);
    const github = auth.profile({ id: 'github:1', email: 'a@example.com', name: 'A' });
    const email = auth.profile({ id: 'email:a@example.com', email: 'a@example.com', name: 'A' });
    expect(github.id).toBe(email.id);
    auth.addPasskey({ id: 'key', userId: github.id, publicKey: 'bytes', counter: 1, transports: [], createdAt: new Date().toISOString() });
    auth.removePasskey('other', 'key'); expect(auth.passkey('key')).not.toBeNull();
    expect(auth.advancePasskey('key', 1, 2)).toBe(true);
    expect(auth.advancePasskey('key', 1, 3)).toBe(false);
    auth.removePasskey(github.id, 'key'); expect(auth.passkey('key')).toBeNull();
  });
});
