/**
 * Git smart-HTTP plumbing for moving history between two hosts, such as GitHub
 * and Artifacts, without unpacking objects in a Worker. Packs stream from one
 * server's upload-pack into the other's receive-pack, and every ref update is
 * a compare-and-swap on the receiving side.
 */
import { ShownError } from '../errors';

export interface GitEndpoint { remote: string; token: string; username?: string }
export const ZERO = '0'.repeat(40);
const encoder = new TextEncoder(), decoder = new TextDecoder();
const moved = 'The Git branch moved since it was read. No changes were pushed.';

/** A Git server's refusal or a failed compare-and-swap. The message is fixed text, safe to show. */
export class GitError extends ShownError {
  /** `report` is what the server said, for logs: it may carry the server's own words, so it is never shown. */
  constructor(readonly code: 'moved' | 'rejected' | 'full' | 'too_large' | 'redirect' | 'refused' | 'unreachable' | 'status' | 'invalid', message: string, readonly report?: string[]) { super(message); this.name = 'GitError'; }
}
/** Artifacts' answer to every push once a repository holds its storage limit, an empty one included. */
const STORAGE_LIMIT = 'ERR artifacts_git_receive_pack_storage_limit';

/** Basic auth as Artifacts and GitHub take it: the token, without its expiry suffix, under the endpoint's user or `x`. */
export function authorization(endpoint: Pick<GitEndpoint, 'token' | 'username'>) {
  return `Basic ${btoa(`${endpoint.username ?? 'x'}:${endpoint.token.split('?expires=')[0]}`)}`;
}
export function pktLine(text: string | Uint8Array): Uint8Array {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  if (bytes.length + 4 > 65_520) throw new Error('Git command exceeds the protocol limit.');
  const result = new Uint8Array(bytes.length + 4);
  result.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, '0')));
  result.set(bytes, 4);
  return result;
}
export const FLUSH = encoder.encode('0000');
/** Bytes one after another, as one stream. */
export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
/** Streams one after another, pulled as the reader asks, so a slow receiver holds the sender back. */
function chain(streams: ReadableStream<Uint8Array>[]): ReadableStream<Uint8Array> {
  const parts = streams.map(stream => stream.getReader());
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (parts.length) {
        const { value, done } = await parts[0].read();
        if (!done) { controller.enqueue(value); return; }
        parts.shift();
      }
      controller.close();
    },
    async cancel(reason) { for (const part of parts) await part.cancel(reason); },
  });
}

async function request(endpoint: GitEndpoint, path: string, init: RequestInit & { duplex?: 'half' }) {
  let response: Response;
  try {
    response = await fetch(`${endpoint.remote.replace(/\/$/, '')}/${path}`, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(300_000),
      // A public source is read without credentials: some hosts refuse an empty password even for public repositories.
      headers: { ...(endpoint.token ? { authorization: authorization(endpoint) } : {}), 'user-agent': 'Braid', ...(init.headers as Record<string, string> | undefined) } });
  } catch { throw new GitError('unreachable', 'The Git server could not be reached.'); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new GitError('redirect', 'Git redirects are not allowed. No credentials were forwarded.'); }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new GitError('refused', 'The Git server refused these credentials.'); }
  if (response.status === 413) { await response.body?.cancel(); throw new GitError('too_large', 'The Git server refused the transfer size.'); }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new GitError('status', `The Git server answered ${response.status}.`); }
  return response;
}

/** Reads one pkt-line stream (bounded) into lines; used for small advertisements and reports. */
async function lines(body: ReadableStream<Uint8Array>, limit: number): Promise<string[]> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new GitError('too_large', 'The Git server response exceeds the metadata limit.'); }
    chunks.push(value);
  }
  const bytes = concat(chunks);
  const result: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) throw new GitError('invalid', 'The Git server sent an invalid response.');
    if (length === 0) { result.push(''); offset += 4; continue; }
    if (length < 4 || offset + length > bytes.length) throw new GitError('invalid', 'The Git server sent an incomplete response.');
    result.push(decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/, ''));
    offset += length;
  }
  if (offset !== bytes.length) throw new GitError('invalid', 'The Git server sent an incomplete response.');
  return result;
}

