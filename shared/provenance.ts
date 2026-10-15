import * as v from 'valibot';
import { modelFromCredit, modelName, toolName } from './models';
import type { Provenance, ProvenanceOwner } from './types';
import { appSlug, isBotLogin } from './people';

/*
 * Agent provenance in Git. The person whose agent it is authors each commit Braid lands, and its message is the
 * change's own: Braid adds nothing to it. What Braid knows (agent id, model, tool, session, fleet, change, task and
 * approver) is one JSON Git note under refs/notes/braid, which hosts store but do not show. History Braid did not
 * land is read from what tools leave in commits: co-author lines, bot authors and generated-with notes.
 */

export const NOTES_REF = 'refs/notes/braid';
export interface CommitFacts { id: string; at: string; author: { name: string; email: string }; message: string }

/* ---------- models ---------- */

// Defined apart so the browser can name agents without Valibot; Git tooling keeps importing them from here.
export { agentKey, modelName, toolBase, toolName } from './models';
/** Stored keys before tuple encoding are accepted only when exactly three parts made them unambiguous. */
export function agentParts(key: string): [string, string, string] {
  return v.parse(v.strictTuple([v.string(), v.string(), v.string()]), key.startsWith('[') ? JSON.parse(key) : key.split('|'));
}
export const canonicalAgentKey = (key: string) => JSON.stringify(agentParts(key));
const ANTHROPIC = 'noreply@anthropic.com';
const AGENT_DOMAIN = '@agents.braid.local';
const emailSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'agent';
/**
 * How a model would co-author a commit: its display name, with Anthropic's no-reply address for Claude models as
 * Claude Code writes it, and a stable `@agents.braid.local` address for others; without a model the tool names it.
 * Braid never adds this line itself. Tools that do are read back by `provenanceOf`.
 */
export function coAuthor(model?: string, tool?: string): { name: string; email: string } {
  const name = model ? modelName(model) : tool ? toolName(tool) : 'Agent';
  const anthropic = model ? /^(?:[\w.-]+\/)*claude/i.test(model) : !!tool && /claude/i.test(tool);
  return { name, email: anthropic ? ANTHROPIC : `${emailSlug(model ?? (tool ? toolName(tool) : 'agent'))}${AGENT_DOMAIN}` };
}

/* ---------- commit messages ---------- */

const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]{0,63}):[ \t]*(.*)$/;
/** Keys trusted even in a last paragraph that also holds prose, as git trusts its own trailers there. */
const KNOWN = new Set(['co-authored-by', 'signed-off-by', 'braid-change', 'braid-task', 'braid-author']);

/** Keep fenced examples out of credits without turning an earlier paragraph into a footer. */
function unquotedMessage(message: string): string {
  message = message.replace(/\r\n?/g, '\n');
  if (!message.includes('```') && !message.includes('~~~')) return message;
  let fence: string | undefined;
  return message.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return '>';
    }
    if (marker) { fence = marker; return '>'; }
    return line;
  }).join('\n');
}

/** Trailers at the end of a commit, including adjacent trailer blocks tools separate with a blank line. */
export function parseTrailers(message: string): Map<string, string[]> {
  const paragraphs = unquotedMessage(message).trim().split(/\n[ \t]*\n/);
  const block = (text: string) => text.split('\n').every((line, index) => TRAILER_LINE.test(line) || (index > 0 && /^[ \t]/.test(line)));
  // The subject is never a trailer block, so "fix: typo" stays a subject.
  if (paragraphs.length < 2) {
    // Some tools omit the separating blank line. Accept only an explicit co-author block after the subject.
    const [subject, ...rest] = paragraphs[0].split('\n'), tail = rest.join('\n');
    if (!/^Co-authored-by:/im.test(tail) || !block(tail)) return new Map();
    paragraphs.splice(0, 1, subject, tail);
  }
  let first = paragraphs.length - 1;
  while (first > 1 && block(paragraphs[first]) && block(paragraphs[first - 1])) first--;
  const lines = paragraphs.slice(first).join('\n').split('\n');
  const all = lines.every((line, index) => TRAILER_LINE.test(line) || (index > 0 && /^[ \t]/.test(line)));
  const trailers = new Map<string, string[]>();
  let last: string[] | undefined;
  for (const line of lines) {
    const match = TRAILER_LINE.exec(line);
    const key = match?.[1].toLowerCase();
    if (match && key && (all || KNOWN.has(key))) {
      last = trailers.get(key) ?? [];
      last.push(match[2].trim());
      trailers.set(key, last);
    } else if (last && /^[ \t]/.test(line)) last[last.length - 1] = `${last[last.length - 1]} ${line.trim()}`;
    else last = undefined;
  }
  return trailers;
}

