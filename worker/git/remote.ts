import * as v from 'valibot';
import { artifactsOf, type BraidEnv } from '../env';
import { HttpError, logFailure } from '../errors';
import { cachedReader, readNote } from './objects';
import { advertisement, authorization, concat, FLUSH, GitError, limited, pktLine, readSection, receive, updateRef, ZERO, type GitEndpoint } from './transport';
import { NOTES_REF, parsePerson, parseTrailers, type BraidNote } from '../../shared/provenance';
import { withoutTrailers } from '../repositories/provenance';
import { actor, type ChangeGateway } from '../changes/router';
import { changeShardOf, submissionShard } from '../changes/names';
import type { RepositoryInfo } from '../changes/shard';
import { coAuthor, gitPushCommands, parse, publicGitFetchLines } from '../schemas';
import { changedFiles, scanPushedHistory } from './history';
import { readingNames } from '../repositories/repository';
import { digest } from '../http/auth';
import { checkAuthorization } from '../http/authorization';

/**
 * Braid as a Git remote over smart HTTP. `git fetch` reads main, and `git push braid HEAD:refs/for/main` opens a
 * change from the pushed commits, or revises the one a `%topic=` names, the way Gerrit's magic refs do; main itself
 * only moves through the merge queue. Agents authenticate with their token as the Basic-auth password. A push's pack
 * streams into Artifacts under a hidden ref, Braid reads the commits from there, and the ref is deleted afterwards.
 */
export const GIT_PATH = /^\/git\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** Artifacts rejects packs at about 30 MB. A pull request can reuse objects from several uploads. */
const PUSH_BYTES = 29_000_000;
const PUSH_LIMIT = 'Cloudflare Artifacts accepts about 30 MB per push. Send packs below 29 MB to refs/braid/uploads/<name>, then push HEAD:refs/for/main.';
const platformRefusal = (error: unknown) => error instanceof GitError ? error.code === 'full'
  ? 'Cloudflare Artifacts limits each repository to 1 GB. This repository has reached that limit.'
  : error.code === 'too_large' ? PUSH_LIMIT : undefined : undefined;
/** How many commits main does not have one push may carry. */
const PUSH_COMMITS = 100;
/** The most a fetch request may send. */
const REQUEST_BYTES = 8 * 1024 * 1024;
const RECEIVE_CAPABILITIES = 'report-status side-band-64k ofs-delta no-thin delete-refs quiet agent=braid';
const encoder = new TextEncoder(), decoder = new TextDecoder();

/** A push Braid refuses, with the reason Git shows its author. */
class Refused extends Error {}
type Command = { old: string; new: string; ref: string };