export interface Advertisement { refs: Map<string, string>; capabilities: Set<string> }
/** Protocol v1 ref advertisement for upload-pack or receive-pack. */
export async function advertisement(endpoint: GitEndpoint, service: 'git-upload-pack' | 'git-receive-pack', limit = 32 * 1024 * 1024): Promise<Advertisement> {
  const response = await request(endpoint, `info/refs?service=${service}`, { method: 'GET' });
  return readAdvertisement(response, service, limit);
}
/** Also used for an explicitly anonymous GitHub probe, whose HTTP status is part of the access decision. */
export async function readAdvertisement(response: Response, service: 'git-upload-pack' | 'git-receive-pack', limit: number): Promise<Advertisement> {
  if (!response.headers.get('content-type')?.startsWith(`application/x-${service}-advertisement`)) { await response.body!.cancel(); throw new GitError('invalid', 'The Git server did not return a smart-HTTP advertisement.'); }
  const refs = new Map<string, string>(), capabilities = new Set<string>();
  for (const line of await lines(response.body!, limit)) {
    if (!line || line.startsWith('# service=')) continue;
    const [head, caps] = line.split('\0');
    const [oid, ref] = head.split(' ');
    if (!/^[a-f0-9]{40}$/.test(oid) || !ref) continue;
    if (caps !== undefined) for (const capability of caps.trim().split(' ')) if (capability) capabilities.add(capability);
    if (ref !== 'capabilities^{}') refs.set(ref, oid);
  }
  return { refs, capabilities };
}
/** A thin pack's deltas may refer to objects the receiver has; one that can't resolve them advertises no-thin. */
const thin = (target: Advertisement) => target.capabilities.has('no-thin') ? [] : ['thin-pack'];

/** Parses a receive-pack report; only a complete, positive acknowledgment of every ref counts as success. */
async function report(response: Response, refs: string[]) {
  const result = await lines(response.body!, 1024 * 1024);
  if (result.includes(STORAGE_LIMIT)) throw new GitError('full', 'This repository reached its storage limit.', result);
  const flush = result.lastIndexOf('');
  const status = result.slice(0, flush < 0 ? result.length : flush);
  if (flush !== result.length - 1 || status[0] !== 'unpack ok' || refs.some(ref => !status.includes(`ok ${ref}`)) || status.some(line => line.startsWith('ng ')))
    throw new GitError('rejected', 'The Git branch changed or rejected this update. Refresh the repository before retrying.', status);
}

/**
 * Reads the opening section of a Git request, its pkt-lines up to the first flush, and returns the stream of what
 * follows, such as a push's pack, untouched.
 */
export async function readSection(body: ReadableStream<Uint8Array>, limit = 65_536): Promise<{ lines: string[]; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader(), found: string[] = [];
  // Built only once the section is read: a stream with a source starts pulling from it at once.
  const remaining = () => new ReadableStream<Uint8Array>({
    async pull(controller) { const { value, done } = await reader.read(); if (done) controller.close(); else controller.enqueue(value); },
    cancel: reason => reader.cancel(reason),
  });
  let buffer = new Uint8Array(0), size = 0;
  try { for (;;) {
    while (buffer.length >= 4) {
      const prefix = decoder.decode(buffer.subarray(0, 4));
      if (!/^[a-f0-9]{4}$/i.test(prefix)) throw new Error('This is not a Git request.');
      const length = parseInt(prefix, 16);
      if ((length > 0 && length < 4) || length > 65_520) throw new Error('This is not a Git request.');
      if (size + (length || 4) > limit) throw new Error('The Git request opens with more than it should.');
      if (length === 0) return { lines: found, rest: chain([new Blob([buffer.subarray(4)]).stream(), remaining()]) };
      if (buffer.length < length) break;
      found.push(decoder.decode(buffer.subarray(4, length)));
      size += length;
      buffer = buffer.subarray(length);
    }
    const { value, done } = await reader.read();
    if (done) throw new Error('The Git request ended early.');
    buffer = concat([buffer, value]);
  } } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}

/**
 * Stores a pack on `target` and points refs at its commits with compare-and-swap, in one receive-pack request. The
 * pack streams through without being unpacked here.
 */
