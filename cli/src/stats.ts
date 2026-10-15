import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileProvenance, modelName, toolBase } from '../../shared/provenance';
import type { Provenance } from '../../shared/types';
import { fail, type BraidContext } from './context';
import { git, gitAsync, gitEnv, gitFailed, gitTry, readCommits, REGULAR, repositoryRoot, resolveCommit } from './git';
import { historyLogins, personLabel, personLogins, provenances } from './present';
import type { RepositoryStats, StatsRow } from './schemas';
import { redact } from './secrets';
import { plain } from './terminal';

type StatsBy = 'model' | 'owner' | 'tool';
export interface StatsOptions { since?: string; by?: StatsBy }
const MAX_LINES = 20_000;
const GENERATED = /(?:^|\/)(?:dist|build|vendor)\/|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$|\.lockb?$|\.min\.[^/]+$/i;
interface File { path: string; mode: string; object: string }
interface Content { binary: boolean; lines: number }

/** Select tracked paths with Git's pathspec rules, intersecting the index with the immutable HEAD tree. */
function headFiles(context: BraidContext, root: string, head: string, paths: readonly string[]): File[] {
  const selected = new Set(git(context, ['ls-files', '--cached', `--with-tree=${head}`, '--full-name', '-z', '--', ...paths], { cwd: paths.length ? context.cwd : root }).toString('utf8').split('\0'));
  return git(context, ['ls-tree', '-r', '-z', '--full-tree', head], { cwd: root }).toString('utf8').split('\0').flatMap(record => {
    const match = /^(\d+) \S+ ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    return match && selected.has(match[3]) ? [{ mode: match[1], object: match[2], path: match[3] }] : [];
  });
}

/** Attributes are read from HEAD, including nested .gitattributes, rather than from local edits or the index. */
function generatedAttributes(context: BraidContext, root: string, head: string, files: readonly File[]) {
  const skipped = new Set<string>();
  if (!files.length) return skipped;
  const args = ['-z', '--stdin', 'linguist-generated', 'diff'], input = `${files.map(file => file.path).join('\0')}\0`;
  const result = gitTry(context, ['check-attr', `--source=${head}`, ...args], { cwd: root, input });
  let output: Buffer = result.stdout;
  if (result.status !== 0) {
    // Git before 2.40 has no --source and refuses it as a usage error, status 129. A temporary index holds HEAD's attributes without touching the clone.
    if (result.status !== 129) gitFailed('check-attr', result.stderr, result.status);
    const folder = mkdtempSync(join(tmpdir(), 'braid-stats-'));
    const env = { ...context.env, GIT_INDEX_FILE: join(folder, 'index') };
    try {
      git(context, ['read-tree', head], { cwd: root, env });
      output = git(context, ['check-attr', '--cached', ...args], { cwd: root, input, env });
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }
  const fields = output.toString('utf8').split('\0');
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path, attribute, value] = fields.slice(index, index + 3);
    if (attribute === 'diff' ? value === 'unset' : !['unspecified', 'unset', 'false', '0'].includes(value)) skipped.add(path);
  }
  return skipped;
}

/**
 * Inspect each unique HEAD blob in one streaming batch. Keep only line counts, never whole files or binary assets.
 * Git's binary heuristic is a NUL in the first 8,000 bytes. Newline counting stops after the line cap is exceeded.
 */
