import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { EmptyPanel, ErrorPanel, PageState } from './States';
import { RepositoryReadError } from '../../screens/RepositoryReadError';

it('gives a not-found page exactly one h1', () => {
  const html = renderToStaticMarkup(<EmptyPanel heading="h1" title="Page not found" />);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/);
});

it('gives a whole-page error exactly one h1', () => {
  const html = renderToStaticMarkup(<ErrorPanel heading="h1" title="Couldn’t load profile" message="Try again shortly." onRetry={() => {}} />);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain('role="alert"');
  expect(html).toContain('Try again');
});

it('keeps empty and error panels inside a page at h2', () => {
  const html = renderToStaticMarkup(<><h1>Settings</h1><EmptyPanel title="No results" /><ErrorPanel title="Couldn’t load settings" /></>);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html.match(/<h2\b/g)).toHaveLength(2);
});

it('retains the existing page-state and page-error headings', () => {
  for (const panel of [<PageState title="Page not found" />, <ErrorPanel page title="Unable to load this page" />]) {
    expect(renderToStaticMarkup(panel).match(/<h1\b/g)).toHaveLength(1);
  }
});

it('keeps a rate-limited read retryable and keeps its retry quiet while in flight', () => {
  const html = renderToStaticMarkup(<RepositoryReadError title="Couldn’t load commits" notFound="Commit not found" state={{ error: 'Too many requests. Try again after 10:00:03 AM.', errorStatus: 429, refreshing: true, refresh: async () => null }} />);
  expect(html).toContain('Try again after 10:00:03 AM.');
  expect(html).toMatch(/<button[^>]*disabled/);
  expect(html).not.toMatch(/animate-spin|Loading|429/);
});
