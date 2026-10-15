import * as v from 'valibot';
import { directoryOf, securityOf, type BraidEnv } from '../env';
import type { Authorization } from '../http/authorization';
import { cachedRepositoryToken, canPush, canRead, githubApi } from './client';
import { HttpError, logFailure, shown } from '../errors';
import { parseFrom } from '../schemas';
import type { GitEndpoint } from '../git/transport';
import type { CommitFacts } from '../../shared/provenance';
import { plural } from '../../shared/labels';
import { appSlug, isBotLogin } from '../../shared/people';

/**
 * How a Braid repository relates to its GitHub counterpart.
 * `pull-requests`: GitHub stays the source of truth. Braid lands each batch
 * through a pull request, so branch protection, required checks, CODEOWNERS and
 * installed review apps all apply. `mirror`: Braid's trunk is the source of
 * truth and every landing is pushed to GitHub's default branch.
 */
export interface GitHubLink {
  installationId: number; repositoryId: number; fullName: string; defaultBranch: string;
  mode: 'pull-requests' | 'mirror';
  linkedBy: string; linkedAt: string;
  /** The Braid account whose own GitHub push access Braid's writes rely on; links made before it rely on `authorization`. */
  pusher?: string;
  /** Last visibility confirmed with GitHub; absent legacy links are withheld from public views. */
  private?: boolean;
  authorization?: Authorization;
  /** The commit Artifacts was imported at without history, if any; sent as a shallow boundary when fetching. */
  shallowRoot?: string;
}
interface GitHubCheck { name: string; app?: string; status: 'pending' | 'passed' | 'failed'; conclusion?: string; url?: string; summary?: string }
interface GitHubReview { reviewer: string; bot: boolean; state: 'approved' | 'changes_requested' | 'commented'; body: string; submittedAt: string; comments: { path: string; line?: number; body: string }[] }
export interface GitHubGate {
  state: 'pending' | 'passed' | 'failed' | 'blocked' | 'merged' | 'closed' | 'stale';
  reason: string; checks: GitHubCheck[]; reviews: GitHubReview[]; mergeableState?: string; mergeCommit?: string;
  /** Requested reviewers that had not reviewed when the wait ran out. */
  missing?: string[];
}

/** The fields of GitHub's answers that Braid reads, nullable where GitHub documents them so. */
const createdPull = v.object({ number: v.number(), html_url: v.string() });
const mergeResult = v.object({ merged: v.boolean(), sha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)) });
const pullState = v.object({ state: v.string(), merged: v.boolean(), merge_commit_sha: v.nullable(v.string()), mergeable_state: v.optional(v.string()), head: v.object({ sha: v.string() }) });
const checkRuns = v.object({ check_runs: v.array(v.object({
  name: v.string(), status: v.string(), conclusion: v.nullable(v.string()), html_url: v.nullish(v.string()),
  app: v.nullish(v.object({ slug: v.nullish(v.string()) })), output: v.nullish(v.object({ title: v.nullish(v.string()), summary: v.nullish(v.string()) })),
})) });
const combinedStatus = v.object({ statuses: v.array(v.object({ context: v.string(), state: v.string(), description: v.nullish(v.string()), target_url: v.nullish(v.string()) })) });
const pullReviews = v.array(v.object({ user: v.nullable(v.object({ login: v.string(), type: v.optional(v.string()) })), state: v.string(), body: v.nullable(v.string()), submitted_at: v.optional(v.string(), ''), commit_id: v.nullable(v.string()) }));
const reviewComments = v.array(v.object({ user: v.nullable(v.object({ login: v.string() })), path: v.string(), line: v.nullish(v.number()), original_line: v.nullish(v.number()), body: v.string() }));
const UNEXPECTED = 'GitHub returned an unexpected answer.';
/** GitHub's blame of one file at one commit, from its GraphQL API: `object` is null when GitHub does not have the commit. */
const blameAnswer = v.object({ data: v.nullish(v.object({ repository: v.nullable(v.object({ object: v.nullable(v.object({ blame: v.optional(v.object({ ranges: v.array(v.object({
  startingLine: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), endingLine: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  commit: v.object({ oid: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)), message: v.string(), committedDate: v.string(), author: v.nullable(v.object({ name: v.nullable(v.string()), email: v.nullable(v.string()) })) }),
})) })) })) })) })) });
const BLAME_QUERY = 'query($owner: String!, $name: String!, $oid: GitObjectID!, $path: String!) { repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { blame(path: $path) { ranges { startingLine endingLine commit { oid message committedDate author { name email } } } } } } } }';

