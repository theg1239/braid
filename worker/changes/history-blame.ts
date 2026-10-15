import { diffArrays } from 'diff';
import { splitLines } from '../../shared/diff';
import type { CommitFacts } from '../../shared/provenance';
import { TreeSnapshot, type ComposeReader, type Version } from '../repositories/compose';
import { LINE_CAP, MAX_EDITS } from './blame';
import { commitFacts } from '../git/objects';

export const BLAME_SEED_VERSION = 1;
export const BLAME_REQUEST_MS = 1_000;
const HISTORY_CHANGES = 100;
const PAGE = 8, PARALLEL = 8;
const MAX_COMMITS = 2_000, MAX_READS = 4_096, MAX_MS = 20_000;
const MAX_RENAME_TREES = 128, MAX_RENAME_FILES = 8;
type HistorySource = Pick<ArtifactsRepo, 'log' | 'readCommit'>;
type FileVersion = Extract<Version, { kind: 'file' }>;
interface HistoryBlame { lines: string[]; commits: CommitFacts[]; note?: string; changes: number }
class HistoryLimit extends Error {}
// Git treats adding/removing the final newline as an edit to that last line.
const gitLines = (text: string) => splitLines(text).map((line, index, lines) => index < lines.length - 1 || text.endsWith('\n') ? line + '\n' : line);

/** Wait only for this request's remaining budget; the caller owns the continuing work through waitUntil. */
export async function withinBlameBudget<T>(work: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: number | undefined;
  try { return await Promise.race([work, new Promise<undefined>(resolve => { timer = setTimeout(resolve, Math.max(0, milliseconds)); })]); }
  finally { clearTimeout(timer); }
}

async function parallel<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let start = 0; start < items.length; start += PARALLEL) {
    // Settle an entire batch before a bound can dispose its Artifacts capability.
    const batch = await Promise.allSettled(items.slice(start, start + PARALLEL).map(read));
    for (const item of batch) { if (item.status === 'rejected') throw item.reason; result.push(item.value); }
  }
  return result;
}

/** Whole-file renames, including edits, but no -C copy/move attribution across surviving files. */
async function renamedFrom(reader: ComposeReader, snapshot: TreeSnapshot, before: string, after: string, file: FileVersion): Promise<{ path: string; version: FileVersion } | undefined> {
  const pending = [{ before, after: after as string | undefined, path: '' }];
  const deleted: { path: string; version: FileVersion }[] = [];
  let trees = 0;
  while (pending.length) {
    if (++trees > MAX_RENAME_TREES) throw new HistoryLimit();
    const pair = pending.pop()!;
    if (pair.before === pair.after) continue;
    const [old, current] = await parallel([pair.before, pair.after], async hash => hash ? reader.readTree(hash) : []);
    const entries = new Map(current!.map(entry => [entry.name, entry]));
    for (const entry of old!) {
      const next = entries.get(entry.name), path = pair.path + entry.name;
      if (entry.type === 'tree') pending.push({ before: entry.hash, after: next?.type === 'tree' ? next.hash : undefined, path: path + '/' });
      else if ((!next || next.type === 'tree') && (entry.mode === '100644' || entry.mode === '100755')) {
        deleted.push({ path, version: { kind: 'file', hash: entry.hash, mode: entry.mode } });
        if (deleted.length > MAX_RENAME_FILES) throw new HistoryLimit();
      }
    }
  }
  const exact = deleted.find(candidate => candidate.version.hash === file.hash);
  if (exact) return exact;
  if (!deleted.length) return;
  const text = (await snapshot.text(file))!;
  const lines = gitLines(text);
  let best: (typeof deleted)[number] | undefined, score = 0.5;
  const candidates = await parallel(deleted, async candidate => ({ candidate, text: await snapshot.text(candidate.version) }));
  for (const candidate of candidates) {
    if (candidate.text === null) continue;
    const parts = diffArrays(gitLines(candidate.text), lines, { maxEditLength: MAX_EDITS, timeout: 20 });
    if (!parts) throw new HistoryLimit();
    const kept = parts.reduce((sum, part) => sum + (part.added || part.removed ? 0 : part.value.reduce((n, line) => n + line.length, 0)), 0);
    const similarity = kept / Math.max(candidate.text.length, text.length, 1);
    if (similarity >= score) { best = candidate.candidate; score = similarity; }
  }
  return best;
}

/**
 * Trace surviving lines backwards along first parents. Metadata arrives in pages; independent trees and blobs
 * are read eight at a time through the same object cache as landings. Each page drops its decoded text, keeping
 * memory bounded even when old versions approach the text limit. A bound never turns uncertain lines into a
 * claim: they retain the boundary commit and a short note.
 */
