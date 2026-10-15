import { expect, it } from 'vitest';
import { withheldFixture } from '../test/withheld';

it('opens a published merge ancestor even when its clock was days ahead of the merge', async () => {
  const f = await withheldFixture();
  try {
    const at = Number(f.h.git.native(['log', '-1', '--format=%ct', f.base]).trim());
    const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
    const commit = (ref: string, mark: number, date: number, parents: string[]) =>
      `commit ${ref}\nmark :${mark}\ncommitter Test <test@example.test> ${date} +0000\n${data('Clock test')}`
      + parents.map((p, i) => `${i ? 'merge' : 'from'} ${p}\n`).join('') + `M 100644 inline clock.txt\n${data('published\n')}`;
    f.h.git.native(['fast-import', '--quiet'],
      commit('refs/side/clock', 1, at + 3 * 86_400, [f.base])
      + commit('refs/side/clock', 2, at + 3600, [':1'])
      + commit('refs/heads/main', 3, at + 7200, [f.base, ':2']));
    const target = f.h.git.native(['rev-parse', 'main^2^']).trim();
    f.h.git.native(['update-ref', '-d', 'refs/side/clock']);
    expect(f.h.git.native(['rev-list', 'main']).trim().split('\n')).toContain(target);
    const path = `/api/repository?ref=${target}&path=clock.txt`;
    expect((await f.call(path, true)).status).toBe(200);
    const response = await f.call(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: 'published\n' });
  } finally { await f.close(); }
});
