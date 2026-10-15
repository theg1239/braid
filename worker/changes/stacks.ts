import type { ChangeReference, ChangeSummary } from '../../shared/types';
import { HttpError } from '../errors';
import { addColumn } from '../sql';

export type StackNode = ChangeReference & { revision: number; headCommit?: string; landedCommit?: string; baseCommit?: string };
type StackView = Pick<ChangeSummary, 'dependsOn' | 'requiredBy' | 'waitingOn' | 'outdated' | 'stack'>;
type NodeRow = { id: string; number: number; status: ChangeReference['status']; revision: number; head: string | null };
const reference = ({ id, number, status }: ChangeReference): ChangeReference => ({ id, number, status });
const numbers = (items: ChangeReference[]) => items.map(item => `#${item.number}`).join(', ');
/** Stacks read per page of the merge queue. */
const STACK_PAGE = 20;
export const outdatedReason = (items: ChangeReference[]) => items.length ? `${numbers(items)} changed since this was built` : undefined;
const finished = (node: ChangeReference) => node.status === 'landed' || node.status === 'closed';
export const waitingReason = (dependencies: ChangeReference[]) => {
  const closed = dependencies.filter(item => item.status === 'closed');
  if (closed.length) return `${numbers(closed)} closed without merging. Revise the dependencies or close this pull request.`;
  const waiting = dependencies.filter(item => item.status !== 'landed');
  return waiting.length ? `Waiting on ${numbers(waiting)}` : undefined;
};

