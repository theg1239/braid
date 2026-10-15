import { modelName, NOTES_REF, parseNote, parsePerson, parseTrailers, provenanceOf, type CommitFacts } from '../../shared/provenance';
import { githubLogin } from '../../shared/people';
import { redactEmails } from '../../shared/privacy';
import type { Provenance, ProvenanceOwner } from '../../shared/types';
import type { BraidContext } from './context';
import { noteIndex, readNotes, resolveCommit, streamCommits } from './git';

const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const mappedLogin = (person: ProvenanceOwner) => person.github || githubLogin(person.email ?? '') || githubLogin(person.name);

/** A person as braid prints them: their GitHub login when known, else their name. */
export const personHandle = (value: string) => {
  const login = githubLogin(value);
  return login ? `@${login}` : value;
};
export function personLabel(person?: ProvenanceOwner, logins?: ReadonlySet<string>) {
  if (!person) return '';
  const login = mappedLogin(person) || (LOGIN.test(person.name) && logins?.has(person.name) ? person.name : undefined);
  return redactEmails(login ? `@${login}` : person.name);
}

/** Only a mapped login establishes an alias; display names and similar spellings do not. */
export function personLogins(people: Iterable<ProvenanceOwner | undefined>, history: Iterable<string> = []) {
  const logins = new Set(history);
  for (const person of people) {
    const login = person && mappedLogin(person);
    if (login && LOGIN.test(login)) logins.add(login);
  }
  return logins;
}

/** Read author and real co-author logins throughout this revision's history, retaining only the login set. */
export async function historyLogins(context: BraidContext, root: string, revision = 'HEAD') {
  const logins = new Set<string>();
  for await (const commit of streamCommits(context, root, [resolveCommit(context, root, revision)])) {
    const people = [commit.author, ...(parseTrailers(commit.message).get('co-authored-by') ?? []).map(parsePerson)];
    for (const login of personLogins(people)) logins.add(login);
  }
  return logins;
}

/** An agent by its model's display name, naming the model too when the agent is known by another name, such as a bot. */
export function agentLabel(agent: NonNullable<Provenance['agent']>) {
  const model = agent.model ? modelName(agent.model) : undefined;
  return model && model.toLowerCase() !== agent.name.toLowerCase() && agent.model?.toLowerCase() !== agent.name.toLowerCase() ? `${agent.name} (${model})` : agent.name;
}

/** Who wrote a commit: an agent, a person, or automation by its own name. */
export const authorLabel = (provenance: Provenance, logins?: ReadonlySet<string>) => provenance.kind === 'bot' ? provenance.agent?.name ?? 'Bot' : provenance.agent ? agentLabel(provenance.agent) : personLabel(provenance.owner, logins);
/** Whose work it was, for an agent's commit; a person's own commit needs no second name. */
export const ownerLabel = (provenance: Provenance, logins?: ReadonlySet<string>) => provenance.kind === 'agent' ? personLabel(provenance.owner, logins) : '';
export const changeLabel = (provenance: Provenance) => provenance.change ? `#${provenance.change.number}` : '';

/** Provenance for each commit, reading Braid's notes for all of them in one batch. */
export function provenances(context: BraidContext, root: string, commits: readonly CommitFacts[], index = noteIndex(context, root, NOTES_REF)) {
  const notes = readNotes(context, root, NOTES_REF, commits.map(commit => commit.id), index);
  return commits.map(commit => provenanceOf(canonicalCredits(commit), parseNote(notes.get(commit.id) ?? '')));
}

/** Copilot CLI's official credit is an alias of its bot identity in the shared reader. Git stays untouched. */
function canonicalCredits(commit: CommitFacts): CommitFacts {
  const boundary = commit.message.indexOf('\n');
  return {
    ...commit,
    author: /^copilot@github\.com$/i.test(commit.author.email) ? { ...commit.author, name: 'copilot[bot]' } : commit.author,
    // Keep the subject intact. The shared trailer parser still decides which credits are real, excluding examples.
    message: boundary < 0 ? commit.message : commit.message.slice(0, boundary) + commit.message.slice(boundary).replace(
      /^(Co-authored-by:[\t ]*)[^<>\r\n]*(<copilot@github\.com>)[\t ]*$/gim, '$1copilot[bot] $2',
    ),
  };
}

/**
 * Whether a commit matches `braid log` and `braid agent list` filters, each a case-insensitive part of what it names:
 * the agent's display name, the model's id or display name (an id such as claude-opus-5-5 also matches its display
 * name), and the owner's name, login or address.
 */
export function matches(provenance: Provenance, filters: { agent?: string; model?: string; owner?: string }) {
  const contains = (values: (string | undefined)[], forms: string[]) => values.some(value => value && forms.some(form => value.toLowerCase().includes(form.toLowerCase())));
  const named = (wanted: string) => [wanted, modelName(wanted)];
  const { agent, owner } = provenance;
  return (!filters.agent || (provenance.kind === 'agent' && !!agent && contains([agent.name, agentLabel(agent)], named(filters.agent))))
    && (!filters.model || (provenance.kind === 'agent' && !!agent?.model && contains([agent.model, modelName(agent.model)], named(filters.model))))
    && (!filters.owner || contains([owner?.name, owner?.email, owner?.github ? `@${owner.github}` : undefined], [filters.owner]));
}
