import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintAccess, verifyAccess } from './agent-token';
import type { BraidEnv } from '../env';

afterEach(() => { vi.restoreAllMocks(); });

describe('agent access tokens', () => {
  it('verifies what it minted with one key per deployment and refuses forgeries', async () => {
    const env = { SESSION_SECRET: 'a-session-secret-long-enough-for-tokens' } as BraidEnv;
    const claims = { grant: 'g1', user: { id: 'u1', email: 'maya@example.test', name: 'Maya' }, workspace: 'w1', team: 't1', scope: 'work' as const, agent: 'fleet:g1:atlas', name: 'atlas', exp: Date.now() + 60_000 };
    const imports = vi.spyOn(crypto.subtle, 'importKey');
    const token = await mintAccess(env, claims);
    for (let request = 0; request < 5; request++) expect(await verifyAccess(env, token)).toEqual({ v: 1, ...claims });
    expect(imports).toHaveBeenCalledTimes(1);
    const [payload, signature] = token.split('.');
    expect(await verifyAccess(env, `${payload}.${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`)).toBeNull();
    expect(await verifyAccess({ SESSION_SECRET: 'another-session-secret-of-enough-length' } as BraidEnv, token)).toBeNull();
    expect(await verifyAccess({ SESSION_SECRET: 'short' } as BraidEnv, token)).toBeNull();
  });
});
