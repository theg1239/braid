import { artifactsOf, directoryOf, type BraidEnv } from '../env';
import type { BlameRange, FileBlame, Provenance } from '../../shared/types';
import { canonicalAgentKey, fileProvenance, formatNote, NOTES_REF, parseNote, provenanceOf, type BraidNote, type CommitFacts } from '../../shared/provenance';
import { landedProvenance, landingNote, type LandedChange } from '../repositories/provenance';
import { agentKey } from '../../shared/models';
import { plural } from '../../shared/labels';
import { splitLines } from '../../shared/diff';
import { baseRanges, LINE_CAP, lineCounts, newRanges, reseed, resolve, shift, type Range } from './blame';
import { BLAME_REQUEST_MS, BLAME_SEED_VERSION, historyBlame, withinBlameBudget } from './history-blame';
import { BlameQueue } from './blame-queue';
import { FileLines, type AgentLineTotals } from './file-lines';
import { TreeSnapshot, type ComposeReader, type Version } from '../repositories/compose';
import { advertisement, type GitEndpoint } from '../git/transport';
import { commitFacts } from '../git/objects';
import { githubBlame, type GitHubLink } from '../github/bridge';
import { HttpError, logFailure, refused, type Result } from '../errors';
import type { ObjectCache } from './cache';
import { repositoryParts } from './names';
import type { RepositoryInfo } from './shard';
import { now } from '../workspace/domain';
import type { Meta } from '../sql';

/** A file's line map on main: its blob, ranges and where lines not yet attributed came from. `seeded` names the commit a read built it at. */
interface LineMap { blob: string; lines: number; ranges: Range[]; base: string | null; note: string | null; seeded: string | null; version: number }
/** How a map's older lines were seeded, versioned apart from the map's compare-and-swap generation and landing origin. */
interface BlameSeed { version: number; base: string; final: boolean; fallback?: Provenance }
/** A commit a landing put on main, on `parent`, with the change it carries. */
interface LandedCommit { commit: string; parent: string; paths: string[]; change: LandedChange }
/** What the records need from the Trunk that keeps them. */
interface AttributionHost {
  repository(key: string): Promise<RepositoryInfo>;
  head(artifacts: ArtifactsRepo, repository: RepositoryInfo, maxAge?: number): Promise<string>;
  endpoint(artifacts: ArtifactsRepo, repository: RepositoryInfo, scope: 'read' | 'write'): Promise<GitEndpoint & { revoke(): Promise<void> }>;
  bind(key: string): void;
  requirePublicBuild(network?: string): void;
  githubLink(): GitHubLink | undefined;
}

/** How far back blame looks for the commit that last changed a file before attributing it to where history starts. */
const HISTORY = 100;
const sameFile = (a: Version, b: Version) => a.kind === b.kind && (a.kind === 'absent' || a.hash === (b as { hash: string }).hash);

/**
 * Who made what on main: Braid's record of each commit it landed or attributed, the note it writes on each landed
 * commit, and each file's line map, which every landing moves and blame reads.
 */
export class Attribution {
  private fileLines: FileLines;
  private blameQueue: BlameQueue;
  /** refs/notes/braid as Git last listed it, for notes this trunk did not write. */
  private listedNotes?: { at: number; head: string | null };
  private blameSeeds = new Map<string, { work: Promise<void>; coarse?: CommitFacts }>();
  private blameSlots = [Promise.resolve(), Promise.resolve()];
  private blameSlot = 0;
  private publicBlameRunning = false;

