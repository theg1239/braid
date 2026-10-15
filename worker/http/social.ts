import { RESERVED_OWNERS } from '../../shared/routes';
import * as v from 'valibot';
import { directoryOf, type BraidEnv } from '../env';
import { repositoryAddress } from '../schemas';
import { clientAddress, networkKey } from './public-access';
import { logFailure } from '../errors';

const LANDING_TITLE = 'Braid · The Git platform for agent fleets';
const DESCRIPTION = 'The Git platform for agent fleets. See which model wrote every line, who owns each agent, and merge pull requests under your rules.';
const IMAGE_ALT = 'Braid, the Git platform for agent fleets';

function decode(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/** Formats a URL after the page handler has established that its repository is public. */
export function socialTitle(url: URL): string {
  const [owner, repo, view, id, ...path] = url.pathname.split('/').filter(Boolean).map(decode);
  if (!owner || owner === 'index.html') return LANDING_TITLE;
  if (owner === 'explore' && !repo) return 'Explore · Braid';
  if (!repo || (RESERVED_OWNERS.has(owner) && !(owner === 'example' && repo === 'relay'))) return 'Braid';
  const address = `${owner}/${repo}`;
  if (view === 'pull' && id && /^\d+$/.test(id)) return `Pull request #${id} · ${address}`;
  if (view === 'commit' && id && /^[a-f\d]{7,40}$/i.test(id)) return `Commit ${id.slice(0, 7)} · ${address}`;
  if ((view === 'blob' || view === 'blame') && id && path.length) return `${path.join('/')} · ${address}`;
  return `${address} · Braid`;
}

/** A single escaped attribute value, including URL segments that decode to HTML. */
function attribute(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function socialTags(url: URL, publicOrigin: string): string {
  // X's card title budget also keeps long file paths compact in other unfurls.
  const full = Array.from(socialTitle(url).replace(/[\u0000-\u001f\u007f]/g, ' '));
  const title = full.length > 70 ? `${full.slice(0, 69).join('')}…` : full.join('');
  const image = new URL('/og.png', publicOrigin || url.origin).href;
  const properties = {
    'og:type': 'website', 'og:site_name': 'Braid', 'og:title': title, 'og:description': DESCRIPTION,
    'og:image': image, 'og:image:width': '1200', 'og:image:height': '630', 'og:image:alt': IMAGE_ALT,
  };
  const names = {
    'twitter:card': 'summary_large_image', 'twitter:title': title, 'twitter:description': DESCRIPTION,
    'twitter:image': image, 'twitter:image:alt': IMAGE_ALT,
  };
  return [...Object.entries(properties).map(([key, value]) => `<meta property="${key}" content="${attribute(value)}" />`),
    ...Object.entries(names).map(([key, value]) => `<meta name="${key}" content="${attribute(value)}" />`)].join('\n');
}

/** Private and unknown addresses have the same generic preview, even for a signed-in browser. */
async function previewUrl(request: Request, env: Pick<BraidEnv, 'DIRECTORY' | 'IP_LIMITER'>): Promise<URL> {
  const url = new URL(request.url);
  const [owner, repo] = url.pathname.split('/').filter(Boolean);
  if (!repo || (owner === 'example' && repo === 'relay') || RESERVED_OWNERS.has(owner)) return url;
  const address = v.safeParse(repositoryAddress, { owner, repo });
  if (address.success) {
    try {
      if (env.IP_LIMITER && !(await env.IP_LIMITER.limit({ key: await networkKey(clientAddress(request)) })).success) return new URL('/', url);
      const found = await directoryOf(env).resolveRepository(null, address.output.owner, address.output.repo);
      if (found.ok && found.data.visibility === 'public') return url;
    } catch (error) {
      // A failed visibility lookup must not publish an address.
      logFailure('social_preview_failed', error);
    }
  }
  return new URL('/', url);
}

/** Stream the shell with public-only preview metadata; no session, ref or file is read. */
export async function servePage(request: Request, env: Pick<BraidEnv, 'ASSETS' | 'PUBLIC_ORIGIN' | 'DIRECTORY' | 'IP_LIMITER'>): Promise<Response> {
  // Vite serves source modules through ASSETS in development. Only documents need
  // the SPA shell; scripts, styles and other subresources keep their own URLs.
  const destination = request.headers.get('sec-fetch-dest');
  if (destination && !['document', 'iframe', 'empty'].includes(destination)) return env.ASSETS.fetch(request);
  // Fetch the SPA shell directly. Asset URL canonicalization can otherwise redirect
  // encoded slashes in refs or file names and change the address before we title it.
  const assetRequest = new Request(new URL('/', request.url), request);
  // The asset's validators describe the shared index, not this route's rewritten head.
  assetRequest.headers.delete('if-none-match');
  assetRequest.headers.delete('if-modified-since');
  assetRequest.headers.delete('range');
  assetRequest.headers.delete('if-range');
  const response = await env.ASSETS.fetch(assetRequest);
  if (request.method !== 'GET' || response.status !== 200 || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return response;
  const tags = socialTags(await previewUrl(request, env), env.PUBLIC_ORIGIN);
  const rewritten = new HTMLRewriter().on('head', { element(head) { head.append(`\n${tags}\n`, { html: true }); } }).transform(response);
  rewritten.headers.delete('etag');
  rewritten.headers.delete('last-modified');
  rewritten.headers.delete('content-length');
  // The head varies with visibility as well as the route and deployment.
  rewritten.headers.set('cache-control', 'no-store');
  return rewritten;
}