/** `Name <email>` as a person; a GitHub no-reply address also names the GitHub login. */
export function parsePerson(value: string): ProvenanceOwner {
  const match = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value.trim());
  if (!match) return { name: value.trim() };
  const email = match[2], github = /^(?:\d+\+)?([A-Za-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com$/i.exec(email)?.[1];
  return { name: match[1].trim() || email, email, ...(github ? { github } : {}) };
}

/* ---------- notes ---------- */

const short = (max: number) => v.pipe(v.string(), v.maxLength(max));
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const attributionEntries = {
  kind: v.optional(v.picklist(['agent', 'human', 'bot'])),
  agent: v.optional(v.object({
    id: v.optional(short(200)), name: short(120), model: v.optional(short(120)), tool: v.optional(short(80)),
    session: v.optional(short(80)), parentSession: v.optional(short(80)), fleet: v.optional(short(120)),
  })),
  owner: v.optional(v.object({ name: short(120), github: v.optional(short(39)) })),
};
/** Braid's Git note on a commit it landed, under refs/notes/braid. Unknown keys are ignored, so later versions stay readable. */
const noteSchema = v.object({
  v: v.literal(1),
  ...attributionEntries,
  files: v.optional(v.record(short(240), v.object(attributionEntries))),
  change: v.optional(v.object({ id: short(40), number: count, revision: count })),
  task: v.optional(v.object({ id: short(100), title: v.optional(short(200)) })),
  approvedBy: v.optional(short(400)),
});
export type BraidNote = v.InferOutput<typeof noteSchema>;
const noteText = v.pipe(v.string(), v.parseJson(), noteSchema);
/** A note's text as Braid wrote it, or null when it is not one. */
export function parseNote(text: string): BraidNote | null {
  const result = v.safeParse(noteText, text);
  return result.success ? result.output : null;
}
export const formatNote = (note: BraidNote) => `${JSON.stringify(note)}\n`;

/** A file's chosen proposal replaces the commit byline, without inheriting another agent's owner or run. */
export function fileProvenance(provenance: Provenance, path: string): Provenance {
  const { files, ...commit } = provenance;
  const author = files && Object.hasOwn(files, path) ? files[path] : undefined;
  return author ? { ...commit, kind: author.kind, agent: author.agent, owner: author.owner } : commit;
}

/* ---------- who made a commit ---------- */

/** Coding agents recognised by the identities they commit or co-author as. */
const AGENTS: { name: string; tool: string; login?: RegExp; email?: RegExp; emailName?: RegExp }[] = [
  { name: 'Claude', tool: 'claude-code', login: /^claude\[bot\]$/i, email: /^noreply@anthropic\.com$/i },
  { name: 'Codex', tool: 'codex', login: /^(?:chatgpt-codex-connector|codex)\[bot\]$/i, email: /^codex@openai\.com$/i },
  { name: 'Copilot', tool: 'github-copilot', login: /^(?:copilot-swe-agent|copilot)(?:\[bot\])?$/i },
  { name: 'Copilot Autofix', tool: 'github-copilot', email: /^(?:\d+\+)?github-advanced-security\[bot\]@users\.noreply\.github\.com$/i, emailName: /^Copilot Autofix(?: powered by AI)?$/i },
  { name: 'Cursor', tool: 'cursor', login: /^cursor(?:agent|\[bot\])$/i, email: /^cursoragent@cursor\.com$/i },
  { name: 'Cursor Bugbot', tool: 'cursor-bugbot', email: /^bugbot@cursor\.com$/i },
  { name: 'Devin', tool: 'devin', login: /^devin-ai-integration(?:\[bot\])?$/i },
  { name: 'Jules', tool: 'jules', login: /^google-labs-jules(?:\[bot\])?$/i, email: /^jules@google\.com$/i },
  { name: 'Gemini', tool: 'gemini', login: /^gemini-code-assist(?:\[bot\])?$/i },
  { name: 'Gemini', tool: 'gemini-cli', login: /^gemini-cli$/i },
  { name: 'Sweep', tool: 'sweep', login: /^sweep-ai(?:-deprecated)?\[bot\]$/i },
  { name: 'Amazon Q', tool: 'amazon-q', login: /^amazon-q-developer\[bot\]$/i },
  { name: 'Aider', tool: 'aider', email: /^(?:aider|noreply)@aider\.(?:chat|dev)$/i },
  { name: 'OpenHands', tool: 'openhands', email: /^openhands@all-hands\.dev$/i },
  { name: 'OpenHands', tool: 'openhands', email: /^contact@all-hands\.dev$/i, emailName: /^OpenHands Bot$/i },
];
const GENERATED: { pattern: RegExp; name: string; tool: string }[] = [
  { pattern: /^(?:🤖 )?Generated with (?:Claude Code|\[Claude Code\]\(https:\/\/claude\.(?:ai|com)\/[^\s)]+\))$/i, name: 'Claude', tool: 'claude-code' },
  { pattern: /^(?:🤖 )?Generated (?:with|by) (?:Codex|\[Codex\]\(https:\/\/(?:chatgpt\.com|openai\.com)\/[^\s)]+\))$/i, name: 'Codex', tool: 'codex' },
  { pattern: /^(?:🤖 )?Generated (?:with|by) (?:Cursor|\[Cursor\]\(https:\/\/(?:www\.)?cursor\.com\/?\))$/i, name: 'Cursor', tool: 'cursor' },
  { pattern: /^Generated with \[Devin\]\(https:\/\/devin\.ai\/?\)$/i, name: 'Devin', tool: 'devin' },
];
// Only the source of GitHub's standard PR merge subject is evidence, never a destination branch.
const BRANCH = /^Merge pull request #\d+ from [^\s/:]+[/:](?:[a-z0-9]+-)?(codex|claude|cursor|copilot|devin|jules)\/\S+$/i;
/** Other GitHub Apps by the names people know them by: AI reviewers and fixers, and plain automation. */
const BOTS: Record<string, { name: string; tool?: string; kind?: 'bot' }> = {
  posthog: { name: 'PostHog AI', tool: 'posthog' }, 'posthog-eu': { name: 'PostHog AI', tool: 'posthog' }, 'posthog-us': { name: 'PostHog AI', tool: 'posthog' },
  'seer-by-sentry': { name: 'Sentry Seer', tool: 'sentry' }, sentry: { name: 'Sentry Seer', tool: 'sentry' },
  coderabbitai: { name: 'CodeRabbit' }, 'greptile-apps': { name: 'Greptile' },
  dependabot: { name: 'Dependabot', kind: 'bot' }, 'dependabot-preview': { name: 'Dependabot', tool: 'dependabot[bot]', kind: 'bot' },
  renovate: { name: 'Renovate', kind: 'bot' }, 'github-actions': { name: 'GitHub Actions', kind: 'bot' },
  'release-please': { name: 'Release Please', kind: 'bot' }, 'semantic-release-bot': { name: 'Semantic Release', kind: 'bot' },
  changeset: { name: 'Changesets', kind: 'bot' },
};
const AUTOMATION: Record<string, { name: string; tool: string }> = {
  'bot@renovateapp.com': { name: 'Renovate', tool: 'renovate[bot]' },
  'renovate@whitesourcesoftware.com': { name: 'Renovate', tool: 'renovate[bot]' },
  'gemini-cli-robot@google.com': { name: 'Gemini CLI release bot', tool: 'gemini-cli-robot' },
};
const botLogin = (person: ProvenanceOwner) => [person.github, person.name].find(value => value && isBotLogin(value));
const botApp = (login: string) => {
  const slug = appSlug(login).toLowerCase();
  return Object.hasOwn(BOTS, slug) ? BOTS[slug] : undefined;
};

