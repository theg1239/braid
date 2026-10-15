import { describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn(async (_url: string) => ({ items: [], nextCursor: null })) }));
vi.mock('../lib/api', () => ({ request, earlyAccount: () => null, errorMessage: String }));
import { accountApi } from './api';

describe('repository search requests', () => {
  it('keeps the default first-page address unchanged', async () => {
    await accountApi.repositories();
    expect(request).toHaveBeenLastCalledWith('/api/repos?limit=30');
  });

  it('encodes the same query and sort alongside the opaque cursor on later pages', async () => {
    await accountApi.repositories('abc+/=', 20, { q: 'hello & world', sort: 'name' });
    const url = new URL(request.mock.lastCall![0], 'https://braid.example');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '20', cursor: 'abc+/=', q: 'hello & world', sort: 'name' });
  });
});
