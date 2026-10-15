import type { LocalActivityBatch, LocalActivityPage, LocalActivityRun } from '../../shared/agent-activity';
import { redactPublicText } from '../../shared/privacy';
import { modelName, toolName } from '../../shared/provenance';
import { HttpError, refused, type Result } from '../errors';

/** Bounded repository telemetry, separate from changes and the landing queue. */
export class LocalActivityStore {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS local_activity (id TEXT PRIMARY KEY, owner TEXT NOT NULL, session TEXT NOT NULL, change_id TEXT, seen INTEGER NOT NULL, value TEXT NOT NULL, UNIQUE(owner, session))');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS local_activity_change ON local_activity(change_id, seen)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS local_activity_limits (owner TEXT PRIMARY KEY, used INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
  }
  list(changeId?: string): LocalActivityPage {
    const sql = this.storage.sql;
    const rows = changeId
      ? sql.exec<{ value: string }>('SELECT value FROM local_activity WHERE change_id = ? ORDER BY seen DESC LIMIT 50', changeId)
      : sql.exec<{ value: string }>('SELECT value FROM local_activity ORDER BY seen DESC LIMIT 50');
    return { items: rows.toArray().map(row => JSON.parse(row.value) as LocalActivityRun) };
  }
  add(ownerId: string, agent: LocalActivityRun['agent'], input: LocalActivityBatch, changeNumber?: number): Result<{ accepted: string[] }> {
    try {
      return this.storage.transactionSync(() => {
        const sql = this.storage.sql, time = Date.now(), at = new Date(time).toISOString();
        sql.exec('DELETE FROM local_activity_limits WHERE reset_at <= ?', time);
        const quota = sql.exec<{ used: number; reset_at: number }>('SELECT used, reset_at FROM local_activity_limits WHERE owner = ?', ownerId).toArray()[0];
        if (quota && quota.used >= 120) throw new HttpError(429, 'Activity is arriving too quickly. Keep working; retry the queued batch.', Math.max(1, Math.ceil((quota.reset_at - time) / 1000)));
        sql.exec('INSERT INTO local_activity_limits VALUES (?, 1, ?) ON CONFLICT(owner) DO UPDATE SET used = used + 1', ownerId, time + 60_000);
        const row = sql.exec<{ value: string }>('SELECT value FROM local_activity WHERE owner = ? AND session = ?', ownerId, input.session).toArray()[0];
        const before: LocalActivityRun | undefined = row ? JSON.parse(row.value) : undefined;
        if (before?.changeId && input.changeId && before.changeId !== input.changeId) throw new HttpError(409, 'This run already belongs to a different pull request.');
        const events = new Map((before?.events ?? []).map(event => [event.id, event]));
        for (const event of input.events) if (!events.has(event.id)) events.set(event.id, event);
        const ordered = [...events.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
        // Keep the process outcome even if delayed async hooks arrive after it.
        const terminal = ordered.findLast(event => event.source === 'process' && ['finished', 'failed'].includes(event.kind));
        const kept = ordered.slice(-200);
        if (terminal && !kept.includes(terminal)) kept[0] = terminal;
        const run: LocalActivityRun = {
          id: before?.id ?? crypto.randomUUID(), session: input.session,
          agent: { name: redactPublicText(input.model ? modelName(input.model) : input.tool ? toolName(input.tool) : agent.name), owner: agent.owner, ...(input.model ? { model: input.model } : {}), ...(input.tool ? { tool: input.tool } : {}) },
          startedAt: before?.startedAt ?? ordered[0]?.at ?? at,
          lastSeenAt: input.active ? at : before?.lastSeenAt ?? ordered.at(-1)?.at ?? at,
          ...(before?.changeId || input.changeId ? { changeId: before?.changeId ?? input.changeId, changeNumber: before?.changeNumber ?? changeNumber } : {}),
          events: kept,
        };
        sql.exec('INSERT INTO local_activity VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner, session) DO UPDATE SET change_id = excluded.change_id, seen = excluded.seen, value = excluded.value', run.id, ownerId, input.session, run.changeId ?? null, time, JSON.stringify(run));
        sql.exec('DELETE FROM local_activity WHERE id IN (SELECT id FROM local_activity ORDER BY seen DESC LIMIT -1 OFFSET 1000)');
        return { ok: true, data: { accepted: input.events.map(event => event.id) } };
      });
    } catch (error) { return refused(error); }
  }
}
