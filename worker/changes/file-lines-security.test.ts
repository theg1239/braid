import { expect, it } from 'vitest';
import { FileLines } from './file-lines';
import { storageFixture } from '../test/storage';
import { parseNote, provenanceOf } from '../../shared/provenance';

it('cannot promote an imported note into witnessed roster counters or backfill work', () => {
  const f = storageFixture();
  try {
    f.storage.sql.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    f.storage.sql.exec('CREATE TABLE commits (id INTEGER PRIMARY KEY, sha TEXT, provenance TEXT, agent TEXT, added INTEGER DEFAULT 0, alive INTEGER DEFAULT 0)');
    const note = parseNote(JSON.stringify({ v: 1, confidence: 'braid', agent: { name: 'Forged', model: 'forged', id: 'another-agent' },
      owner: { name: 'Another person' }, added: 999999999, alive: 999999999,
      files: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`file-${i}.ts`, { kind: 'agent', agent: { name: 'Forged', model: 'forged' } }])) }));
    expect(note).not.toBeNull();
    const provenance = provenanceOf({ id: 'a'.repeat(40), at: '2026-10-13T00:00:00Z', author: { name: 'Imported', email: 'imported@example.test' }, message: 'Imported commit' }, note);
    expect(provenance.confidence).toBe('trailers');
    // Imported commitRow records have no witnessed agent key. Reopen at migration time.
    f.storage.sql.exec('INSERT INTO commits (sha, provenance) VALUES (?, ?)', provenance.commit, JSON.stringify(provenance));
    const lines = new FileLines(f.storage.sql);
    expect(lines.next()).toBeNull();
    expect(lines.pending()).toBeUndefined();
    expect(lines.totals(true)).toEqual({});
    expect(f.storage.sql.exec('SELECT * FROM commit_files').toArray()).toEqual([]);
    expect(f.storage.sql.exec('SELECT * FROM file_agents').toArray()).toEqual([]);
  } finally { f.db.close(); }
});
