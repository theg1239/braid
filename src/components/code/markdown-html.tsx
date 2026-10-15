import { createElement, Fragment, type CSSProperties, type ReactNode } from 'react';

/*
 * The HTML a README carries, as GitHub shows it: `<p align="center">`, `<img>`, `<picture>`, `<video>`, badges in links,
 * `<details>`. A small tokenizer reads the tags, and only an allowlist of elements and attributes is rebuilt as React
 * elements; nothing is ever inserted as markup. An element off the list keeps only its text, and the content of
 * script, style, frames and forms is dropped with them. Addresses go through the caller's resolvers.
 */

export type Piece = { kind: 'open'; tag: string; attrs: Record<string, string>; closed: boolean } | { kind: 'close'; tag: string } | { kind: 'text'; text: string } | { kind: 'node'; node: ReactNode };

export interface Resolvers {
  /** An element for a link, or null when its target may not be followed. */
  anchor(href: string, children: ReactNode, key: number): ReactNode;
  /** An image from a written source; alt text when the source may not load. */
  image(src: string, attrs: { alt: string; title?: string; width?: string; height?: string; align?: string }, key: number): ReactNode;
  /** A video from written sources and poster. */
  video(sources: string[], attrs: { poster?: string; width?: string; height?: string }, key: number): ReactNode;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose content is code, scripts or controls: dropped whole. */
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'noscript', 'template', 'textarea', 'select', 'button', 'form', 'svg', 'math', 'title', 'head', 'canvas', 'audio']);
/** Elements rebuilt as themselves, with the attributes each keeps. */
const ELEMENTS: Record<string, string[]> = {
  p: ['align'], div: ['align'], span: [], br: [], hr: [], b: [], strong: [], i: [], em: [], u: [], s: [], strike: [], del: [], ins: [], mark: [],
  sub: [], sup: [], small: [], kbd: [], code: [], pre: [], samp: [], var: [], abbr: ['title'], cite: [], q: [], blockquote: [],
  h1: ['align'], h2: ['align'], h3: ['align'], h4: ['align'], h5: ['align'], h6: ['align'], ul: [], ol: ['start'], li: [], dl: [], dt: [], dd: [],
  details: ['open'], summary: [], table: [], thead: [], tbody: [], tfoot: [], tr: [], td: ['align', 'colspan', 'rowspan'], th: ['align', 'colspan', 'rowspan'],
  caption: [], figure: [], figcaption: [],
};
const ALIGN = new Set(['left', 'center', 'right', 'justify']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', laquo: '«', raquo: '»', times: '×' };
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? whole;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
/** HTML as tags and text, by the tokenizer rules for start tags, end tags and comments. */
export function tokenize(html: string): Piece[] {
  const pieces: Piece[] = [];
  let index = 0, text = '';
  const flush = () => { if (text) { pieces.push({ kind: 'text', text: decodeEntities(text) }); text = ''; } };
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) { text += html.slice(index); break; }
    text += html.slice(index, open);
    if (html.startsWith('<!--', open)) { flush(); const end = html.indexOf('-->', open + 4); index = end < 0 ? html.length : end + 3; continue; }
    if (html[open + 1] === '!' || html[open + 1] === '?') { flush(); const end = html.indexOf('>', open); index = end < 0 ? html.length : end + 1; continue; }
    const closing = html[open + 1] === '/';
    const name = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(open + (closing ? 2 : 1)))?.[0];
    if (!name) { text += '<'; index = open + 1; continue; }
    let at = open + (closing ? 2 : 1) + name.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      while (/\s/.test(html[at] ?? '')) at++;
      if (at >= html.length || html[at] === '>' || html.startsWith('/>', at)) break;
      ATTRIBUTE.lastIndex = at;
      const match = ATTRIBUTE.exec(html);
      if (!match) { at++; continue; }
      const key = match[1].toLowerCase();
      if (!(key in attrs)) attrs[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
      at = ATTRIBUTE.lastIndex;
    }
    // A tag cut off at the end of its token stays text, as an unfinished tag reads on GitHub.
    if (at >= html.length) { text += html.slice(open); break; }
    flush();
    const tag = name.toLowerCase(), selfClosing = html.startsWith('/>', at);
    pieces.push(closing ? { kind: 'close', tag } : { kind: 'open', tag, attrs, closed: selfClosing || VOID.has(tag) });
    index = at + (selfClosing ? 2 : 1);
  }
  flush();
  return pieces;
}

type Element = { tag: string; attrs: Record<string, string>; children: (Element | ReactNode)[] };
const isElement = (value: unknown): value is Element => typeof value === 'object' && value !== null && 'children' in value && 'attrs' in value && 'tag' in value;

