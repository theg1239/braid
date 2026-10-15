/** Bytes per stored part, well within the 2 MB a Durable Object's SQLite value may hold. */
const BYTE_PART = 128 * 1024;

/** Large immutable diffs, screenshots and prepared Git writes stay out of workspace snapshots and SQLite rows. */
export class ContentStore {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS content_chunks (id TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (id, part))');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS content_bytes (id TEXT NOT NULL, part INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY (id, part))');
  }
  /** Stores immutable bytes, such as a screenshot named by its hash, once. */
  putBytes(id: string, bytes: Uint8Array) {
    if (this.storage.sql.exec('SELECT part FROM content_bytes WHERE id = ? LIMIT 1', id).toArray().length) return;
    this.storage.transactionSync(() => {
      for (let offset = 0, part = 0; offset < bytes.length || part === 0; offset += BYTE_PART)
        this.storage.sql.exec('INSERT INTO content_bytes (id, part, value) VALUES (?, ?, ?)', id, part++, bytes.slice(offset, offset + BYTE_PART).buffer);
    });
  }
  bytes(id: string): Uint8Array<ArrayBuffer> | undefined {
    const rows = this.storage.sql.exec<{ value: ArrayBuffer }>('SELECT value FROM content_bytes WHERE id = ? ORDER BY part', id).toArray();
    if (!rows.length) return undefined;
    const bytes = new Uint8Array(rows.reduce((size, row) => size + row.value.byteLength, 0));
    let offset = 0;
    for (const row of rows) { bytes.set(new Uint8Array(row.value), offset); offset += row.value.byteLength; }
    return bytes;
  }
  put(id: string, value: unknown) {
    if (/^(diff|result):/.test(id) && this.storage.sql.exec('SELECT part FROM content_chunks WHERE id = ? LIMIT 1', id).toArray().length) return;
    const json = JSON.stringify(value);
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM content_chunks WHERE id = ?', id);
      let part = 0;
      for (let offset = 0; offset < json.length;) {
        let end = Math.min(offset + 32_768, json.length);
        if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
        this.storage.sql.exec('INSERT INTO content_chunks (id, part, value) VALUES (?, ?, ?)', id, part++, json.slice(offset, end));
        offset = end;
      }
    });
  }
  delete(id: string) { this.storage.sql.exec('DELETE FROM content_chunks WHERE id = ?', id); }
  get<T>(id: string): T | undefined {
    const rows = this.storage.sql.exec<{ value: string }>('SELECT value FROM content_chunks WHERE id = ? ORDER BY part', id).toArray();
    return rows.length ? JSON.parse(rows.map(row => row.value).join('')) as T : undefined;
  }
  /** Only immutable review data belongs in backups, not mutable publication plans. */
  chunks() {
    const ids = this.storage.sql.exec<{ id: string }>("SELECT DISTINCT id FROM content_chunks WHERE id LIKE 'diff:%' OR id LIKE 'result:%' ORDER BY id").toArray();
    const storage = this.storage;
    return (function* () {
      for (const { id } of ids) yield* storage.sql.exec<{ id: string; part: number; value: string }>('SELECT id, part, value FROM content_chunks WHERE id = ? ORDER BY part', id).toArray();
    })();
  }
}
