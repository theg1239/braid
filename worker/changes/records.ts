import { ContentStore } from '../workspace/content';

/** Keep indexed fields in the row; large metadata uses the same bounded chunks as revision patches. */
export class ChangeRecords<T extends { id: string; revision: number; headCommit?: string }> {
  constructor(private content: ContentStore) {}

  write(change: T): string {
    const value = JSON.stringify(change), contentKey = `record:${change.id}`;
    // Even three-byte UTF-8 characters leave ample room below SQLite's 2 MB row limit.
    if (value.length <= 262_144) { this.content.delete(contentKey); return value; }
    this.content.put(contentKey, change);
    return JSON.stringify({ id: change.id, revision: change.revision, headCommit: change.headCommit, contentKey });
  }

  read(value: string): T {
    const row = JSON.parse(value) as T | { contentKey: string };
    if (!('contentKey' in row)) return row;
    const change = this.content.get<T>(row.contentKey);
    if (!change) throw new Error('Change record chunks are missing.');
    return change;
  }
}
