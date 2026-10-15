import { expect, it, vi } from 'vitest';
import { grow, withheldFixture } from '../test/withheld';

it('refuses a cold publication walk when the repository build budget is exhausted', async () => {
  const f = await withheldFixture();
  try {
    const { main } = grow(f, 5_000);
    for (let i = 0; i < 30; i++) expect(f.h.trunk.publicBuild(`prior-${i}`).allowed).toBe(true);
    const budget = vi.spyOn(f.h.trunk, 'publicBuild');
    f.calls.length = 0;
    const response = await f.call(`/api/repository?${new URLSearchParams({ ref: main.get(3)!, path: 'n.txt' })}`);
    expect.soft(response.status).toBe(503);
    expect.soft(response.headers.get('retry-after')).toBeTruthy();
    expect.soft(budget).toHaveBeenCalled();
    expect.soft(f.calls.filter(call => /^log:/.test(call))).toEqual([expect.stringMatching(/^log:(refs\/heads\/)?main$/)]);
    f.calls.length = 0;
    const warm = await f.call(`/api/repository?${new URLSearchParams({ ref: main.get(4_999)!, path: 'n.txt' })}`);
    expect(warm.status).toBe(200);
    expect(f.calls.filter(call => /^log:/.test(call))).toEqual([]);
  } finally { await f.close(); }
});