async function scanContents(context: BraidContext, root: string, objects: readonly string[]) {
  const found = new Map<string, Content>();
  if (!objects.length) return found;
  const child = spawn('git', ['cat-file', '--batch'], { cwd: root, env: gitEnv(context.env), timeout: 300_000 });
  let errors = '', header = Buffer.alloc(0), remaining = 0, separator = false, current: string | undefined;
  let size = 0, read = 0, newlines = 0, last = 0, binary = false;
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  child.stdin.on('error', () => {}); // Git closing early shows in its exit status below.
  const closed = new Promise<number>((done, reject) => { child.once('error', reject); child.once('close', code => done(code ?? 1)); });
  // Handled at once, so a spawn error while stdout is read is not unhandled; `await closed` below still throws it.
  void closed.catch(() => {});
  child.stdin.end(`${objects.join('\n')}\n`);
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        if (separator) { separator = false; offset++; continue; }
        if (!current) {
          const end = chunk.indexOf(0x0a, offset);
          if (end < 0) { header = Buffer.concat([header, chunk.subarray(offset)]); break; }
          const match = /^([a-f0-9]+) blob (\d+)$/.exec(Buffer.concat([header, chunk.subarray(offset, end)]).toString('utf8'));
          if (!match) fail('Git did not return a tracked file blob.');
          current = match[1]; size = remaining = Number(match[2]); read = newlines = last = 0; binary = false; header = Buffer.alloc(0); offset = end + 1;
        }
        const count = Math.min(remaining, chunk.length - offset), content = chunk.subarray(offset, offset + count);
        if (!binary && read < 8000) binary = content.subarray(0, 8000 - read).includes(0);
        if (!binary && newlines <= MAX_LINES) {
          for (let end = content.indexOf(0x0a); end >= 0 && newlines <= MAX_LINES; end = content.indexOf(0x0a, end + 1)) newlines++;
        }
        if (count) last = content[count - 1];
        read += count; remaining -= count; offset += count;
        if (!remaining) {
          found.set(current, { binary, lines: newlines + (size && last !== 0x0a ? 1 : 0) });
          current = undefined; separator = true;
        }
      }
    }
    const status = await closed;
    if (status !== 0) gitFailed('cat-file', redact(plain(errors)), status);
    if (found.size !== objects.length) fail('Git did not return all tracked file blobs.');
    return found;
  } finally { if (child.exitCode === null) child.kill(); }
}

/** Incremental blame contains one header per range, without copying the file's text or repeating line metadata. */
function blameCounts(output: string) {
  const counts = new Map<string, number>();
  for (const match of output.matchAll(/^([a-f0-9]{40}|[a-f0-9]{64}) \d+ \d+ (\d+)$/gm)) counts.set(match[1], (counts.get(match[1]) ?? 0) + Number(match[2]));
  return counts;
}

/**
 * Models with the same display name share a row even when one commit names an id and another names the model. A
 * person who commits from a GitHub no-reply address and from another address is one owner when their name exactly
 * matches a login seen in this history.
 */
export function groupStats(counts: ReadonlyMap<string, number>, known: ReadonlyMap<string, Provenance>, by?: StatsBy, history: Iterable<string> = []): StatsRow[] {
  const grouped = new Map<string, StatsRow>();
  const logins = personLogins([...known.values()].map(provenance => provenance.owner), history);
  for (const [commit, lines] of counts) {
    if (!lines) continue;
    const provenance = known.get(commit);
    if (!provenance) fail(`Git did not return commit ${commit}.`);
    const agent = provenance.agent, owner = personLabel(provenance.owner, logins) || undefined;
    const model = agent?.model ? modelName(agent.model) : undefined;
    const name = model ?? agent?.name ?? 'Agent', tool = agent?.tool ? toolBase(agent.tool) : undefined;
    let row: StatsRow;
    if (provenance.kind === 'human') row = { kind: 'human', name: 'people', lines: 0, share: 0 };
    else if (provenance.kind === 'bot') row = { kind: 'bot', name: agent?.name ?? 'Bot', ...(tool ? { tool } : {}), lines: 0, share: 0 };
    else if (by === 'model') row = { kind: 'agent', name, ...(model ? { model } : {}), lines: 0, share: 0 };
    else if (by === 'owner') row = { kind: 'agent', name: owner ?? 'unknown owner', ...(owner ? { owner } : {}), lines: 0, share: 0 };
    else if (by === 'tool') row = { kind: 'agent', name: tool ?? 'unknown tool', ...(tool ? { tool } : {}), lines: 0, share: 0 };
    else row = { kind: 'agent', name: owner ? `${name} for ${owner}` : name, ...(model ? { model } : {}), ...(owner ? { owner } : {}), ...(tool ? { tool } : {}), lines: 0, share: 0 };
    const key = JSON.stringify([row.kind, row.name.toLowerCase(), row.owner]);
    const previous = grouped.get(key);
    if (previous) {
      previous.lines += lines;
      if (previous.tool !== row.tool) delete previous.tool;
    } else { row.lines = lines; grouped.set(key, row); }
  }
  const total = [...grouped.values()].reduce((sum, row) => sum + row.lines, 0);
  return [...grouped.values()].map(row => ({ ...row, share: total ? row.lines / total : 0 })).sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
}

