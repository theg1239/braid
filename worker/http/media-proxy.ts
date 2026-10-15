import { HttpError } from '../errors';
import { limited } from '../git/transport';
import { mediaAddress, parse, parseFrom } from '../schemas';

/*
 * The remote images and videos a README shows, fetched by Braid as GitHub's camo fetches them: a reader's browser
 * only ever talks to Braid, so no host a README names learns a reader's address, cookies or the page they read.
 * Only https sources, only image and video answers, and only for Braid's own pages. Each answer keeps a sandbox
 * policy, so an SVG opened on its own cannot run as this site.
 */

const IMAGE_BYTES = 10 * 1024 * 1024;
const VIDEO_BYTES = 100 * 1024 * 1024;
const REDIRECTS = 4;
export const MEDIA_SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** GitHub shows an image addressed by its file page (`/owner/repo/blob/ref/path`) from that file's raw address, and so does Braid. */
function githubFile(url: URL): URL {
  const page = url.hostname === 'github.com' ? /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname) : null;
  return page ? new URL(`/${page[1]}/${page[2]}/raw/${page[3]}`, url) : url;
}

export async function mediaProxy(request: Request): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Media is only read.');
  // Browsers say where a request comes from; another site may not use Braid to fetch for it.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') throw new HttpError(403, 'Media loads only on Braid pages.');
  let next = githubFile(parse(mediaAddress, new URL(request.url).searchParams.get('url')));
  const range = request.headers.get('range');
  let response: Response;
  for (let hop = 0; ; hop++) {
    try {
      response = await fetch(next, { method: request.method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'Braid media proxy', accept: 'image/*, video/*', ...(range ? { range } : {}) } });
    } catch { throw new HttpError(502, 'The media host could not be reached.'); }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    await response.body?.cancel();
    if (hop >= REDIRECTS) throw new HttpError(502, 'The media host redirected too many times.');
    let redirected: string;
    try { redirected = new URL(location, next).href; }
    catch { throw new HttpError(502, 'The media host returned an invalid redirect.'); }
    next = parseFrom(mediaAddress, redirected, 'The media host returned an invalid redirect.');
  }
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'The media host did not return the file.'); }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!/^(image|video)\/[a-z0-9.+-]+$/.test(type)) { await response.body?.cancel(); throw new HttpError(415, 'Only images and videos are shown.'); }
  const limit = type.startsWith('image/') ? IMAGE_BYTES : VIDEO_BYTES;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new HttpError(413, 'This file is too large to show.'); }
  const headers = new Headers({ 'content-type': type, 'content-disposition': 'inline', 'content-security-policy': MEDIA_SANDBOX, 'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=86400' });
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const body = response.body ? limited(response.body, limit, () => { /* The stream ends with an error past the limit. */ }) : null;
  return new Response(request.method === 'HEAD' ? null : body, { status: response.status, headers });
}
