import { mergeFile, type ConflictRegion, type MergeRules, type MergeStrategy } from '../../shared/merge';
import { editContent, isBlobEdit, type GitFileEdit } from '../git/edits';
import type { ChangeConflict } from '../../shared/types';
import { blobText, cachedReader, gitBlobHash, type GitObjectReader } from '../git/objects';

export interface ComposeReader extends GitObjectReader { readBlob(hash: string): Promise<Blob | null> }
export interface ComposeChange { id: string; baseCommit: string; files: Record<string, GitFileEdit> }
export interface ComposedChange {
  id: string;
  /** `empty` means every edit was already on trunk, so the change lands without a commit of its own. */
  status: 'applied' | 'empty' | 'conflicted';
  /** Effective edits relative to the trunk plus all earlier changes in the batch. */
  files: Record<string, GitFileEdit>;
  strategies: Record<string, MergeStrategy | 'already-applied'>;
  conflicts: ChangeConflict[];
}

type FileMode = '100644' | '100755';
export type Version =
  | { kind: 'absent' }
  | { kind: 'file'; hash: string; mode: FileMode; text?: string | null }
  | { kind: 'special'; hash: string; mode: string };

/** Text above this size is never merged line by line; concurrent edits to it conflict. */
const MERGE_TEXT_LIMIT = 1024 * 1024;
const MAX_REGION_LINES = 120, MAX_REGIONS = 24;

/** Path lookups and decoded text at any commit, cached for one landing or submission. */
export class TreeSnapshot {
  private trees = new Map<string, Promise<Map<string, ArtifactsTreeEntry> | null>>();
  private blobs = new Map<string, Promise<string | null>>();
  constructor(private reader: ComposeReader) {}

  async version(commit: string, path: string): Promise<Version> {
    const root = (await this.reader.readCommit(commit))?.treeHash;
    if (!root) throw new Error('A commit needed for this landing is not available yet.');
    let hash = root;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entry = (await this.tree(hash))?.get(parts[i]);
      if (!entry) return { kind: 'absent' };
      if (i === parts.length - 1) {
        if (entry.mode === '100644' || entry.mode === '100755') return { kind: 'file', hash: entry.hash, mode: entry.mode };
        return { kind: 'special', hash: entry.hash, mode: entry.mode };
      }
      if (entry.type !== 'tree') return { kind: 'special', hash: entry.hash, mode: entry.mode };
      hash = entry.hash;
    }
    return { kind: 'absent' };
  }

  private tree(hash: string) {
    let value = this.trees.get(hash);
    if (!value) {
      value = this.reader.readTree(hash).then(entries => {
        if (!entries) throw new Error('A tree needed for this landing is not available yet.');
        return new Map(entries.map(entry => [entry.name, entry]));
      });
      this.trees.set(hash, value);
    }
    return value;
  }

  /** UTF-8 text without NUL bytes, or null for binary or oversized content. */
  text(version: Extract<Version, { kind: 'file' }>): Promise<string | null> {
    if (version.text !== undefined) return Promise.resolve(version.text !== null && version.text.length <= MERGE_TEXT_LIMIT && new TextEncoder().encode(version.text).length <= MERGE_TEXT_LIMIT ? version.text : null);
    let value = this.blobs.get(version.hash);
    if (!value) {
      value = this.reader.readBlob(version.hash).then(async blob => {
        if (!blob) throw new Error('A file needed for this landing is not available yet.');
        return blob.size > MERGE_TEXT_LIMIT ? null : blobText(blob);
      });
      // Bound decoded text retained across a large batch; immutable Git objects can be read again.
      if (this.blobs.size >= 4) this.blobs.delete(this.blobs.keys().next().value!);
      this.blobs.set(version.hash, value);
    }
    return value;
  }
}

function sameFile(x: Version, y: Version) {
  if (x.kind === 'absent' || y.kind === 'absent') return x.kind === y.kind;
  return x.kind === y.kind && x.hash === y.hash && x.mode === y.mode;
}
const trimmed = (regions: ConflictRegion[]) => regions.slice(0, MAX_REGIONS).map(region => ({
  ...region, base: region.base.slice(0, MAX_REGION_LINES), ours: region.ours.slice(0, MAX_REGION_LINES), theirs: region.theirs.slice(0, MAX_REGION_LINES),
}));

/**
 * Applies changes in queue order on top of `head`. Each change is applied
 * atomically: one conflicting file ejects the whole change, and later changes
 * compose against the trunk plus every change accepted before them.
 */
