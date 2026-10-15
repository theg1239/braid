import { artifactsOf, type BraidEnv } from '../env';
import type { AgentRecord, AgentScope, Change, ChangeCounts, ChangePage, ChangeStatus, HotPath, ProvenanceOwner } from '../../shared/types';
import { HttpError, unwrap } from '../errors';
import { jsonBody } from '../http/auth';
import * as v from 'valibot';
import { blameQuery, body, changeCursor, closing, hook, idempotencyKey, instruction, landing, pageCursor, parse, provenanceQuery, review, rosterIdFilter, simulation, stackPage, SUBMISSION_BYTES, SUBMISSION_TOO_LARGE } from '../schemas';
import { IMAGE_CACHE } from './evidence';
import type { Authorization } from '../http/authorization';
import { CHANGE_SHARDS, PATH_SHARDS, byPathShard, changeShardOf, pathShardOf, shardOf, submissionShard, swarmOf, trunkOf } from './names';
import { recordedExample, type DemoDecision, type ExampleState } from './demo';
import type { Workspace } from '../workspace/workspace';
import type { Actor, AgentStats, ChangeContext } from './shard';
import type { Trunk } from './trunk';
import { publicRosterId, reconcileProvenance } from '../repositories/provenance';
import { publicMetadata } from '../http/public-view';
import { readingNames } from '../repositories/repository';
import { approvalWithComment, commentBody } from './comments';
import { agentReportRoute } from '../agents/report-routes';
import { localActivityRoute } from './local-activity-route';
import { cachedPublicRead } from '../http/read-cache';

export interface ChangeGateway {
  /** The repository's Workspace object name; every related object derives its name from it. */
  repository: string;
  mode: 'live' | 'demo';
  role: 'owner' | 'viewer' | 'demo';
  publicViewer?: boolean;
  /** Where a new copy of the recorded example is created: near its visitor. */
  location?: DurableObjectLocationHint;
  /** Gateway-derived network digest; public callers cannot select their cold-build share. */
  publicNetwork?: string;
  /** The signed-in person; `owner` names them in commits when this request creates work. */
  person?: { id: string; name: string; owner?: ProvenanceOwner };
  /** A connected agent: its model when its token names one, the person who owns its work and the fleet that minted it. */
  agent?: { id: string; label: string; scope: AgentScope; model?: string; owner?: ProvenanceOwner; fleet?: string };
  authorization?: Authorization;
}

const STATUSES: ChangeStatus[] = ['open', 'revise', 'attention', 'queued', 'landing', 'landed', 'closed'];
const GROUPS: Record<string, ChangeStatus[]> = { active: ['open', 'revise', 'attention', 'queued', 'landing'], done: ['landed', 'closed'], attention: ['attention'] };

