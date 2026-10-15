import type { ComposeReader } from './compose';

export class CacheMiss extends Error {}

type Kind = 'commit' | 'tree' | 'blob';
interface ObjectSource { readCommit(hash: string): Promise<{ treeHash: string } | null>; readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>; readBlob(hash: string): Promise<Blob | null> }
interface SeedObjects { commits?: Map<string, { treeHash: string }>; trees?: Map<string, ArtifactsTreeEntry[]>; blobs?: Map<string, Uint8Array> }
const decode = <T>(kind: Kind, value: ArrayBuffer | string) => (kind === 'blob' ? new Uint8Array(value as ArrayBuffer) : JSON.parse(value as string)) as T;

const MEMORY_ENTRIES = 4000;
/** Objects kept in memory by their stored size, so a few large blobs cannot crowd the isolate's 128 MB. */
const MEMORY_BYTES = 24 * 1024 * 1024;
const STORED_BYTES = 96 * 1024 * 1024;
const BLOB_LIMIT = 1024 * 1024;

/**
 * Git objects never change, so they can be cached forever by hash. Artifacts
 * limits reads per namespace; the landing queue seeds this cache with the
 * trees and blobs it creates, so steady-state landings rarely read at all.
 */
export class ObjectCache {
  private memory = new Map<string, { value: unknown; size: number }>();
  private memoryBytes = 0;
  private inserts = 0;
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS git_objects (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, value BLOB NOT NULL, size INTEGER NOT NULL, used INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS git_objects_used ON git_objects(used)');
  }

  reader(source: ObjectSource): ComposeReader {
    return {
      readCommit: hash => this.read('commit', hash, async () => { const commit = await source.readCommit(hash); return commit ? { treeHash: commit.treeHash } : null; }),
      readTree: hash => this.read('tree', hash, () => source.readTree(hash)),
      readBlob: async hash => {
        let streamed: Blob | null = null;
        const bytes = await this.read('blob', hash, async () => {
          const blob = await source.readBlob(hash);
          // Artifacts can stream large blobs. Do not copy one into the isolate just to skip caching it.
          if (blob && blob.size > BLOB_LIMIT) { streamed = blob; return null; }
          return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
        });
        return streamed ?? (bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null);
      },
    };
  }

  /** Cache-only reads do not touch LRU timestamps or fetch missing Artifacts objects. */
  cachedReader(): ComposeReader {
    const read = <T>(kind: Kind, hash: string): T | null => {
      const memory = this.memory.get(`${kind}:${hash}`);
      if (memory) return memory.value as T;
      const row = this.sql.exec<{ value: ArrayBuffer | string }>('SELECT value FROM git_objects WHERE hash = ? AND kind = ?', hash, kind).toArray()[0];
      if (!row) throw new CacheMiss('Git object is not cached.');
      return decode<T>(kind, row.value);
    };
    return { readCommit: async hash => read('commit', hash), readTree: async hash => read('tree', hash), readBlob: async hash => { const bytes = read<Uint8Array<ArrayBuffer>>('blob', hash); return bytes ? new Blob([bytes]) : null; } };
  }

  seed(objects: SeedObjects) {
    for (const [hash, commit] of objects.commits ?? []) this.store('commit', hash, commit);
    for (const [hash, tree] of objects.trees ?? []) this.store('tree', hash, tree);
    for (const [hash, blob] of objects.blobs ?? []) this.store('blob', hash, blob);
  }

  private async read<T>(kind: Kind, hash: string, load: () => Promise<T | null>): Promise<T | null> {
    const key = `${kind}:${hash}`;
    const memory = this.memory.get(key);
    if (memory) {
      this.memory.delete(key); this.memory.set(key, memory);
      return memory.value as T;
    }
    const row = this.sql.exec<{ value: ArrayBuffer | string; size: number }>('SELECT value, size FROM git_objects WHERE hash = ? AND kind = ?', hash, kind).toArray()[0];
    if (row) {
      const value = decode<T>(kind, row.value);
      this.sql.exec('UPDATE git_objects SET used = ? WHERE hash = ?', Date.now(), hash);
      this.remember(key, value, row.size);
      return value;
    }
    const value = await load();
    // Missing objects are not cached: an object can appear after a push or an import completes.
    if (value !== null) this.store(kind, hash, value);
    return value;
  }

  /** Keeps an object in memory, dropping the least recently used past the entry or byte limit; one larger than the whole budget stays out. */
  private remember(key: string, value: unknown, size: number) {
    const previous = this.memory.get(key);
    if (previous) { this.memory.delete(key); this.memoryBytes -= previous.size; }
    if (size > MEMORY_BYTES) return;
    this.memory.set(key, { value, size });
    this.memoryBytes += size;
    while (this.memory.size > MEMORY_ENTRIES || this.memoryBytes > MEMORY_BYTES) {
      const [oldest, entry] = this.memory.entries().next().value!;
      this.memory.delete(oldest);
      this.memoryBytes -= entry.size;
    }
  }

  private store(kind: Kind, hash: string, value: unknown) {
    const stored = kind === 'blob' ? value as Uint8Array : JSON.stringify(value);
    const size = typeof stored === 'string' ? stored.length * 2 : stored.byteLength;
    this.remember(`${kind}:${hash}`, value, size);
    if (size > BLOB_LIMIT) return;
    this.sql.exec('INSERT OR REPLACE INTO git_objects (hash, kind, value, size, used) VALUES (?, ?, ?, ?, ?)', hash, kind, typeof stored === 'string' ? stored : stored.slice().buffer, size, Date.now());
    if (++this.inserts % 200 === 0) this.evict();
  }

  private evict() {
    const total = this.sql.exec<{ total: number | null }>('SELECT SUM(size) AS total FROM git_objects').one().total ?? 0;
    if (total <= STORED_BYTES) return;
    // Drop the least recently used quarter so eviction stays rare.
    const rows = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM git_objects').one().count;
    this.sql.exec('DELETE FROM git_objects WHERE hash IN (SELECT hash FROM git_objects ORDER BY used LIMIT ?)', Math.ceil(rows / 4));
  }
}
