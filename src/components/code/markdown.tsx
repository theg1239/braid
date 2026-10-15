import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { RouterLink } from '../ui/Link';
import { useBranch, useCodeHref } from './branch';
import { renderHtml, tokenize, type Piece, type Resolvers } from './markdown-html';
import '../../styles/markdown.css';
import { dirname } from '../../lib/format';
import { useRoute } from '../../lib/router';
import { workspaceScopeNow } from '../../lib/api';

/*
 * Markdown as GitHub shows a README, from marked's tokens straight to React elements. Markup never
 * reaches the page as markup: a README's HTML is rebuilt from an allowlist (markdown-html.tsx), text
 * stays text, and a link keeps only an http(s), same-page or relative target. Relative targets open
 * the file in Braid. Images and videos show inline: a repository file loads through Braid at the
 * commit being read, and remote sources load through Braid's media proxy. This module loads only when
 * a Markdown file is on screen.
 */

type Inline = Tokens.Text | Tokens.Escape | Tokens.Link | Tokens.Image | Tokens.Strong | Tokens.Em | Tokens.Codespan | Tokens.Br | Tokens.Del | Tokens.HTML | Tokens.Tag;

/** Where a link in `path` may go, or null when it may not be followed. */
function resolveHref(href: string, path: string, codeHref: ReturnType<typeof useCodeHref>): { kind: 'external' | 'app' | 'anchor'; to: string } | null {
  const target = href.trim();
  if (!target || target.startsWith('//')) return null;
  if (target.startsWith('#')) return { kind: 'anchor', to: target };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1].toLowerCase();
  if (scheme) return scheme === 'http' || scheme === 'https' ? { kind: 'external', to: target } : null;
  // Relative to the file's directory, clamped at the repository root. Repository content is
  // untrusted, so a target that is not a valid path (`50%.md`, `\\[`) stays text instead of throwing.
  const base = `file:///${dirname(path)}`;
  try {
    const resolved = new URL(target, base);
    const file = decodeURIComponent(resolved.pathname.replace(/^\/+/, ''));
    return file ? { kind: 'app', to: `${codeHref(file)}${resolved.hash}` } : null;
  } catch {
    return null;
  }
}

/**
 * Where an image or a video in `path` loads from: a repository file through Braid at the commit being read, a remote
 * file through Braid's media proxy (http is asked for over https), so the reader's browser contacts no other host, or
 * a data image as written; null for anything else.
 */
function mediaSource(src: string, path: string, branch: ReturnType<typeof useBranch>, image: boolean): string | null {
  const target = src.trim();
  if (!target || target.startsWith('//')) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1].toLowerCase();
  if (scheme === 'https' || scheme === 'http') return `/api/media?${new URLSearchParams({ url: scheme === 'http' ? `https:${target.slice(5)}` : target })}`;
  if (scheme === 'data') return image && /^data:image\/(png|gif|jpe?g|webp|avif|svg\+xml)[;,]/i.test(target) ? target : null;
  if (scheme) return null;
  try {
    const resolved = new URL(target, `file:///${dirname(path)}`);
    const file = decodeURIComponent(resolved.pathname.replace(/^\/+/, ''));
    if (!file) return null;
    const scope = workspaceScopeNow(), ref = branch.gitRef || (branch.main ? '' : branch.name);
    return `/api/repository?${new URLSearchParams({ ...(scope ? { workspace: scope } : {}), ...(ref ? { ref } : {}), path: file, media: '1' })}`;
  } catch {
    return null;
  }
}

/** GitHub shows an uploaded video, or a link to a video file, standing alone on its line as a player. */
function videoLink(href: string): boolean {
  if (/^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{36}$/i.test(href)) return true;
  try { return /\.(mp4|m4v|webm|mov|ogv)$/i.test(new URL(href, 'file:///').pathname); } catch { return false; }
}