export async function receive(target: GitEndpoint, updates: { old: string; new: string; ref: string }[], pack: ReadableStream<Uint8Array>, shallow: string[] = []) {
  // A pack whose oldest commits arrive without parents names them first, as a shallow Git client's push does.
  const commands = [...shallow.map(hash => pktLine(`shallow ${hash}\n`)), ...updates.map((update, index) => pktLine(`${update.old} ${update.new} ${update.ref}${index ? '' : '\0report-status'}\n`))];
  const response = await request(target, 'git-receive-pack', { method: 'POST', body: chain([new Blob([...commands, FLUSH] as BlobPart[]).stream(), pack]), duplex: 'half',
    headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' } });
  await report(response, updates.map(update => update.ref));
}

async function emptyPack(): Promise<Uint8Array> {
  const header = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  const pack = new Uint8Array(32);
  pack.set(header);
  pack.set(new Uint8Array(await crypto.subtle.digest('SHA-1', header)), 12);
  return pack;
}

/** Moves a ref to a commit the server already has, with compare-and-swap on its previous value. */
export async function updateRef(endpoint: GitEndpoint, ref: string, expected: string, next: string) {
  const current = (await advertisement(endpoint, 'git-receive-pack')).refs.get(ref) ?? ZERO;
  if (current === next) return;
  if (current !== expected) throw new GitError('moved', moved);
  const body = [pktLine(`${expected} ${next} ${ref}\0report-status\n`), FLUSH, ...(next === ZERO ? [] : [await emptyPack()])];
  const response = await request(endpoint, 'git-receive-pack', { method: 'POST', body: new Blob(body as BlobPart[]),
    headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' } });
  await report(response, [ref]);
}

/**
 * Skips upload-pack's acknowledgment and shallow lines, handing each to `line`, and yields the raw pack that follows
 * (no side-band was requested).
 */
function packStream(body: ReadableStream<Uint8Array>, line?: (text: string) => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0), packing = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (packing) {
          if (buffer.length) { controller.enqueue(buffer); buffer = new Uint8Array(0); return; }
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value); return;
        }
        while (buffer.length >= 4 && !packing) {
          const prefix = decoder.decode(buffer.subarray(0, 4));
          if (prefix === 'PACK') { packing = true; break; }
          const length = parseInt(prefix, 16);
          if (Number.isNaN(length)) { controller.error(new GitError('invalid', 'The source sent an invalid pack response.')); return; }
          if (length === 0) { buffer = buffer.subarray(4); continue; }
          if (buffer.length < length) break;
          const text = decoder.decode(buffer.subarray(4, length));
          if (text.startsWith('ERR ')) { controller.error(new GitError('refused', 'The source Git server refused the fetch.')); return; }
          line?.(text.replace(/\n$/, ''));
          buffer = buffer.subarray(length);
        }
        if (packing) continue;
        const { value, done } = await reader.read();
        if (done) { controller.error(new GitError('invalid', 'The source closed before sending a pack.')); return; }
        buffer = concat([buffer, value]);
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
}

/**
 * Copies the history needed for `want` from `source` into `target` and moves
 * `ref` on the target from `expected` to `want`. The target's existing commits
 * are offered as `have`, so only missing objects travel; `shallow` names the
 * target's shallow boundary when it was imported without full history, and
 * `thin` lets the pack refer to what the haves hold instead of carrying it.
 */
export async function relay(options: { source: GitEndpoint; target: GitEndpoint; want: string; ref: string; expected: string; have?: string[]; shallow?: string[]; thin?: true; transfer?: () => Promise<{ wrap(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>; finish(): Promise<void> }> }) {
  const { source, target, want, ref, expected } = options;
  if (!/^[a-f0-9]{40}$/.test(want)) throw new Error('Invalid commit to relay.');
  const advertised = await advertisement(target, 'git-receive-pack');
  const current = advertised.refs.get(ref) ?? ZERO;
  if (current === want) return;
  if (current !== expected) throw new GitError('moved', moved);
  if (!advertised.capabilities.has('report-status')) throw new GitError('invalid', 'The target cannot confirm updates.');
  const haves = [...new Set([...(options.have ?? []), ...(expected !== ZERO ? [expected] : [])])].filter(oid => /^[a-f0-9]{40}$/.test(oid)).slice(0, 64);
  const capabilities = ['no-progress', ...(options.thin ? thin(advertised) : []), ...(advertised.capabilities.has('ofs-delta') ? ['ofs-delta'] : [])];
  const negotiation = [
    pktLine(`want ${want} ${capabilities.join(' ')}\n`),
    ...(options.shallow ?? []).map(oid => pktLine(`shallow ${oid}\n`)),
    FLUSH,
    ...haves.map(oid => pktLine(`have ${oid}\n`)),
    pktLine('done\n'),
  ];
  const transfer = await options.transfer?.();
  try {
    const fetched = await request(source, 'git-upload-pack', { method: 'POST', body: new Blob(negotiation as BlobPart[]),
      headers: { 'content-type': 'application/x-git-upload-pack-request', accept: 'application/x-git-upload-pack-result' } });
    // Pull-based so a slow receiver applies backpressure to the source instead of buffering the pack.
    await receive(target, [{ old: expected, new: want, ref }], packStream(transfer ? transfer.wrap(fetched.body!) : fetched.body!));
  } finally { await transfer?.finish(); }
}

/** A stream that fails once more than `max` bytes have passed through it; `passed` hears the running size. */
export function limited(stream: ReadableStream<Uint8Array>, max: number, exceeded: () => void, passed?: (size: number) => void): ReadableStream<Uint8Array> {
  let size = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      passed?.(size);
      if (size <= max) controller.enqueue(chunk);
      else { exceeded(); controller.error(new Error('The push is too large.')); }
    },
  }));
}

