import { cachedPublicRead } from './read-cache';

const token = /^[!#$%&'*+.^_`|~\w-]+$/;
const quoted = /^"(?:[\t !#-\[\]-~\x80-\xff]|\\[\t !-~\x80-\xff])*"$/;

/** HTTP list/parameter separators inside quoted strings are data, including escaped quotes. */
function fields(value: string, separator: string): string[] {
  const result: string[] = [];
  let start = 0, quote = false, escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) escaped = false;
    else if (quote && char === '\\') escaped = true;
    else if (char === '"') quote = !quote;
    else if (!quote && char === separator) { result.push(value.slice(start, index).trim()); start = index + 1; }
  }
  return quote || escaped ? [] : [...result, value.slice(start).trim()];
}

/** Parse Accept media ranges and weights. A specific q=0 overrides an accepting wildcard. Ties keep agent text. */
export function prefersGuideHtml(accept: string | null, textSubtype: 'plain' | 'markdown' = 'plain'): boolean {
  const ranges = fields(accept ?? '', ',').flatMap(field => {
    const [media, ...parameters] = fields(field, ';');
    if (!media) return [];
    const [type, subtype, extra] = media.toLowerCase().split('/');
    if (!type || !subtype || extra !== undefined || !token.test(type) || !token.test(subtype) || type === '*' && subtype !== '*') return [];
    let quality = 1, charset = false, weighted = false;
    for (const parameter of parameters) {
      const equals = parameter.indexOf('=');
      const name = parameter.slice(0, equals).trim().toLowerCase(), value = parameter.slice(equals + 1).trim();
      if (equals < 1 || !token.test(name) || !token.test(value) && !quoted.test(value)) return [];
      if (name === 'q') {
        if (weighted || !/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) return [];
        quality = Number(value); weighted = true;
      } else {
        const decoded = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
        // Both representations are UTF-8; other media parameters do not describe either one.
        if (name !== 'charset' || decoded.toLowerCase() !== 'utf-8' || charset) return [];
        charset = true;
      }
    }
    return [{ type, subtype, quality, specificity: (type === '*' ? 0 : subtype === '*' ? 1 : 2) * 2 + Number(charset) }];
  });
  const preference = (subtype: string) => ranges.filter(range => (range.type === '*' || range.type === 'text') && (range.subtype === '*' || range.subtype === subtype))
    .sort((a, b) => b.specificity - a.specificity || b.quality - a.quality)[0];
  const html = preference('html'), text = preference(textSubtype);
  return !!html && html.quality > 0 && (!text || html.quality > text.quality || html.quality === text.quality && html.specificity > text.specificity);
}

const escapeText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function guidePage(path: string, text: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(path.slice(1))} · Braid</title>
<style>
@font-face{font-family:'Geist Mono';src:url('/fonts/GeistMono-latin.woff2') format('woff2');font-weight:100 900;font-style:normal;font-display:swap}
:root{color-scheme:dark;background:oklch(10% 0 0);color:oklch(97% 0 0)}
body{margin:0;padding:24px 20px}pre{max-width:88ch;margin:0 auto;font:400 16px/1.6 'Geist Mono',ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
</style></head><body><pre>${escapeText(text)}</pre></body></html>`;
}

export async function guideResponse(request: Request, text: string, origin: string, buildId: string): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  const textSubtype = path === '/skills/braid/SKILL.md' ? 'markdown' : 'plain';
  const html = prefersGuideHtml(request.headers.get('accept'), textSubtype);
  const headers = { 'content-type': `text/${html ? 'html' : textSubtype}; charset=utf-8`, vary: 'Accept',
    'cache-control': path === '/local-agents.md' ? 'no-store' : 'public, max-age=300' };
  const render = async () => new Response(html ? guidePage(path, text) : text, { headers });
  // Personalized task links must bypass both the edge cache and its shared in-flight reads.
  if (path === '/local-agents.md') return render();
  // Workers Cache API does not key on Vary. Normalize Accept to exactly two separate representations.
  const key = new Request(`https://guides.braid.invalid/${encodeURIComponent(buildId)}/${encodeURIComponent(origin)}/${html ? 'html' : 'text'}${path}`);
  const response = await cachedPublicRead(key, 300, render);
  response.headers.set('cache-control', headers['cache-control']);
  return response;
}
