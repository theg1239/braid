import * as v from 'valibot';
import type { RepositoryShowcase } from '../../shared/account';
import { logFailure } from '../errors';

/*
 * What GitHub shows of a public repository beside its code, for Explore: its language from the REST API, its stars,
 * forks and topics from its page, and the social preview its maintainers uploaded. GitHub draws a card for every other repository; that card repeats the
 * name and numbers Explore already shows, so only an uploaded picture is kept. Either answer may be missing, and a
 * sync without them keeps what the last one found.
 */

const UPLOADED_PREVIEW = 'repository-images.githubusercontent.com';
const TOPICS = 4;
const facts = v.object({ stargazers_count: v.pipe(v.number(), v.integer(), v.minValue(0)), language: v.nullable(v.string()) });

async function restFacts(fullName: string): Promise<Pick<RepositoryShowcase, 'stars' | 'language'>> {
  const response = await fetch(`https://api.github.com/repos/${fullName}`, { headers: { 'user-agent': 'Braid', accept: 'application/vnd.github+json' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) { await response.body?.cancel(); console.warn(JSON.stringify({ event: 'showcase_github_refused', source: 'rest', status: response.status })); return {}; }
  const parsed = v.safeParse(facts, await response.json());
  if (!parsed.success) return {};
  return { stars: parsed.output.stargazers_count, ...(parsed.output.language ? { language: parsed.output.language.slice(0, 40) } : {}) };
}

/** GitHub's own data for its repository page, embedded in the page as JSON. */
const embedded = v.object({ payload: v.object({ sidebarAbout: v.object({
  stargazerCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  forksCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  topics: v.array(v.object({ name: v.string() })),
  repo: v.object({ ownerId: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
}) }) });

/**
 * What the repository's page says: the stars, forks, topics and owner's picture GitHub embeds in it, and its `og:image` when that is a
 * picture the maintainers uploaded. The page answers where the unauthenticated API has run out of requests.
 */
async function pageFacts(fullName: string): Promise<Omit<RepositoryShowcase, 'latest' | 'language'>> {
  const response = await fetch(`https://github.com/${fullName}`, { headers: { 'user-agent': 'Braid', accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html')) { await response.body?.cancel(); console.warn(JSON.stringify({ event: 'showcase_github_refused', source: 'page', status: response.status })); return {}; }
  let image: string | null = null, data = '';
  await new HTMLRewriter()
    .on('meta[property="og:image"]', { element(meta) { image ??= meta.getAttribute('content'); } })
    .on('script[type="application/json"][data-target="react-app.embeddedData"]', { text(chunk) { data += chunk.text; } })
    .transform(response).arrayBuffer();
  const url = image ? URL.parse(image) : null;
  const parsed = data ? v.safeParse(embedded, parseJson(data)) : null;
  const about = parsed?.success ? parsed.output.payload.sidebarAbout : null;
  return {
    ...(url?.protocol === 'https:' && url.hostname === UPLOADED_PREVIEW ? { cover: url.href } : {}),
    ...(about ? { stars: about.stargazerCount, forks: about.forksCount, topics: about.topics.slice(0, TOPICS).map(topic => topic.name.slice(0, 50)),
      avatar: `https://avatars.githubusercontent.com/u/${about.repo.ownerId}?s=192` } : {}),
  };
}

const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

export async function githubShowcase(fullName: string): Promise<RepositoryShowcase> {
  const failed = (source: string) => (error: unknown) => { logFailure('showcase_github_failed', error, { source }); return {}; };
  const [rest, page] = await Promise.all([restFacts(fullName).catch(failed('rest')), pageFacts(fullName).catch(failed('page'))]);
  return { ...rest, ...page };
}