export async function historyBlame(source: HistorySource, objects: ComposeReader, from: string, path: string,
  { changes: maxChanges = HISTORY_CHANGES, commits: maxCommits = MAX_COMMITS, reads: maxReads = MAX_READS, progress }: { changes?: number; commits?: number; reads?: number; progress?: (commit: CommitFacts) => void } = {}): Promise<HistoryBlame> {
  const deadline = Date.now() + MAX_MS;
  let reads = 0, changes = 0, visited = 0;
  const check = () => { if (++reads > maxReads || Date.now() >= deadline) throw new HistoryLimit(); };
  const reader: ComposeReader = {
    readCommit: async hash => { check(); return objects.readCommit(hash); },
    readTree: async hash => { check(); const tree = await objects.readTree(hash); if (!tree) throw new Error('A blame tree is not available yet.'); return tree; },
    readBlob: async hash => { check(); return objects.readBlob(hash); },
  };
  const attributed = new Map<string, CommitFacts>();
  let lines: string[] = [], pending = new Int32Array(0), remaining = 0;
  let cursor = from, boundary: ArtifactsCommitMetadata | undefined, firstChange = false, initialized = false;
  const assign = (indices: Int32Array, commit: ArtifactsCommitMetadata) => {
    for (const index of indices) if (index) { lines[index - 1] = commit.hash; remaining--; }
    attributed.set(commit.hash, commitFacts(commit));
  };
  const finish = (reason?: string): HistoryBlame => {
    const incomplete = remaining > 0;
    if (incomplete) assign(pending, boundary!);
    return { lines, commits: [...attributed.values()], changes,
      ...(incomplete && reason ? { note: `Earlier lines are attributed to ${boundary!.hash.slice(0, 7)} (${reason}).` } : {}) };
  };
  try {
    while (visited < maxCommits) {
      check();
      const page = await source.log({ ref: cursor, limit: PAGE + 1 });
      if (!page.length) {
        if (!boundary) throw new Error('Blame history is not available yet.');
        return finish('earlier history unavailable');
      }
      const metadata = new Map(page.map(commit => [commit.hash, commit]));
      const snapshot = new TreeSnapshot({ ...reader, readCommit: async hash => metadata.get(hash) ?? reader.readCommit(hash) });
      if (!initialized) {
        boundary = page[0];
        progress?.(commitFacts(boundary));
        const version = await snapshot.version(boundary.hash, path);
        if (version.kind !== 'file') throw new Error('Blame requires a text file.');
        const text = await snapshot.text(version);
        if (text === null) throw new Error('Blame requires a text file.');
        remaining = splitLines(text).length;
        lines = new Array<string>(remaining).fill('');
        pending = Int32Array.from({ length: remaining }, (_, i) => i + 1);
        initialized = true;
        if (!remaining) return finish();
      }
      const count = Math.min(PAGE, page.length, maxCommits - visited);
      const versions = await parallel(page.slice(0, count + 1), commit => snapshot.version(commit.hash, path));
      // Only read blobs around actual file changes; unchanged commits cost tree metadata, not file reads.
      const files = new Map<string, FileVersion>();
      for (let i = 0; i < versions.length; i++) {
        const here = versions[i], before = versions[i + 1];
        if (here.kind === 'file' && (i === 0 || !before || before.kind !== 'file' || before.hash !== here.hash)) files.set(here.hash, here);
        if (here.kind === 'file' && before?.kind === 'file' && here.hash !== before.hash) files.set(before.hash, before);
      }
      await parallel([...files.values()], version => snapshot.text(version));
      let renamed = false;
      for (let i = 0; i < count; i++) {
        const entry = page[i];
        boundary = entry; visited++;
        if (Date.now() >= deadline) return finish('history limit reached');
        const parent = entry.parents[0];
        if (!parent) { assign(pending, entry); return finish(); }
        let prior = metadata.get(parent);
        if (!prior) { check(); prior = await source.readCommit(parent) ?? undefined; }
        if (!prior) return finish('earlier history unavailable');
        let before = versions[i + 1] ?? await snapshot.version(parent, path);
        const here = versions[i] as FileVersion;
        if (before.kind === 'absent') {
          const rename = await renamedFrom(reader, snapshot, prior.treeHash, entry.treeHash, here);
          if (rename) { path = rename.path; before = rename.version; renamed = true; }
          else { assign(pending, entry); return finish(); }
        }
        if (before.kind !== 'file') { assign(pending, entry); return finish(); }
        if (here.hash !== before.hash) {
          if (changes >= maxChanges) return finish(`last ${changes} file changes searched`);
          changes++;
          if (!firstChange) { firstChange = true; progress?.(commitFacts(entry)); }
          const [old, current] = await Promise.all([snapshot.text(before), snapshot.text(here)]);
          if (old === null || current === null) return finish('earlier text unavailable');
          const oldLines = gitLines(old), currentLines = gitLines(current);
          if (oldLines.length > LINE_CAP) return finish('earlier file exceeds the line limit');
          const parts = diffArrays(oldLines, currentLines, { maxEditLength: MAX_EDITS, timeout: 50 });
          if (!parts) return finish('earlier diff exceeds the limit');
          const older = new Int32Array(oldLines.length);
          let a = 0, b = 0;
          for (const part of parts) {
            if (part.added) { assign(pending.subarray(b, b + part.count), entry); b += part.count; }
            else if (part.removed) a += part.count;
            else { older.set(pending.subarray(b, b + part.count), a); a += part.count; b += part.count; }
          }
          pending = older;
          if (!remaining) return finish();
        }
        boundary = prior;
        cursor = parent;
        if (renamed) break; // The next page resolves the earlier path, never a copied file.
      }
    }
    return finish('history limit reached');
  } catch (error) {
    if (error instanceof HistoryLimit && initialized) return finish('history limit reached');
    throw error;
  }
}
