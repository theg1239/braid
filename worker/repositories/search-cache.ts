import type { SearchBlob, SearchIndex } from './search';

/** Three commit manifests share immutable blobs. Eviction collects blobs no retained manifest uses. */
export class SearchIndexStore {
  constructor(private storage: DurableObjectStorage, private heads: number) {}

  has(head: string): boolean {
    this.initialize();
    return this.storage.sql.exec('SELECT 1 FROM search_heads_v2 WHERE head = ?', head).toArray().length > 0;
  }

  read(head: string): SearchIndex | null {
    this.initialize();
    const row = this.storage.sql.exec<{ limited: number }>('SELECT limited FROM search_heads_v2 WHERE head = ?', head).toArray()[0];
    if (!row) return null;
    this.touch(head);
    const files = this.storage.sql.exec<{ path: string; hash: string | null; searchable: number }>('SELECT path, hash, searchable FROM search_files_v2 WHERE head = ? ORDER BY ordinal', head).toArray();
    const blobs = this.storage.sql.exec<{ hash: string; content: string | null; size: number; limited: number }>('SELECT DISTINCT b.* FROM search_blobs_v2 b JOIN search_files_v2 f ON f.hash = b.hash WHERE f.head = ?', head).toArray();
    return { files: files.map(file => ({ ...file, searchable: file.searchable === 1 })),
      blobs: new Map(blobs.map(({ hash, limited, ...blob }) => [hash, { ...blob, limited: limited === 1 }])), truncated: row.limited === 1 };
  }

  /** Called during a build, after read() has initialized storage. Sizes include binary and oversized blobs. */
  blob(hash: string): SearchBlob | undefined {
    const row = this.storage.sql.exec<{ content: string | null; size: number; limited: number }>('SELECT content, size, limited FROM search_blobs_v2 WHERE hash = ?', hash).toArray()[0];
    return row && { ...row, limited: row.limited === 1 };
  }

  write(head: string, index: SearchIndex) {
    this.initialize();
    // Each content row is at most one 256 KiB searchable file; even a full index fits SQLite's row limit.
    this.storage.transactionSync(() => {
      for (const [hash, blob] of index.blobs) this.storage.sql.exec('INSERT OR IGNORE INTO search_blobs_v2 (hash, content, size, limited) VALUES (?, ?, ?, ?)', hash, blob.content, blob.size, Number(blob.limited));
      this.storage.sql.exec('DELETE FROM search_files_v2 WHERE head = ?', head);
      index.files.forEach((file, ordinal) => this.storage.sql.exec('INSERT INTO search_files_v2 (head, ordinal, path, hash, searchable) VALUES (?, ?, ?, ?, ?)', head, ordinal, file.path, file.hash, Number(file.searchable)));
      this.storage.sql.exec('INSERT OR REPLACE INTO search_heads_v2 (head, limited, used) VALUES (?, ?, (SELECT COALESCE(MAX(used), 0) + 1 FROM search_heads_v2))', head, Number(index.truncated));
      for (const old of this.storage.sql.exec<{ head: string }>('SELECT head FROM search_heads_v2 ORDER BY used DESC LIMIT -1 OFFSET ?', this.heads)) {
        this.storage.sql.exec('DELETE FROM search_files_v2 WHERE head = ?', old.head);
        this.storage.sql.exec('DELETE FROM search_heads_v2 WHERE head = ?', old.head);
      }
      this.storage.sql.exec('DELETE FROM search_blobs_v2 WHERE hash NOT IN (SELECT hash FROM search_files_v2 WHERE hash IS NOT NULL)');
    });
  }

  touch(head: string) {
    this.initialize();
    this.storage.sql.exec('UPDATE search_heads_v2 SET used = (SELECT MAX(used) + 1 FROM search_heads_v2) WHERE head = ?', head);
  }

  private initialize() {
    // Workspace reset can clear the database while this object's memory is still alive.
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS search_heads_v2 (head TEXT PRIMARY KEY, limited INTEGER NOT NULL, used INTEGER NOT NULL)');
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS search_files_v2 (head TEXT NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT, searchable INTEGER NOT NULL, PRIMARY KEY (head, ordinal))');
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS search_blobs_v2 (hash TEXT PRIMARY KEY, content TEXT, size INTEGER NOT NULL, limited INTEGER NOT NULL)');
    // Version 1 had no hashes; rebuild once rather than invent content identities during migration.
    this.storage.sql.exec('DROP TABLE IF EXISTS search_files_v1');
    this.storage.sql.exec('DROP TABLE IF EXISTS search_heads_v1');
  }
}
