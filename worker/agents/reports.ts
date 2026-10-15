import type { AgentReport } from '../../shared/types';
import { redactPublicText } from '../../shared/privacy';
import { HttpError, refused, type Result } from '../errors';
import { agentReport, agentReportId, parse } from '../schemas';

const DAY = 86_400_000;
const clean = (text: string, max: number) => redactPublicText(text).slice(0, max);

/** Kept inside the repository's Trunk object, separately from its Git and landing state. */
export class AgentReportStore {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS agent_reports (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, resolved INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS agent_report_limits (connection TEXT PRIMARY KEY, used INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
  }

  list(): AgentReport[] {
    return this.storage.sql.exec<{ value: string }>('SELECT value FROM agent_reports WHERE resolved = 0 ORDER BY seq DESC LIMIT 200').toArray().map(row => JSON.parse(row.value) as AgentReport);
  }

  add(agent: AgentReport['agent'], raw: unknown): Result<AgentReport> {
    try {
      const input = parse(agentReport, raw), now = Date.now();
      const report: AgentReport = {
        id: `ar_${crypto.randomUUID()}`, summary: clean(input.summary, 200), createdAt: new Date(now).toISOString(),
        ...(input.details !== undefined ? { details: clean(input.details, 4000) } : {}),
        ...(input.tool ? { tool: clean(input.tool, 200) } : {}),
        ...(input.pull_request ? { pullRequest: input.pull_request } : {}),
        agent: { connection: agent.connection, name: clean(agent.name, 120), ...(agent.model ? { model: clean(agent.model, 120) } : {}),
          owner: { name: clean(agent.owner.name, 80), ...(agent.owner.publicId ? { publicId: agent.owner.publicId } : {}), ...(agent.owner.github ? { github: clean(agent.owner.github, 39) } : {}) } },
      };
      return this.storage.transactionSync(() => {
        const sql = this.storage.sql;
        sql.exec('DELETE FROM agent_report_limits WHERE reset_at <= ?', now);
        const quota = sql.exec<{ used: number; reset_at: number }>('SELECT used, reset_at FROM agent_report_limits WHERE connection = ?', agent.connection).toArray()[0];
        if (quota && quota.used >= 20) throw new HttpError(429, `This agent connection has reached its limit of 20 reports per day. Try again after ${new Date(quota.reset_at).toISOString()}.`, Math.max(1, Math.ceil((quota.reset_at - now) / 1000)));
        sql.exec('INSERT INTO agent_report_limits (connection, used, reset_at) VALUES (?, 1, ?) ON CONFLICT(connection) DO UPDATE SET used = used + 1', agent.connection, now + DAY);
        sql.exec('INSERT INTO agent_reports (id, value) VALUES (?, ?)', report.id, JSON.stringify(report));
        sql.exec('DELETE FROM agent_reports WHERE seq IN (SELECT seq FROM agent_reports ORDER BY seq DESC LIMIT -1 OFFSET 200)');
        return { ok: true, data: report };
      });
    } catch (error) { return refused(error); }
  }

  resolve(id: string): Result<AgentReport[]> {
    try {
      parse(agentReportId, id);
      const updated = this.storage.sql.exec('UPDATE agent_reports SET resolved = 1 WHERE id = ?', id);
      if (!updated.rowsWritten) throw new HttpError(404, 'Report not found.');
      return { ok: true, data: this.list() };
    } catch (error) { return refused(error); }
  }
}