/** Offline, read-only statistics of HEAD. No credentials, network or cache are needed. */
export async function collectStats(context: BraidContext, paths: readonly string[] = [], options: StatsOptions = {}): Promise<RepositoryStats> {
  const root = repositoryRoot(context), head = resolveCommit(context, root, 'HEAD');
  const files = headFiles(context, root, head, paths), attributes = generatedAttributes(context, root, head, files);
  const skipped = { binary: 0, generated: 0, large: 0 };
  const candidates = files.filter(file => {
    if (GENERATED.test(file.path) || attributes.has(file.path)) { skipped.generated++; return false; }
    if (!REGULAR.has(file.mode)) { skipped.binary++; return false; }
    return true;
  });
  const contents = await scanContents(context, root, [...new Set(candidates.map(file => file.object))]);
  const counted = candidates.filter(file => {
    const content = contents.get(file.object)!;
    if (content.binary) { skipped.binary++; return false; }
    if (content.lines > MAX_LINES) { skipped.large++; return false; }
    return true;
  });
  const counts = new Map<string, number>();
  const byFile = new Map<string, Map<string, number>>();
  let next = 0;
  const workers = Array.from({ length: Math.min(availableParallelism(), counted.length) }, async () => {
    while (next < counted.length) {
      const file = counted[next++];
      if (!contents.get(file.object)!.lines) continue;
      const output = await gitAsync(context, ['blame', '--incremental', head, '--', file.path], root);
      const attributed = blameCounts(output.toString('utf8'));
      byFile.set(file.path, attributed);
      if ([...attributed.values()].reduce((sum, count) => sum + count, 0) !== contents.get(file.object)!.lines) fail(`Git did not attribute every line of ${file.path}.`);
      for (const [commit, lines] of attributed) counts.set(commit, (counts.get(commit) ?? 0) + lines);
    }
  });
  const settled = await Promise.allSettled(workers);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  const facts = readCommits(context, root, [...counts.keys()], options.since);
  const known = new Map(provenances(context, root, [...facts.values()]).map(provenance => [provenance.commit, provenance]));
  if (options.since) for (const commit of counts.keys()) if (!known.has(commit)) counts.delete(commit);
  // A task landing can name a different agent for each file. Keep that dimension until grouping.
  const attributedCounts = new Map<string, number>(), attributedKnown = new Map<string, Provenance>();
  for (const [path, linesByCommit] of byFile) for (const [commit, lines] of linesByCommit) {
    if (!counts.has(commit)) continue; // Excluded by --since.
    const provenance = known.get(commit);
    if (!provenance) fail(`Git did not return commit ${commit}.`);
    const key = JSON.stringify([commit, path]);
    attributedCounts.set(key, lines);
    attributedKnown.set(key, fileProvenance(provenance, path));
  }
  const rows = groupStats(attributedCounts, attributedKnown, options.by, await historyLogins(context, root, head));
  return { repository: basename(root), head, files: counted.length, lines: rows.reduce((sum, row) => sum + row.lines, 0), rows, skipped };
}