/** Pieces as a tree: an end tag closes its nearest open match, and dropped elements lose their content. */
function tree(pieces: Piece[]): Element {
  const root: Element = { tag: '', attrs: {}, children: [] }, stack = [root];
  let dropping: { tag: string; depth: number } | null = null;
  for (const piece of pieces) {
    if (dropping) {
      if (piece.kind === 'open' && piece.tag === dropping.tag && !piece.closed) dropping.depth++;
      if (piece.kind === 'close' && piece.tag === dropping.tag && --dropping.depth === 0) dropping = null;
      continue;
    }
    const top = stack.at(-1)!;
    if (piece.kind === 'text') top.children.push(piece.text);
    else if (piece.kind === 'node') top.children.push(piece.node);
    else if (piece.kind === 'open') {
      if (DROP.has(piece.tag)) { if (!piece.closed) dropping = { tag: piece.tag, depth: 1 }; continue; }
      const element: Element = { tag: piece.tag, attrs: piece.attrs, children: [] };
      top.children.push(element);
      if (!piece.closed) stack.push(element);
    } else {
      const at = stack.findLastIndex(element => element.tag === piece.tag);
      if (at > 0) stack.length = at;
    }
  }
  return root;
}

const alignStyle = (align: string | undefined): CSSProperties | undefined => align && ALIGN.has(align.toLowerCase()) ? { textAlign: align.toLowerCase() as CSSProperties['textAlign'] } : undefined;
const size = (value: string | undefined) => value && /^\d+%?$/.test(value.trim()) ? value.trim() : undefined;

/** The first address of a `srcset`. */
const first = (srcset: string | undefined) => srcset?.split(',')[0]?.trim().split(/\s+/)[0] || undefined;

function render(element: Element, resolvers: Resolvers, key: number): ReactNode {
  const children = () => element.children.map((child, index) => isElement(child) ? render(child, resolvers, index) : <Fragment key={index}>{child}</Fragment>);
  const { tag, attrs } = element;
  if (!tag) return <Fragment key={key}>{children()}</Fragment>;
  if (tag === 'a') return attrs.href ? resolvers.anchor(attrs.href, children(), key) : <Fragment key={key}>{children()}</Fragment>;
  if (tag === 'img') return attrs.src ? resolvers.image(attrs.src, { alt: attrs.alt ?? '', title: attrs.title, width: size(attrs.width), height: size(attrs.height), align: attrs.align }, key) : null;
  if (tag === 'picture') {
    // Braid is dark, so a picture's dark-scheme source wins, as GitHub's dark theme picks it.
    const sources = element.children.filter(isElement);
    const dark = sources.find(child => child.tag === 'source' && /prefers-color-scheme:\s*dark/i.test(child.attrs.media ?? ''));
    const img = sources.find(child => child.tag === 'img');
    const src = first(dark?.attrs.srcset) ?? img?.attrs.src ?? first(sources.find(child => child.tag === 'source')?.attrs.srcset);
    return src ? resolvers.image(src, { alt: img?.attrs.alt ?? '', title: img?.attrs.title, width: size(img?.attrs.width), height: size(img?.attrs.height), align: img?.attrs.align }, key) : null;
  }
  if (tag === 'video') {
    const sources = [attrs.src, ...element.children.filter(isElement).filter(child => child.tag === 'source').map(child => child.attrs.src)].filter((src): src is string => !!src);
    return sources.length ? resolvers.video(sources, { poster: attrs.poster, width: size(attrs.width), height: size(attrs.height) }, key) : null;
  }
  if (tag === 'center') return <div key={key} style={{ textAlign: 'center' }}>{children()}</div>;
  const allowed = ELEMENTS[tag];
  if (!allowed) return <Fragment key={key}>{children()}</Fragment>;
  const props: Record<string, unknown> = { key };
  if (allowed.includes('align')) props.style = alignStyle(attrs.align);
  if (tag === 'ol' && /^\d+$/.test(attrs.start ?? '')) props.start = Number(attrs.start);
  if ((tag === 'td' || tag === 'th') && /^\d+$/.test(attrs.colspan ?? '')) props.colSpan = Number(attrs.colspan);
  if ((tag === 'td' || tag === 'th') && /^\d+$/.test(attrs.rowspan ?? '')) props.rowSpan = Number(attrs.rowspan);
  if (tag === 'details' && 'open' in attrs) props.open = true;
  if (tag === 'abbr' && attrs.title) props.title = attrs.title;
  return VOID.has(tag) ? createElement(tag, props) : createElement(tag, props, ...children());
}

/** Tags and rendered Markdown, mixed as a paragraph mixes them, as React elements. */
export function renderHtml(pieces: Piece[], resolvers: Resolvers): ReactNode {
  return render(tree(pieces), resolvers, 0);
}