/**
 * Copies `depth` more commits of history beneath the target's shallow boundary. `parents` are the missing parents of
 * the `boundary` commits; the source sends them and their ancestors `depth` commits deep, minus what the target has,
 * in one pack of at most `limit` bytes. The push declares the new boundary the source reported, as a shallow Git
 * client does, and moves `ref` to the first parent, keeping the copy referenced. Returns that boundary, empty once
 * history reached its roots, and the pack's size.
 */
export async function relayHistory(options: { source: GitEndpoint; target: GitEndpoint; boundary: string[]; parents: string[]; depth: number; ref: string; have: string[]; limit: number; transfer?: () => Promise<{ wrap(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>; finish(): Promise<void> }> }): Promise<{ boundary: string[]; bytes: number }> {
  const { source, target, boundary, parents, depth, ref, limit } = options;
  const oid = /^[a-f0-9]{40}$/;
  if (!parents.length || ![...boundary, ...parents].every(hash => oid.test(hash)) || !Number.isSafeInteger(depth) || depth < 1) throw new Error('Invalid history to relay.');
  const advertised = await advertisement(target, 'git-receive-pack');
  if (!advertised.capabilities.has('report-status')) throw new GitError('invalid', 'The target cannot confirm updates.');
  // The boundary goes first among the haves. A thin pack leaves out what their trees hold, so a part carries what
  // changed beneath the boundary instead of another whole snapshot of the repository.
  const haves = [...new Set([...boundary, ...options.have])].filter(hash => oid.test(hash)).slice(0, 64);
  const capabilities = ['no-progress', 'shallow', ...thin(advertised), ...(advertised.capabilities.has('ofs-delta') ? ['ofs-delta'] : [])];
  const negotiation = [
    pktLine(`want ${parents[0]} ${capabilities.join(' ')}\n`),
    ...parents.slice(1).map(hash => pktLine(`want ${hash}\n`)),
    ...boundary.map(hash => pktLine(`shallow ${hash}\n`)),
    pktLine(`deepen ${depth}\n`),
    FLUSH,
    ...haves.map(hash => pktLine(`have ${hash}\n`)),
    pktLine('done\n'),
  ];
  const next = new Set<string>();
  let bytes = 0, over = false;
  const transfer = await options.transfer?.();
  try {
    const fetched = await request(source, 'git-upload-pack', { method: 'POST', body: new Blob(negotiation as BlobPart[]),
      headers: { 'content-type': 'application/x-git-upload-pack-request', accept: 'application/x-git-upload-pack-result' } });
    const pack = packStream(limited(transfer ? transfer.wrap(fetched.body!) : fetched.body!, limit, () => { over = true; }, size => { bytes = size; }),
      line => { if (line.startsWith('shallow ') && oid.test(line.slice(8))) next.add(line.slice(8)); }).getReader();
    // The source reports the new boundary before its pack, so the push can declare it.
    const first = await pack.read();
    if (first.done) throw new GitError('invalid', 'The source closed before sending a pack.');
    const rest = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(first.value); },
      async pull(controller) { const { value, done } = await pack.read(); if (done) controller.close(); else controller.enqueue(value); },
      cancel: reason => pack.cancel(reason),
    });
    await receive(target, [{ old: advertised.refs.get(ref) ?? ZERO, new: parents[0], ref }], rest, [...next]);
  } catch (error) {
    // The receiver reports a body that stopped early in its own words; the limit is the reason.
    if (over) throw new GitError('too_large', 'This part of the history is larger than one push may carry.');
    throw error;
  } finally { await transfer?.finish(); }
  return { boundary: [...next], bytes };
}