function knownAgent(person: ProvenanceOwner) {
  const known = AGENTS.find(agent => (person.github && agent.login?.test(person.github)) || (isBotLogin(person.name) && agent.login?.test(person.name)) || (person.email && agent.email?.test(person.email) && (!agent.emailName || agent.emailName.test(person.name))));
  if (known) return known;
  const login = botLogin(person), app = login && botApp(login);
  return app && app.kind !== 'bot' ? { name: app.name, tool: app.tool ?? login! } : undefined;
}
/** Whether a paragraph is one of the footers coding tools add to the commits they write. */
export const generatedFooter = (paragraph: string) => GENERATED.some(sign => sign.pattern.test(paragraph.trim()));
function generatedAgent(message: string) {
  if (!/Generated (?:with|by) /i.test(message)) return undefined;
  const paragraphs = unquotedMessage(message).trim().split(/\n[ \t]*\n/);
  let last = paragraphs.length - 1;
  while (last > 0 && paragraphs[last].split('\n').every(line => TRAILER_LINE.test(line))) last--;
  return last > 0 ? GENERATED.find(sign => sign.pattern.test(paragraphs[last])) : undefined;
}
/** Known coding identities remain agents; other apps and explicit release identities are plain automation. */
function botOf(person: ProvenanceOwner): { name: string; tool: string; kind: 'agent' | 'bot' } | undefined {
  const known = knownAgent(person);
  if (known) return { name: known.name, tool: known.tool, kind: 'agent' };
  const automation = person.email && AUTOMATION[person.email.toLowerCase()];
  if (automation) return { ...automation, kind: 'bot' };
  const login = botLogin(person);
  if (!login) return undefined;
  const bot = botApp(login);
  return { name: bot?.name ?? appSlug(login), tool: bot?.tool ?? login, kind: 'bot' };
}
const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== '')) as T;

