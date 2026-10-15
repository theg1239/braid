import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { agentRoster } from './router';
import { Trunk } from './trunk';
import { agentKey } from '../../shared/provenance';
import type { ChangeAuthor } from '../../shared/types';

let h: Awaited<ReturnType<typeof changeHarness>>;
afterEach(async () => { await h?.close(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; error: string }): T => { if (!result.ok) throw new Error(result.error); return result.data; };
const owner = { id: 'user:maya', name: 'Maya' };
const claude: ChangeAuthor = { kind: 'agent', id: 'agent:claude', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.4', owner };
const codex: ChangeAuthor = { kind: 'agent', id: 'agent:codex', name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8', owner: { id: 'user:ishaan', name: 'Ishaan' } };
const combined = { kind: 'agent' as const, id: 'task:combined', name: 'Claude Opus 5.5 and GPT-6.1 Sol', owner };

async function setup() {
  h = await changeHarness();
  const base = h.git.commitTree({ 'README.md': 'Start\n', '.braid/policy.json': JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 } }) });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  await h.trunk.configure(h.repository, { enabled: true, actor: 'Owner' });
}

describe('per-file roster totals', () => {
  it('splits combined landings by the same file authors as blame and tracks surviving lines', async () => {
    await setup();
    const body = { title: 'Combined task', summary: 'Chosen proposals', baseCommit: h.head(), files: [
      { path: 'a.ts', content: 'a one\na two\n' }, { path: 'a-extra.ts', content: 'a extra\n' },
      { path: 'b.ts', content: 'b one\nb two\nb three\n' }, { path: 'fallback.md', content: 'Combined author\n' },
      { path: '.braid/missions/task/decision.md', content: 'Selected by Braid\n' }, { path: 'human.md', content: 'A person wrote this\n' },
    ] };
    const change = ok(await h.shard(0).submit({ ...h.context(combined, 0), system: true, fileAuthors: {
      'a.ts': claude, 'a-extra.ts': { ...claude, tool: 'claude-code/2.5' }, 'b.ts': codex,
      '.braid/missions/task/decision.md': { kind: 'bot', id: 'braid', name: 'Braid', tool: 'braid' },
      'human.md': { kind: 'human', id: 'person', name: 'A person' },
    } }, body, 'per-file-roster-combined'));
    await h.settle();
    expect(ok(await h.shard(0).get(change.id)).status).toBe('landed');
    const expected = {
      [agentKey(claude)!]: { added: 3, alive: 3 }, [agentKey(codex)!]: { added: 3, alive: 3 }, [agentKey(combined)!]: { added: 1, alive: 1 },
    };
    expect(await h.trunk.agentLines(h.repository)).toEqual(expected);
    for (const [path, author] of [['a.ts', claude], ['a-extra.ts', claude], ['b.ts', codex]] as const) {
      expect(ok(await h.trunk.blame(h.repository, path)).ranges[0].provenance.agent?.model).toBe(author.model);
    }
    const roster = await agentRoster(h.env, h.repository);
    expect(Object.fromEntries(roster.map(record => [record.id, record.lines]))).toEqual(expected);
    expect(roster.find(record => record.id === agentKey(claude))).toMatchObject({ name: claude.name, owner, tools: ['claude-code/2.4', 'claude-code/2.5'] });
    expect(roster.some(record => record.name === 'Braid')).toBe(false);
    // Repeated roster reads use the stored counts, without walking Git or reading file contents.
    const reads = vi.spyOn(h.artifacts, 'get'); reads.mockClear();
    await agentRoster(h.env, h.repository); await agentRoster(h.env, h.repository);
    expect(reads).not.toHaveBeenCalled();

    ok(await h.submit('later', { title: 'Revise chosen files', summary: 'Revise and delete', baseCommit: h.head(), files: [
      { path: 'a.ts', content: 'changed\na two\n' }, { path: 'b.ts', content: null },
    ] }));
    await h.settle();
    expect(await h.trunk.agentLines(h.repository)).toMatchObject({
      [agentKey(claude)!]: { added: 3, alive: 2 }, [agentKey(codex)!]: { added: 3, alive: 0 }, [agentKey(combined)!]: { added: 1, alive: 1 },
    });
  });

  it('keeps commit-wide totals for older notes without files', async () => {
    await setup();
    ok(await h.submit({ ...claude, kind: 'agent' }, { title: 'Old-style contribution', summary: 'One author', baseCommit: h.head(), agent: { tool: claude.tool }, files: [
      { path: 'a.ts', content: 'a\nb\n' }, { path: 'b.ts', content: 'c\n' },
    ] }));
    await h.settle();
    expect(await h.trunk.agentLines(h.repository)).toEqual({ [agentKey(claude)!]: { added: 3, alive: 3 } });
    expect((await agentRoster(h.env, h.repository))[0]).toMatchObject({ changes: { landed: 1 }, lines: { added: 3, alive: 3 } });
  });

  it('backfills stored combined commits in bounded alarms, including lines deleted since landing', async () => {
    await setup();
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `file-${i}.ts`, content: `first ${i}\nsecond ${i}\n` }));
    ok(await h.shard(0).submit({ ...h.context(combined, 0), system: true,
      fileAuthors: Object.fromEntries(files.map((file, i) => [file.path, i % 2 ? codex : claude])),
    }, { title: 'Older combined task', summary: 'Chosen files', baseCommit: h.head(), files }, 'per-file-roster-old-combined'));
    await h.settle();
    ok(await h.submit('later', { title: 'Revise old task', summary: 'Delete and edit', baseCommit: h.head(), files: [
      { path: 'file-0.ts', content: null }, { path: 'file-8.ts', content: 'replacement\nsecond 8\n' },
    ] }));
    await h.settle();
    const expected = await h.trunk.agentLines(h.repository);
    const { ctx } = h.trunk as unknown as { ctx: DurableObjectState };
    // Retain the old commit totals, notes and current blame maps, as a deployed pre-upgrade object would.
    for (const table of ['commit_files', 'file_agents', 'file_line_backfill']) ctx.storage.sql.exec(`DELETE FROM ${table}`);
    ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'file-lines-version'");
    const restarted = new Trunk(ctx, h.env);
    const reads = vi.spyOn(h.artifacts, 'get'); reads.mockClear();
    await restarted.agentLines(h.repository);
    expect(reads).not.toHaveBeenCalled();
    await restarted.alarm();
    expect(ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM commit_files').one().count).toBeLessThanOrEqual(8);
    for (let i = 0; i < 9 && ctx.storage.sql.exec('SELECT 1 FROM file_line_backfill').toArray().length; i++) {
      ctx.storage.sql.exec('UPDATE file_line_backfill SET due = 0');
      await restarted.alarm();
    }
    expect(ctx.storage.sql.exec('SELECT 1 FROM file_line_backfill').toArray()).toEqual([]);
    expect(await restarted.agentLines(h.repository)).toEqual(expected);
    expect(expected).toMatchObject({
      [agentKey(claude)!]: { added: 10, alive: 7 }, [agentKey(codex)!]: { added: 8, alive: 8 }, [agentKey(combined)!]: { added: 0, alive: 0 },
    });
    reads.mockClear();
    await restarted.agentLines(h.repository); await restarted.agentLines(h.repository);
    expect(reads).not.toHaveBeenCalled();
  });
});