const IMAGE_ALIGN = new Set(['left', 'right']);
function MdImage({ src, alt, title, width, height, align, path }: { src: string; alt: string; title?: string | null; width?: string; height?: string; align?: string; path: string }) {
  const source = mediaSource(src, path, useBranch(), true);
  if (!source) return <>{alt}</>;
  const side = align && IMAGE_ALIGN.has(align.toLowerCase()) ? ` md__img--${align.toLowerCase()}` : '';
  return <img className={`md__img${side}`} src={source} alt={alt} title={title ?? undefined} width={width} height={height} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
}

function MdVideo({ sources, poster, width, height, path }: { sources: string[]; poster?: string; width?: string; height?: string; path: string }) {
  const branch = useBranch();
  const loaded = sources.map(src => mediaSource(src, path, branch, false)).filter((src): src is string => !!src);
  if (!loaded.length) return null;
  const still = poster ? mediaSource(poster, path, branch, true) ?? undefined : undefined;
  return (
    <video className="md__video" controls muted playsInline preload="metadata" poster={still} width={width} height={height}>
      {loaded.map(src => <source key={src} src={src} />)}
      Your browser cannot play this video.
    </video>
  );
}

function HtmlAnchor({ href, path, children }: { href: string; path: string; children: ReactNode }) {
  const target = resolveHref(href, path, useCodeHref());
  if (!target) return <>{children}</>;
  if (target.kind === 'app') return <RouterLink href={target.to} className="md__link">{children}</RouterLink>;
  return target.kind === 'external'
    ? <a href={target.to} target="_blank" rel="noreferrer noopener" className="md__link">{children}</a>
    : <a href={target.to} className="md__link">{children}</a>;
}

/** How a README's HTML in `path` resolves its links, images and videos. */
const resolvers = (path: string): Resolvers => ({
  anchor: (href, children, key) => <HtmlAnchor key={key} href={href} path={path}>{children}</HtmlAnchor>,
  image: (src, attrs, key) => <MdImage key={key} src={src} path={path} {...attrs} />,
  video: (sources, attrs, key) => <MdVideo key={key} sources={sources} path={path} {...attrs} />,
});

function slug(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}

function plain(tokens: Token[]): string {
  return tokens.map((token) => ('tokens' in token && token.tokens ? plain(token.tokens) : 'text' in token ? String(token.text) : '')).join('');
}

function Link({ token, path, children }: { token: Tokens.Link; path: string; children: ReactNode }) {
  const codeHref = useCodeHref();
  const target = resolveHref(token.href, path, codeHref);
  const className = 'md__link';
  if (!target) return <>{children}</>;
  if (target.kind === 'external') {
    return (
      <a href={target.to} title={token.title ?? undefined} target="_blank" rel="noreferrer noopener" className={className}>
        {children}
      </a>
    );
  }
  if (target.kind === 'anchor') {
    return (
      <a href={target.to} title={token.title ?? undefined} className={className}>
        {children}
      </a>
    );
  }
  return (
    <RouterLink href={target.to} title={token.title ?? undefined} className={className}>
      {children}
    </RouterLink>
  );
}

function renderInline(tokens: Token[] | undefined, path: string): ReactNode {
  // Inline tags, such as a badge's <a><img></a>, open and close around other tokens: they are read together.
  if ((tokens ?? []).some(token => token.type === 'html')) {
    const pieces: Piece[] = (tokens ?? []).flatMap((token): Piece[] => token.type === 'html' ? tokenize((token as Tokens.HTML).text) : [{ kind: 'node', node: renderInline([token], path) }]);
    return renderHtml(pieces, resolvers(path));
  }
  return (tokens ?? []).map((raw, index) => {
    const token = raw as Inline;
    switch (token.type) {
      case 'text':
        return <Fragment key={index}>{token.tokens ? renderInline(token.tokens, path) : token.text}</Fragment>;
      case 'escape':
        return <Fragment key={index}>{token.text}</Fragment>;
      case 'strong':
        return <strong key={index}>{renderInline(token.tokens, path)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(token.tokens, path)}</em>;
      case 'del':
        return <del key={index}>{renderInline(token.tokens, path)}</del>;
      case 'codespan':
        return (
          <code key={index} className="md__code-inline">
            {token.text}
          </code>
        );
      case 'br':
        return <br key={index} />;
      case 'link':
        return (
          <Link key={index} token={token} path={path}>
            {renderInline(token.tokens, path)}
          </Link>
        );
      case 'image':
        return <MdImage key={index} src={token.href} alt={token.text} title={token.title} path={path} />;
      default:
        return null;
    }
  });
}

