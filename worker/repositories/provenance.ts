import { directoryOf, securityOf, type BraidEnv } from '../env';
import { digest } from '../http/auth';
import { redactEmails } from '../../shared/privacy';
import type { ChangeAuthor, Provenance, ProvenanceOwner } from '../../shared/types';
import { agentParts, modelName, parsePerson, parseTrailers, toolName, type BraidNote } from '../../shared/provenance';

/**
 * How Braid writes who made a change into Git: the person whose agent it is authors the commit and a note under
 * refs/notes/braid says the rest. The message is the change's own; Braid's record of each commit outranks all of it.
 */
export interface GitHubIdentity { id: number; login: string }
/** What Braid records about a change it lands, for its commit, note and provenance. */
export interface LandedChange { changeId: string; number: number; revision: number; title: string; author: ChangeAuthor; fileAuthors?: Record<string, ChangeAuthor>; taskId?: string; approvedBy: string }

/** A person's name as others see it in commits and notes: never their email address. */
export function personName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (/^@[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(trimmed)) return trimmed;
  return redactEmails(trimmed.includes('@') && !trimmed.includes(' ') ? trimmed.split('@')[0] : trimmed).slice(0, 80) || 'Someone';
}
/** How a person reads to others: their @username, or their name. */
export const personHandle = (person: { name: string; username?: string | null }) => person.username ? `@${person.username}` : personName(person.name);
/** The person behind agents and changes, with their GitHub no-reply address only when Braid knows their GitHub id and login. */
export function ownerOf(person: { id: string; name: string; username?: string | null }, github: GitHubIdentity | null, publicId?: string): ProvenanceOwner {
  return { id: `user:${person.id}`, ...(publicId ? { publicId } : {}), name: personHandle(person), ...(github ? { email: `${github.id}+${github.login}@users.noreply.github.com`, github: github.login } : {}) };
}
export const isAgent = (author: ChangeAuthor) => author.kind === 'agent' || author.kind === 'simulated';
/** An agent goes by its model, or its tool when the model is unknown; there are no invented names. */
export const agentName = (model?: string, tool?: string) => model ? modelName(model) : tool ? toolName(tool) : undefined;

export const rosterId = async (key: string) => `roster:${await digest(key)}`;
const people = new WeakMap<BraidEnv, Map<string, Promise<string | undefined>>>();
export function publicPerson(env: BraidEnv, id: string): Promise<string | undefined> {
  let cache = people.get(env);
  if (!cache) { cache = new Map(); people.set(env, cache); }
  const key = id.replace(/^user:/, '');
  let result = cache.get(key);
  if (!result) {
    result = Promise.resolve(directoryOf(env).publicPerson(key));
    if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    // Forget misses and failures, so a person recorded later is found.
    void result.then(value => { if (!value) cache!.delete(key); }, () => cache!.delete(key));
  }
  return result;
}
/** The person behind an agent or a change, with their GitHub identity and public id, read side by side. */
export async function personOwner(env: BraidEnv, person: { id: string; name: string; username?: string | null }): Promise<ProvenanceOwner> {
  const [github, publicId] = await Promise.all([securityOf(env).githubIdentity(person.id), publicPerson(env, person.id)]);
  return ownerOf(person, github, publicId);
}
/** Landing authorship records the person before writing their immutable public attribution. */
export async function publicAuthor(env: BraidEnv, author: ChangeAuthor): Promise<ChangeAuthor> {
  const owner = author.owner;
  if (!owner && (isAgent(author) || author.kind === 'bot')) return author;
  const directory = directoryOf(env);
  return owner ? { ...author, owner: { ...owner, publicId: owner.publicId ?? await directory.recordPerson(owner.id ?? owner.name) } }
    : { ...author, owner: { name: personName(author.name), publicId: await directory.recordPerson(author.id) } };
}
export async function publicRosterId(env: BraidEnv, key: string): Promise<string> {
  const parts = agentParts(key), [model, owner, tool] = parts;
  const person = await publicPerson(env, owner);
  const tuple = [model, person ?? '', tool];
  // Keep established public ids only for tuples that could not collide in the old encoding.
  return rosterId(parts.every(part => !part.includes('|')) ? tuple.join('|') : JSON.stringify(tuple));
}

/** Resolve inferred Git identities on every read, including cached blame, before private addresses leave the server. */
export async function reconcileProvenance(env: BraidEnv, rows: Provenance[]): Promise<Provenance[]> {
  const owners = [...new Map(rows.flatMap(row => row.confidence === 'inferred' && row.owner ? [[JSON.stringify(row.owner), row.owner] as const] : [])).values()];
  if (!owners.length) return rows;
  const resolved = await directoryOf(env).gitPeople(owners);
  const known = new Map(owners.map((owner, index) => [JSON.stringify(owner), resolved[index]]));
  return rows.map(row => row.confidence === 'inferred' && row.owner ? { ...row, owner: known.get(JSON.stringify(row.owner))! } : row);
}