export async function gitRemote(request: Request, env: BraidEnv, gateway: ChangeGateway, browserBase: string): Promise<Response> {
  const url = new URL(request.url), action = GIT_PATH.exec(url.pathname)![2];
  const service = action === 'info/refs' ? url.searchParams.get('service') : action;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'Fetch with git-upload-pack or push with git-receive-pack.');
  if (request.method !== (action === 'info/refs' ? 'GET' : 'POST')) throw new HttpError(405, 'Method not allowed.');
  if (gateway.mode !== 'live') throw new HttpError(404, 'This repository has no Git remote.');
  if (service === 'git-receive-pack' && gateway.agent?.scope !== 'work') throw new HttpError(403, 'Pushing a change needs a connection with work access.');
  const repository = await env.WORKSPACES.getByName(gateway.repository).repository();
  if (!repository) throw new HttpError(409, 'Create or import a repository first.');
  using artifacts = readingNames(await artifactsOf(env).get(repository.id), repository);
  if (action === 'info/refs' && service === 'git-receive-pack') {
    const head = (await artifacts.log({ ref: repository.branch, limit: 1 }))[0]?.hash;
    if (!head) throw new HttpError(409, 'Main is still preparing. Retry shortly.');
    const source = await endpoint(artifacts, repository, 'read');
    try {
      const prefix = await uploadPrefix(gateway), { refs } = await advertisement(source, 'git-upload-pack');
      const uploads = [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, hash]): [string, string] => [`refs/braid/uploads/${ref.slice(prefix.length)}`, hash]);
      return advertise('git-receive-pack', [[`refs/heads/${repository.branch}`, head], ...uploads], RECEIVE_CAPABILITIES);
    } finally { await revoke(artifacts, source.token); }
  }
  // Git asks for protocol v2 when it can: a shallow clone needs it, since Artifacts answers v1's stateless shallow negotiation without the shallow list.
  const v2 = /(?:^|:)version=2(?::|$)/.test(request.headers.get('git-protocol') ?? '');
  if (action === 'info/refs') {
    const source = await endpoint(artifacts, repository, 'read');
    try {
      if (v2) return await advertiseV2(source);
      const { refs, capabilities } = await advertisement(source, 'git-upload-pack');
      // Every branch, with Braid's notes; pushes in progress live under refs/braid and stay hidden.
      const visible = [...refs].filter(([ref]) => shown(ref));
      if (gateway.publicViewer) await rememberTips(env, gateway.repository, visible.map(([, oid]) => oid));
      return advertise('git-upload-pack', visible, [...capabilities].join(' '));
    } finally { await revoke(artifacts, source.token); }
  }
  if (action === 'git-upload-pack' && gateway.publicViewer) request = await authorizeFetch(request, env, gateway, v2);
  if (action === 'git-upload-pack' && v2) return uploadV2(request, env, gateway, repository, await endpoint(artifacts, repository, 'read', 600));
  if (action === 'git-upload-pack') return fetchPack(request, env, repository, await endpoint(artifacts, repository, 'read', 600));
  return push(request, env, gateway, repository, artifacts, browserBase);
}

/** The refs a fetch sees: every branch and Braid's notes. Pushes in progress live under refs/braid and stay hidden. */
const shown = (ref: string) => ref === 'HEAD' || ref.startsWith('refs/heads/') || ref === NOTES_REF;
const uploadPrefix = async (gateway: ChangeGateway) => `refs/braid/uploads/${await digest(actor(gateway).id)}/`;

/** Protocol v2's opening: Artifacts' capabilities as they are, since v2 lists refs only when asked. */
async function advertiseV2(source: GitEndpoint): Promise<Response> {
  const upstream = await artifactsGit(source, 'info/refs?service=git-upload-pack', { headers: { 'git-protocol': 'version=2' } }, 30);
  if (upstream.status !== 200 || !upstream.headers.get('content-type')?.startsWith('application/x-git-upload-pack-advertisement')) {
    await upstream.body?.cancel();
    throw new HttpError(502, 'Artifacts could not list the repository. Retry the fetch.');
  }
  return new Response(upstream.body, { headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' } });
}

/** A v2 request or response as packets; flush, delimiter and response-end are their numbers 0, 1 and 2. */
function packets(bytes: Uint8Array): (Uint8Array | number)[] {
  const result: (Uint8Array | number)[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const prefix = decoder.decode(bytes.subarray(offset, offset + 4));
    const length = /^[a-f0-9]{4}$/i.test(prefix) ? Number.parseInt(prefix, 16) : Number.NaN;
    if (!Number.isInteger(length) || length === 3 || offset + Math.max(length, 4) > bytes.length) throw new HttpError(400, 'This is not a complete Git request.');
    if (length < 4) { result.push(length); offset += 4; continue; }
    result.push(bytes.subarray(offset + 4, offset + length));
    offset += length;
  }
  return result;
}
const encodePackets = (list: (Uint8Array | number)[]) => concat(list.map(item => typeof item === 'number' ? encoder.encode(item.toString(16).padStart(4, '0')) : pktLine(item)));

/** The tips a public fetch was just shown, kept briefly in this data center, so the fetch that follows needs no other check. */
const TIPS_SECONDS = 60;
const tipsKey = (env: BraidEnv, repository: string) => new Request(`https://repository.braid.invalid/${env.BUILD_ID ?? 'dev'}/${encodeURIComponent(repository)}/git-tips`);
async function recalledTips(env: BraidEnv, repository: string): Promise<Set<string>> {
  const kept = await (await caches.open('repository')).match(tipsKey(env, repository));
  return new Set(kept ? await kept.json() as string[] : []);
}
async function rememberTips(env: BraidEnv, repository: string, tips: string[]) {
  const known = await recalledTips(env, repository);
  for (const tip of tips) if (/^[0-9a-f]{40}$/.test(tip)) known.add(tip);
  await (await caches.open('repository')).put(tipsKey(env, repository), Response.json([...known].slice(-1_000), { headers: { 'cache-control': `public, max-age=${TIPS_SECONDS}` } }));
}

/** A fetch request is small, so it is read whole: inflated, as Git compresses it, and only up to REQUEST_BYTES. */
async function requestBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  if (!request.body) throw new HttpError(400, 'Send a Git request.');
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding !== 'gzip' && encoding !== 'identity') throw new HttpError(400, 'Unsupported Git request encoding.');
  const reader = (encoding === 'gzip' ? request.body.pipeThrough(new DecompressionStream('gzip')) : request.body).getReader();
  const chunks: Uint8Array[] = [];
  for (let size = 0; ;) {
    const { value, done } = await reader.read();
    if (done) return concat(chunks);
    size += value.length;
    if (size > REQUEST_BYTES) { await reader.cancel(); throw new HttpError(413, 'This Git request is too large.'); }
    chunks.push(value);
  }
}