function ListItem({ item, path }: { item: Tokens.ListItem; path: string }) {
  const tokens = item.tokens.filter((token) => token.type !== 'checkbox');
  return (
    <li className={item.task ? 'md__task' : undefined}>
      {item.task ? <input type="checkbox" checked={!!item.checked} disabled readOnly aria-label={item.checked ? 'Done' : 'To do'} /> : null}
      {item.loose ? renderBlocks(tokens, path, new Map()) : renderTight(tokens, path)}
    </li>
  );
}

/** A tight list item's text renders without paragraphs, as GitHub renders it. */
function renderTight(tokens: Token[], path: string): ReactNode {
  return tokens.map((token, index) =>
    token.type === 'text' || token.type === 'paragraph' ? (
      <Fragment key={index}>{renderInline((token as Tokens.Text).tokens, path)}</Fragment>
    ) : (
      <Fragment key={index}>{renderBlocks([token], path, new Map())}</Fragment>
    ),
  );
}

function renderBlocks(tokens: Token[], path: string, ids: Map<string, number>): ReactNode {
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        const Tag = `h${Math.min(heading.depth + 1, 6)}` as 'h1';
        return (
          <Tag key={index} id={slug(plain(heading.tokens), ids)} className="md__heading">
            {renderInline(heading.tokens, path)}
          </Tag>
        );
      }
      case 'paragraph': {
        const inline = (token as Tokens.Paragraph).tokens.filter(part => !(part.type === 'text' && !part.raw.trim()));
        const only = inline.length === 1 && inline[0].type === 'link' ? inline[0] as Tokens.Link : null;
        if (only && only.text === only.href && videoLink(only.href)) return <MdVideo key={index} sources={[only.href]} path={path} />;
        return <p key={index}>{renderInline((token as Tokens.Paragraph).tokens, path)}</p>;
      }
      case 'html':
        return <div key={index} className="md__html">{renderHtml(tokenize((token as Tokens.HTML).text), resolvers(path))}</div>;
      case 'text':
        return <p key={index}>{renderInline((token as Tokens.Text).tokens, path)}</p>;
      case 'code':
        return (
          <pre key={index} className="md__code" tabIndex={0} role="group" aria-label="Code block">
            <code>{(token as Tokens.Code).text}</code>
          </pre>
        );
      case 'blockquote':
        return <blockquote key={index}>{renderBlocks((token as Tokens.Blockquote).tokens, path, ids)}</blockquote>;
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, i) => <ListItem key={i} item={item} path={path} />);
        return list.ordered ? (
          <ol key={index} start={list.start === '' ? undefined : Number(list.start)}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
      case 'table': {
        const table = token as Tokens.Table;
        return (
          <div key={index} className="md__table" tabIndex={0} role="group" aria-label="Table">
            <table>
              <thead>
                <tr>
                  {table.header.map((cell, i) => (
                    <th key={i} align={cell.align ?? undefined}>
                      {renderInline(cell.tokens, path)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} align={cell.align ?? undefined}>
                        {renderInline(cell.tokens, path)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case 'hr':
        return <hr key={index} />;
      default:
        // Blank space and link definitions render nothing.
        return null;
    }
  });
}

/** A Markdown file as prose. `path` resolves its relative links. */
export function Markdown({ source, path, landmark = true }: { source: string; path: string; landmark?: boolean }) {
  const { hash } = useRoute(), region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hash) return;
    let id: string;
    try { id = decodeURIComponent(hash); } catch { return; }
    region.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [hash, path, source]);
  const tokens = Lexer.lex(source, { gfm: true });
  return (
    <div ref={region} className="md" role={landmark ? 'region' : undefined} aria-label={landmark ? `Preview of ${path}` : undefined}>
      {renderBlocks(tokens, path, new Map())}
    </div>
  );
}
