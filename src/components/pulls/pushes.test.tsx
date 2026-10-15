import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Change } from '../../../shared/types';
import { pushLabel } from './pushes';

vi.mock('../../lib/api', () => ({ changes: { evidenceImageUrl: vi.fn() } }));
vi.mock('../../lib/router', () => ({ paths: { pull: () => '/pull/22/files' }, navigate: vi.fn() }));
vi.mock('../../lib/live', () => ({ refreshLive: vi.fn() }));
vi.mock('./guide', () => ({ useGuide: () => ({ guide: null }) }));
vi.mock('../../lib/resources', () => ({ useChangeComparison: () => ({ comparison: { files: [] } }), useChangeDiff: vi.fn() }));
vi.mock('../../lib/viewed', () => ({ useViewed: () => new Set(), setViewed: vi.fn() }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => null }));
vi.mock('../code', () => ({ useDiffStyle: () => 'unified', setDiffStyle: vi.fn() }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
import { Proof } from './Proof';
import { FilesChanged } from './Files';

const change = { id: 'ch_copy', number: 22, revision: 2, files: [], evidence: [{ kind: 'command', revision: 1, command: 'npm test', exitCode: 1, output: '', source: 'agent', at: '2026-10-12T12:00:00Z' }] } as unknown as Change;
describe('push copy', () => {
  it('labels the first and later pushes', () => {
    expect(pushLabel(1)).toBe('First push');
    expect(pushLabel(3)).toBe('Push 3');
  });
  it('labels earlier proof with its push and failing command', () => {
    const html = renderToStaticMarkup(<Proof change={change} />);
    expect(html).toContain('First push');
    expect(html).toContain('npm test failed');
    expect(html).not.toContain('Revision');
  });
  it('labels the earlier-push filter and empty comparison without API vocabulary', () => {
    const html = renderToStaticMarkup(<FilesChanged change={change} since={1} focus={null} />);
    expect(html).toContain('Since first push');
    expect(html).toContain('No changes since first push');
    expect(html).not.toMatch(/revisions?/i);
  });
});
