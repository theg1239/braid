import { digest } from './auth';
import { HttpError } from '../errors';
import { idempotencyKey, parse } from '../schemas';

export interface Receipt { key: string; signature: string; status?: number; body?: string }
export class RequestJournal {
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, signature TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL)');
  }
  async read(request: Request, body: Record<string, unknown>, required: boolean): Promise<Receipt | undefined> {
    const key = request.headers.get('idempotency-key');
    if (!key) {
      if (required) throw new HttpError(400, 'Send an Idempotency-Key so this operation can be safely retried.');
      return;
    }
    parse(idempotencyKey('Use a unique 16–128 character Idempotency-Key.'), key);
    const signature = await digest(`${request.method}\n${new URL(request.url).pathname}\n${request.headers.get('x-braid-user-id') || request.headers.get('x-braid-actor')}\n${JSON.stringify(body)}`);
    const prior = this.sql.exec<{ signature: string; status: number; body: string }>('SELECT signature, status, body FROM requests WHERE key = ?', key).toArray()[0];
    if (prior && prior.signature !== signature) throw new HttpError(409, 'This request key has already been used for a different operation.');
    return prior ? { key, ...prior } : { key, signature };
  }
  save(receipt: Receipt | undefined, status: number, body: unknown) {
    if (receipt) this.sql.exec('INSERT INTO requests (key, signature, status, body) VALUES (?, ?, ?, ?)', receipt.key, receipt.signature, status, JSON.stringify(body));
  }
}
