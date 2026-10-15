/** What Braid's Durable Objects share about their SQLite storage. */

/** Adds a column that an object created before it lacks. True when it was added, so the caller can fill it. */
export function addColumn(sql: SqlStorage, table: string, column: string, type: string): boolean {
  if (sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(row => row.name === column)) return false;
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

/** An object's `meta` table: one text value per key. */
export class Meta {
  constructor(private sql: SqlStorage) { sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); }
  get(key: string): string | undefined { return this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value; }
  set(key: string, value: string) { this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }
  delete(...keys: string[]) { for (const key of keys) this.sql.exec('DELETE FROM meta WHERE key = ?', key); }
  /** A value written with `setJson`, or `fallback` when there is none. */
  json<T>(key: string, fallback: T): T { const value = this.get(key); return value === undefined ? fallback : JSON.parse(value) as T; }
  setJson(key: string, value: unknown) { this.set(key, JSON.stringify(value)); }
}