/**
 * Who made a commit. A model co-authoring under a known agent address (Anthropic's no-reply address, or Braid's
 * `@agents.braid.local`) is the agent and the commit's author its owner; Braid's note on the commit, when there is
 * one, wins for every detail it has. Then Braid's earlier `Braid-Author` trailer, then the signs coding tools leave.
 * Braid's own records of what it landed outrank all of this with confidence `braid`.
 */
export function provenanceOf(commit: CommitFacts, note?: BraidNote | null): Provenance {
  const trailers = parseTrailers(commit.message);
  const one = (key: string) => trailers.get(key)?.[0] || undefined;
  const base = { commit: commit.id, at: commit.at, subject: commit.message.split('\n', 1)[0].slice(0, 200),
    ...(note?.files ? { files: Object.fromEntries(Object.entries(note.files).map(([path, author]) => [path, {
      kind: author.kind ?? (author.agent ? 'agent' : 'human'),
      ...(author.agent ? { agent: { ...author.agent, name: author.agent.model ? modelName(author.agent.model) : author.agent.name } } : {}),
      ...(author.owner ? { owner: author.owner } : {}),
    }])) } : {}) };
  // Braid's first trailers, kept readable for the history they are in.
  const change = /^#(\d+)\s+((?:ch_[0-9a-f]+|c[0-9]+))$/.exec(one('braid-change') ?? ''), task = /^((?:mission|task|t)[_-][A-Za-z0-9_-]+)(?:\s+(.+))?$/.exec(one('braid-task') ?? '');
  const links = {
    ...(note?.change ? { change: { id: note.change.id, number: note.change.number } } : change ? { change: { id: change[2], number: Number(change[1]) } } : {}),
    ...(note?.task ? { task: defined({ id: note.task.id, title: note.task.title }) } : task ? { task: defined({ id: task[1], title: task[2] }) } : {}),
  };
  const author = parsePerson(`${commit.author.name} <${commit.author.email}>`);
  const aiderAuthor = /^(.+) \(aider\)$/i.exec(author.name);
  // The note names the owner by name and GitHub login; the commit keeps the address when they are the same person.
  const owner = note?.owner ? defined({ ...note.owner, email: note.owner.github && note.owner.github === author.github ? author.email : undefined }) : aiderAuthor ? { ...author, name: aiderAuthor[1] } : author;
  const coAuthors = (trailers.get('co-authored-by') ?? []).map(parsePerson);
  const model = coAuthors.find(person => person.email && (person.email.toLowerCase() === ANTHROPIC || person.email.toLowerCase().endsWith(AGENT_DOMAIN)));
  const people = [...new Map(coAuthors.filter(person => !botOf(person) && !person.email?.toLowerCase().endsWith(AGENT_DOMAIN) && !/ \(aider\)$/i.test(person.name))
    .map(person => [(person.email ?? person.name).toLowerCase(), person])).values()];
  const humanCoAuthor = people.length === 1 ? people[0] : undefined;
  if (note?.kind === 'bot') return { ...base, kind: 'bot', ...(note.agent ? { agent: note.agent } : {}), ...links, confidence: 'trailers' };
  if (note && !note.agent) return { ...base, kind: 'human', owner, ...links, confidence: 'trailers' };
  const legacy = /^(.+?) \((agent|simulated|human|github)(?:, ([^)]+))?\)$/.exec(one('braid-author') ?? '');
  const legacyAgent = legacy && legacy[2] !== 'human' && legacy[2] !== 'github';
  const credits = coAuthors.flatMap(person => {
    const agent = knownAgent(person);
    return agent ? [{ tool: agent.tool, model: modelFromCredit(person.name) }] : [];
  });
  // Squashed work can credit several tools or models. Git cannot say which one wrote each line.
  const ambiguous = !legacyAgent && !model?.email?.toLowerCase().endsWith(AGENT_DOMAIN) && (new Set(credits.map(credit => credit.tool)).size > 1 || new Set(credits.flatMap(credit => credit.model ? [credit.model] : [])).size > 1);
  if (!note && ambiguous) {
    const person = botOf(author) ? humanCoAuthor : owner;
    return { ...base, kind: 'agent', agent: { name: 'Agent' }, ...(person ? { owner: person } : {}), ...links, confidence: 'inferred' };
  }
  if (model || note?.agent) {
    const braid = !!model?.email?.toLowerCase().endsWith(AGENT_DOMAIN);
    const generated = generatedAgent(commit.message);
    const bot = botOf(author);
    const modelId = model && (braid ? model.email!.slice(0, -AGENT_DOMAIN.length) : modelFromCredit(model.name));
    const named = model && !ambiguous ? defined({ name: braid ? modelName(model.name) : modelId ?? 'Claude', model: modelId, tool: generated?.tool ?? (aiderAuthor ? 'aider' : bot?.kind === 'agent' ? bot.tool : undefined) ?? (!braid ? 'claude-code' : undefined) }) : undefined;
    const agent = defined({ ...named, ...note?.agent, name: note?.agent?.model ? modelName(note.agent.model) : note?.agent?.name ?? named!.name });
    // A tool's bot account is not a person. Its human co-author may name the owner; otherwise the owner is unknown.
    const person = note?.owner || !bot ? owner : humanCoAuthor;
    return { ...base, kind: 'agent', agent, ...(person ? { owner: person } : {}), ...links, confidence: note || braid ? 'trailers' : 'inferred' };
  }
  if (legacyAgent) return { ...base, kind: 'agent', agent: defined({ name: legacy[1], model: legacy[3] }), ...links, confidence: 'trailers' };
  const bot = botOf(author);
  const credit = (person: ProvenanceOwner, agent: { name: string; tool: string }) => {
    const model = modelFromCredit(person.name);
    return defined({ name: model ?? agent.name, tool: agent.tool, model });
  };
  const codingAuthor = knownAgent(author);
  if (codingAuthor) return { ...base, kind: 'agent', agent: credit(author, codingAuthor), ...(humanCoAuthor ? { owner: humanCoAuthor } : {}), ...links, confidence: 'inferred' };
  for (const person of coAuthors) {
    const agent = knownAgent(person);
    if (!agent) continue;
    const personOwner = bot ? humanCoAuthor : owner;
    return { ...base, kind: 'agent', agent: credit(person, agent), ...(personOwner ? { owner: personOwner } : {}), ...links, confidence: 'inferred' };
  }
  if (aiderAuthor) return { ...base, kind: 'agent', agent: { name: 'Aider', tool: 'aider' }, owner, ...links, confidence: 'inferred' };
  const personOwner = bot ? humanCoAuthor : owner;
  const generated = generatedAgent(commit.message);
  const branch = BRANCH.exec(base.subject)?.[1].toLowerCase();
  const fromBranch = branch && AGENTS.find(agent => agent.tool.includes(branch) || agent.name.toLowerCase() === branch);
  const coding = generated || fromBranch;
  if (coding) return { ...base, kind: 'agent', agent: { name: coding.name, tool: coding.tool }, ...(personOwner ? { owner: personOwner } : {}), ...links, confidence: 'inferred' };
  if (bot) return { ...base, kind: bot.kind, agent: { name: bot.name, tool: bot.tool }, ...(humanCoAuthor ? { owner: humanCoAuthor } : {}), ...links, confidence: 'inferred' };
  for (const person of coAuthors) {
    const agent = botOf(person);
    if (agent) return { ...base, kind: agent.kind, agent: { name: agent.name, tool: agent.tool }, owner, ...links, confidence: 'inferred' };
  }
  return { ...base, kind: 'human', owner, ...links, confidence: note ? 'trailers' : 'inferred' };
}
