import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from './markdown';
import { Branch } from './branch';

vi.mock('../../lib/router', () => ({ useRoute: () => ({ hash: '' }), paths: { code: (path: string, options?: { ref?: string }) => `/code?path=${encodeURIComponent(path)}${options?.ref ? `&ref=${encodeURIComponent(options.ref)}` : ''}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('../../lib/api', () => ({ workspaceScopeNow: () => 'w1' }));

const html = (source: string) => renderToStaticMarkup(<Markdown source={source} path="docs/README.md" />);

describe('Markdown preview of repository files', () => {
  it('rebuilds README HTML from an allowlist, never as markup', () => {
    const out = html('<script>alert(1)</script>\n\nHello <img src=x onerror=alert(1)> there <iframe src="https://evil.example"></iframe> <b onclick="x()">bold</b>');
    expect(out).not.toMatch(/<script|alert\(1\)|onerror|onclick|<iframe|evil\.example/);
    expect(out).toContain('Hello');
    expect(out).toContain('<img class="md__img" src="/api/repository?workspace=w1&amp;path=docs%2Fx&amp;media=1"');
    expect(out).toContain('<b>bold</b>');
  });

  it('keeps a script element whole out of a block of HTML, content included', () => {
    const out = html('<div align="center">\n<script>document.cookie</script><style>body{}</style>\n<p>Kept</p>\n</div>');
    expect(out).not.toMatch(/cookie|body\{\}|<script|<style/);
    expect(out).toMatch(/<div style="text-align:center">\s*<p>Kept<\/p>\s*<\/div>/);
  });

  it('follows only safe targets from HTML links, and keeps badges in their links', () => {
    const out = html('<a href="javascript:alert(1)">bad</a> <a href="https://ci.example/run"><img src="https://img.shields.io/badge/ci-passing-green.svg" alt="CI"></a> <a href="../LICENSE">License</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('bad');
    expect(out).toContain('<a href="https://ci.example/run" target="_blank" rel="noreferrer noopener" class="md__link"><img class="md__img" src="/api/media?url=https%3A%2F%2Fimg.shields.io%2Fbadge%2Fci-passing-green.svg" alt="CI"');
    expect(out).toContain('href="/code?path=LICENSE"');
  });

  it("shows a picture's dark source, as Braid's dark theme would on GitHub", () => {
    const out = html('<p align="center">\n  <picture>\n    <source media="(prefers-color-scheme: dark)" srcset="./logo-dark.svg">\n    <img src="./logo-light.svg" alt="Logo" width="240">\n  </picture>\n</p>');
    expect(out).toContain('src="/api/repository?workspace=w1&amp;path=docs%2Flogo-dark.svg&amp;media=1"');
    expect(out).toContain('alt="Logo"');
    expect(out).toContain('width="240"');
    expect(out).not.toContain('logo-light');
  });

  it('plays an uploaded video standing alone on its line, and video elements', () => {
    const asset = 'https://github.com/user-attachments/assets/0f9a6a4e-5c1b-4f62-9c55-2b0c3c1a7d11';
    const out = html(`Demo:\n\n${asset}\n\n<video src="./demo.mp4" poster="./demo.png"></video>\n\nSee ${asset} inline.`);
    expect(out).toContain(`<source src="/api/media?url=${encodeURIComponent(asset)}"/>`);
    expect(out).toContain('<source src="/api/repository?workspace=w1&amp;path=docs%2Fdemo.mp4&amp;media=1"/>');
    expect(out).toContain('poster="/api/repository?workspace=w1&amp;path=docs%2Fdemo.png&amp;media=1"');
    // A link inside a sentence stays a link.
    expect(out).toContain(`See <a href="${asset}"`);
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

  it('shows repository images at the commit being read, remote images through the media proxy, and refuses other schemes', () => {
    const out = renderToStaticMarkup(<Branch.Provider value={{ name: 'main', gitRef: 'c'.repeat(40), main: true, streaming: false }}>
      <Markdown source={'![Architecture](./images/flow.png) ![Badge](https://example.com/badge.svg) ![Old](http://example.com/a.png) ![Bad](javascript:alert(1)) ![Dot](data:image/png;base64,AAAA)'} path="docs/README.md" />
    </Branch.Provider>);
    expect(out).toContain(`src="/api/repository?workspace=w1&amp;ref=${'c'.repeat(40)}&amp;path=docs%2Fimages%2Fflow.png&amp;media=1"`);
    expect(out).toContain('src="/api/media?url=https%3A%2F%2Fexample.com%2Fbadge.svg"');
    // http is asked for over https.
    expect(out).toContain('src="/api/media?url=https%3A%2F%2Fexample.com%2Fa.png"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('Bad');
    // Remote hosts learn nothing about the page or the repository being read.
    expect(out).toMatch(/referrerpolicy="no-referrer"/i);
  });
});
