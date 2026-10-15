import { DatabaseSync } from 'node:sqlite';

/** Real SQLite with a small Durable Object storage adapter for persistence and boundary tests. */
export function storageFixture() {
  const db = new DatabaseSync(':memory:');
  const values = new Map<string, unknown>();
  let alarm: number | null = null, nesting = 0;
  const sql = { exec(query: string, ...bindings: (string | number | ArrayBuffer | null)[]) {
    const stmt = db.prepare(query);
    const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) as (string | number | null | Uint8Array)[];
    let rowsWritten = 0;
    const rows = stmt.columns().length ? stmt.all(...values) : (rowsWritten = Number(stmt.run(...values).changes), []);
    // node:sqlite returns BLOB columns as Uint8Array; Durable Objects return ArrayBuffer.
    for (const row of rows as Record<string, unknown>[]) for (const [key, value] of Object.entries(row)) if (value instanceof Uint8Array) row[key] = value.slice().buffer;
    return { rowsWritten, toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('Expected one row'); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  const storage = { sql,
    transactionSync<T>(run: () => T): T {
      const name = `test_${nesting++}`; db.exec(`SAVEPOINT ${name}`);
      try { const result = run(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { nesting--; }
    },
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { return values.delete(key); },
    async getAlarm() { return alarm; }, async setAlarm(time: number) { alarm = time; },
    async deleteAlarm() { alarm = null; },
    async deleteAll() { values.clear(); for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) db.exec(`DROP TABLE "${row.name}"`); },
  } as unknown as DurableObjectStorage;
  let ready = Promise.resolve();
  const background: Promise<unknown>[] = [];
  const ctx = { storage, id: { toString: () => 'test-workspace' }, blockConcurrencyWhile(fn: () => Promise<void>) { ready = fn(); return ready; },
    waitUntil(promise: Promise<unknown>) { background.push(promise); } } as unknown as DurableObjectState;
  /** Work handed to waitUntil, once it has all settled. */
  const settled = async () => { await Promise.allSettled(background.splice(0)); };
  return { ctx, storage, db, ready: () => ready, settled };
}
