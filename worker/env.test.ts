import { expect, it, vi } from 'vitest';
import { artifactsOf, publicOrigin } from './env';
import { recordingAnswers } from './test/rpc-answers';

it('disposes each Artifacts answer as it arrives, keeps its data, and leaves the repository handle to `using`', async () => {
  const closed = vi.fn();
  const repo = { [Symbol.dispose]: closed, createToken: async () => ({ plaintext: 'token' }), info: async () => ({ remote: 'https://git.example/r' }),
    readCommit: async () => null, log: async () => [{ hash: 'a'.repeat(40) }], revokeToken: async () => true };
  const answers = recordingAnswers({ get: async () => repo, create: async () => ({ name: 'r', remote: 'https://git.example/r', token: 'initial' }) });
  const artifacts = artifactsOf({ ARTIFACTS: answers.binding as unknown as Artifacts });
  {
    using handle = await artifacts.get('r');
    expect((await handle.createToken('read', 60)).plaintext).toBe('token');
    expect((await handle.info()).remote).toBe('https://git.example/r');
    expect(await handle.log()).toEqual([{ hash: 'a'.repeat(40) }]);
    expect(await handle.readCommit('a'.repeat(40))).toBeNull();
    expect(await handle.revokeToken('token')).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  }
  expect(closed).toHaveBeenCalledOnce();
  expect((await artifacts.create('r')).token).toBe('initial');
  expect(answers.undisposed()).toEqual([]);
});

it('takes the public origin only as a configured HTTPS origin with a session secret', () => {
  const secret = 'a-session-secret-of-at-least-32-chars';
  expect(publicOrigin({ PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: secret }).origin).toBe('https://braid.example');
  for (const [origin, message] of [['', 'The public application URL is not configured.'], ['not a url', 'The public application URL is not configured.'],
    ['http://braid.example', 'Configure an HTTPS application origin.'], ['https://braid.example/app', 'Configure an HTTPS application origin.']])
    expect(() => publicOrigin({ PUBLIC_ORIGIN: origin, SESSION_SECRET: secret })).toThrow(expect.objectContaining({ status: 503, message }));
  expect(() => publicOrigin({ PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'short' })).toThrow(expect.objectContaining({ status: 503 }));
});
