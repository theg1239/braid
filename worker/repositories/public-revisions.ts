import { artifactsOf, type BraidEnv } from '../env';
import { CHANGE_SHARDS, changeShardOf, trunkOf } from '../changes/names';
import { HttpError } from '../errors';
import { advertisement } from '../git/transport';
import { scanPushedHistory } from '../git/history';
import { encodeCursor, historyQuery, parse } from '../schemas';
import { readingNames } from './repository';
import { NOTES_REF } from '../../shared/provenance';

/**
 * Which commits a public reader may open. A commit is published when a branch, a tag or Braid's notes reach it, or
 * when it is a commit a recorded push carried in a revision that is not withheld and whose pushed history scanned
 * clean. A pushed revision's commits stay in Artifacts after its hidden ref is gone, so naming one by hash, by the
 * start of its hash, by a hidden ref or through a history cursor must not open it.
 *
 * Branch and tag names cost nothing extra: a listed branch reaches its reader by name, as a member's read names it, and
 * any other name is read once by name, which Artifacts reads only as a branch, a tag or a commit. A commit named by
 * hash is checked against what this repository's object has already walked; then, in one round, the default branch's
 * newest commits, the commit itself and the change shards; then history from the public refs down to the commit's date.
 */

/** The readers whose answer a caller's revision selects. */
const REVISION_READERS = new Set(['/api/repository', '/api/repository/tree', '/api/repository/tree/commits', '/api/repository/search', '/api/search/repository',
  '/api/repository/commits', '/api/repository/commit', '/api/repository/commit/diff', '/api/repository/compare', '/api/repository/compare/diff']);
const SELECTORS = ['ref', 'sha', 'base', 'head', 'cursor'];
const missing = () => new HttpError(404, 'Repository revision not found.');