export async function composeChanges(source: ComposeReader, head: string, changes: ComposeChange[], rules: MergeRules = {}): Promise<ComposedChange[]> {
  const reader = Object.assign(cachedReader(source), { readBlob: (hash: string) => source.readBlob(hash) });
  const snapshot = new TreeSnapshot(reader);
  const overlay = new Map<string, Version>();
  const current = async (path: string): Promise<Version> => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = overlay.get(parts.slice(0, i).join('/'));
      if (parent && parent.kind !== 'absent') return { kind: 'special', hash: parent.hash, mode: parent.mode };
    }
    return overlay.get(path) ?? snapshot.version(head, path);
  };
  const results: ComposedChange[] = [];
  for (const change of changes) {
    const files: Record<string, GitFileEdit> = Object.create(null), strategies: ComposedChange['strategies'] = Object.create(null), conflicts: ChangeConflict[] = [];
    const pending = new Map<string, Version>();
    for (const [path, edit] of Object.entries(change.files)) {
      const base = await snapshot.version(change.baseCommit, path), trunk = await current(path);
      const content = isBlobEdit(edit) ? undefined : editContent(edit);
      const explicitMode = edit !== null && typeof edit !== 'string' ? edit.mode : undefined;
      const proposed: Version = content === null ? { kind: 'absent' }
        : { kind: 'file', hash: isBlobEdit(edit) ? edit.blob : await gitBlobHash(content!), mode: explicitMode ?? (base.kind === 'file' ? base.mode : '100644'), text: content };
      if (sameFile(proposed, base)) continue;
      const write = (version: Version, strategy: MergeStrategy | 'already-applied') => {
        strategies[path] = strategy;
        if (strategy === 'already-applied') return;
        pending.set(path, version);
        files[path] = version.kind === 'absent' ? null : version.kind === 'file' ? version.text === undefined || version.text === null ? { blob: version.hash, mode: version.mode } : { content: version.text, mode: version.mode } : null;
      };
      if (sameFile(trunk, proposed)) { write(proposed, 'already-applied'); continue; }
      if (base.kind === 'special' || trunk.kind === 'special') { conflicts.push({ path, kind: 'type' }); continue; }
      if (sameFile(trunk, base)) { write(proposed, 'fast-forward'); continue; }
      if (proposed.kind === 'absent') {
        if (trunk.kind === 'absent') write(proposed, 'already-applied');
        else conflicts.push({ path, kind: 'delete-modify' });
        continue;
      }
      if (trunk.kind === 'absent') { conflicts.push({ path, kind: 'modify-delete' }); continue; }
      // With no base mode, neither addition's executable bit takes precedence, even when their blobs agree.
      if (base.kind === 'absent' && trunk.mode !== proposed.mode) { conflicts.push({ path, kind: 'mode' }); continue; }
      const baseMode = base.kind === 'file' ? base.mode : undefined;
      const changedMode = explicitMode !== undefined && explicitMode !== baseMode ? explicitMode : undefined;
      if (changedMode && baseMode && trunk.mode !== baseMode && changedMode !== trunk.mode) { conflicts.push({ path, kind: 'mode' }); continue; }
      const mode = changedMode ?? trunk.mode;
      if (base.kind === 'file' && trunk.hash === base.hash) {
        // Trunk changed only the mode. Content and executable-bit edits merge independently, including binaries.
        write({ ...proposed, mode }, 'fast-forward');
        continue;
      }
      if (proposed.hash === trunk.hash || (base.kind === 'file' && proposed.hash === base.hash)) {
        // Only the executable bit differs from trunk; keep trunk's content.
        if (mode === trunk.mode) { write(trunk, 'already-applied'); continue; }
        write({ kind: 'file', hash: trunk.hash, mode }, 'line');
        continue;
      }
      const [baseText, trunkText, text] = await Promise.all([base.kind === 'file' ? snapshot.text(base) : '', snapshot.text(trunk), snapshot.text(proposed)]);
      if (baseText === null || trunkText === null || text === null || text.includes('\0') || text.length > MERGE_TEXT_LIMIT) { conflicts.push({ path, kind: 'binary' }); continue; }
      const merged = mergeFile(path, baseText, trunkText, text, rules);
      if (!merged.clean) {
        conflicts.push({ path, kind: base.kind === 'absent' ? 'add-add' : 'content', regions: trimmed(merged.conflicts), ...(merged.jsonPaths ? { jsonPaths: merged.jsonPaths } : {}) });
        continue;
      }
      const hash = await gitBlobHash(merged.text);
      // The change's effect may already be on trunk, for example an identical edit merged beside other work.
      if (hash === trunk.hash && mode === trunk.mode) write(trunk, 'already-applied');
      else write({ kind: 'file', hash, mode, text: merged.text }, merged.strategy);
    }
    if (conflicts.length) { results.push({ id: change.id, status: 'conflicted', files: {}, strategies: {}, conflicts }); continue; }
    for (const [path, version] of pending) overlay.set(path, version);
    results.push({ id: change.id, status: Object.keys(files).length ? 'applied' : 'empty', files, strategies, conflicts: [] });
  }
  return results;
}
