import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from './markdown';
import { Branch } from './branch';

vi.mock('../../lib/router', () => ({ useRoute: () => ({ hash: '' }), paths: { code: (path: string, options?: { ref?: string }) => `/code?path=${encodeURIComponent(path)}${options?.ref ? `&ref=${encodeURIComponent(options.ref)}` : ''}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));

const html = (source: string) => renderToStaticMarkup(<Markdown source={source} path="docs/README.md" />);

describe('Markdown preview of repository files', () => {
  it('never renders raw HTML', () => {
    const out = html('<script>alert(1)</script>\n\nHello <img src=x onerror=alert(1)> there');
    expect(out).not.toMatch(/<script|<img|onerror/);
    expect(out).toContain('Hello');
  });

  it('follows only http(s), same-page and repository links', () => {
    const out = html('[a](javascript:alert(1)) [b](https://example.com) [c](#usage) [d](../src/index.ts) [e](data:text/html,x)');
    expect(out).not.toMatch(/javascript:|data:/);
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="#usage"');
    expect(out).toContain('href="/code?path=src%2Findex.ts"');
  });

  it('keeps a link it cannot resolve as text instead of failing the page', () => {
    const out = html('[half](50%.md) and [odd](a%zz)');
    expect(out).toContain('half');
    expect(out).not.toContain('<a');
  });

  it('keeps a relative link on the viewed branch and preserves its heading anchor', () => {
    const out = renderToStaticMarkup(<Branch.Provider value={{ name: 'release/next', gitRef: 'b'.repeat(40), main: false, streaming: false }}><Markdown source="[Setup](./setup.md#install)" path="docs/README.md" /></Branch.Provider>);
    expect(out).toContain('href="/code?path=docs%2Fsetup.md&amp;ref=release%2Fnext#install"');
  });

  it('makes repository image sources openable without loading remote images', () => {
    const out = html('![Architecture](./images/flow.png) ![Badge](https://example.com/badge.svg)');
    expect(out).toContain('href="/code?path=docs%2Fimages%2Fflow.png"');
    expect(out).toContain('href="https://example.com/badge.svg"');
    expect(out).not.toContain('<img');
  });
});
