/**
 * How long a request waited on each thing it asked, sent back as `Server-Timing`, so a slow answer says where its
 * time went in any browser's network panel. Only durations travel; names are fixed phases, never data.
 */
export class Timings {
  private readonly entries: string[] = [];
  async wait<P extends PromiseLike<unknown>>(name: string, work: P): Promise<Awaited<P>> {
    const start = performance.now();
    try { return await work; } finally { this.entries.push(`${name};dur=${Math.round(performance.now() - start)}`); }
  }
  record(name: string, milliseconds: number) { this.entries.push(`${name};dur=${Math.max(0, Math.round(milliseconds))}`); }
  /** Another object's own timings, such as a Durable Object's, under a prefix. */
  add(header: string | null, prefix: string) {
    for (const entry of header?.split(',') ?? []) if (entry.trim()) this.entries.push(`${prefix}${entry.trim()}`);
  }
  header(): string { return this.entries.join(', '); }
}