/** A branch or tag name as Git accepts one, without the operators and spellings that make Git look elsewhere. */
const branchName = (name: string) => name.length <= 255 && name !== '@' && !name.startsWith('-') && !name.endsWith('.')
  && !/[\x00-\x20\x7f~^:?*[\\]/.test(name) && !name.includes('..') && !name.includes('@{')
  && name.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
type Selector = { kind: 'commit'; hash: string } | { kind: 'prefix'; prefix: string } | { kind: 'name'; name: string };
/** What a public caller's revision can name, decided without Git: a commit, the start of one, or a branch or tag. */
function publicSelector(value: string): Selector | null {
  if (/^[0-9a-f]{40}$/i.test(value)) return { kind: 'commit', hash: value.toLowerCase() };
  const qualified = /^refs\/(?:heads|tags)\/(.*)$/.exec(value);
  // Every other namespace, including Braid's hidden pushes, is not a public revision.
  if (qualified ? !branchName(qualified[1]) : value.startsWith('refs/') || !branchName(value)) return null;
  if (!qualified && /^[0-9a-f]{7,39}$/i.test(value)) return { kind: 'prefix', prefix: value.toLowerCase() };
  return { kind: 'name', name: value };
}
/** At the gateway, before any reader or edge cache answers: one value per selector, and only names Braid reads strictly. */
export function checkPublicSelectors(url: URL) {
  if (!REVISION_READERS.has(url.pathname)) return;
  for (const name of SELECTORS) if (url.searchParams.getAll(name).length > 1) throw new HttpError(400, 'Use each revision selector once.');
  for (const name of ['ref', 'base', 'head']) {
    const value = url.searchParams.get(name);
    if (value && !publicSelector(value)) throw missing();
  }
}

/** What authorization needs from the repository's object. */
export interface RevisionScope {
  env: BraidEnv;
  key: string;
  project: { id: string; branch: string; head: string; remote?: string; branches?: string[] };
  network?: string;
}
type Context = RevisionScope & { open: () => Promise<ArtifactsRepo>; charge: () => Promise<void> };
/** A chain to read from `hash`, dated by the child it continues; `pages` reads of `size` commits each, side by side. */
type Item = { hash: string; at: number; size: number; pages?: number };

const PAGE = 100, PAGE_MAX = 1_000, SIDE = 16;
/** Branch tips and the default branch's head are read again after this; anything walked stays published. */
const FRESH_MS = 10_000;
/** A recorded revision's grant: rescans after a scanner change can withhold a revision. */
const GRANT_MS = 60_000;
/** How long one walk's knowledge is kept before starting over. */
const LIFETIME_MS = 30 * 60_000;
/** Commits one repository keeps in memory, and Artifacts reads one check may make; past either it asks to retry. */
const WALK_LIMIT = 300_000, CHECK_READS = 400;
/** A day around the target date prioritizes likely chains; Git timestamps do not bound reachability. */
const SLOP = 86_400;
/** Reads made side by side, and the most ref tips one listing adds. */
const BATCH = 25, TIP_LIMIT = 1_000;
/** Merges nearest the target's date tried one at a time, before the refs' tips are listed. */
const NEAREST = 4;

/**
 * One repository's publication authority, kept in its Durable Object's memory so a commit is walked to once. Positive
 * answers outlive a branch moving, as Braid's branches only move forward through the landing queue; a commit not
 * found is looked for again from the current tips.
 */
export class PublicRevisions {
  /** Commits a public ref reaches: walked, or queued to be, as a tip or the parent of a walked commit. */
  private reachable = new Set<string>();
  /** Commits whose first-parent page was read, so their parents are accounted for. */
  private walked = new Set<string>();
  /** Where the default branch's first-parent chain continues: most commits a reader names are on it. */
  private trunk: Item[] = [];
  /** Merge parents, the other refs' chains, and where each continues. */
  private others: Item[] = [];
  /** Ref tips listed but not yet read, so not yet dated. */
  private undated: string[] = [];
  /** Chains that reached a commit the repository does not have yet, as while a mirror copies its history in parts. */
  private waiting: { item: Item; list: Item[]; since: number }[] = [];
  private grants = new Map<string, number>();
  private born = Date.now();
  private tipsAt = 0;
  private defaultAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Pins every revision a public request selects, in place: names to their full branch or tag ref, or to the commit
   * when only Git could tell which one a name is, and commits and hash prefixes to commits that are published.
   * `authorized` is a commit the gateway already resolved from a published branch.
   */
  async pin(url: URL, scope: RevisionScope, authorized?: string | null): Promise<void> {
    if (!REVISION_READERS.has(url.pathname)) return;
    const params = url.searchParams, path = url.pathname;
    for (const name of SELECTORS) if (params.getAll(name).length > 1) throw new HttpError(400, 'Use each revision selector once.');
    await this.with(scope, async context => {
      if (path === '/api/repository/commit' || path === '/api/repository/commit/diff') {
        // A shorter hash resolves among commits walked from the branches; anything else fails the reader's own check.
        const sha = params.get('sha') ?? '';
        if (/^[0-9a-f]{40}$/i.test(sha)) await this.require(sha.toLowerCase(), context);
        return;
      }
      if (path === '/api/repository/compare/diff') {
        for (const name of ['base', 'head']) { const value = params.get(name) ?? ''; if (/^[0-9a-f]{40}$/.test(value)) await this.require(value, context); }
        return;
      }
      if (path === '/api/repository/compare') {
        for (const name of ['base', 'head']) { const value = params.get(name); if (value) params.set(name, await this.select(value, context)); }
        return;
      }
      const ref = params.get('ref') || scope.project.branch;
      const pinned = ref === authorized ? ref : await this.select(ref, context);
      const cursor = path === '/api/repository/commits' ? parse(historyQuery, { cursor: params.get('cursor') || undefined }).cursor : undefined;
      params.set('ref', pinned);
      if (!cursor) return;
      // A page continues from commits a public read reached; the reader still checks that it continues this branch and path.
      await this.require(cursor.next, context);
      await this.require(cursor.head, context);
      const same = cursor.ref === ref || cursor.ref === pinned || await this.select(cursor.ref, context).then(value => value === pinned, () => false);
      if (same) params.set('cursor', encodeCursor({ ...cursor, ref: pinned }));
    });
  }

  /** RPC for public Git fetches: whether every wanted commit is published. */
  async published(hashes: string[], scope: RevisionScope): Promise<boolean> {
    return this.with(scope, async context => {
      for (const hash of hashes) if (!await this.isPublished(hash, context)) return false;
      return true;
    });
  }

  /** One Artifacts handle for the request, opened only if something needs Git. */
  private async with<T>(scope: RevisionScope, work: (context: Context) => Promise<T>): Promise<T> {
    if (Date.now() - this.born > LIFETIME_MS) this.reset();
    let repo: ArtifactsRepo | undefined, charged: Promise<void> | undefined;
    const charge = () => charged ??= (async () => {
      const budget = await trunkOf(scope.env, scope.key).publicBuild(scope.network);
      if (!budget.allowed) throw new HttpError(503, 'This repository is preparing public content. Retry shortly.', budget.retryAfter);
    })();
    try { return await work({ ...scope, charge, open: async () => repo ??= readingNames(await artifactsOf(scope.env).get(scope.project.id), scope.project) }); }
    finally { repo?.[Symbol.dispose](); }
  }
  private reset() {
    this.reachable.clear(); this.walked.clear(); this.trunk = []; this.others = []; this.undated = []; this.waiting = []; this.grants.clear();
    this.born = Date.now(); this.tipsAt = 0; this.defaultAt = 0;
  }

  /** The value a reader is given for a public selector. */
  private async select(value: string, context: Context): Promise<string> {
    const selector = publicSelector(value);
    if (!selector) throw missing();
    if (selector.kind === 'commit') { await this.require(selector.hash, context); return selector.hash; }
    if (selector.kind === 'prefix' && !this.listed(value, context)) {
      // Artifacts expands the prefix; the commit it finds is then checked like any other.
      const [found] = await (await context.open()).log({ ref: selector.prefix, limit: 1 });
      if (found?.hash.startsWith(selector.prefix)) { await this.require(found.hash, context); return found.hash; }
    }
    return this.named(value, context);
  }
  private listed(name: string, context: Context) { return name === context.project.branch || !!context.project.branches?.includes(name); }
  /**
   * A branch the repository lists is handed to its reader by name, exactly as a member's read names it, with no extra
   * request. Any other name is read once and pinned to the commit it names. Artifacts reads a branch, a tag or a commit
   * ID and nothing else, so a plain name cannot reach a hidden namespace such as `refs/braid/`; a full `refs/...` name
   * would name nothing there, so it is never passed on.
   */
  private async named(name: string, context: Context): Promise<string> {
    const plain = name === 'HEAD' ? context.project.branch : name.replace(/^refs\/(?:heads|tags)\//, '');
    if (!name.startsWith('refs/tags/') && this.listed(plain, context)) return plain;
    const [found] = await (await context.open()).log({ ref: plain, limit: 1 });
    if (!found) throw missing();
    // Published by definition, and the reader need not resolve the name again. The walk starts from it too.
    if (!this.reachable.has(found.hash)) { this.reachable.add(found.hash); this.others.push({ hash: found.hash, at: found.committedAt, size: SIDE }); }
    return found.hash;
  }

  private async require(hash: string, context: Context) {
    if (!await this.isPublished(hash, context)) throw missing();
  }
  private known(hash: string, context: Context) {
    return hash === context.project.head || this.reachable.has(hash) || (this.grants.get(hash) ?? 0) > Date.now();
  }
  /** Checks that read Git run one at a time, so concurrent reads share a walk rather than repeating it. */
  private isPublished(hash: string, context: Context): Promise<boolean> {
    if (this.known(hash, context)) return Promise.resolve(true);
    const next = this.queue.then(() => this.check(hash, context));
    // The caller sees a failed check through `next`; the queue only orders the checks after it.
    this.queue = next.catch(() => {});
    return next;
  }
  private async check(hash: string, context: Context): Promise<boolean> {
    if (this.known(hash, context)) return true;
    const due = this.waiting.filter(entry => Date.now() - entry.since > FRESH_MS);
    this.waiting = this.waiting.filter(entry => !due.includes(entry));
    for (const { item, list } of due) list.push(item);
    const repo = await context.open();
    // One round: most commit pages, history cursors and blame links name one of the default branch's newest commits,
    // and an open pull request's commits are known to the change shard that holds it.
    const [, grant] = await Promise.all([this.newest(repo, context), this.grant(hash, context)]);
    if (this.known(hash, context) || grant && await this.granted(hash, grant, context)) return true;
    const target = await repo.readCommit(hash);
    return !!target && this.reach(target, context);
  }
  /** The default branch's newest commits, read again once it may have moved. */
  private async newest(repo: ArtifactsRepo, context: Context) {
    if (Date.now() - this.defaultAt <= FRESH_MS) return;
    const page = await repo.log({ ref: context.project.branch, limit: PAGE });
    this.defaultAt = Date.now();
    this.absorb(page, { size: PAGE }, this.trunk);
  }
  /** What the change shards record about a commit a push carried, from whichever shard holds its change. */
  private async grant(hash: string, { env, key }: Context) {
    const shards = await trunkOf(env, key).occupiedShards(key) ?? Array.from({ length: CHANGE_SHARDS }, (_, shard) => shard);
    return (await Promise.all(shards.map(shard => changeShardOf(env, key, shard).publicCommit(hash)))).find(Boolean) ?? null;
  }
  /** A commit a recorded push carried, in a revision that is not withheld, on a base that is published. */
  private async granted(hash: string, grant: { baseCommit: string; legacy: boolean }, context: Context): Promise<boolean> {
    if (!this.known(grant.baseCommit, context)) {
      const base = await (await context.open()).readCommit(grant.baseCommit);
      if (!base || !await this.reach(base, context)) return false;
    }
    if (grant.legacy && !await this.scanLegacy(hash, grant.baseCommit, context)) return false;
    this.grants.set(hash, Date.now() + GRANT_MS);
    return true;
  }
  /** A head pushed before pushes recorded their history: each commit between it and published history is scanned now. */
  private async scanLegacy(hash: string, baseCommit: string, context: Context): Promise<boolean> {
    await context.charge();
    const repo = await context.open();
    const base = await repo.readCommit(baseCommit);
    if (!base) return false;
    const todo = [hash], seen = new Set<string>(), commits: ArtifactsCommitMetadata[] = [];
    while (todo.length) {
      const next = todo.pop()!;
      if (seen.has(next) || this.reachable.has(next)) continue;
      if (seen.size >= 100) return false;
      seen.add(next);
      const commit = await repo.readCommit(next);
      if (!commit) return false;
      commits.push(commit); todo.push(...commit.parents);
    }
    return !(await scanPushedHistory(repo, base.treeHash, commits)).some(item => item.secrets);
  }

  /**
   * Walks from the public refs until `target` is reached. The default branch's first-parent chain comes first, down to
   * the target's date, in pages of a thousand commits read side by side, twice as many each round. Then a few of the
   * merges dated nearest the target, one at a time, as the merge that brought a commit in usually came soon after it;
   * then the other refs' tips, listed once and read only if still needed; then every other chain and merge dated near
   * the target, nearest first, a batch at a time. Finally walk every remaining chain, since Git permits an ancestor
   * to be arbitrarily newer than its children. Dates only prioritize reads; they never establish absence.
   */
  private async reach(target: ArtifactsCommitMetadata, context: Context): Promise<boolean> {
    const repo = await context.open(), at = target.committedAt, floor = at - SLOP;
    for (let reads = 0, near = 0, listed = false; !this.reachable.has(target.hash);) {
      let list = this.trunk, items = this.take(list, floor, at, 1);
      if (!items.length && near < NEAREST) { items = this.take(list = this.others, floor, at, 1); near += items.length; }
      if (!items.length && !listed && Date.now() - this.tipsAt > FRESH_MS) { listed = true; await context.charge(); await this.tips(repo, context); continue; }
      if (!items.length && this.undated.length) { await context.charge(); await this.date(repo); continue; }
      if (!items.length) items = this.take(list = this.others, floor, at, BATCH);
      if (!items.length) items = this.take(list = this.trunk, -Infinity, at, 1);
      if (!items.length) items = this.take(list = this.others, -Infinity, at, BATCH);
      if (!items.length) return false;
      const pages = items.flatMap(item => Array.from({ length: item.pages ?? 1 }, (_, index) => ({ item, offset: index * item.size })));
      if (this.walked.size >= WALK_LIMIT || reads + pages.length > CHECK_READS) { list.push(...items); throw new HttpError(503, 'This history is still being checked. Retry shortly.', 5); }
      reads += pages.length;
      let read: ArtifactsCommitMetadata[][];
      try { await context.charge(); read = await Promise.all(pages.map(({ item, offset }) => repo.log({ ref: item.hash, limit: item.size, ...(offset ? { offset } : {}) }))); }
      catch (error) { list.push(...items); throw error; }
      for (const item of items) {
        const page = read.filter((_, index) => pages[index].item === item).flat();
        if (!page.length) { this.waiting.push({ item, list, since: Date.now() }); continue; }
        this.walked.add(item.hash);
        this.absorb(page, item, list);
      }
    }
    return true;
  }
  /** Removes and returns up to `count` queued items whose dates are nearest `at`, among those no older than `floor`. */
  private take(list: Item[], floor: number, at: number, count: number): Item[] {
    const taken: Item[] = [];
    while (taken.length < count) {
      let best: Item | undefined, index = -1;
      for (let i = 0; i < list.length;) {
        const item = list[i];
        // Walked since it was queued: drop it.
        if (this.walked.has(item.hash)) { list[i] = list[list.length - 1]; list.pop(); continue; }
        if (item.at >= floor && (!best || Math.abs(item.at - at) < Math.abs(best.at - at))) { best = item; index = i; }
        i++;
      }
      if (!best) break;
      list[index] = list[list.length - 1]; list.pop();
      taken.push(best);
    }
    return taken;
  }
  /** The refs a public reader starts from: branches, tags (peeled) and Braid's notes. A new tip is published as listed. */
  private async tips(repo: ArtifactsRepo, context: Context) {
    if (!context.project.remote) { this.tipsAt = Date.now(); return; }
    // The token expires within a minute, so a failed revocation is harmless.
    const token = (await repo.createToken('read', 60)).plaintext;
    let refs: Map<string, string>;
    try { refs = (await advertisement({ remote: context.project.remote, token }, 'git-upload-pack', 4 * 1024 * 1024)).refs; }
    finally { await repo.revokeToken(token).catch(() => {}); }
    this.tipsAt = Date.now();
    for (const [ref, hash] of refs) {
      const root = ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/') || ref === NOTES_REF;
      if (root && !refs.has(`${ref}^{}`) && !this.reachable.has(hash) && this.undated.length < TIP_LIMIT) { this.reachable.add(hash); this.undated.push(hash); }
    }
  }
  /** Reads the listed tips' newest commits, a batch at a time: each one's date places it in the walk, and most end in history already walked. */
  private async date(repo: ArtifactsRepo) {
    while (this.undated.length) {
      const batch = this.undated.splice(0, BATCH).filter(hash => !this.walked.has(hash));
      let pages: ArtifactsCommitMetadata[][];
      try { pages = await Promise.all(batch.map(hash => repo.log({ ref: hash, limit: SIDE }))); }
      catch (error) { this.undated.push(...batch); throw error; }
      pages.forEach((page, index) => { this.walked.add(batch[index]); this.absorb(page, { size: SIDE }, this.others); });
    }
  }
  /**
   * Records a read of `read.size` commits, `read.pages` times over, down one first-parent chain: its commits are
   * published, their merge parents join the walk, and so does the chain below it, read next in twice as many commits.
   * The default branch's chain continues in pages of a thousand, twice as many side by side each time.
   */
  private absorb(page: ArtifactsCommitMetadata[], read: Pick<Item, 'size' | 'pages'>, continuation: Item[]) {
    let last: ArtifactsCommitMetadata | undefined;
    for (const commit of page) {
      // A commit another read already covered: the rest of this chain is known.
      if (this.walked.has(commit.hash) && commit !== page[0]) { last = undefined; break; }
      this.walked.add(commit.hash); this.reachable.add(commit.hash);
      for (const parent of commit.parents.slice(1)) if (!this.reachable.has(parent)) { this.reachable.add(parent); this.others.push({ hash: parent, at: commit.committedAt, size: SIDE }); }
      last = commit;
    }
    const next = last?.parents[0];
    if (!next || this.walked.has(next)) return;
    this.reachable.add(next);
    const trunk = continuation === this.trunk, pages = trunk && read.size === PAGE_MAX ? Math.min((read.pages ?? 1) * 2, BATCH) : 1;
    const item = { hash: next, at: last!.committedAt, size: trunk ? PAGE_MAX : Math.min(read.size * 2, PAGE_MAX), ...(pages > 1 ? { pages } : {}) };
    // A short page ends where the repository's history does for now: the parent is published, and read once it arrives.
    if (page.length === read.size * (read.pages ?? 1)) continuation.push(item);
    else this.waiting.push({ item, list: continuation, since: Date.now() });
  }
}