/** One small, synchronous graph per repository. Edge replacement and cycle detection cannot interleave. */
export class StackGraph {
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS stack_nodes (id TEXT PRIMARY KEY, number INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, head TEXT)');
    sql.exec('CREATE INDEX IF NOT EXISTS stack_heads ON stack_nodes(head, status)');
    sql.exec('CREATE TABLE IF NOT EXISTS stack_edges (child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY(child, parent))');
    if (addColumn(sql, 'stack_edges', 'revision', 'INTEGER NOT NULL DEFAULT 0'))
      sql.exec('UPDATE stack_edges SET revision = COALESCE((SELECT revision FROM stack_nodes WHERE id = parent), 0)');
    sql.exec('CREATE TABLE IF NOT EXISTS stack_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, head TEXT NOT NULL, PRIMARY KEY(id, revision))');
    sql.exec('CREATE TABLE IF NOT EXISTS stack_wakes (id TEXT PRIMARY KEY, version INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS stack_parents ON stack_edges(parent, child)');
    sql.exec('CREATE TABLE IF NOT EXISTS stack_receipts (id TEXT NOT NULL, revision INTEGER NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(id, revision))');
  }
  private node(id: string) { return this.sql.exec<NodeRow>('SELECT * FROM stack_nodes WHERE id = ?', id).toArray()[0]; }
  observe(nodes: StackNode[]) {
    for (const node of nodes) {
      const previous = this.node(node.id);
      if (node.headCommit) this.sql.exec('INSERT OR IGNORE INTO stack_versions (id, revision, head) VALUES (?, ?, ?)', node.id, node.revision, node.headCommit);
      this.sql.exec(`INSERT INTO stack_nodes (id, number, status, revision, head) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, head = excluded.head
      WHERE excluded.revision >= stack_nodes.revision AND stack_nodes.status NOT IN ('landed', 'closed')`,
    node.id, node.number, node.status, node.revision, node.landedCommit ?? node.headCommit ?? null);
      if (previous && (node.revision > previous.revision || (!finished(previous) && finished(node)))) {
        for (const id of this.children(node.id)) this.sql.exec('INSERT INTO stack_wakes (id, version) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET version = version + 1', id);
      }
    }
  }
  wakes() { return this.sql.exec<{ id: string; version: number }>('SELECT * FROM stack_wakes LIMIT 128').toArray(); }
  acknowledge(id: string, version: number) { this.sql.exec('DELETE FROM stack_wakes WHERE id = ? AND version = ?', id, version); }
  outdated(id: string): ChangeReference[] {
    return this.sql.exec<NodeRow>('SELECT n.* FROM stack_edges e JOIN stack_nodes n ON n.id = e.parent WHERE e.child = ? AND e.revision < n.revision ORDER BY n.number', id).toArray().map(reference);
  }
  pins(id: string) {
    return this.sql.exec<{ parent: string; revision: number }>('SELECT parent, revision FROM stack_edges WHERE child = ?', id).toArray();
  }
  ancestors(id: string): StackNode[] {
    const found = new Set<string>();
    const visit = (child: string) => { for (const parent of this.parents(child)) if (!found.has(parent)) { found.add(parent); visit(parent); } };
    visit(id);
    return this.order([...found]).map(item => { const node = this.node(item.id)!; return { ...item, revision: node.revision, ...(node.head ? { headCommit: node.head } : {}) }; });
  }
  validate(id: string | undefined, dependencies: StackNode[], retainClosed = false) {
    if (dependencies.length > 16) throw new HttpError(400, 'A pull request can depend on at most 16 pull requests.');
    for (const item of dependencies) {
      if (item.id === id) throw new HttpError(409, 'A pull request cannot depend on itself.');
      if (!retainClosed && (this.node(item.id)?.status ?? item.status) === 'closed') throw new HttpError(409, `#${item.number} closed without merging. Choose an open or merged pull request.`);
      if (id && this.ancestors(item.id).some(parent => parent.id === id)) throw new HttpError(409, 'Pull request dependencies cannot form a cycle.');
    }
  }
  heads(commit: string): ChangeReference[] {
    return this.sql.exec<NodeRow>("SELECT * FROM stack_nodes WHERE head = ? AND status NOT IN ('landed', 'closed') LIMIT 17", commit).toArray().map(reference);
  }
  dependencies(id: string): ChangeReference[] {
    return this.sql.exec<NodeRow>('SELECT n.* FROM stack_edges e JOIN stack_nodes n ON n.id = e.parent WHERE e.child = ? ORDER BY n.number', id).toArray().map(reference);
  }
  private parents(id: string) { return this.sql.exec<{ parent: string }>('SELECT parent FROM stack_edges WHERE child = ?', id).toArray().map(row => row.parent); }
  private children(id: string) { return this.sql.exec<{ child: string }>('SELECT child FROM stack_edges WHERE parent = ?', id).toArray().map(row => row.child); }
  private component(id: string) {
    const found = new Set<string>(), pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (found.has(next)) continue;
      found.add(next);
      if (found.size > 128) throw new HttpError(400, 'A stack can contain at most 128 pull requests.');
      pending.push(...this.parents(next), ...this.children(next));
    }
    return [...found];
  }
  private order(ids: string[]): ChangeReference[] {
    const nodes = ids.map(id => this.node(id)!).sort((a, b) => a.number - b.number);
    const emitted = new Set<string>(), result: ChangeReference[] = [];
    while (result.length < nodes.length) {
      const node = nodes.find(node => !emitted.has(node.id) && this.parents(node.id).every(id => emitted.has(id)));
      if (!node) throw new HttpError(409, 'Pull request dependencies cannot form a cycle.');
      emitted.add(node.id); result.push(reference(node));
    }
    return result;
  }
  /** Called inside the trunk's storage transaction; a rejected edge edit rolls back completely. */
  set(node: StackNode, dependencies: StackNode[], signature: string, retainClosed: boolean, pins?: { parent: string; revision: number }[]) {
    const receipt = this.sql.exec<{ signature: string }>('SELECT signature FROM stack_receipts WHERE id = ? AND revision = ?', node.id, node.revision).toArray()[0];
    if (receipt) {
      if (receipt.signature !== signature) throw new HttpError(409, 'This revision already has a prepared submission. Retry the original request.');
      return this.dependencies(node.id);
    }
    this.validate(node.id, dependencies, retainClosed);
    this.observe(dependencies);
    if (!retainClosed) for (const item of dependencies) {
      if (this.node(item.id)!.status === 'closed') throw new HttpError(409, `#${item.number} closed without merging. Choose an open or merged pull request.`);
    }
    this.observe([node]);
    this.sql.exec('DELETE FROM stack_edges WHERE child = ?', node.id);
    for (const item of dependencies) {
      const built = node.baseCommit ? this.sql.exec<{ revision: number }>('SELECT revision FROM stack_versions WHERE id = ? AND head = ? ORDER BY revision DESC LIMIT 1', item.id, node.baseCommit).toArray()[0]?.revision : undefined;
      this.sql.exec('INSERT INTO stack_edges (child, parent, revision) VALUES (?, ?, ?)', node.id, item.id, pins?.find(pin => pin.parent === item.id)?.revision ?? built ?? item.revision);
    }
    this.order(this.component(node.id));
    this.sql.exec('INSERT INTO stack_receipts (id, revision, signature) VALUES (?, ?, ?)', node.id, node.revision, signature);
    return this.dependencies(node.id);
  }
  views(ids: string[]): Record<string, StackView> {
    const result: Record<string, StackView> = {};
    for (const id of ids) {
      if (result[id] || !this.node(id)) continue;
      const order = this.order(this.component(id));
      for (const [index, item] of order.entries()) {
        const dependsOn = this.dependencies(item.id), requiredBy = this.children(item.id).map(child => reference(this.node(child)!)).sort((a, b) => a.number - b.number);
        result[item.id] = { dependsOn, requiredBy, outdated: finished(item) ? [] : this.outdated(item.id), waitingOn: finished(item) ? [] : dependsOn.filter(parent => parent.status !== 'landed'),
          ...(order.length > 1 ? { stack: { position: index + 1, total: order.length } } : {}) };
      }
    }
    return Object.fromEntries(ids.map(id => [id, result[id] ?? {}]));
  }
  active(after = 0): { stacks: ChangeReference[][]; nextStackCursor: number | null } {
    const seen = new Set<string>(), stacks: ChangeReference[][] = [];
    let cursor = after, last = 0;
    // Read bounded pages of nodes; a large connected stack must not hide later stacks.
    for (;;) {
      const seeds = this.sql.exec<{ id: string; number: number }>("SELECT n.id, n.number FROM stack_nodes n WHERE n.number > ? AND n.status NOT IN ('closed', 'landed') AND (EXISTS (SELECT 1 FROM stack_edges WHERE child = n.id) OR EXISTS (SELECT 1 FROM stack_edges WHERE parent = n.id)) ORDER BY n.number LIMIT 100", cursor).toArray();
      for (const seed of seeds) {
        cursor = seed.number;
        if (seen.has(seed.id)) continue;
        const order = this.order(this.component(seed.id));
        order.forEach(item => seen.add(item.id));
        const first = Math.min(...order.filter(item => !finished(item)).map(item => item.number));
        if (first <= after) continue;
        if (stacks.length === STACK_PAGE) return { stacks, nextStackCursor: last };
        stacks.push(order);
        last = first;
      }
      if (seeds.length < 100) return { stacks, nextStackCursor: null };
    }
  }
}