/**
 * A public fetch may want only published commits: a pushed revision's commits stay in Artifacts after its hidden ref
 * is gone. Wants the repository just advertised pass at once; any other is checked by the repository's object.
 */
async function authorizeFetch(request: Request, env: BraidEnv, gateway: ChangeGateway, v2: boolean): Promise<Request> {
  const body = await requestBody(request), sections = packets(body);
  const command = v2 && sections[0] instanceof Uint8Array ? decoder.decode(sections[0]).trim() : '';
  if (v2 && command !== 'command=ls-refs' && command !== 'command=fetch') throw new HttpError(400, 'Braid answers ls-refs and fetch.');
  if (!v2 || command === 'command=fetch') {
    const delimiter = v2 ? sections.indexOf(1) : -1;
    if (v2 && delimiter < 0) throw new HttpError(400, 'Incomplete Git fetch request.');
    const args = sections.slice(delimiter + 1);
    if (args.some(item => typeof item === 'number' && item !== 0)) throw new HttpError(400, 'Invalid Git fetch delimiter.');
    const lines = parse(publicGitFetchLines, args.filter(item => item instanceof Uint8Array).map(item => decoder.decode(item)));
    // A ref a fetch names must be one it is shown; Artifacts resolves it as named.
    for (const line of lines) if (/^(?:want-ref|deepen-not) /.test(line)) {
      const ref = line.trim().split(' ')[1];
      if (ref === 'HEAD' || !shown(ref)) throw new HttpError(404, 'Repository revision not found.');
    }
    const wants = [...new Set(lines.filter(line => line.startsWith('want ')).map(line => line.slice(5, 45)))];
    if (!wants.length && !lines.some(line => line.startsWith('want-ref '))) throw new HttpError(400, 'Choose a commit to fetch.');
    const tips = wants.length ? await recalledTips(env, gateway.repository) : new Set<string>();
    const others = wants.filter(want => !tips.has(want));
    if (others.length && !await env.WORKSPACES.getByName(gateway.repository).publicCommits(gateway.repository, others, gateway.publicNetwork))
      throw new HttpError(404, 'Repository revision not found.');
  }
  const headers = new Headers(request.headers);
  headers.delete('content-encoding'); headers.delete('content-length');
  return new Request(request, { headers, body });
}

