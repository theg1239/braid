import { DurableObject } from 'cloudflare:workers';
import type { BraidEnv } from '../env';
import type { ChangeStatus, HotPath } from '../../shared/types';

interface PathClaim { changeId: string; number: number; title: string; status: ChangeStatus; author: string }
type Row = PathClaim & { path: string };

/**
 * Which active changes touch which files, sharded by path. Agents ask it before
 * editing and the change store records overlaps on submission; it never blocks
 * work. Landing correctness comes from the queue's three-way merge, not from here.
 */
export class PathIndex extends DurableObject<BraidEnv> {
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS claims (path TEXT NOT NULL, change_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, author TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (path, change_id))');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS claims_change ON claims(change_id)');
  }

  private rows(paths: string[], exclude = ''): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < paths.length; i += 90) {
      const chunk = paths.slice(i, i + 90);
      rows.push(...this.ctx.storage.sql.exec<{ path: string; change_id: string; number: number; title: string; status: ChangeStatus; author: string }>(
        `SELECT path, change_id, number, title, status, author FROM claims WHERE path IN (${chunk.map(() => '?').join(',')}) AND change_id != ? ORDER BY updated_at DESC LIMIT 400`, ...chunk, exclude,
      ).toArray().map(row => ({ path: row.path, changeId: row.change_id, number: row.number, title: row.title, status: row.status, author: row.author })));
    }
    return rows;
  }

  /** Replaces a change's claims within this shard and returns the other changes on the same paths. */
  register(claim: PathClaim, paths: string[]): Record<string, PathClaim[]> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM claims WHERE change_id = ?', claim.changeId);
      for (const path of paths) this.ctx.storage.sql.exec('INSERT INTO claims (path, change_id, number, title, status, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        path, claim.changeId, claim.number, claim.title.slice(0, 200), claim.status, claim.author.slice(0, 120), Date.now());
    });
    return this.group(this.rows(paths, claim.changeId));
  }

  status(changeId: string, status: ChangeStatus) {
    this.ctx.storage.sql.exec('UPDATE claims SET status = ?, updated_at = ? WHERE change_id = ?', status, Date.now(), changeId);
  }

  release(changeId: string) { this.ctx.storage.sql.exec('DELETE FROM claims WHERE change_id = ?', changeId); }

  touching(paths: string[]): Record<string, PathClaim[]> { return this.group(this.rows(paths)); }

  hot(limit: number): HotPath[] {
    const paths = this.ctx.storage.sql.exec<{ path: string; active: number }>('SELECT path, COUNT(*) AS active FROM claims GROUP BY path ORDER BY active DESC, path LIMIT ?', Math.min(50, limit)).toArray();
    const claims = this.group(this.rows(paths.map(row => row.path)));
    return paths.map(row => ({ path: row.path, active: row.active, changes: (claims[row.path] ?? []).slice(0, 8).map(claim => ({ changeId: claim.changeId, number: claim.number, status: claim.status, author: claim.author })) }));
  }

  private group(rows: Row[]) {
    const result: Record<string, PathClaim[]> = {};
    for (const { path, ...claim } of rows) (result[path] ??= []).push(claim);
    return result;
  }
}
