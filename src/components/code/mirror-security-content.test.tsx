import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { Markdown } from './markdown';

vi.mock('../../lib/router', () => ({ useRoute: () => ({ hash: '' }), paths: { code: (path: string) => `/code?path=${encodeURIComponent(path)}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('../../lib/api', () => ({ workspaceScopeNow: () => 'w1' }));

it.each([
  '<script>alert(1)</script>', '<svg onload="alert(1)"></svg>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<img src="https://attacker.invalid/track" onerror="alert(1)">', '<a href="javascript:alert(1)">open</a>',
  '[open](javascript:alert(1))', '[open](data:text/html;base64,PHNjcmlwdD4=)',
  '[open](javascript&#58;alert(1))', '[open](java&#x09;script:alert(1))',
  '![track](https://attacker.invalid/track)',
])('keeps mirrored content inert: %s', source => {
  const html = renderToStaticMarkup(<Markdown source={source} path="README.md" />);
  expect(html).not.toMatch(/<(?:script|svg|iframe|object|embed)\b|\son(?:load|error|click)=/i);
  // Images load only from Braid: a tracking pixel never sees the reader's browser.
  const sources = [...html.matchAll(/\s(?:src|poster|srcset)="([^"]*)"/g)].map(match => match[1]);
  expect(sources.every(source => source.startsWith('/api/media?url=') || source.startsWith('/api/repository?'))).toBe(true);
  const targets = [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
  expect(targets.every(target => target.startsWith('/code?') || target.startsWith('#') || /^https?:\/\//.test(target))).toBe(true);
});

it('escapes mirrored filenames in accessible preview attributes', () => {
  const html = renderToStaticMarkup(<Markdown source="# README" path={'\"><svg onload="alert(1)">\u202e.md'} />);
  expect(html).not.toContain('<svg');
  expect(html).toContain('&quot;&gt;&lt;svg');
});
