import type { RepositorySearch, SearchHighlight, SearchLine } from '../../shared/search';
import { parseSearch, searchFileFilter } from '../../shared/search-query';
import { artifactsFailed, HttpError } from '../errors';
import { blobText } from '../git/objects';
import { parse, repositorySearchQuery } from '../schemas';
import { SearchIndexStore } from './search-cache';
import { Timings } from '../http/timing';

export const SEARCH_LIMITS = {
  fileBytes: 256 * 1024, files: 1_000, bytes: 4 * 1024 * 1024,
  entries: 20_000, trees: 1_000, depth: 64, pathBytes: 512 * 1024,
  matches: 100, filenames: 100, snippet: 320, cachedHeads: 3, concurrency: 6,
};
type SearchRepo = Pick<ArtifactsRepo, 'log' | 'readTree' | 'readBlob'>;
type SearchFile = { path: string; content: string | null };
export type SearchBlob = { content: string | null; size: number; limited: boolean };
export type SearchIndex = {
  files: { path: string; hash: string | null; searchable: boolean }[];
  blobs: Map<string, SearchBlob>;
  truncated: boolean;
};

export function searchRequest(params: URLSearchParams, defaultRef: string) {
  const query = parse(repositorySearchQuery, Object.fromEntries(params));
  return { ...query, ref: query.ref ?? defaultRef };
}

const GENERATED_DIRECTORY = /^(?:\.git|node_modules|vendor|dist|build|out|target|coverage|generated|__generated__|\.next|\.nuxt|\.output|\.cache|\.turbo|\.cloudflare)$/i;
const GENERATED_FILE = /(?:\.min\.(?:[cm]?js|css)$|\.map$|\.lockb?$|^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum)$)/i;
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|eot|zip|gz|br|bz2|xz|7z|tar|jar|wasm|exe|dll|so|dylib|mp[34]|mov|webm|wav|ogg|sqlite|db)$/i;
const excludedFile = (path: string) => GENERATED_FILE.test(path.split('/').at(-1)!) || BINARY_FILE.test(path);
const CONTROL = /[\x00-\x08\x0e-\x1f]/;
const literal = (query: string) => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');

/** At most three bounded indexes per Durable Object, shared by concurrent queries and evicted in LRU order. */
class SearchCache {
  private heads = new Map<string, Promise<SearchIndex>>();
  // Different cold heads build one at a time, bounding transient blob memory too.
  private building = Promise.resolve();
  constructor(private stored?: SearchIndexStore) {}

  blob(hash: string) { return this.stored?.blob(hash); }

  read(head: string, build: () => Promise<SearchIndex>): Promise<SearchIndex> {
    const cached = this.heads.get(head);
    if (cached) { this.heads.delete(head); this.heads.set(head, cached); this.stored?.touch(head); return cached; }
    const pending = this.building.then(async () => {
      const saved = this.stored?.read(head);
      if (saved) return saved;
      const index = await build();
      this.stored?.write(head, index);
      return index;
    });
    this.building = pending.then(() => undefined, () => undefined);
    this.heads.set(head, pending);
    while (this.heads.size > SEARCH_LIMITS.cachedHeads) this.heads.delete(this.heads.keys().next().value!);
    void pending.catch(() => { if (this.heads.get(head) === pending) this.heads.delete(head); });
    return pending;
  }
}
const caches = new WeakMap<object, SearchCache>();

/** Finish every read before disposing the request's Artifacts capability, including when one fails. */
async function batch<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results = await Promise.allSettled(items.map(read));
  return results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
}

