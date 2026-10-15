import { afterEach, expect, it, vi } from 'vitest';
import { ContentStore } from './content';
import { storageFixture } from '../test/storage';

const databases: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.db.close(); });
function fixture() { const db = storageFixture(); databases.push(db); return { ...db, content: new ContentStore(db.storage) }; }

it('round trips multi-megabyte Unicode content in bounded SQLite rows across instances', () => {
  const f = fixture(), value = { before: '界😀\t\n'.repeat(150_000), after: 'x'.repeat(1_000_000) };
  f.content.put('diff:unicode', value);
  expect(new ContentStore(f.storage).get('diff:unicode')).toEqual(value);
  const rows = [...f.content.chunks()];
  expect(rows.length).toBeGreaterThan(50);
  for (const row of rows) {
    expect(new TextEncoder().encode(row.value).length).toBeLessThanOrEqual(131_072);
    expect(/[\uD800-\uDFFF]/u.test(row.value)).toBe(false);
  }
});

it('replaces plans atomically and exports immutable result content only', () => {
  const f = fixture(); f.content.put('plan:x', { state: 'prior' }); f.content.put('diff:y', { text: 'review' }); f.content.put('result:z', { summary: 'previous' });
  const exec = f.storage.sql.exec.bind(f.storage.sql);
  vi.spyOn(f.storage.sql, 'exec').mockImplementation((query, ...bindings) => {
    if (query.startsWith('INSERT INTO content_chunks') && bindings[1] === 1) throw new Error('Interrupted write');
    return exec(query, ...bindings);
  });
  expect(() => f.content.put('plan:x', { state: 'next'.repeat(40_000) })).toThrow('Interrupted write');
  expect(f.content.get('plan:x')).toEqual({ state: 'prior' });
  expect([...f.content.chunks()].map(row => row.id)).toEqual(['diff:y', 'result:z']);
  expect(f.content.get('missing')).toBeUndefined();
});

it('keeps a streamed export stable while later requests add or repeat immutable content', () => {
  const f = fixture(), value = { text: 'old'.repeat(30_000) };
  f.content.put('diff:a', value); f.content.put('result:b', { summary: 'accepted' });
  const exportRows = f.content.chunks();
  const first = exportRows.next().value!;
  f.content.put('diff:a', { text: 'replacement' });
  f.content.put('diff:new', { text: 'later' });
  f.content.put('result:b', { summary: 'replacement' });
  const rows = [first, ...exportRows];
  expect(new Set(rows.map(row => row.id))).toEqual(new Set(['diff:a', 'result:b']));
  expect(JSON.parse(rows.filter(row => row.id === 'diff:a').map(row => row.value).join(''))).toEqual(value);
  expect(f.content.get('result:b')).toEqual({ summary: 'accepted' });
});

it('stores bytes such as screenshots once, in parts small enough for any row', () => {
  const f = fixture(), bytes = Uint8Array.from({ length: 300_000 }, (_, index) => index % 251);
  f.content.putBytes('image:a.png', bytes);
  f.content.putBytes('image:a.png', new Uint8Array([1]));
  expect(new ContentStore(f.storage).bytes('image:a.png')).toEqual(bytes);
  expect(f.db.prepare("SELECT COUNT(*) AS parts FROM content_bytes WHERE id = 'image:a.png'").get()).toEqual({ parts: 3 });
  expect(f.content.bytes('image:missing.png')).toBeUndefined();
});