/** The Git author of a landed change: its owner, by their GitHub no-reply address when known and a stable Braid address otherwise. */
export function gitAuthor(author: ChangeAuthor): { name: string; email: string } {
  const owner = author.owner;
  if (owner) return { name: personName(owner.name), email: owner.email ?? `${owner.publicId ?? 'person'}@people.braid.local` };
  if (isAgent(author)) return { name: 'Braid', email: 'agents@braid.local' };
  return { name: personName(author.name), email: 'person@people.braid.local' };
}

/** Whether a message's last paragraph is nothing but trailers, so another one joins it. */
function endsInTrailers(message: string) {
  const paragraphs = message.trim().split(/\n[ \t]*\n/);
  return paragraphs.length > 1 && paragraphs.at(-1)!.split('\n').every(line => /^[A-Za-z0-9][A-Za-z0-9-]{0,63}:[ \t]*\S/.test(line));
}
/** Who made a change, as GitHub readers know them: the model for its owner (`Claude Opus 5.5 for @maya-chen`), or the person. */
export function byline(author: ChangeAuthor): string {
  if (author.kind === 'bot') return author.name;
  const owner = author.owner && (author.owner.github ? `@${author.owner.github}` : author.owner.name);
  if (isAgent(author)) return owner ? `${author.name} for ${owner}` : author.name;
  return owner ?? personName(author.name);
}
/** The byline on GitHub, where `@login` would notify the owner on every merge-queue pull request; a profile link names them quietly. */
export function githubByline(author: ChangeAuthor): string {
  const login = author.owner?.github;
  return login ? byline(author).replace(`@${login}`, `[${login}](https://github.com/${login})`) : byline(author);
}
/** A message without a closing paragraph of trailers, such as its co-author lines. */
export function withoutTrailers(message: string): string {
  const trimmed = message.trim();
  return endsInTrailers(trimmed) ? trimmed.split(/\n[ \t]*\n/).slice(0, -1).join('\n\n') : trimmed;
}
const address = (person: string) => (parsePerson(person).email ?? person).toLowerCase();
/**
 * A landed change's commit message: its title and summary, then the co-author lines its submitted commits carried,
 * verbatim and once each. Braid adds nothing of its own; the model, tool and run are in the note.
 */
export function commitMessage(change: { title: string; summary: string; coAuthors: string[] }): string {
  const body = `${change.title}\n\n${change.summary.slice(0, 1200)}`.trim();
  const seen = new Set((parseTrailers(body).get('co-authored-by') ?? []).map(address));
  const kept = change.coAuthors.filter(person => !seen.has(address(person)) && !!seen.add(address(person)));
  return kept.length ? `${body}${endsInTrailers(body) ? '\n' : '\n\n'}${kept.map(person => `Co-authored-by: ${person}`).join('\n')}` : body;
}

const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== '')) as T;
const agentOf = (author: ChangeAuthor) => defined({ id: redactEmails(author.id).slice(0, 200), name: redactEmails(author.name).slice(0, 120), model: author.model && redactEmails(author.model).slice(0, 120), tool: author.tool && redactEmails(author.tool),
  fleet: author.fleet && redactEmails(author.fleet).slice(0, 120), session: author.session && redactEmails(author.session), parentSession: author.parentSession && redactEmails(author.parentSession) });
const attribution = (author: ChangeAuthor): Pick<Provenance, 'kind' | 'agent' | 'owner'> => ({
  kind: author.kind === 'bot' ? 'bot' : isAgent(author) ? 'agent' : 'human',
  ...(isAgent(author) || author.kind === 'bot' ? { agent: agentOf(author) } : {}),
  ...(author.owner ? { owner: author.owner } : isAgent(author) || author.kind === 'bot' ? {} : { owner: { name: personName(author.name) } }),
});
const noteAuthor = (author: ChangeAuthor) => ({
  ...(author.kind === 'bot' ? { kind: 'bot' as const } : {}),
  ...(isAgent(author) || author.kind === 'bot' ? { agent: agentOf(author) } : {}),
  ...(author.owner ? { owner: defined({ name: personName(author.owner.name), github: author.owner.github }) } : {}),
});
/** The note on a landed commit: what its lines cannot show, from the raw model id to who approved it. */
export function landingNote(change: LandedChange): BraidNote {
  const { author } = change;
  return {
    v: 1,
    ...noteAuthor(author),
    ...(change.fileAuthors ? { files: Object.fromEntries(Object.entries(change.fileAuthors).map(([path, author]) => [path, noteAuthor(author)])) } : {}),
    change: { id: change.changeId, number: change.number, revision: change.revision },
    ...(change.taskId ? { task: { id: change.taskId.slice(0, 100), title: redactEmails(change.title).slice(0, 200) } } : {}),
    approvedBy: redactEmails(change.approvedBy).slice(0, 400),
  };
}
/** What Braid knows about a commit it landed, which outranks anything the commit says about itself. */
export function landedProvenance(commit: string, at: string, change: LandedChange): Provenance {
  return {
    commit, at, subject: change.title.slice(0, 200), ...attribution(change.author),
    ...(change.fileAuthors ? { files: Object.fromEntries(Object.entries(change.fileAuthors).map(([path, author]) => [path, attribution(author)])) } : {}),
    change: { id: change.changeId, number: change.number },
    ...(change.taskId ? { task: { id: change.taskId, title: change.title } } : {}),
    confidence: 'braid',
  };
}
