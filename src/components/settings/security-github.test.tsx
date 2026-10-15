import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '../../../shared/policy';
import { textOf } from '../../test/fixtures';
import { Security } from './Rules';

let queue: { data?: unknown; error?: string } = {};
vi.mock('../../lib/live', () => ({ useLive: (key: string) => (key === 'policy' ? { data: { policy: DEFAULT_POLICY } } : queue) }));
vi.mock('../../lib/router', () => ({ paths: { settings: (section: string) => `/settings/${section}`, code: (path: string) => `/files/${path}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));

it('asks to link GitHub only after the queue answers without a link', () => {
  queue = {};
  const pending = renderToStaticMarkup(<Security />);
  expect(textOf(pending)).not.toContain('Link GitHub');
  expect(pending).toContain('skeleton-line');

  queue = { data: { github: { mode: 'pull-requests', fullName: 'acme/relay' } } };
  expect(textOf(renderToStaticMarkup(<Security />))).toContain('On GitHub acme/relay');

  queue = { data: {} };
  expect(textOf(renderToStaticMarkup(<Security />))).toContain('Link GitHub for pull requests');

  queue = { error: 'HTTP 503' };
  const failed = textOf(renderToStaticMarkup(<Security />));
  expect(failed).not.toContain('Link GitHub');
  expect(failed).toContain('Couldn’t load the GitHub link');
});
