import type { ChangeGuide, GuideFileAttributes } from '../../shared/guide';
import { GUIDE_MODEL, GUIDE_TIMEOUT_MS, GuideInputError, guideDeadline, guideError, hostedGuide, prepareGuide, type GuideDescription, type GuideInput } from './guide';

type Row = { change_id: string; revision: number; model: string; description: string; value: string; attempts: number; error: string | null };
const LEASE_MS = GUIDE_TIMEOUT_MS + 30_000;
const RETRY_MS = 1_000;

/** Durable, revision-keyed runs. Reads never wait for Git or AI; attempts are claimed before any external work. */
export class GuideStore {
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS change_guides (change_id TEXT NOT NULL, revision INTEGER NOT NULL, model TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, due INTEGER NOT NULL, PRIMARY KEY (change_id, revision))');
    sql.exec('CREATE INDEX IF NOT EXISTS change_guides_due ON change_guides(status, due)');
  }
  enqueue(id: string, revision: number, description: GuideDescription): boolean {
    const value: ChangeGuide = { status: 'pending', revision, chapters: [], generatedBy: GUIDE_MODEL, attributes: [] };
    return this.sql.exec('INSERT OR IGNORE INTO change_guides (change_id, revision, model, description, status, value, due) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, revision, GUIDE_MODEL, JSON.stringify(description), 'pending', JSON.stringify(value), Date.now()).rowsWritten > 0;
  }
  get(id: string, revision: number): ChangeGuide | undefined {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM change_guides WHERE change_id = ? AND revision = ?', id, revision).toArray()[0];
    return row ? JSON.parse(row.value) as ChangeGuide : undefined;
  }
  nextDue(): number | null {
    return this.sql.exec<{ due: number | null }>("SELECT MIN(due) AS due FROM change_guides WHERE status = 'pending'").one().due;
  }
  async runDue(ai: Ai, load: (id: string, revision: number, description: GuideDescription) => Promise<GuideInput>): Promise<void> {
    const jobs = this.sql.exec<Row>("SELECT change_id, revision, model, description, value, attempts, error FROM change_guides WHERE status = 'pending' AND due <= ? ORDER BY due LIMIT 2", Date.now()).toArray();
    // Synchronous claims make overlapping alarms harmless; an expired lease consumes the previous attempt.
    const claimed = jobs.filter(job => {
      if (job.attempts >= 2) {
        const guide = JSON.parse(job.value) as ChangeGuide;
        this.finish(job, { ...guide, status: 'failed', error: job.error ?? 'Guide generation was interrupted after two attempts.' });
        return false;
      }
      const won = this.sql.exec("UPDATE change_guides SET attempts = attempts + 1, due = ? WHERE change_id = ? AND revision = ? AND status = 'pending' AND attempts = ? AND due <= ?",
        Date.now() + LEASE_MS, job.change_id, job.revision, job.attempts, Date.now()).rowsWritten > 0;
      if (won) job.attempts++;
      return won;
    });
    await Promise.all(claimed.map(async job => {
      let attributes: GuideFileAttributes[] = (JSON.parse(job.value) as ChangeGuide).attributes;
      try {
        const result = await guideDeadline(async signal => {
          const input = await load(job.change_id, job.revision, JSON.parse(job.description) as GuideDescription);
          signal.throwIfAborted();
          attributes = input.attributes;
          const pending: ChangeGuide = { status: 'pending', revision: job.revision, chapters: [], generatedBy: job.model, attributes };
          this.sql.exec("UPDATE change_guides SET value = ? WHERE change_id = ? AND revision = ? AND status = 'pending' AND attempts = ?", JSON.stringify(pending), job.change_id, job.revision, job.attempts);
          return hostedGuide(ai, prepareGuide(input), job.revision, job.model, job.error ?? (job.attempts > 1 ? 'The previous attempt was interrupted before it completed.' : undefined));
        });
        this.finish(job, result);
      } catch (error) {
        const reason = guideError(error);
        if (job.attempts >= 2 || error instanceof GuideInputError) this.finish(job, { status: 'failed', revision: job.revision, error: reason, chapters: [], generatedBy: job.model, attributes });
        else this.sql.exec("UPDATE change_guides SET error = ?, due = ? WHERE change_id = ? AND revision = ? AND status = 'pending' AND attempts = ?", reason, Date.now() + RETRY_MS, job.change_id, job.revision, job.attempts);
      }
    }));
  }
  private finish(job: Row, guide: ChangeGuide) {
    this.sql.exec("UPDATE change_guides SET status = ?, value = ? WHERE change_id = ? AND revision = ? AND status = 'pending' AND attempts = ?", guide.status, JSON.stringify(guide), job.change_id, job.revision, job.attempts);
  }
}