  constructor(private ctx: DurableObjectState, private env: BraidEnv, private meta: Meta, private cache: ObjectCache, private host: AttributionHost) {
    const sql = ctx.storage.sql;
    // Who made each commit on main that Braid landed or attributed, with the lines its landing added and how many are still on main.
    sql.exec('CREATE TABLE IF NOT EXISTS commits (id INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, provenance TEXT NOT NULL, agent TEXT, added INTEGER NOT NULL DEFAULT 0, alive INTEGER NOT NULL DEFAULT 0)');
    sql.exec('CREATE INDEX IF NOT EXISTS commits_agent ON commits(agent)');
    this.fileLines = new FileLines(sql);
    // Each file's lines on main as run-length ranges of commit rows, moved by every landing.
    sql.exec('CREATE TABLE IF NOT EXISTS blame (path TEXT PRIMARY KEY, blob TEXT NOT NULL, lines INTEGER NOT NULL, ranges TEXT NOT NULL, base TEXT, note TEXT, seeded TEXT, version INTEGER NOT NULL DEFAULT 0)');
    // Notes for landed commits that are not on refs/notes/braid yet.
    sql.exec('CREATE TABLE IF NOT EXISTS notes_outbox (sha TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.blameQueue = new BlameQueue(ctx.storage);
    if (meta.get('agent-key-version') !== '2') ctx.storage.transactionSync(() => {
      for (const row of sql.exec<{ id: number; agent: string; provenance: string }>('SELECT id, agent, provenance FROM commits WHERE agent IS NOT NULL').toArray()) {
        const provenance = JSON.parse(row.provenance) as Provenance;
        const key = provenance.kind !== 'agent' ? null : row.agent.startsWith('[') || row.agent.split('|').length === 3 ? canonicalAgentKey(row.agent)
          : agentKey({ kind: 'agent', model: provenance.agent?.model, tool: provenance.agent?.tool, owner: provenance.owner });
        sql.exec('UPDATE commits SET agent = ? WHERE id = ?', key, row.id);
      }
      meta.set('agent-key-version', '2');
    });
    const backfill = this.fileLines.next();
    if (backfill !== null) ctx.blockConcurrencyWhile(async () => {
      const due = Math.max(Date.now() + 50, backfill);
      const scheduled = await ctx.storage.getAlarm();
      if (scheduled === null || scheduled > due) await ctx.storage.setAlarm(due);
    });
  }

  /** When the alarm next has blame or roster work, or Infinity. */
  due() { return Math.min(this.blameQueue.next() ?? Infinity, this.fileLines.next() ?? Infinity); }
  notesPending() { return this.ctx.storage.sql.exec('SELECT sha FROM notes_outbox LIMIT 1').toArray().length > 0; }
  /** Lines each agent's landings added, and how many are still on main, by roster key. */
  agentLines(contributors: boolean): Record<string, AgentLineTotals> { return this.fileLines.totals(contributors); }

  /**
   * What Braid keeps about the commits a batch landed: its own record of who made each one (confidence `braid`), the
   * note it writes on each commit, and the line maps the landing moves. None of it can undo a landing, so a failure
   * is logged and its notes stay pending until they are written.
   */
  async recordLanding(key: string, landed: LandedCommit[]) {
    if (!landed.length) return;
    const at = now();
    for (const { commit, change } of landed) {
      const provenance = landedProvenance(commit, at, change);
      this.ctx.storage.sql.exec('INSERT INTO commits (sha, provenance, agent) VALUES (?, ?, ?) ON CONFLICT(sha) DO UPDATE SET provenance = excluded.provenance, agent = excluded.agent',
        commit, JSON.stringify(provenance), agentKey(change.author));
      if (provenance.files) {
        const row = this.ctx.storage.sql.exec<{ id: number }>('SELECT id FROM commits WHERE sha = ?', commit).one().id;
        this.fileLines.record(row, provenance);
        this.ctx.storage.sql.exec('DELETE FROM file_line_backfill WHERE commit_id = ?', row);
      }
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO notes_outbox (sha, value) VALUES (?, ?)', commit, formatNote(landingNote(change)));
    }
    try {
      const repository = await this.host.repository(key);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      const snapshot = new TreeSnapshot(this.cache.reader(artifacts));
      for (const { commit, parent, paths } of landed) {
        const row = this.commitRow(commit, () => { throw new Error('A landed commit has no record.'); });
        for (const path of paths) {
          try {
            const [before, after] = await Promise.all([snapshot.version(parent, path), snapshot.version(commit, path)]);
            const [beforeText, afterText] = await Promise.all([before.kind === 'file' ? snapshot.text(before) : null, after.kind === 'file' ? snapshot.text(after) : null]);
            this.landLines(path, commit, parent, row, { version: before, text: beforeText }, { version: after, text: afterText });
          } catch (error) {
            // A map that could not follow this landing would attribute lines wrongly; without one, the next read rebuilds it.
            this.replaceMap(path, null);
            logFailure('blame_failed', error);
          }
        }
      }
      await this.publishNotes(repository, artifacts);
    } catch (error) { logFailure('provenance_failed', error); }
  }

  /** Forgets every line map, for a main that moved outside Braid's landings; each is rebuilt when next read. */
  dropMaps() { for (const row of this.ctx.storage.sql.exec<{ path: string }>('SELECT path FROM blame').toArray()) this.replaceMap(row.path, null); }

  /**
   * Moves one file's map across one landed commit, synchronously so no read interleaves: unchanged lines keep their
   * commit and the lines it added take `row`. A map that does not match the parent starts again from the parent, whose
   * lines are attributed from history when first read.
   */
  private landLines(path: string, commit: string, parent: string, row: number, before: { version: Version; text: string | null }, after: { version: Version; text: string | null }) {
    if (after.version.kind !== 'file' || after.text === null) { this.replaceMap(path, null); return; }
    const map = this.loadMap(path);
    // Already recorded, unless a read built this map at this very commit before the landing was.
    if (map?.blob === after.version.hash && map.seeded !== commit) return;
    const lines = splitLines(after.text);
    if (lines.length > LINE_CAP) { this.replaceMap(path, null); return; }
    let next: Omit<LineMap, 'version'>, added: number;
    if (before.version.kind === 'file' && before.text !== null) {
      const previous = splitLines(before.text), continued = map && map.blob === before.version.hash && map.seeded !== commit ? map : undefined;
      const moved = shift(continued?.ranges ?? baseRanges(previous.length), previous, lines, row);
      next = { blob: after.version.hash, lines: lines.length, ranges: moved.ranges, base: continued ? continued.base : parent, note: continued?.note ?? null, seeded: null };
      added = moved.added;
    } else {
      next = { blob: after.version.hash, lines: lines.length, ranges: newRanges(lines.length, row), base: null, note: null, seeded: null };
      added = lines.length;
    }
    this.replaceMap(path, next);
    this.ctx.storage.sql.exec('UPDATE commits SET added = added + ? WHERE id = ?', added, row);
    this.fileLines.added(row, path, added);
  }

  private loadMap(path: string): LineMap | undefined {
    const row = this.ctx.storage.sql.exec<Omit<LineMap, 'ranges'> & { ranges: string }>('SELECT blob, lines, ranges, base, note, seeded, version FROM blame WHERE path = ?', path).toArray()[0];
    return row ? { ...row, ranges: JSON.parse(row.ranges) as Range[] } : undefined;
  }
  /** Replaces a file's map and moves each commit's count of lines still on main by the difference. */
  private replaceMap(path: string, next: Omit<LineMap, 'version'> | null) {
    const old = this.loadMap(path), deltas = new Map<number, number>();
    for (const [commit, count] of lineCounts(old?.ranges ?? [])) deltas.set(commit, -count);
    for (const [commit, count] of lineCounts(next?.ranges ?? [])) deltas.set(commit, (deltas.get(commit) ?? 0) + count);
    for (const [commit, delta] of deltas) if (delta) {
      this.ctx.storage.sql.exec('UPDATE commits SET alive = alive + ? WHERE id = ?', delta, commit);
      this.fileLines.alive(commit, path, delta);
    }
    if (!next) { this.ctx.storage.sql.exec('DELETE FROM blame WHERE path = ?', path); return; }
    this.ctx.storage.sql.exec('INSERT INTO blame (path, blob, lines, ranges, base, note, seeded, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET blob = excluded.blob, lines = excluded.lines, ranges = excluded.ranges, base = excluded.base, note = excluded.note, seeded = excluded.seeded, version = excluded.version',
      path, next.blob, next.lines, JSON.stringify(next.ranges), next.base, next.note, next.seeded, (old?.version ?? 0) + 1);
  }
  /** Keep line-map ids and counts stable when new Git facts refresh an inferred row; witnessed records win. */
  private commitRow(sha: string, provenance: () => Provenance): number {
    const known = this.ctx.storage.sql.exec<{ id: number; provenance: string }>('SELECT id, provenance FROM commits WHERE sha = ?', sha).toArray()[0];
    if (known) {
      if ((JSON.parse(known.provenance) as Provenance).confidence === 'inferred') this.ctx.storage.sql.exec('UPDATE commits SET provenance = ?, agent = NULL WHERE id = ?', JSON.stringify(provenance()), known.id);
      return known.id;
    }
    return this.ctx.storage.sql.exec<{ id: number }>('INSERT INTO commits (sha, provenance) VALUES (?, ?) RETURNING id', sha, JSON.stringify(provenance())).one().id;
  }
  private async readFacts(artifacts: ArtifactsRepo, sha: string): Promise<CommitFacts | null> {
    const commit = await artifacts.readCommit(sha);
    return commit ? commitFacts(commit) : null;
  }

  /** A note at one pinned notes ref, in Git's flat layout or any depth of two-character fan-out. */
  private async importedNote(snapshot: TreeSnapshot, notes: string, sha: string): Promise<BraidNote | null> {
    const parts: string[] = [];
    for (let offset = 0; offset < sha.length; offset += 2) {
      const version = await snapshot.version(notes, [...parts, sha.slice(offset)].join('/'));
      if (version.kind === 'file') return parseNote(await snapshot.text(version) ?? '');
      parts.push(sha.slice(offset, offset + 2));
    }
    return null;
  }

  /** Imported notes are claims from Git, never witnessed landings. A landing during I/O still wins in commitRow. */
  private async importedRows(artifacts: ArtifactsRepo, facts: CommitFacts[]): Promise<Map<string, number>> {
    const commits = [...new Map(facts.map(fact => [fact.id, fact])).values()];
    const known = new Map<string, number>();
    for (let start = 0; start < commits.length; start += 100) {
      const batch = commits.slice(start, start + 100);
      for (const row of this.ctx.storage.sql.exec<{ sha: string; id: number; provenance: string }>(`SELECT sha, id, provenance FROM commits WHERE sha IN (${batch.map(() => '?').join(',')})`, ...batch.map(fact => fact.id)).toArray()) {
        if ((JSON.parse(row.provenance) as Provenance).confidence !== 'inferred') known.set(row.sha, row.id);
      }
    }
    const missing = commits.filter(fact => !known.has(fact.id));
    if (missing.length) {
      const notes = (await artifacts.log({ ref: NOTES_REF, limit: 1 }))[0]?.hash
        ?? await this.notesHead(this.meta.get('repository')!).catch(error => { logFailure('notes_head_failed', error); return null; });
      const snapshot = new TreeSnapshot(this.cache.reader(artifacts));
      for (let start = 0; start < missing.length; start += 8) {
        const rows = await Promise.all(missing.slice(start, start + 8).map(async fact => {
          const note = notes ? await this.importedNote(snapshot, notes, fact.id) : null;
          return [fact.id, this.commitRow(fact.id, () => provenanceOf(fact, note))] as const;
        }));
        for (const [sha, row] of rows) known.set(sha, row);
      }
    }
    return known;
  }

  /** The row of a commit Braid did not land, read from Artifacts and attributed from what it says about itself. */
  private async seedRow(artifacts: ArtifactsRepo, sha: string): Promise<number> {
    const known = this.ctx.storage.sql.exec<{ id: number }>('SELECT id FROM commits WHERE sha = ?', sha).toArray()[0];
    if (known) return known.id;
    const facts = await this.readFacts(artifacts, sha);
    if (!facts) throw new Error('A commit on main is not available yet.');
    return (await this.importedRows(artifacts, [facts])).get(sha)!;
  }

  /** GitHub's ranges when available; otherwise first-parent line history from Artifacts. */
  private async seedLines(artifacts: ArtifactsRepo, commit: string, path: string, progress: (commit: CommitFacts) => void): Promise<{ attribute: (origin: number) => number; note?: string }> {
    const link = this.host.githubLink();
    const ranges = link ? await githubBlame(this.env, link, commit, path).catch(error => { logFailure('github_blame_failed', error); return null; }) : null;
    if (ranges) {
      const byLine: number[] = [];
      const rows = await this.importedRows(artifacts, ranges.map(range => range.commit));
      for (const range of ranges) {
        const row = rows.get(range.commit.id)!;
        for (let line = range.start; line <= range.end; line++) byLine[line] = row;
      }
      const last = byLine.at(-1)!;
      return { attribute: origin => byLine[origin] ?? last };
    }
    const history = await historyBlame(artifacts, this.cache.reader(artifacts), commit, path, { progress });
    const rows = await this.importedRows(artifacts, history.commits);
    return { attribute: origin => rows.get(history.lines[origin - 1])!, note: history.note };
  }

  private async publicBlameAllowed(key: string) {
    const parts = repositoryParts(key);
    if (!parts) return false;
    const access = await directoryOf(this.env).publicRead(parts.workspaceId);
    return access.ok && access.data.teamId === parts.teamId;
  }

  private async schedulePublicBlame() {
    const next = this.blameQueue.next();
    if (next === null) return;
    const scheduled = await this.ctx.storage.getAlarm();
    const due = Math.max(Date.now() + 50, next);
    if (scheduled === null || due < scheduled) await this.ctx.storage.setAlarm(due);
  }

  /** Internal import/member-read hook. Anonymous requests can only queue the file they requested. */
  async warmBlame(key: string, head: string) {
    this.host.bind(key);
    if (!this.blameQueue.claimWarm(head)) return;
    const repository = await this.host.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    // Never warm a caller-chosen historical revision; resolve the configured default branch.
    if (await this.host.head(artifacts, repository) !== head) return;
    const { blameWarmPaths } = await import('./blame-warm');
    const paths = await blameWarmPaths(artifacts, head);
    this.blameQueue.warm(paths.filter(path => {
      const map = this.loadMap(path);
      return !map || map.seeded !== head || this.outdatedBlame(path, map) || map.ranges.some(range => !range[2]);
    }));
    await this.schedulePublicBlame();
  }

  /** Visitors only enqueue. Current visibility is checked again before the alarm opens Artifacts. */
  private async publicBlame(key: string, path: string, ref?: string, network?: string): Promise<Result<FileBlame>> {
    const head = this.meta.get('head') ?? '', branch = this.meta.get('branch');
    if (ref && branch && ref !== branch && ref !== head) return { ok: false, status: 400, error: `Blame reads ${branch} for now.` };
    const map = this.loadMap(path);
    const unavailable = !map && this.blameQueue.unavailable(path, head);
    if (unavailable) return unavailable;
    const available: Result<FileBlame> = { ok: true, data: map ? this.fileBlame(path, head, map)
      : { path, ref: head, lines: 0, ranges: [], pending: true, note: 'Line history is being prepared.' } };
    if (map && !this.outdatedBlame(path, map) && !map.ranges.some(range => !range[2])) return available;
    if (map?.base && this.blameSeeds.has(JSON.stringify([path, map.base]))) return available;
    try {
      if (!await this.publicBlameAllowed(key)) return map ? available : { ok: false, status: 404, error: 'Repository not found.' };
      if (!this.blameQueue.requested(path)) {
        if (!this.blameQueue.has(path) && this.blameQueue.full()) throw new HttpError(503, 'This repository is preparing public content. Retry shortly.', 60);
        this.host.requirePublicBuild(network);
        this.host.bind(key);
        this.blameQueue.enqueue(path);
      }
      await this.schedulePublicBlame();
      return available;
    } catch (error) {
      if (!(error instanceof HttpError)) logFailure('public_blame_enqueue_failed', error);
      return map ? available : refused(error, 503, 'Blame is not available right now. Retry shortly.');
    }
  }

  async seedPublicBlame() {
    if (this.publicBlameRunning) return;
    const key = this.meta.get('repository');
    if (!key) return;
    let jobs = this.blameQueue.take();
    if (!jobs.length) return;
    this.publicBlameRunning = true;
    try {
      // Persist the retry alarm before any remote read, so eviction cannot strand a claimed job.
      await this.schedulePublicBlame();
      if (jobs.some(job => !job.warm) && !await this.publicBlameAllowed(key)) {
        this.blameQueue.clearPublic();
        jobs = jobs.filter(job => job.warm);
        if (!jobs.length) return;
      }
      const head = this.meta.get('head') ?? '';
      const results = await Promise.allSettled(jobs.map(job => this.readBlame(key, job.path, undefined, Infinity)));
      for (let i = 0; i < jobs.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && (result.value.ok || result.value.status < 500)) {
          if (!this.loadMap(jobs[i].path) && (result.value.ok || head === this.meta.get('head'))) {
            this.blameQueue.remember(jobs[i].path, result.value.ok ? result.value.data.ref : head, result.value);
          }
          this.blameQueue.done(jobs[i].path);
        } else this.blameQueue.failed(jobs[i]);
      }
    } catch (error) {
      logFailure('public_blame_seed_failed', error);
      for (const job of jobs) this.blameQueue.failed(job);
    } finally {
      this.publicBlameRunning = false;
      await this.schedulePublicBlame();
    }
  }

