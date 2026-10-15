import type { FileBlame } from '../../shared/types';
import type { Result } from '../errors';
import { addColumn } from '../sql';

export const PUBLIC_BLAME_PENDING = 30;
export const PUBLIC_BLAME_HOURLY = 60;
// Speculation leaves twenty queue places and forty-four hourly starts for requested files.
export const BLAME_WARM_FILES = 8;
export const BLAME_WARM_HOURLY = 16;
const HOUR = 3_600_000, LEASE = 60_000, ATTEMPTS = 3;
type Job = { path: string; attempts: number; warm: number };

/** Persisted file jobs, including leases: eviction retries work without resetting its rolling-hour cost. */
export class BlameQueue {
  private sql: SqlStorage;
  constructor(private storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS blame_queue (path TEXT PRIMARY KEY, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS blame_starts (started INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS blame_unavailable (path TEXT PRIMARY KEY, head TEXT NOT NULL, value TEXT NOT NULL)');
    for (const table of ['blame_queue', 'blame_starts']) addColumn(this.sql, table, 'warm', 'INTEGER NOT NULL DEFAULT 0');
    this.sql.exec('CREATE TABLE IF NOT EXISTS blame_warmed (head TEXT PRIMARY KEY, started INTEGER NOT NULL)');
  }

  has(path: string) { return this.sql.exec('SELECT path FROM blame_queue WHERE path = ?', path).toArray().length > 0; }
  requested(path: string) { return this.sql.exec('SELECT path FROM blame_queue WHERE path = ? AND warm = 0', path).toArray().length > 0; }
  full() { return this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM blame_queue').one().count >= PUBLIC_BLAME_PENDING; }
  /** An actual request promotes speculative work without resetting its lease or attempts. */
  enqueue(path: string) { this.sql.exec('INSERT INTO blame_queue (path, due) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET warm = 0', path, Date.now()); }
  done(path: string) { this.sql.exec('DELETE FROM blame_queue WHERE path = ?', path); }
  clearPublic() { this.sql.exec('DELETE FROM blame_queue WHERE warm = 0'); }

  /** Claim before discovery I/O, durably once per commit. At most two discoveries per rolling hour. */
  claimWarm(head: string): boolean {
    return this.storage.transactionSync(() => {
      if (this.sql.exec('SELECT head FROM blame_warmed WHERE head = ?', head).toArray().length) return false;
      if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM blame_warmed WHERE started > ?', Date.now() - HOUR).one().count >= 2) return false;
      if (!this.warmRoom()) return false;
      this.sql.exec('INSERT INTO blame_warmed (head, started) VALUES (?, ?)', head, Date.now());
      return true;
    });
  }

  private starts(warmOnly: boolean, time = Date.now()) {
    return this.sql.exec<{ used: number; first: number | null }>(`SELECT COUNT(*) AS used, MIN(started) AS first FROM blame_starts WHERE started > ?${warmOnly ? ' AND warm = 1' : ''}`, time - HOUR).one();
  }

  private warmRoom(): number {
    const queued = this.sql.exec<{ count: number; warm: number }>('SELECT COUNT(*) AS count, COALESCE(SUM(warm), 0) AS warm FROM blame_queue').one();
    return Math.max(0, Math.min(BLAME_WARM_FILES - queued.warm, PUBLIC_BLAME_PENDING - 20 - queued.count, BLAME_WARM_HOURLY - this.starts(true).used - queued.warm));
  }

  warm(paths: string[]) {
    for (const path of paths.slice(0, BLAME_WARM_FILES)) {
      if (!this.warmRoom()) break;
      this.sql.exec('INSERT OR IGNORE INTO blame_queue (path, due, warm) VALUES (?, ?, 1)', path, Date.now());
    }
  }

  /** Bounded negative cache: absent, binary and oversized files must not look perpetually pending. */
  unavailable(path: string, head: string): Result<FileBlame> | undefined {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM blame_unavailable WHERE path = ? AND head = ?', path, head).toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  remember(path: string, head: string, result: Result<FileBlame>) {
    this.sql.exec('INSERT OR REPLACE INTO blame_unavailable (path, head, value) VALUES (?, ?, ?)', path, head, JSON.stringify(result));
    this.sql.exec('DELETE FROM blame_unavailable WHERE rowid NOT IN (SELECT rowid FROM blame_unavailable ORDER BY rowid DESC LIMIT ?)', PUBLIC_BLAME_PENDING);
  }

  next(): number | null {
    const warm = this.starts(true);
    const warmAfter = warm.used >= BLAME_WARM_HOURLY ? warm.first! + HOUR : 0;
    const due = this.sql.exec<{ due: number | null }>('SELECT MIN(CASE WHEN warm = 1 THEN MAX(due, ?) ELSE due END) AS due FROM blame_queue', warmAfter).one().due;
    if (due === null) return null;
    const budget = this.starts(false);
    return Math.max(due, budget.used >= PUBLIC_BLAME_HOURLY ? budget.first! + HOUR : 0);
  }

  /** Reserve before any upstream I/O. An interrupted attempt still consumes budget and a retry. */
  take(): Job[] {
    return this.storage.transactionSync(() => {
      const time = Date.now();
      this.sql.exec('DELETE FROM blame_starts WHERE started <= ?', time - HOUR);
      this.sql.exec('DELETE FROM blame_queue WHERE attempts >= ? AND due <= ?', ATTEMPTS, time);
      const used = this.starts(false, time).used;
      let warmLeft = BLAME_WARM_HOURLY - this.starts(true, time).used;
      const jobs = this.sql.exec<Job>('SELECT path, attempts, warm FROM blame_queue WHERE due <= ? ORDER BY warm, due, path LIMIT ?', time, Math.max(0, Math.min(2, PUBLIC_BLAME_HOURLY - used))).toArray()
        .filter(job => !job.warm || warmLeft-- > 0);
      for (const job of jobs) {
        this.sql.exec('UPDATE blame_queue SET attempts = attempts + 1, due = ? WHERE path = ?', time + LEASE, job.path);
        this.sql.exec('INSERT INTO blame_starts (started, warm) VALUES (?, ?)', time, job.warm);
      }
      return jobs.map(job => ({ ...job, attempts: job.attempts + 1 }));
    });
  }

  failed(job: Job) {
    if (job.attempts >= ATTEMPTS) this.done(job.path);
    else this.sql.exec('UPDATE blame_queue SET due = ? WHERE path = ?', Date.now() + 5_000 * 2 ** (job.attempts - 1), job.path);
  }
}

