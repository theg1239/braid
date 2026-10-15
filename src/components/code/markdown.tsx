import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { RouterLink } from '../ui/Link';
import { useCodeHref } from './branch';
import '../../styles/markdown.css';
import { dirname } from '../../lib/format';
import { useRoute } from '../../lib/router';

/*
 * Markdown as GitHub shows a README, from marked's tokens straight to React elements. No HTML
 * ever reaches the page: raw HTML tokens are dropped, text stays text, and a link keeps only an
 * http(s), same-page or relative target. Relative targets open the file in Braid; an image is
 * a link to its source, since the page's CSP allows no remote images. This module loads only
 * when a Markdown file is on screen.
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

function slug(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}

function plain(tokens: Token[]): string {
  return tokens.map((token) => ('tokens' in token && token.tokens ? plain(token.tokens) : 'text' in token ? String(token.text) : '')).join('');
}

function Link({ token, path, children, image = false }: { token: Tokens.Link | Tokens.Image; path: string; children: ReactNode; image?: boolean }) {
  const codeHref = useCodeHref();
  const target = resolveHref(token.href, path, codeHref);
  const className = image ? 'md__link md__image' : 'md__link';
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
        return <Link key={index} token={token} path={path} image>{token.text || 'Image'}</Link>;
      default:
        // Raw HTML is never rendered.
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
      case 'paragraph':
        return <p key={index}>{renderInline((token as Tokens.Paragraph).tokens, path)}</p>;
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
        // Blank space, link definitions and raw HTML blocks render nothing.
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
