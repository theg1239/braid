import type { Provenance } from '../../shared/types';
import { fileProvenance } from '../../shared/provenance';
import { agentKey, provenanceAuthorKind } from '../../shared/models';
import type { AgentStats } from './shard';
import { addColumn, Meta } from '../sql';

export interface AgentLineTotals { added: number; alive: number; contributor?: AgentStats }
const BACKFILL_ATTEMPTS = 3;

/** Only per-file overrides need extra counters; old commits keep their existing totals. */
export class FileLines {
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS commit_files (commit_id INTEGER NOT NULL, path TEXT NOT NULL, agent TEXT, added INTEGER NOT NULL DEFAULT 0, alive INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (commit_id, path))');
    sql.exec('CREATE TABLE IF NOT EXISTS file_agents (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS file_line_backfill (commit_id INTEGER PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0)');
    addColumn(sql, 'file_line_backfill', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
    const meta = new Meta(sql);
    if (!meta.get('file-lines-version')) {
      sql.exec(`INSERT OR IGNORE INTO file_line_backfill (commit_id) SELECT id FROM commits
        WHERE json_extract(provenance, '$.confidence') = 'braid' AND json_type(provenance, '$.files') = 'object'
        AND NOT EXISTS (SELECT 1 FROM commit_files WHERE commit_id = commits.id)`);
      meta.set('file-lines-version', '1');
    }
  }

  next() { return this.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM file_line_backfill WHERE attempts < ?', BACKFILL_ATTEMPTS).one().due; }

  pending() {
    return this.sql.exec<{ id: number; sha: string; provenance: string; offset: number }>(`SELECT c.id, c.sha, c.provenance, f.offset
      FROM file_line_backfill f JOIN commits c ON c.id = f.commit_id WHERE f.due <= ? AND f.attempts < ? ORDER BY f.due, f.commit_id LIMIT 1`, Date.now(), BACKFILL_ATTEMPTS).toArray()[0];
  }

  /** Charge before I/O so interruptions cannot retry a missing historical object forever. */
  start(row: number) {
    this.sql.exec('UPDATE file_line_backfill SET attempts = attempts + 1, due = ? WHERE commit_id = ?', Date.now() + 60_000, row);
  }

  record(row: number, provenance: Provenance) {
    for (const path of Object.keys(provenance.files ?? {})) {
      const file = fileProvenance(provenance, path), kind = provenanceAuthorKind(file);
      const key = agentKey({ kind, model: file.agent?.model, tool: file.agent?.tool, owner: file.owner });
      this.sql.exec('INSERT OR IGNORE INTO commit_files (commit_id, path, agent) VALUES (?, ?, ?)', row, path, key);
      if (!key) continue;
      const stored = this.sql.exec<{ value: string }>('SELECT value FROM file_agents WHERE key = ?', key).toArray()[0];
      const previous = stored ? JSON.parse(stored.value) as AgentStats : undefined;
      const agent = file.agent!;
      const stats: AgentStats = {
        key, kind: kind === 'simulated' ? 'simulated' : 'agent', name: agent.name, owner: file.owner, fleet: agent.fleet,
        models: [...new Set([...(previous?.models ?? []), ...(agent.model ? [agent.model] : [])])],
        tools: [...new Set([...(previous?.tools ?? []), ...(agent.tool ? [agent.tool] : [])])],
        authors: [...new Set([...(previous?.authors ?? []), ...(agent.id ? [agent.id] : [])])],
        firstActive: previous && previous.firstActive < provenance.at ? previous.firstActive : provenance.at,
        lastActive: previous && previous.lastActive > provenance.at ? previous.lastActive : provenance.at,
        // Pull request counts still belong to their submitting author; these agents supplied individual files.
        counts: {}, sentBack: 0, reverted: 0,
      };
      this.sql.exec('INSERT OR REPLACE INTO file_agents (key, value) VALUES (?, ?)', key, JSON.stringify(stats));
    }
  }

  added(row: number, path: string, count: number) {
    this.sql.exec('UPDATE commit_files SET added = added + ? WHERE commit_id = ? AND path = ?', count, row, path);
  }

  alive(row: number, path: string, delta: number) {
    this.sql.exec('UPDATE commit_files SET alive = alive + ? WHERE commit_id = ? AND path = ?', delta, row, path);
  }

  totals(contributors = false): Record<string, AgentLineTotals> {
    // Remove every override from the commit author, including files attributed to a person or Braid itself.
    const rows = this.sql.exec<{ agent: string; added: number; alive: number }>(`
      WITH overrides AS (SELECT commit_id, SUM(added) AS added, SUM(alive) AS alive FROM commit_files GROUP BY commit_id),
      contributions AS (
        SELECT c.agent, c.added - COALESCE(f.added, 0) AS added, c.alive - COALESCE(f.alive, 0) AS alive
        FROM commits c LEFT JOIN overrides f ON f.commit_id = c.id WHERE c.agent IS NOT NULL
        UNION ALL SELECT agent, added, alive FROM commit_files WHERE agent IS NOT NULL
      ) SELECT agent, SUM(added) AS added, SUM(alive) AS alive FROM contributions GROUP BY agent`).toArray();
    const totals: Record<string, AgentLineTotals> = Object.fromEntries(rows.map(row => [row.agent, { added: row.added, alive: row.alive }]));
    if (contributors) for (const row of this.sql.exec<{ key: string; value: string }>('SELECT key, value FROM file_agents')) {
      if (totals[row.key]) totals[row.key].contributor = JSON.parse(row.value) as AgentStats;
    }
    return totals;
  }
}