/**
 * The App's installation outlives a person's access. Before every use, including a cached token, ask GitHub with
 * the linking person's own authorization whether they may still read the repository or push to it.
 */
async function requirePersonAccess(env: BraidEnv, link: Pick<GitHubLink, 'repositoryId' | 'fullName' | 'pusher' | 'authorization'>, write: boolean) {
  const action = write ? 'push to' : 'read';
  const user = link.pusher ?? link.authorization?.user.id;
  if (!user) throw new HttpError(403, `Link ${link.fullName} again so Braid can confirm who may ${action} it.`);
  if (link.authorization) {
    const owner = link.authorization;
    const allowed = await directoryOf(env).access(owner.user, owner.workspaceId, true);
    if (!allowed.ok || allowed.data.teamId !== owner.teamId)
      throw new HttpError(403, 'The owner who linked this GitHub repository no longer has repository access.');
  }
  const access = await securityOf(env).githubAccessToken(user);
  if (!access.ok) throw new HttpError(409, `Reconnect GitHub to keep ${write ? 'writing to' : 'reading'} ${link.fullName}.`);
  // GitHub answers 403 or 404 when the person can no longer see the repository at all.
  const answer = await githubApi(`/repositories/${link.repositoryId}`, access.token).catch((error: unknown) => { if (error instanceof HttpError && error.status === 403) return null; throw error; });
  if (!(write ? canPush(answer, link.repositoryId) : canRead(answer, link.repositoryId))) throw new HttpError(403, `The person who linked ${link.fullName} can no longer ${action} it on GitHub.`);
}
/** A token scoped to the linked repository and the permissions landing needs, for a person who may still use it. */
export async function installationToken(env: BraidEnv, link: Pick<GitHubLink, 'installationId' | 'repositoryId' | 'fullName' | 'pusher' | 'authorization'>, write: boolean): Promise<string> {
  await requirePersonAccess(env, link, write);
  return write
    ? cachedRepositoryToken(env, link.installationId, link.repositoryId, { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read' },
      'Braid’s GitHub App needs read and write access to contents and pull requests. Add them to the app on GitHub, then accept them for this account.')
    : cachedRepositoryToken(env, link.installationId, link.repositoryId, { contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' },
      'Braid’s GitHub App needs read access to pull requests, checks and statuses. Add them to the app on GitHub, then accept them for this account.');
}
export async function githubEndpoint(env: BraidEnv, link: GitHubLink, write: boolean): Promise<GitEndpoint> {
  return { remote: `https://github.com/${link.fullName}.git`, token: await installationToken(env, link, write), username: 'x-access-token' };
}

export async function openPullRequest(env: BraidEnv, link: GitHubLink, input: { branch: string; title: string; body: string }) {
  const token = await installationToken(env, link, true);
  const pull = parseFrom(createdPull, await githubApi(`/repos/${link.fullName}/pulls`, token, {
    method: 'POST', body: { title: input.title.slice(0, 250), head: input.branch, base: link.defaultBranch, body: input.body.slice(0, 60_000), maintainer_can_modify: false },
  }), UNEXPECTED);
  return { number: pull.number, url: pull.html_url };
}

/**
 * Who last changed each line of a file at a commit, as GitHub's blame says: ranges of lines with the commit that wrote
 * them. Null when GitHub does not have the commit or the file.
 */
export async function githubBlame(env: BraidEnv, link: GitHubLink, oid: string, path: string): Promise<{ start: number; end: number; commit: CommitFacts }[] | null> {
  const token = await installationToken(env, link, false);
  const [owner, name] = link.fullName.split('/');
  const answer = parseFrom(blameAnswer, await githubApi('/graphql', token, { method: 'POST', body: { query: BLAME_QUERY, variables: { owner, name, oid, path } } }), UNEXPECTED);
  const ranges = answer.data?.repository?.object?.blame?.ranges;
  return ranges?.length ? ranges.map(range => ({ start: range.startingLine, end: range.endingLine,
    commit: { id: range.commit.oid, at: range.commit.committedDate, author: { name: range.commit.author?.name ?? '', email: range.commit.author?.email ?? '' }, message: range.commit.message } })) : null;
}

/** Names of the checks that failed on a commit, such as main before a batch. */
export async function failedChecks(env: BraidEnv, link: GitHubLink, sha: string): Promise<string[]> {
  const token = await installationToken(env, link, false);
  const runs = parseFrom(checkRuns, await githubApi(`/repos/${link.fullName}/commits/${sha}/check-runs?per_page=100`, token), UNEXPECTED);
  return runs.check_runs.filter(run => run.status === 'completed' && FAILED.has(run.conclusion ?? '')).map(run => run.name);
}

/** Asks review apps or people to review a pull request; returns why GitHub refused, or null. */
export async function requestReviewers(env: BraidEnv, link: GitHubLink, number: number, reviewers: string[]): Promise<string | null> {
  if (!reviewers.length) return null;
  const token = await installationToken(env, link, true);
  try { await githubApi(`/repos/${link.fullName}/pulls/${number}/requested_reviewers`, token, { method: 'POST', body: { reviewers } }); return null; }
  catch (error) { return shown(error, 'GitHub refused the review request.'); }
}

export async function closePullRequest(env: BraidEnv, link: GitHubLink, number: number, comment: string) {
  const token = await installationToken(env, link, true);
  // Closing matters more than the comment that explains it.
  await githubApi(`/repos/${link.fullName}/issues/${number}/comments`, token, { method: 'POST', body: { body: comment.slice(0, 60_000) } })
    .catch(error => logFailure('github_comment_failed', error, { repositoryId: link.repositoryId, pull: number }));
  await githubApi(`/repos/${link.fullName}/pulls/${number}`, token, { method: 'PATCH', body: { state: 'closed' } });
}

/** Merges with a merge commit, so every change commit stays in GitHub's history with its provenance. */
export async function mergePullRequest(env: BraidEnv, link: GitHubLink, number: number, sha: string, title: string): Promise<string> {
  const token = await installationToken(env, link, true);
  const result = v.safeParse(mergeResult, await githubApi(`/repos/${link.fullName}/pulls/${number}/merge`, token, { method: 'PUT', body: { merge_method: 'merge', sha, commit_title: title.slice(0, 250) } }));
  if (!result.success || !result.output.merged) throw new HttpError(409, 'GitHub did not merge the landing pull request.');
  return result.output.sha;
}

// A cancelled or timed-out run is missing evidence, never a pass. Neutral and
// skipped conclusions pass as GitHub's branch protection treats them, but are
// recorded as warnings because review apps report findings as neutral.
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/**
 * Reads GitHub's own verdict on a landing pull request: required and optional
 * checks, commit statuses, reviews from people and review apps, and branch
 * protection through mergeability. `blocked` means GitHub requires something
 * Braid cannot supply, such as a CODEOWNERS approval.
 */
export async function pullRequestGate(env: BraidEnv, link: GitHubLink, number: number, sha: string, openedAt: number, expect: { reviewers: string[]; waitMs: number }): Promise<GitHubGate> {
  const token = await installationToken(env, link, false);
  const repo = `/repos/${link.fullName}`;
  const read = <S extends v.GenericSchema>(schema: S, path: string) => githubApi(path, token).then(answer => parseFrom(schema, answer, UNEXPECTED));
  const [pull, runs, combined, reviews, comments] = await Promise.all([
    read(pullState, `${repo}/pulls/${number}`), read(checkRuns, `${repo}/commits/${sha}/check-runs?per_page=100`), read(combinedStatus, `${repo}/commits/${sha}/status`),
    read(pullReviews, `${repo}/pulls/${number}/reviews?per_page=100`), read(reviewComments, `${repo}/pulls/${number}/comments?per_page=100`),
  ]);
  const checks: GitHubCheck[] = [
    ...runs.check_runs.map(run => ({ name: run.name, ...(run.app?.slug ? { app: run.app.slug } : {}), status: run.status !== 'completed' ? 'pending' as const : FAILED.has(run.conclusion ?? '') ? 'failed' as const : 'passed' as const,
      ...(run.conclusion ? { conclusion: run.conclusion } : {}), ...(run.html_url ? { url: run.html_url } : {}), summary: [run.output?.title, run.output?.summary].filter(Boolean).join(' — ').slice(0, 1500) })),
    ...combined.statuses.map(status => ({ name: status.context, status: status.state === 'pending' ? 'pending' as const : status.state === 'success' ? 'passed' as const : 'failed' as const,
      conclusion: status.state, ...(status.target_url ? { url: status.target_url } : {}), summary: (status.description ?? '').slice(0, 500) })),
  ];
  // The latest review from each reviewer on the landing commit counts.
  const latest = new Map<string, GitHubReview>();
  for (const { user, ...review } of reviews.filter(review => review.commit_id === sha)) {
    const state = review.state === 'APPROVED' ? 'approved' : review.state === 'CHANGES_REQUESTED' ? 'changes_requested' : review.state === 'COMMENTED' ? 'commented' : null;
    if (!state || !user) continue;
    latest.set(user.login, { reviewer: user.login, bot: user.type === 'Bot' || isBotLogin(user.login), state, body: (review.body ?? '').slice(0, 4000), submittedAt: review.submitted_at, comments: [] });
  }
  for (const comment of comments) {
    const review = comment.user ? latest.get(comment.user.login) : undefined;
    const line = comment.line ?? comment.original_line;
    if (review && review.comments.length < 50) review.comments.push({ path: comment.path, ...(line ? { line } : {}), body: comment.body.slice(0, 2000) });
  }
  const gate = (state: GitHubGate['state'], reason: string): GitHubGate => ({ state, reason, checks, reviews: [...latest.values()], ...(pull.mergeable_state ? { mergeableState: pull.mergeable_state } : {}) });
  if (pull.merged) return { ...gate('merged', 'The landing pull request was merged on GitHub.'), ...(pull.merge_commit_sha ? { mergeCommit: pull.merge_commit_sha } : {}) };
  if (pull.state === 'closed') return gate('closed', 'Someone closed the landing pull request on GitHub.');
  if (pull.head.sha !== sha) return gate('stale', 'The landing branch changed on GitHub.');
  const failed = checks.filter(check => check.status === 'failed');
  if (failed.length) return gate('failed', `GitHub checks failed: ${failed.map(check => check.name).join(', ')}.`);
  const requested = [...latest.values()].filter(review => review.state === 'changes_requested');
  if (requested.length) return gate('failed', `Changes requested on GitHub by ${requested.map(review => review.reviewer).join(', ')}.`);
  if (checks.some(check => check.status === 'pending')) return gate('pending', 'Waiting for GitHub checks.');
  if (pull.mergeable_state === 'dirty' || pull.mergeable_state === 'behind') return gate('stale', 'GitHub\'s default branch moved, so these changes will be combined with it again.');
  if (pull.mergeable_state === 'unknown' || pull.mergeable_state === undefined) return gate('pending', 'GitHub is still computing mergeability.');
  // Nothing reported yet: give CI a moment to register before concluding the repository has none.
  if (!checks.length && Date.now() - openedAt < 90_000) return gate('pending', 'Waiting for GitHub checks to start.');
  if (pull.mergeable_state === 'blocked') return gate('blocked', 'GitHub branch protection requires an approval or check that has not been given.');
  // Requested review apps get a bounded wait; one that never reviews is recorded, not counted as a pass.
  const login = (name: string) => appSlug(name.toLowerCase());
  const reviewed = new Set([...latest.keys()].map(login));
  const missing = expect.reviewers.filter(name => !reviewed.has(login(name)));
  if (missing.length && Date.now() - openedAt < expect.waitMs) return gate('pending', `Waiting for ${missing.join(', ')} to review.`);
  const passed = `${plural(checks.length, 'GitHub check')} passed`;
  if (missing.length) return { ...gate('passed', `${checks.length ? passed : 'GitHub allows the merge'}; ${missing.join(', ')} did not review in time.`), missing };
  return gate('passed', checks.length ? `${passed}.` : 'No GitHub checks are configured; branch protection allows the merge.');
}