  /**
   * Whether a coarse seed from before seed versions attributed this map: it gave every older line to one commit and
   * said so in the note. Every seed since records its version with the note it writes, so a note without the current
   * version marks a map to seed again.
   */
  private outdatedBlame(path: string, map: LineMap) {
    return !!map.note && this.blameSeed(path)?.version !== BLAME_SEED_VERSION;
  }
  private blameSeed(path: string) { return this.meta.json<BlameSeed | undefined>(`blame-seed:${path}`, undefined); }

  private async seedMap(repository: string, artifacts: ArtifactsRepo, path: string, base: string, deadline: number) {
    const id = JSON.stringify([path, base]);
    let job = this.blameSeeds.get(id);
    if (!job) {
      const pending: { work: Promise<void>; coarse?: CommitFacts } = { work: Promise.resolve() };
      // Two walks at a time bound decoded historical blobs across simultaneous file views, too.
      const slot = this.blameSlot++ % this.blameSlots.length;
      pending.work = this.blameSlots[slot].then(async () => {
        // This capability belongs to the background work, not to the request that may finish first.
        using source = await artifactsOf(this.env).get(repository);
        const seed = await this.seedLines(source, base, path, commit => { pending.coarse = commit; });
        const current = this.loadMap(path);
        // A landing can move unresolved origins while this runs. Resolve those origins on the latest map;
        // never replace a different base or any range that Braid already attributed.
        if (current?.base !== base) return;
        this.replaceMap(path, { ...current, ranges: resolve(current.ranges, current.lines, seed.attribute), base: null, note: seed.note ?? null });
        this.meta.setJson(`blame-seed:${path}`, { version: BLAME_SEED_VERSION, base, final: true } satisfies BlameSeed);
      }).catch(error => { logFailure('blame_seed_failed', error); }).finally(() => { this.blameSeeds.delete(id); });
      this.blameSlots[slot] = pending.work;
      this.blameSeeds.set(id, pending);
      this.ctx.waitUntil(pending.work);
      job = pending;
    }
    if (deadline === Infinity) {
      await job.work;
      if (this.loadMap(path)?.base === base) throw new Error('Blame history could not be completed.');
      return;
    }
    const previous = this.blameSeed(path);
    if (previous?.base === base && previous.fallback) return;
    await withinBlameBudget(job.work, deadline - Date.now());
    if (this.loadMap(path)?.base !== base) return;
    const coarse = job.coarse ?? await this.readFacts(artifacts, base);
    if (!coarse) throw new Error('A commit on main is not available yet.');
    const known = this.ctx.storage.sql.exec<{ provenance: string }>('SELECT provenance FROM commits WHERE sha = ?', coarse.id).toArray()[0];
    // A temporary display must not hold the response for notes, or cache an unverified claim as final provenance.
    const fallback = known ? JSON.parse(known.provenance) as Provenance : provenanceOf(coarse);
    const current = this.loadMap(path);
    if (current?.base !== base) return;
    this.meta.setJson(`blame-seed:${path}`, { version: BLAME_SEED_VERSION, base, final: false, fallback } satisfies BlameSeed);
    this.replaceMap(path, { ...current, note: `Earlier lines are attributed to ${coarse.id.slice(0, 7)} while history loads.` });
  }