async function indexRepository(repo: SearchRepo, root: string, timings: Timings, cachedBlob: (hash: string) => SearchBlob | undefined): Promise<SearchIndex> {
  const index: SearchIndex = { files: [], blobs: new Map(), truncated: false };
  const entries: { path: string; hash: string }[] = [];
  let visited = 0, trees = 0, pathBytes = 0;
  const pending = [{ hash: root, prefix: '', depth: 0 }];
  const treeStart = performance.now();
  // Process a wave in order, so network completion order never changes the bounded file set.
  traversal: while (pending.length) {
    const count = Math.min(SEARCH_LIMITS.concurrency, SEARCH_LIMITS.trees - trees);
    if (!count) { index.truncated = true; break; }
    const wave = pending.splice(0, count);
    trees += wave.length;
    const loaded = await batch(wave, async item => {
      const tree = await repo.readTree(item.hash);
      if (!tree) throw new HttpError(503, 'Repository search is temporarily unavailable.');
      return tree;
    });
    for (let at = 0; at < wave.length; at++) for (const entry of loaded[at]) {
      const { prefix, depth } = wave[at];
      if (visited === SEARCH_LIMITS.entries) { index.truncated = true; break traversal; }
      visited++;
      const path = prefix + entry.name;
      if (entry.type === 'tree') {
        if (!GENERATED_DIRECTORY.test(entry.name)) {
          if (depth === SEARCH_LIMITS.depth) { index.truncated = true; break traversal; }
          pending.push({ hash: entry.hash, prefix: `${path}/`, depth: depth + 1 });
        }
      } else if ((entry.type === 'blob' || entry.type === 'exec') && !excludedFile(path)) {
        if (entries.length === SEARCH_LIMITS.files || pathBytes + path.length * 2 > SEARCH_LIMITS.pathBytes) { index.truncated = true; break traversal; }
        pathBytes += path.length * 2;
        entries.push({ path, hash: entry.hash });
      }
    }
  }
  timings.record('search-tree', performance.now() - treeStart);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const contents = new Map<string, Promise<SearchBlob>>();
  const read = (hash: string) => {
    let pending = contents.get(hash);
    if (pending) return pending;
    pending = (async () => {
      const saved = cachedBlob(hash);
      if (saved) return saved;
      let blob: Blob | null;
      try { blob = await repo.readBlob(hash); }
      catch (error) {
        if (artifactsFailed(error, 'MEMORY_LIMIT')) return { content: null, size: 0, limited: true };
        throw error;
      }
      if (!blob) throw new HttpError(503, 'Repository search is temporarily unavailable.');
      const text = blob.size <= SEARCH_LIMITS.fileBytes ? await blobText(blob) : null;
      return { content: text === null || CONTROL.test(text) ? null : text.replace(/^\uFEFF/, ''), size: blob.size, limited: false };
    })();
    contents.set(hash, pending);
    return pending;
  };
  let bytes = 0;
  const blobStart = performance.now();
  index.files = entries.map(entry => ({ path: entry.path, hash: null, searchable: false }));
  for (let at = 0; at < entries.length;) {
    if (bytes >= SEARCH_LIMITS.bytes) { index.truncated = true; break; }
    // Reserve a full searchable file per read near the byte limit. Artifacts has no size metadata;
    // oversized blobs are rejected before decoding, and at most one wave can cross the read budget.
    const count = Math.min(SEARCH_LIMITS.concurrency, Math.ceil((SEARCH_LIMITS.bytes - bytes) / SEARCH_LIMITS.fileBytes));
    const wave = entries.slice(at, at + count);
    const loaded = await batch(wave, entry => read(entry.hash));
    for (const file of loaded) {
      // Duplicate blobs save RPCs, but each path still spends the query's scan budget.
      bytes += file.size;
      index.truncated ||= file.limited || bytes > SEARCH_LIMITS.bytes;
      const hash = entries[at].hash;
      index.blobs.set(hash, file);
      index.files[at].hash = hash;
      index.files[at].searchable = bytes <= SEARCH_LIMITS.bytes;
      at++;
    }
  }
  timings.record('search-blobs', performance.now() - blobStart);
  return index;
}