const changeKey = idempotencyKey('Send a unique 16–128 character Idempotency-Key so this change can be retried safely.');
const requestKey = (request: Request) => parse(changeKey, request.headers.get('idempotency-key'));
/** Who a request acts as: an agent with its model, owner and fleet, or a person. */
export function actor(gateway: ChangeGateway): Actor {
  const { agent, person } = gateway;
  if (agent) return { kind: 'agent', id: `agent:${agent.id}`, name: agent.label, ...(agent.model ? { model: agent.model } : {}), ...(agent.owner ? { owner: agent.owner } : {}), ...(agent.fleet ? { fleet: agent.fleet } : {}) };
  if (gateway.role === 'owner') return { kind: 'owner', id: person ? `user:${person.id}` : 'owner', name: person?.name ?? 'Owner', ...(person?.owner ? { owner: person.owner } : {}) };
  return { kind: 'viewer', id: person ? `user:${person.id}` : 'viewer', name: person?.name ?? 'Viewer' };
}
/** A page size from the query string, clamped to what one request serves. */
const size = (fallback: number, max: number) => v.pipe(v.optional(v.string(), String(fallback)), v.transform(Number), v.number('Send a whole number as the limit.'), v.integer('Send a whole number as the limit.'), v.toMinValue(1), v.toMaxValue(max));
/** `GET /api/changes`: a status or group of them, a page cursor and size, and an author or task to narrow to. */
const listQuery = v.object({
  status: v.optional(v.pipe(v.string(), v.transform(value => GROUPS[value] ?? value.split(',')), v.array(v.picklist(STATUSES, 'Unknown change status.')))),
  cursor: v.optional(pageCursor),
  limit: size(50, 100),
  author: v.optional(v.string()),
  task: v.optional(v.string()),
  /** A fleet roster record's id (`AgentRecord.id`): its model, owner and tool. */
  agent: v.optional(v.string()),
});
const revisionNumber = v.optional(v.pipe(v.string(), v.transform(Number), v.number('Invalid revision.'), v.integer('Invalid revision.'), v.minValue(1, 'Invalid revision.')));
/** `GET /api/changes/:id/diff`: one file at the current revision unless another is named, against main or, with `since`, an earlier revision. */
const diffQuery = body({ path: v.optional(v.string(), ''), revision: revisionNumber, since: revisionNumber }, 'Choose a file.');
const guideQuery = v.object({ revision: v.optional(v.pipe(v.string(), v.regex(/^[1-9]\d{0,15}$/, 'Invalid revision.'), v.transform(Number), v.safeInteger('Invalid revision.'))) });
/** `GET /api/changes/:id/compare?since=`: the files that differ between an earlier revision and the current one, or `revision`. */
const compareQuery = body({ since: v.pipe(v.string('Choose a revision to compare with.'), v.transform(Number), v.number('Choose a revision to compare with.'), v.integer('Choose a revision to compare with.'), v.minValue(1, 'Choose a revision to compare with.')), revision: revisionNumber }, 'Choose a revision to compare with.');
const hotQuery = v.object({ limit: size(12, 50) });
const query = <S extends v.GenericSchema>(schema: S, url: URL) => parse(schema, Object.fromEntries(url.searchParams));
/** `/api/changes/:id/evidence/:image`: a screenshot by its hash, which never changes. */
const EVIDENCE_IMAGE = /^\/api\/changes\/([^/]+)\/evidence\/([a-f0-9]{64}\.(?:png|jpg|webp))$/;
const COMMENTS = /^\/api\/changes\/([^/]+)\/comments(?:\/([^/]+)\/(resolve))?$/;
const image = ({ type, bytes }: { type: string; bytes: Uint8Array<ArrayBuffer> }) => new Response(bytes, { headers: { 'content-type': type, 'cache-control': IMAGE_CACHE } });
/** `?paths=a,b` on coordination requests, up to 200 paths. */
const pathsOf = (url: URL) => (url.searchParams.get('paths') ?? '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 200);

type ListQuery = { statuses?: ChangeStatus[]; before?: { updatedAt: string; id: string }; limit: number; author?: string; taskId?: string; agent?: string; publicViewer?: boolean };
export async function listChanges(env: BraidEnv, repository: string, query: ListQuery): Promise<ChangePage> {
  if (!query.publicViewer) return gatherChanges(env, repository, query);
  const queryKey = encodeURIComponent(JSON.stringify([query.statuses, query.before, query.limit, query.author, query.taskId, query.agent]));
  const key = new Request(`https://changes.braid.invalid/${env.BUILD_ID ?? 'dev'}/${encodeURIComponent(repository)}?query=${queryKey}`);
  return (await cachedPublicRead(key, 10, async () => Response.json(await gatherChanges(env, repository, query)))).json();
}
/**
 * The shards worth asking: the queue's record of the ones holding changes, or every shard once for a repository from
 * before the record, whose gather then completes it. A shard a change is being written to has already joined the record
 * by taking its number, so a list never misses one; a shard listed with nothing in it only costs a call.
 */
async function occupiedShards(env: BraidEnv, repository: string): Promise<{ shards: number[]; record: ((occupied: number[]) => Promise<void>) | null }> {
  const trunk = trunkOf(env, repository);
  const known = await trunk.occupiedShards(repository);
  if (known) return { shards: known, record: null };
  return { shards: Array.from({ length: CHANGE_SHARDS }, (_, shard) => shard), record: occupied => trunk.recordShards(repository, occupied) };
}
async function gatherChanges(env: BraidEnv, repository: string, query: ListQuery): Promise<ChangePage> {
  const { before, limit } = query;
  const { shards, record } = await occupiedShards(env, repository);
  const pages = await Promise.all(shards.map(shard => changeShardOf(env, repository, shard).list({ statuses: query.statuses, before, limit, author: query.author, taskId: query.taskId, agent: query.agent })));
  const counts: ChangeCounts = { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 };
  for (const page of pages) for (const status of STATUSES) counts[status] += page.counts[status];
  const items = pages.flatMap(page => page.items).sort((a, b) => a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1).slice(0, limit);
  const [stacks]: [Awaited<ReturnType<Trunk['stackViews']>>, void] = await Promise.all([
    items.length ? trunkOf(env, repository).stackViews(items.map(item => item.id)) : {},
    record?.(shards.filter((_, index) => STATUSES.some(status => pages[index].counts[status] > 0))),
  ]);
  return { items: items.map(item => ({ ...item, ...stacks[item.id] })), nextCursor: items.length === limit ? changeCursor(items[items.length - 1]) : null, counts };
}

export async function hotPaths(env: BraidEnv, repository: string, limit = 12): Promise<HotPath[]> {
  const shards = await Promise.all(Array.from({ length: PATH_SHARDS }, (_, shard) => pathShardOf(env, repository, shard).hot(limit)));
  return shards.flat().sort((a, b) => b.active - a.active || (a.path < b.path ? -1 : 1)).slice(0, limit);
}

/**
 * The fleet roster: one record per agent, which is a model, its owner and its tool, gathered from every change shard,
 * with the lines its landings added and how many are still on main from the landing queue's line maps.
 */
export async function agentRoster(env: BraidEnv, repository: string, readOnly = false, preserveKeys = false): Promise<AgentRecord[]> {
  const [shards, lines] = await Promise.all([
    occupiedShards(env, repository).then(({ shards }) => Promise.all(shards.map(shard => changeShardOf(env, repository, shard).agentStats()))),
    trunkOf(env, repository).agentLines(repository, readOnly, true),
  ]);
  const merged = new Map<string, AgentStats>();
  for (const stats of [...shards.flat(), ...Object.values(lines).flatMap(line => line.contributor ? [line.contributor] : [])]) {
    const known = merged.get(stats.key);
    if (!known) { merged.set(stats.key, stats); continue; }
    const latest = stats.lastActive > known.lastActive ? stats : known;
    merged.set(stats.key, { ...latest, models: [...new Set([...known.models, ...stats.models])], tools: [...new Set([...known.tools, ...stats.tools])],
      firstActive: stats.firstActive < known.firstActive ? stats.firstActive : known.firstActive, sentBack: known.sentBack + stats.sentBack, reverted: known.reverted + stats.reverted,
      authors: [...new Set([...known.authors, ...stats.authors])],
      counts: Object.fromEntries(STATUSES.map(status => [status, (known.counts[status] ?? 0) + (stats.counts[status] ?? 0)])) });
  }
  return (await Promise.all([...merged.values()].map(async (stats): Promise<AgentRecord> => ({
    id: readOnly && !preserveKeys ? await publicRosterId(env, stats.key) : stats.key, name: stats.name, ...(stats.owner ? { owner: stats.owner } : {}), models: stats.models, tools: stats.tools, ...(stats.fleet ? { fleet: stats.fleet } : {}), authors: stats.authors.sort(),
    changes: { landed: stats.counts.landed ?? 0, sentBack: stats.sentBack, reverted: stats.reverted, open: GROUPS.active.reduce((sum, status) => sum + (stats.counts[status] ?? 0), 0) },
    lines: { added: lines[stats.key]?.added ?? 0, alive: lines[stats.key]?.alive ?? 0 }, firstActive: stats.firstActive, lastActive: stats.lastActive,
    ...(stats.kind === 'simulated' ? { simulated: true as const } : {}),
  })))).sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

/**
 * The recorded example: the same read API over a recorded run. A visitor can
 * answer the changes that wait for a person (approve, send back or close);
 * their decisions live in their own demo workspace and their comments in its change shard.
 */
async function demoRoute(request: Request, url: URL, env: BraidEnv, gateway: ChangeGateway): Promise<Response> {
  const path = url.pathname;
  const workspace = env.WORKSPACES.get(env.WORKSPACES.idFromName(gateway.repository), gateway.location ? { locationHint: gateway.location } : undefined) as DurableObjectStub<Workspace>;
  const copy = gateway.repository.startsWith('demo:');
  const [state, example] = await Promise.all([copy ? workspace.exampleState() : { decisions: {}, changes: [] } satisfies ExampleState, recordedExample()]);
  const commentsShard = 0;
  const commentsStore = () => changeShardOf(env, gateway.repository, commentsShard, gateway.location ? { locationHint: gateway.location } : undefined);
  // The shared example is immutable: only a visitor's writable copy can have comment overlays.
  const personal = copy && gateway.role !== 'viewer';
  const withComments = async (change: Change): Promise<Change> => {
    const stored: Record<string, Change['comments']> = personal ? await commentsStore().exampleComments([change.id]) : {};
    const comments = stored[change.id] ?? change.comments ?? [];
    return { ...change, comments, commentCount: comments.length };
  };
  const comment = path.match(COMMENTS);
  if (comment) {
    const change = example.change(comment[1], state);
    if ((request.method === 'GET' || request.method === 'HEAD') && !comment[2]) return Response.json((await withComments(change)).comments);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (!personal) throw new HttpError(403, 'This copy of the example is read-only.');
    const context: ChangeContext = { repository: gateway.repository, shard: commentsShard, actor: { kind: 'owner', id: 'example-visitor', name: 'You' } };
    const raw = await jsonBody(request, 65_536), key = requestKey(request);
    if (comment[2]) return Response.json(unwrap(await commentsStore().resolveConversation(context, change.id, comment[2], raw, key, change)));
    const input = parse(commentBody, raw);
    const diff = input.path ? example.diff(change.id, input.path, { revision: input.revision }, state) : undefined;
    return Response.json(unwrap(await commentsStore().comment(context, change.id, input, key, change, diff)), { status: 201 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const action = path.match(/^\/api\/changes\/([^/]+)\/(approve|reviews|close)$/);
    if (path.endsWith('/revert')) throw new HttpError(409, 'The recorded example cannot change its history. Revert works on your own repositories.');
    if (/^\/api\/instructions(\/|$)/.test(path)) throw new HttpError(409, 'The recorded example keeps its instructions as recorded. Add instructions on your own repositories.');
    if (!action || !copy) throw new HttpError(409, 'This is the recorded example. Sign in and open a repository to submit changes.');
    const change = example.change(action[1], state);
    const body = await jsonBody(request);
    let decision: DemoDecision;
    if (action[2] === 'approve') {
      const input = parse(approvalWithComment, body);
      if (input.revision !== change.revision) throw new HttpError(409, `Approve revision ${change.revision}, the current revision.`);
      if (!['open', 'revise', 'attention'].includes(change.status)) throw new HttpError(409, 'Only open changes can be approved.');
      decision = { action: 'approve', at: Date.now(), revision: change.revision, ...(input.body ? { note: input.body } : {}) };
    } else if (action[2] === 'reviews') {
      const sent = parse(review, body);
      if (sent.verdict !== 'revise') throw new HttpError(409, 'In the recorded example you can approve, send back or close a change.');
      if (sent.revision !== change.revision) throw new HttpError(409, `Review revision ${change.revision}, the current revision.`);
      if (!['open', 'revise', 'attention', 'queued'].includes(change.status)) throw new HttpError(409, 'This change is not accepting reviews.');
      decision = { action: 'send-back', at: Date.now(), revision: change.revision, note: sent.summary };
    } else {
      if (['landed', 'closed'].includes(change.status)) throw new HttpError(409, 'This change is already finished.');
      decision = { action: 'close', at: Date.now(), revision: change.revision, reason: parse(closing, body).reason };
    }
    if (state.changes.some(extra => extra.change.id === change.id)) throw new HttpError(409, 'You already landed this change in its task.');
    const updated = await workspace.recordExampleDecision(change.id, decision);
    return Response.json(await withComments(example.change(change.id, updated)));
  }
  if (path === '/api/changes') {
    const { status, cursor, limit, author, task, agent } = query(listQuery, url);
    const page = example.changes({ statuses: status, before: cursor, limit, author, taskId: task, agent }, state);
    const stored: Record<string, Change['comments']> = personal ? await commentsStore().exampleComments(page.items.map(item => item.id)) : {};
    return Response.json({ ...page, items: page.items.map(item => ({ ...item, commentCount: stored[item.id]?.length ?? item.commentCount ?? 0 })) });
  }
  const guide = path.match(/^\/api\/changes\/([^/]+)\/guide$/);
  if (guide) return Response.json(publicMetadata(example.guide(guide[1], query(guideQuery, url).revision, state), new Set(['path'])), { headers: { 'cache-control': 'private, no-store' } });
  const compared = path.match(/^\/api\/changes\/([^/]+)\/compare$/);
  if (compared) {
    const { since, revision } = query(compareQuery, url);
    return Response.json(example.compare(compared[1], since, revision, state));
  }
  const evidence = path.match(EVIDENCE_IMAGE);
  if (evidence) return image(example.image(evidence[1], evidence[2], state));
  const match = path.match(/^\/api\/changes\/([^/]+)(\/diff)?$/);
  if (match && !match[2]) return Response.json(await withComments(example.change(match[1], state)));
  if (match) {
    const { path: file, revision, since } = query(diffQuery, url);
    return Response.json(example.diff(match[1], file, { revision, since }, state));
  }
  if (path === '/api/queue') return Response.json(example.queue(state));
  if (path === '/api/coordination/hot') return Response.json(example.hot(state));
  if (path === '/api/coordination') return Response.json(example.touching(pathsOf(url), state));
  if (path === '/api/policy') return Response.json(example.policy(state));
  if (path === '/api/instructions') return Response.json(example.instructions(state));
  if (path === '/api/hooks') return Response.json(null);
  if (path === '/api/swarm') return Response.json(example.swarm(state));
  if (path === '/api/blame') {
    const { path: file, ref } = query(blameQuery, url);
    return Response.json(publicMetadata(example.blame(file, state, ref)));
  }
  if (path === '/api/provenance') return Response.json(publicMetadata(example.provenance(query(provenanceQuery, url).commits, state)));
  if (path === '/api/agents') return Response.json(example.agents(state));
  throw new HttpError(404, 'Endpoint not found.');
}

/** Routes the change, queue, coordination, policy and instructions API. Returns null for other paths. */
export async function changesRoute(request: Request, env: BraidEnv, gateway: ChangeGateway): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/local-activity') return localActivityRoute(request, env, gateway);
  if (/^\/api\/agent-reports(?:\/|$)/.test(path)) return agentReportRoute(request, env, gateway);
  if (!/^\/api\/(changes|queue|coordination|policy|swarm|hooks|instructions)(\/|$)/.test(path) && !['/api/blame', '/api/provenance', '/api/agents'].includes(path)) return null;
  const write = request.method !== 'GET' && request.method !== 'HEAD';
  if (gateway.mode !== 'live') return demoRoute(request, url, env, gateway);
  if (write && gateway.role !== 'owner') throw new HttpError(403, 'Only owners and their connected agents can change this repository.');
  const repository = gateway.repository;
  const who = actor(gateway);
  const trunk = trunkOf(env, repository);
  const shardFor = (shard: number) => changeShardOf(env, repository, shard);
  const context = (shard: number): ChangeContext => ({ repository, shard, actor: who, authorization: gateway.authorization });
  const submissionKey = () => { const key = requestKey(request); return { key, shard: submissionShard(`${who.id}:${key}`) }; };
  const personOnly = (refusal: string) => { if (gateway.agent) throw new HttpError(403, refusal); };
  /** A change's shard: its id names it, and a number is looked up in the landing queue's block directory. */
  const shardOfChange = async (reference: string) => {
    const shard = shardOf(reference) ?? (/^[1-9]\d{0,12}$/.test(reference) ? await trunk.shardForNumber(Number(reference)) : null);
    if (shard === null) throw new HttpError(404, 'Change not found.');
    return shard;
  };

  const comment = path.match(COMMENTS);
  if (comment) {
    const shard = await shardOfChange(comment[1]), stub = shardFor(shard);
    if ((request.method === 'GET' || request.method === 'HEAD') && !comment[2]) return Response.json(unwrap(await stub.get(comment[1], gateway.publicViewer)).comments ?? []);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (gateway.agent && gateway.agent.scope !== 'work') throw new HttpError(403, 'A work connection is required to reply.');
    const raw = await jsonBody(request, 65_536), key = requestKey(request);
    if (comment[2]) return Response.json(unwrap(await stub.resolveConversation(context(shard), comment[1], comment[2], raw, key)));
    return Response.json(unwrap(await stub.comment(context(shard), comment[1], raw, key)), { status: 201 });
  }

  if (path === '/api/changes' && request.method === 'GET') {
    const { status, cursor, limit, author, task, agent } = query(listQuery, url);
    if (gateway.publicViewer && agent) parse(rosterIdFilter, agent);
    const publicAuthor = gateway.publicViewer && author ? parse(rosterIdFilter, author) : undefined;
    let selectedAgent = publicAuthor ?? agent;
    if (gateway.publicViewer && selectedAgent) {
      const records = await agentRoster(env, repository, true, true);
      const identities = await Promise.all(records.map(async record => ({ key: record.id, id: await publicRosterId(env, record.id) })));
      selectedAgent = identities.find(record => record.id === selectedAgent)?.key ?? '\0';
    }
    return Response.json(await listChanges(env, repository, { statuses: status, before: cursor, limit, author: publicAuthor ? undefined : author === 'me' ? who.id : author, taskId: task, agent: selectedAgent, publicViewer: gateway.publicViewer }));
  }
  if (path === '/api/changes' && request.method === 'POST') {
    const { key, shard } = submissionKey();
    return Response.json(unwrap(await shardFor(shard).submit(context(shard), await jsonBody(request, SUBMISSION_BYTES, SUBMISSION_TOO_LARGE), key)), { status: 201 });
  }
  if (path === '/api/changes/checkout' && request.method === 'POST') {
    // A ten-minute read-only token for cloning or fetching trunk.
    const info = await env.WORKSPACES.getByName(repository).repository();
    if (!info) throw new HttpError(409, 'Create or import a live repository first.');
    using repo = readingNames(await artifactsOf(env).get(info.id), info);
    const head = (await repo.log({ ref: info.branch, limit: 1 }))[0]?.hash;
    if (!head) throw new HttpError(409, 'Trunk is still preparing. Retry shortly.');
    const token = await repo.createToken('read', 600);
    return Response.json({ remote: info.remote, token: token.plaintext.split('?expires=')[0], expiresAt: token.expiresAt, branch: info.branch, head });
  }
  const evidence = path.match(EVIDENCE_IMAGE);
  if (evidence && request.method === 'GET') {
    return image(unwrap(await shardFor(await shardOfChange(evidence[1])).image(evidence[1], evidence[2], gateway.publicViewer)));
  }
  const match = path.match(/^\/api\/changes\/([^/]+)(?:\/(diff|compare|guide|revisions|reviews|approve|close|revert|restack))?$/);
  if (match) {
    const shard = await shardOfChange(match[1]);
    const stub = shardFor(shard);
    if (match[2] === 'guide' && (request.method === 'GET' || request.method === 'HEAD')) {
      return Response.json(unwrap(await stub.guide(match[1], query(guideQuery, url).revision, gateway.publicViewer)), { headers: { 'cache-control': 'private, no-store' } });
    }
    if (!match[2] && request.method === 'GET') {
      // A public viewer sees CI and GitHub checks only when the linked GitHub repository is public too.
      const [found, publicChecks] = await Promise.all([stub.get(match[1], gateway.publicViewer), !gateway.publicViewer || trunk.publicChecks()]);
      const change = unwrap(found);
      if (!publicChecks) change.checks = change.checks.filter(check => !['ci', 'github'].includes(check.source ?? ''));
      return Response.json(change);
    }
    if (match[2] === 'diff' && request.method === 'GET') {
      const { path: file, revision, since } = query(diffQuery, url);
      return Response.json(unwrap(await stub.diff(repository, match[1], file, revision, since, gateway.publicViewer, gateway.publicNetwork)));
    }
    if (match[2] === 'compare' && request.method === 'GET') {
      const { since, revision } = query(compareQuery, url);
      return Response.json(unwrap(await stub.compare(repository, match[1], since, revision, gateway.publicViewer, gateway.publicNetwork)));
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (match[2] === 'revisions') return Response.json(unwrap(await stub.revise(context(shard), match[1], await jsonBody(request, SUBMISSION_BYTES, SUBMISSION_TOO_LARGE), requestKey(request))));
    if (match[2] === 'restack') {
      if (gateway.agent && gateway.agent.scope !== 'work') throw new HttpError(403, 'A work connection is required to restack.');
      return Response.json(unwrap(await stub.restack(context(shard), match[1], await jsonBody(request), requestKey(request))));
    }
    if (match[2] === 'revert') return Response.json(unwrap(await stub.revert(context(shard), match[1], requestKey(request))), { status: 201 });
    const body = await jsonBody(request, 65_536);
    const key = request.headers.has('idempotency-key') ? requestKey(request) : undefined;
    if (match[2] === 'reviews') return Response.json(unwrap(await stub.review(context(shard), match[1], body, key)));
    if (match[2] === 'approve') {
      personOnly('Agents cannot approve changes; a person approves.');
      return Response.json(unwrap(await stub.approve(context(shard), match[1], body, key)));
    }
    if (match[2] === 'close') return Response.json(unwrap(await stub.close(context(shard), match[1], body)));
  }
  if (path === '/api/queue' && request.method === 'GET') return Response.json(await trunk.status(repository, gateway.publicViewer, query(stackPage, url).stackCursor));
  if (path === '/api/queue/landing' && request.method === 'POST') {
    personOnly('Only a person can enable autonomous landing.');
    const { enabled } = parse(landing, await jsonBody(request));
    return Response.json(await trunk.configure(repository, { enabled, ...(gateway.authorization ? { authorization: gateway.authorization } : {}), actor: who.name }));
  }
  if (path === '/api/policy' && request.method === 'GET') return Response.json(gateway.publicViewer ? unwrap(await trunk.publicPolicy(repository, gateway.publicNetwork)) : await trunk.policy(repository));
  if (path === '/api/instructions' && request.method === 'GET') return Response.json(gateway.publicViewer ? unwrap(await trunk.publicInstructions(repository, gateway.publicNetwork)) : await trunk.instructions(repository));
  const instructions = path.match(/^\/api\/instructions(?:\/([a-z0-9-]{1,40}))?$/);
  if (instructions && write) {
    // A person gives every agent its instructions, through a change of their own that lands under the repository's rules.
    personOnly('Only a person can change the instructions every agent follows.');
    const { key, shard } = submissionKey();
    if (request.method === 'POST' && !instructions[1]) return Response.json(unwrap(await shardFor(shard).instruct(context(shard), { add: parse(instruction, await jsonBody(request)) }, key)), { status: 201 });
    if (request.method === 'DELETE' && instructions[1]) return Response.json(unwrap(await shardFor(shard).instruct(context(shard), { remove: instructions[1] }, key)), { status: 201 });
    throw new HttpError(405, 'Method not allowed.');
  }
  if (path === '/api/hooks') {
    // The webhook to the repository's CI: only owners see or change it, and its secret is never returned.
    if (gateway.role !== 'owner' || gateway.agent) throw new HttpError(403, 'Only an owner can manage webhooks.');
    if (request.method === 'GET') return Response.json(await trunk.hook(repository));
    if (request.method === 'DELETE') { await trunk.deleteHook(repository); return Response.json(null); }
    if (request.method === 'PUT') return Response.json(unwrap(await trunk.setHook(repository, { ...parse(hook, await jsonBody(request)), actor: who.name, origin: url.origin })));
    throw new HttpError(405, 'Method not allowed.');
  }
  if (path === '/api/coordination' && request.method === 'GET') {
    const paths = pathsOf(url);
    if (!paths.length) throw new HttpError(400, 'List the paths to check, separated by commas.');
    const results = await Promise.all([...byPathShard(paths)].map(([shard, group]) => pathShardOf(env, repository, shard).touching(group)));
    return Response.json(Object.assign({}, ...results));
  }
  if (path === '/api/coordination/hot' && request.method === 'GET') return Response.json(await hotPaths(env, repository, query(hotQuery, url).limit));
  // Who wrote what: blame for one file on main, provenance for commits, and the fleet roster.
  if (path === '/api/blame' && request.method === 'GET') {
    const { path: file, ref } = query(blameQuery, url);
    const blame = unwrap(await trunk.blame(repository, file, ref, gateway.publicViewer, gateway.publicNetwork));
    const rows = await reconcileProvenance(env, blame.ranges.map(range => range.provenance));
    return Response.json(publicMetadata({ ...blame, ranges: blame.ranges.map((range, index) => ({ ...range, provenance: rows[index] })) }));
  }
  if (path === '/api/provenance' && request.method === 'GET') {
    const commits = query(provenanceQuery, url).commits;
    if (gateway.publicViewer && commits.length > 20) throw new HttpError(400, 'Public provenance reads accept up to 20 commits.');
    return Response.json(publicMetadata(await reconcileProvenance(env, await trunk.provenance(repository, commits, gateway.publicViewer))));
  }
  if (path === '/api/agents' && request.method === 'GET') return Response.json(await agentRoster(env, repository, gateway.publicViewer));
  if (path.startsWith('/api/swarm')) {
    const swarm = swarmOf(env, repository);
    if (path === '/api/swarm' && request.method === 'GET') return Response.json(await swarm.status());
    personOnly('Only a person can start or stop a simulation.');
    if (path === '/api/swarm' && request.method === 'POST') return Response.json(unwrap(await swarm.start(repository, parse(simulation, await jsonBody(request)), who.name, who.owner)), { status: 202 });
    if (path === '/api/swarm/stop' && request.method === 'POST') return Response.json(await swarm.stop(who.name));
  }
  throw new HttpError(404, 'Endpoint not found.');
}