/**
 * A protocol v2 upload-pack request: `ls-refs` answers with the refs a fetch may see, and `fetch` streams Artifacts'
 * pack straight back. The request is read whole to learn its command.
 */
async function uploadV2(request: Request, env: BraidEnv, gateway: ChangeGateway, repository: RepositoryInfo, source: GitEndpoint): Promise<Response> {
  const done = () => revokeLater(env, repository, source.token);
  try {
    const body = await requestBody(request);
    const [first] = packets(body);
    const command = typeof first === 'number' ? '' : decoder.decode(first).trim();
    if (command !== 'command=ls-refs' && command !== 'command=fetch') throw new HttpError(400, 'Braid answers ls-refs and fetch.');
    const upstream = await artifactsGit(source, 'git-upload-pack', { method: 'POST', body,
      headers: { 'content-type': 'application/x-git-upload-pack-request', accept: 'application/x-git-upload-pack-result', 'git-protocol': 'version=2' } }, 300);
    if (upstream.status !== 200 || !upstream.body) { await upstream.body?.cancel(); throw new HttpError(502, 'Artifacts could not send the history. Retry the fetch.'); }
    if (command === 'command=fetch') {
      const streamed = upstream.body.pipeThrough(new TransformStream({ flush: done }));
      return new Response(streamed, { headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' } });
    }
    const listed = packets(new Uint8Array(await upstream.arrayBuffer()));
    await done();
    const visible = listed.filter(item => typeof item === 'number' || shown(decoder.decode(item).split(' ')[1]?.trim() ?? ''));
    if (gateway.publicViewer) await rememberTips(env, gateway.repository, visible.flatMap(item => typeof item === 'number' ? [] : [decoder.decode(item).slice(0, 40)]));
    return new Response(encodePackets(visible), { headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' } });
  } catch (error) { await done(); throw error; }
}

const advertise = (service: string, refs: [string, string][], capabilities: string) => new Response(new Blob([pktLine(`# service=${service}\n`), FLUSH,
  ...refs.map(([ref, oid], index) => pktLine(`${oid} ${ref}${index ? '' : `\0${capabilities}`}\n`)), FLUSH] as BlobPart[]),
{ headers: { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' } });

async function endpoint(artifacts: ArtifactsRepo, repository: RepositoryInfo, scope: 'read' | 'write', seconds = 300): Promise<GitEndpoint> {
  return { remote: repository.remote, token: (await artifacts.createToken(scope, seconds)).plaintext };
}
/** Revokes a request's token. It expires on its own within minutes, so a failed revocation is harmless. */
const revoke = (artifacts: ArtifactsRepo, token: string) => artifacts.revokeToken(token).catch(() => {});
/** Revokes a token once an answer has streamed, after the request's own handle is gone. */
async function revokeLater(env: BraidEnv, repository: RepositoryInfo, token: string) {
  using artifacts = await artifactsOf(env).get(repository.id);
  await revoke(artifacts, token);
}
/** A request to Artifacts' Git endpoint under the request's token, never following a redirect. */
async function artifactsGit(source: GitEndpoint, path: string, init: Omit<RequestInit, 'headers'> & { duplex?: 'half'; headers?: Record<string, string> }, seconds: number): Promise<Response> {
  try {
    return await fetch(`${source.remote.replace(/\/$/, '')}/${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(seconds * 1000),
      headers: { authorization: authorization(source), 'user-agent': 'Braid', ...init.headers } });
  } catch { throw new HttpError(502, 'Artifacts could not be reached. Retry the fetch.'); }
}

/** Streams Artifacts' answer to a fetch straight back, and revokes the read token once it has been sent. */
async function fetchPack(request: Request, env: BraidEnv, repository: RepositoryInfo, source: GitEndpoint): Promise<Response> {
  const done = () => revokeLater(env, repository, source.token), encoding = request.headers.get('content-encoding');
  try {
    const upstream = await artifactsGit(source, 'git-upload-pack', { method: 'POST', body: request.body, duplex: 'half',
      headers: { 'content-type': 'application/x-git-upload-pack-request', accept: 'application/x-git-upload-pack-result', ...(encoding ? { 'content-encoding': encoding } : {}) } }, 300);
    if (upstream.status !== 200 || !upstream.body) { await upstream.body?.cancel(); throw new HttpError(502, 'Artifacts could not send the history. Retry the fetch.'); }
    return new Response(upstream.body.pipeThrough(new TransformStream({ flush: done })), { headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' } });
  } catch (error) { await done(); throw error; }
}

/**
 * Receives a push: one command for `refs/for/main` (with `%topic=<name>` to revise that topic's change), and
 * optionally `refs/notes/braid` with notes on the pushed commits. Anything else is refused before any pack is kept.
 */
async function push(request: Request, env: BraidEnv, gateway: ChangeGateway, repository: RepositoryInfo, artifacts: ArtifactsRepo, browserBase: string): Promise<Response> {
  if (!request.body) throw new HttpError(400, 'Push a commit to refs/for/main.');
  if (Number(request.headers.get('content-length')) > PUSH_BYTES) { await request.body.cancel(); throw new HttpError(413, PUSH_LIMIT); }
  const { lines, rest } = await readSection(request.body).catch(() => { throw new HttpError(400, 'This is not a complete Git command section.'); });
  // Git probes authentication with a flush-only POST before streaming a large HTTP push.
  if (!lines.length) { await drain(rest); return new Response(null, { headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' } }); }
  const [first = ''] = lines, capabilities = new Set(first.split('\0')[1]?.trim().split(' ') ?? []);
  let commands: Command[];
  try { commands = parse(gitPushCommands, lines); }
  catch (error) { await drain(rest); throw error; }
  const answer = (results: { ref: string; error?: string }[], messages: string[] = []) => report(capabilities.has('side-band-64k'), results, messages);
  // Git shows one reason against every ref the push named; the schema guarantees at least one.
  const fail = (error: string) => answer(commands.map(command => ({ ref: command.ref, error })));
  const refuse = async (reason: string) => { await drain(rest); return fail(reason); };
  const upload = commands.length === 1 ? /^refs\/braid\/uploads\/([A-Za-z0-9._-]{1,64})$/.exec(commands[0].ref) : null;
  if (upload) {
    await checkAuthorization(env, gateway.authorization);
    const source = await endpoint(artifacts, repository, 'write'), ref = `${await uploadPrefix(gateway)}${upload[1]}`;
    let large = false;
    try {
      await checkAuthorization(env, gateway.authorization);
      await receive(source, [{ ...commands[0], ref }], limited(rest, PUSH_BYTES, () => { large = true; }));
      return answer(commands.map(command => ({ ref: command.ref })), ['Git objects uploaded. Push HEAD:refs/for/main to open the pull request.']);
    } catch (error) {
      if (error instanceof HttpError) { await drain(rest); throw error; }
      logFailure('git_upload_failed', error);
      return fail(large ? PUSH_LIMIT : platformRefusal(error) ?? 'Artifacts could not store this upload. Retry with a new upload name.');
    } finally { await revoke(artifacts, source.token); }
  }
  const changes = commands.filter(command => command.ref.startsWith('refs/for/')), notes = commands.find(command => command.ref === NOTES_REF);
  if (commands.some(command => command.new === ZERO)) return refuse('Braid does not delete refs. Push a commit to refs/for/main to open a change.');
  if (commands.some(command => command.ref.startsWith('refs/heads/'))) return refuse(`${repository.branch} only moves through the merge queue. Push to refs/for/${repository.branch} to open a change.`);
  if (changes.length !== 1 || commands.length !== changes.length + (notes ? 1 : 0)) return refuse(`Push one change at a time, to refs/for/${repository.branch}, with ${NOTES_REF} if you have notes.`);
  const target = /^refs\/for\/([^%]+)(?:%(.*))?$/.exec(changes[0].ref);
  if (!target || target[1] !== repository.branch) return refuse(`Changes land on ${repository.branch}: push to refs/for/${repository.branch}.`);
  const options = target[2]?.split(',') ?? [], topic = /^topic=([A-Za-z0-9._-]{1,64})$/.exec(options[0] ?? '')?.[1];
  if (options.length > 1 || (options.length && !topic)) return refuse(`Name a topic as refs/for/${repository.branch}%topic=<name>, in at most 64 letters, digits, dots, dashes and underscores.`);

  const incoming = `refs/braid/incoming/${crypto.randomUUID()}`, tip = changes[0].new;
  const updates = [{ old: ZERO, new: tip, ref: incoming }, ...(notes ? [{ old: ZERO, new: notes.new, ref: `${incoming}-notes` }] : [])];
  await checkAuthorization(env, gateway.authorization);
  const store = await endpoint(artifacts, repository, 'write');
  let large = false, receiving = false;
  try {
    await checkAuthorization(env, gateway.authorization);
    receiving = true;
    await receive(store, updates, limited(rest, PUSH_BYTES, () => { large = true; }));
    const { body, history } = await pushedChange(artifacts, repository, tip, notes?.new);
    const who = actor(gateway), shard = submissionShard(topic ? `${who.id}:topic:${topic}` : `${who.id}:push-${tip}`);
    const result = await changeShardOf(env, gateway.repository, shard).push({ repository: gateway.repository, shard, actor: who, authorization: gateway.authorization }, { ...(topic ? { topic } : {}), commit: tip, history }, body);
    if (!result.ok) return fail(result.error);
    const { number, revision, next } = result.data;
    return answer(commands.map(command => ({ ref: command.ref })), [`Change #${number}${revision > 1 ? `, revision ${revision}` : ''}: ${browserBase}/pull/${number}`, ...(next ? [next] : [])]);
  } catch (error) {
    if (!receiving && error instanceof HttpError) { await drain(rest); throw error; }
    if (large) return fail(PUSH_LIMIT);
    const platform = platformRefusal(error);
    if (platform) return fail(platform);
    if (error instanceof Refused || error instanceof HttpError && error.status === 409) return fail(error.message);
    logFailure('push_failed', error);
    return fail('Braid could not take this push. Retry it.');
  } finally {
    // A failed acknowledgment can still have created refs. Cleanup is another write and requires current access;
    // if it fails, the request's unique refs remain hidden rather than bypassing a revocation to delete them.
    if (receiving) for (const update of updates) {
      try { await checkAuthorization(env, gateway.authorization); await updateRef(store, update.ref, update.new, ZERO); }
      catch (error) { logFailure('git_incoming_cleanup_failed', error); }
    }
    await revoke(artifacts, store.token);
  }
}

/** Git's answer to a push: per-ref results, and with side-band, messages Git prints as `remote:` lines first. */
function report(sideband: boolean, results: { ref: string; error?: string }[], messages: string[]): Response {
  const status = concat([pktLine('unpack ok\n'), ...results.map(result => pktLine(result.error ? `ng ${result.ref} ${result.error.replace(/\s+/g, ' ').trim().slice(0, 300)}\n` : `ok ${result.ref}\n`)), FLUSH]);
  const band = (channel: number, bytes: Uint8Array) => pktLine(concat([new Uint8Array([channel]), bytes]));
  const parts = sideband ? [...messages.map(message => band(2, encoder.encode(`${message}\n`))), band(1, status), FLUSH] : [status];
  return new Response(new Blob(parts as BlobPart[]), { headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' } });
}

/** Reads what a refused push still sends, so Git receives the answer rather than a broken connection. */
async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  for (let size = 0; ;) {
    const { value, done } = await reader.read();
    if (done) return;
    size += value.byteLength;
    if (size > PUSH_BYTES) { await reader.cancel(); return; }
  }
}

/**
 * The change a push proposes, read from the commits Artifacts now holds: its files against the newest commit of
 * main the push is based on, its title and summary from the commit messages, the co-author lines the commits carry,
 * and the model, tool and session from a Braid note on them when the push brought one.
 */
async function pushedChange(artifacts: ArtifactsRepo, repository: RepositoryInfo, tip: string, notes: string | undefined) {
  const main = await artifacts.log({ ref: repository.branch, limit: 1000 });
  const position = new Map(main.map((commit, index) => [commit.hash, index]));
  const pushed: ArtifactsCommitMetadata[] = [], queue = [tip], seen = new Set<string>();
  let base: number | undefined;
  while (queue.length) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const index = position.get(sha);
    if (index !== undefined) { base = Math.min(base ?? index, index); continue; }
    if (pushed.length === PUSH_COMMITS) throw new Refused(`Push at most ${PUSH_COMMITS} commits that ${repository.branch} does not have.`);
    const commit = await artifacts.readCommit(sha);
    if (!commit) throw new Refused(`This push is not based on ${repository.branch}'s history. Fetch ${repository.branch} and rebase onto it.`);
    pushed.push(commit);
    queue.push(...commit.parents);
  }
  if (base === undefined) throw new Refused(`This push is not based on ${repository.branch}'s history. Fetch ${repository.branch} and rebase onto it.`);
  if (!pushed.length) throw new Refused(`${repository.branch} already has this commit, so there is nothing to propose.`);
  const files = await changedFiles(artifacts, main[base].treeHash, pushed[0].treeHash);
  if (!files.length) throw new Refused(`These commits change no files compared with ${repository.branch}.`);
  // Every commit main lacks is scanned on its own, so a fetch or a read by hash never opens a snapshot the tip hides.
  const history = await scanPushedHistory(artifacts, main[base].treeHash, pushed, files);
  // Found from the tip back, so the reverse is oldest first.
  const commits = [...pushed].reverse();
  const subject = (message: string) => message.split('\n', 1)[0].trim();
  const own = withoutTrailers(commits[0].message).split('\n').slice(1).join('\n').trim();
  const summary = commits.length > 1 ? commits.map(commit => `- ${subject(commit.message)}`).join('\n') : own || subject(commits[0].message);
  const seenAuthors = new Set<string>(), coAuthors = commits.flatMap(commit => parseTrailers(commit.message).get('co-authored-by') ?? [])
    .filter(person => {
      if (!v.is(coAuthor, person)) return false;
      const email = parsePerson(person).email!.toLowerCase();
      return !seenAuthors.has(email) && !!seenAuthors.add(email);
    }).slice(0, 5);
  const note = notes ? await noteOn(artifacts, notes, pushed.map(commit => commit.hash)) : null;
  const run = note?.agent ? Object.fromEntries(Object.entries({ tool: note.agent.tool, session: note.agent.session, parentSession: note.agent.parentSession }).filter(([, value]) => value)) : {};
  return { history, body: {
    title: (subject(commits[0].message) || 'Pushed change').slice(0, 120), summary: summary.slice(0, 1200), baseCommit: main[base].hash, files,
    ...(note?.agent?.model ? { model: note.agent.model } : {}), ...(Object.keys(run).length ? { agent: run } : {}), ...(coAuthors.length ? { coAuthors } : {}),
  } };
}

/** Braid's note on the newest pushed commit that has one. */
async function noteOn(artifacts: ArtifactsRepo, notes: string, commits: string[]): Promise<BraidNote | null> {
  // Every commit starts from the same root tree, so each tree is read once.
  const reader = Object.assign(cachedReader(artifacts), { readBlob: (hash: string) => artifacts.readBlob(hash) });
  const unreadable = () => new HttpError(503, 'The pushed notes are not readable yet.');
  const tree = (await reader.readCommit(notes))?.treeHash;
  if (!tree) throw unreadable();
  for (const sha of commits) {
    const note = await readNote(reader, tree, sha, unreadable);
    if (note) return note;
  }
  return null;
}