  /** Old coarse seeds lost their original line positions. Revisit imported ranges at today's head, keeping landings. */
  private upgradeBlame(path: string, head: string, map: LineMap): LineMap {
    if (!this.outdatedBlame(path, map)) return map;
    const ids = [...lineCounts(map.ranges).keys()];
    const witnessed = new Set([...this.blameRows(ids)].filter(([, provenance]) => provenance.confidence === 'braid').map(([id]) => id));
    const ranges = reseed(map.ranges, map.lines, witnessed), final = ranges.every(range => range[2]);
    this.replaceMap(path, { ...map, ranges, base: final ? null : head, note: final ? null : map.note });
    this.meta.setJson(`blame-seed:${path}`, { version: BLAME_SEED_VERSION, base: head, final } satisfies BlameSeed);
    return this.loadMap(path)!;
  }

  /**
   * The commit that last changed a file, following first parents from `from` for up to a hundred commits, or else the
   * commit main's history starts at. A commit whose parent Artifacts does not have is where an import without its
   * earlier history starts.
   */
  private async lastChange(artifacts: ArtifactsRepo, reader: ComposeReader, snapshot: TreeSnapshot, from: string, path: string): Promise<string> {
    for (const entry of await artifacts.log({ ref: from, limit: HISTORY })) {
      const parent = entry.parents[0];
      if (!parent || !await reader.readCommit(parent)) return entry.hash;
      if (!sameFile(await snapshot.version(entry.hash, path), await snapshot.version(parent, path))) return entry.hash;
    }
    return this.historyStart(artifacts, from);
  }
  /** The commit main's first-parent history starts at: the import for a repository imported without its history. */
  private async historyStart(artifacts: ArtifactsRepo, from: string): Promise<string> {
    const known = this.meta.get('history-start');
    if (known) return known;
    let last = from;
    for (let offset = 0; offset < 20_000; offset += 1000) {
      const page = await artifacts.log({ ref: from, limit: 1000, offset });
      last = page.at(-1)?.hash ?? last;
      if (page.length < 1000) { this.meta.set('history-start', last); break; }
    }
    return last;
  }