function matchIndex(index: { files: SearchFile[]; truncated: boolean }, ref: string, query: string): RepositorySearch {
  const result: RepositorySearch = { ref, files: [], results: [], matchCount: 0, truncated: index.truncated };
  const parsed = parseSearch(query), accepts = searchFileFilter(parsed);
  const terms = [...new Set(parsed.terms)].sort((a, b) => b.length - a.length).map(literal);
  const pattern = new RegExp(terms.map(term => term.source).join('|'), 'giu');
  const contains = (text: string) => terms.every(term => { term.lastIndex = 0; return term.test(text); });
  const files = index.files.filter(file => accepts(file.path));
  for (const file of files) {
    if (!contains(file.path)) continue;
    pattern.lastIndex = 0;
    const highlights: SearchHighlight[] = [];
    for (const match of terms.length ? file.path.matchAll(pattern) : []) {
      highlights.push({ start: match.index, end: match.index + match[0].length });
    }
    if (result.files.length === SEARCH_LIMITS.filenames) { result.truncated = true; break; }
    result.files.push({ path: file.path, highlights });
  }
  if (!terms.length) return result;
  for (const file of files) {
    if (file.content === null || !contains(file.content)) continue;
    const matches: SearchLine[] = [];
    let line = 1, lineStart = 0, nextLine = file.content.indexOf('\n');
    let excerpt: { start: number; end: number; prefix: number; row: SearchLine } | undefined;
    pattern.lastIndex = 0;
    for (const match of file.content.matchAll(pattern)) {
      if (result.matchCount === SEARCH_LIMITS.matches) {
        result.truncated = true;
        if (matches.length) result.results.push({ path: file.path, matches });
        return result;
      }
      const start = match.index, end = start + match[0].length;
      while (nextLine >= 0 && nextLine < start) {
        line++; lineStart = nextLine + 1; nextLine = file.content.indexOf('\n', lineStart);
      }
      if (!excerpt || excerpt.row.line !== line || end > excerpt.end) {
        let lineEnd = nextLine < 0 ? file.content.length : nextLine;
        if (file.content[lineEnd - 1] === '\r') lineEnd--;
        const from = Math.max(lineStart, start - Math.min(80, SEARCH_LIMITS.snippet - match[0].length)), to = Math.min(lineEnd, from + SEARCH_LIMITS.snippet);
        const prefix = from > lineStart ? 1 : 0;
        const row: SearchLine = { line, content: `${prefix ? '…' : ''}${file.content.slice(from, to)}${to < lineEnd ? '…' : ''}`, highlights: [] };
        excerpt = { start: from, end: to, prefix, row };
        matches.push(row);
      }
      excerpt.row.highlights.push({ start: start - excerpt.start + excerpt.prefix, end: end - excerpt.start + excerpt.prefix });
      result.matchCount++;
    }
    if (matches.length) result.results.push({ path: file.path, matches });
  }
  return result;
}

/** Shared by background warmups and queries, including concurrent requests for the same commit. */
type SearchOptions = { storage?: DurableObjectStorage; timings?: Timings; beforeBuild?: () => Promise<void> };
export async function repositorySearchIndex(owner: object, repo: SearchRepo, ref: string, options: SearchOptions = {}) {
  const timings = options.timings ?? new Timings();
  const [head] = await timings.wait('search-head', repo.log({ ref, limit: 1 }));
  if (!head) throw new HttpError(404, 'Repository revision not found.');
  let cache = caches.get(owner);
  if (!cache) { cache = new SearchCache(options.storage && new SearchIndexStore(options.storage, SEARCH_LIMITS.cachedHeads)); caches.set(owner, cache); }
  const index = await timings.wait('search-index', cache.read(head.hash, async () => {
    // Charge only a genuine cold build, after checking both in-memory and persisted indexes.
    await options.beforeBuild?.();
    return indexRepository(repo, head.treeHash, timings, hash => cache.blob(hash));
  }));
  return { ref: head.hash, index };
}

/** Resolve the branch every time; only immutable commit contents are cached, never a moving branch name. */
export async function repositorySearch(owner: object, repo: SearchRepo, query: ReturnType<typeof searchRequest>, options: SearchOptions = {}): Promise<RepositorySearch> {
  const timings = options.timings ?? new Timings();
  const { ref, index } = await repositorySearchIndex(owner, repo, query.ref, { ...options, timings });
  const started = performance.now();
  const files = index.files.map(file => ({ path: file.path, content: file.searchable ? index.blobs.get(file.hash!)!.content : null }));
  const result = matchIndex({ files, truncated: index.truncated }, ref, query.q);
  timings.record('search-match', performance.now() - started);
  return result;
}

/** The example searches exactly the files in its workspace snapshot, including visitor-approved changes. */
export function recordedSearch(files: Record<string, string>, ref: string, query: string): RepositorySearch {
  const index: { files: SearchFile[]; truncated: boolean } = { files: [], truncated: false };
  let bytes = 0, pathBytes = 0;
  for (const path of Object.keys(files).sort()) {
    if (path.split('/').slice(0, -1).some(part => GENERATED_DIRECTORY.test(part)) || excludedFile(path)) continue;
    if (index.files.length === SEARCH_LIMITS.files || pathBytes + path.length * 2 > SEARCH_LIMITS.pathBytes) { index.truncated = true; break; }
    pathBytes += path.length * 2;
    const file: SearchFile = { path, content: null };
    index.files.push(file);
    if (bytes >= SEARCH_LIMITS.bytes) { index.truncated = true; continue; }
    const content = files[path], size = new TextEncoder().encode(content).length;
    bytes += size;
    if (bytes > SEARCH_LIMITS.bytes) { index.truncated = true; continue; }
    if (size <= SEARCH_LIMITS.fileBytes && !CONTROL.test(content)) file.content = content;
  }
  return matchIndex(index, ref, query);
}
