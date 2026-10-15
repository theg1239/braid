import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, logFailure } from './errors';

describe('logFailure', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const logged = (error: unknown) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logFailure('test_failed', error, { changeId: 'ch_1' });
    return JSON.parse(warn.mock.calls[0][0] as string) as Record<string, unknown>;
  };

  it('logs typed fields and never the message of an error Braid did not write', () => {
    const error = Object.assign(new Error('fetch https://x-access-token:ghs_secret@github.com failed'), { code: 'NOT_FOUND', status: 404 });
    expect(logged(error)).toEqual({ event: 'test_failed', changeId: 'ch_1', error: 'Error', code: 'NOT_FOUND', status: 404 });
  });
  it("keeps Braid's own fixed text", () => {
    expect(logged(new HttpError(409, 'The branch moved.', undefined, 'moved'))).toEqual({ event: 'test_failed', changeId: 'ch_1', error: 'Error', message: 'The branch moved.', code: 'moved', status: 409 });
  });
  it('names what was thrown when it is not an error', () => {
    expect(logged('text')).toEqual({ event: 'test_failed', changeId: 'ch_1', error: 'string' });
  });
});