  private blameRows(ids: number[]): Map<number, Provenance> {
    const known = new Map<number, Provenance>();
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      for (const row of this.ctx.storage.sql.exec<{ id: number; provenance: string }>(`SELECT id, provenance FROM commits WHERE id IN (${batch.map(() => '?').join(',')})`, ...batch).toArray()) known.set(row.id, JSON.parse(row.provenance) as Provenance);
    }
    return known;
  }

  private fileBlame(path: string, head: string, map: LineMap): FileBlame {
    const seed = this.blameSeed(path);
    const ids = [...new Set(map.ranges.map(range => range[2]).filter(Boolean))];
    const known = this.blameRows(ids);
    if (map.base && seed?.base === map.base && seed.fallback) known.set(0, seed.fallback);
    for (const [id, provenance] of known) known.set(id, fileProvenance(provenance, path));
    const ranges: BlameRange[] = [];
    for (const [start, count, commit] of map.ranges) {
      const provenance = known.get(commit);
      if (!provenance) continue;
      const last = ranges.at(-1);
      if (last?.provenance === provenance && last.start + last.lines === start) last.lines += count;
      else ranges.push({ start, lines: count, provenance });
    }
    const pending = this.outdatedBlame(path, map) || map.ranges.some(range => !range[2]);
    return { path, ref: head, lines: map.lines, ranges, ...(map.note ? { note: map.note } : {}), ...(pending ? { pending: true } : {}) };
  }

  /**
   * Who last changed each line of a file on main. Braid's maps follow every landing; a file it has no map for is
   * attributed from GitHub's blame or history the first time it is read, and kept up to date from then on.
   */
  async blame(key: string, path: string, ref?: string, cacheOnly = false, network?: string): Promise<Result<FileBlame>> {
    return cacheOnly ? this.publicBlame(key, path, ref, network) : this.readBlame(key, path, ref, Date.now() + BLAME_REQUEST_MS);
  }

  private async readBlame(key: string, path: string, ref: string | undefined, deadline: number): Promise<Result<FileBlame>> {
    this.host.bind(key);
    try {
      const repository = await this.host.repository(key);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      const reader = this.cache.reader(artifacts), snapshot = new TreeSnapshot(reader);
      for (let attempt = 0; attempt < (deadline === Infinity ? 1 : 3); attempt++) {
        // Pin a fresh head after an interrupted read, and never replace a map a landing moved during Git I/O.
        const generation = this.loadMap(path)?.version;
        const head = await this.host.head(artifacts, repository, 10_000);
        if (ref && ref !== repository.branch && ref !== head) throw new HttpError(400, `Blame reads ${repository.branch} for now.`);
        const version = await snapshot.version(head, path);
        if (version.kind === 'absent') throw new HttpError(404, `${path} is not on ${repository.branch}.`);
        if (version.kind === 'special') throw new HttpError(409, `${path} is not a regular file.`);
        const text = await snapshot.text(version);
        if (this.loadMap(path)?.version !== generation) continue;
        if (text === null) return { ok: true, data: { path, ref: head, lines: 0, ranges: [], note: 'Binary files and files over 1 MB have no line blame.' } };
        const lines = splitLines(text).length;
        if (lines > LINE_CAP) {
          // Anonymous jobs never enter the older whole-file history search beyond the line cap.
          if (deadline === Infinity) return { ok: true, data: { path, ref: head, lines, ranges: [], note: `Files over ${LINE_CAP.toLocaleString('en-US')} lines have no line blame.` } };
          const row = await this.seedRow(artifacts, await this.lastChange(artifacts, reader, snapshot, head, path));
          return { ok: true, data: { ...this.fileBlame(path, head, { blob: version.hash, lines, ranges: [[1, lines, row]], base: null, note: null, seeded: null, version: 0 }),
            note: `Braid blames files of up to ${LINE_CAP.toLocaleString('en-US')} lines line by line. This one has ${lines.toLocaleString('en-US')}, so it is attributed to the last commit that changed it.` } };
        }
        let map = this.loadMap(path);
        if (map?.blob !== version.hash) {
          this.replaceMap(path, { blob: version.hash, lines, ranges: baseRanges(lines), base: head, note: null, seeded: head });
          map = this.loadMap(path)!;
        }
        map = this.upgradeBlame(path, head, map);
        if (map.base && map.ranges.some(range => !range[2])) {
          await this.seedMap(repository.id, artifacts, path, map.base, deadline);
          // The seed may finish, or a landing may move this file while history loads.
          if (this.loadMap(path)?.blob !== map.blob) continue;
          map = this.loadMap(path)!;
        }
        return { ok: true, data: this.fileBlame(path, head, map) };
      }
      throw new HttpError(503, 'Main is moving quickly. Retry the blame.');
    } catch (error) {
      if (!(error instanceof HttpError)) logFailure('blame_read_failed', error);
      return refused(error, 503, 'Blame is not available right now. Retry shortly.');
    }
  }

  /**
   * The commit refs/notes/braid names: the one this trunk wrote last, or else Git's own listing of the ref, kept for a
   * minute, as Artifacts reads a branch, a tag or a commit and not a notes ref. Reading it writes nothing.
   */
  async notesHead(key: string): Promise<string | null> {
    const written = this.meta.get('notes');
    if (written) return written;
    if (this.listedNotes && Date.now() - this.listedNotes.at < 60_000) return this.listedNotes.head;
    const repository = await this.host.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    const endpoint = await this.host.endpoint(artifacts, repository, 'read');
    try { this.listedNotes = { at: Date.now(), head: (await advertisement(endpoint, 'git-upload-pack', 4 * 1024 * 1024)).refs.get(NOTES_REF) ?? null }; }
    finally { await endpoint.revoke(); }
    return this.listedNotes.head;
  }

  /** Who made each commit: Braid's own record for what it landed, and what the commit says for the rest. Unknown commits are left out. */
  async provenance(key: string, commits: string[], cacheOnly = false): Promise<Provenance[]> {
    if (!cacheOnly) this.host.bind(key);
    const known = new Map(this.ctx.storage.sql.exec<{ sha: string; provenance: string }>(`SELECT sha, provenance FROM commits WHERE sha IN (${commits.map(() => '?').join(',')})`, ...commits)
      .toArray().map(row => [row.sha, JSON.parse(row.provenance) as Provenance]));
    const missing = commits.filter(sha => !known.has(sha));
    if (!cacheOnly && missing.length) {
      const repository = await this.host.repository(key);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      const facts = await Promise.all(missing.map(sha => this.readFacts(artifacts, sha).catch(error => { logFailure('provenance_read_failed', error); return null; })));
      const rows = await this.importedRows(artifacts, facts.filter(fact => fact !== null));
      for (const [sha, row] of rows) known.set(sha, JSON.parse(this.ctx.storage.sql.exec<{ provenance: string }>('SELECT provenance FROM commits WHERE id = ?', row).one().provenance));
    }
    return commits.flatMap(sha => known.has(sha) ? [known.get(sha)!] : []);
  }

  /** Upgrade existing combined landings once, at most eight files per alarm. Roster reads never walk Git. */
  async backfillFileLines() {
    const key = this.meta.get('repository'), pending = this.fileLines.pending();
    if (!key || !pending) return;
    this.fileLines.start(pending.id);
    try {
      const repository = await this.host.repository(key);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      const commit = await artifacts.readCommit(pending.sha);
      if (!commit) throw new Error('The recorded landing is not available yet.');
      const provenance = JSON.parse(pending.provenance) as Provenance;
      const paths = Object.keys(provenance.files ?? {}), snapshot = new TreeSnapshot(this.cache.reader(artifacts));
      const counts: { path: string; added: number }[] = [];
      const deadline = Date.now() + 2_000;
      for (const path of paths.slice(pending.offset, pending.offset + 8)) {
        const [before, after] = await Promise.all([commit.parents[0] ? snapshot.version(commit.parents[0], path) : { kind: 'absent' as const }, snapshot.version(pending.sha, path)]);
        const [beforeText, afterText] = await Promise.all([before.kind === 'file' ? snapshot.text(before) : null, after.kind === 'file' ? snapshot.text(after) : null]);
        const old = splitLines(beforeText ?? ''), lines = splitLines(afterText ?? '');
        const added = afterText === null || lines.length > LINE_CAP ? 0 : shift(baseRanges(old.length), old, lines, pending.id).added;
        counts.push({ path, added });
        if (Date.now() >= deadline) break;
      }
      this.ctx.storage.transactionSync(() => {
        const current = this.ctx.storage.sql.exec<{ offset: number }>('SELECT offset FROM file_line_backfill WHERE commit_id = ?', pending.id).toArray()[0];
        if (current?.offset !== pending.offset) return;
        for (const { path, added } of counts) {
          this.fileLines.record(pending.id, { ...provenance, files: { [path]: provenance.files![path] } });
          // A landing may have changed this map while Git was read; count its current surviving lines.
          const alive = lineCounts(this.loadMap(path)?.ranges ?? []).get(pending.id) ?? 0;
          this.ctx.storage.sql.exec('UPDATE commit_files SET added = ?, alive = ? WHERE commit_id = ? AND path = ?', added, alive, pending.id, path);
        }
        const offset = pending.offset + counts.length;
        if (offset >= paths.length) this.ctx.storage.sql.exec('DELETE FROM file_line_backfill WHERE commit_id = ?', pending.id);
        else this.ctx.storage.sql.exec('UPDATE file_line_backfill SET offset = ?, due = ?, attempts = 0 WHERE commit_id = ?', offset, Date.now() + 50, pending.id);
      });
    } catch (error) {
      logFailure('roster_backfill_failed', error);
      this.ctx.storage.sql.exec('UPDATE file_line_backfill SET due = ? WHERE commit_id = ?', Date.now() + 60_000, pending.id);
    }
  }

  /** Writes pending notes to Artifacts as one commit on refs/notes/braid; they stay pending until that works. */
  async publishNotes(repository: RepositoryInfo, artifacts: ArtifactsRepo) {
    const pending = this.ctx.storage.sql.exec<{ sha: string; value: string }>('SELECT sha, value FROM notes_outbox ORDER BY sha LIMIT 500').toArray();
    if (!pending.length) return;
    const endpoint = await this.host.endpoint(artifacts, repository, 'write');
    try {
      const created = { commits: new Map<string, { treeHash: string }>(), trees: new Map<string, ArtifactsTreeEntry[]>(), blobs: new Map<string, Uint8Array>() };
      const head = await (await import('../git/push')).pushNotes({ remote: endpoint.remote, token: endpoint.token, ref: NOTES_REF, repository: this.cache.reader(artifacts), created,
        notes: Object.fromEntries(pending.map(row => [row.sha, row.value])), message: `Braid provenance for ${plural(pending.length, 'commit')}` });
      this.cache.seed(created);
      for (const row of pending) this.ctx.storage.sql.exec('DELETE FROM notes_outbox WHERE sha = ? AND value = ?', row.sha, row.value);
      this.meta.set('notes', head);
    } finally { await endpoint.revoke(); }
  }
}
