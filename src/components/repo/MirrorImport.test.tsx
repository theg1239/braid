import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MirrorContext, type RepositoryMirror } from '../../account/mirrors';
import { MirrorImportBar } from './MirrorImport';
import type { ProjectImport } from '../../../shared/types';

vi.mock('../../lib/router', () => ({ setRouteRef: vi.fn() }));
vi.mock('../../lib/live', () => ({ useLive: vi.fn() }));

const source = 'https://github.com/alice/repo';
const mirror: RepositoryMirror = { source, syncedAt: null, importing: true, startedAt: '2026-10-15T00:00:15.000Z' };
const importing: ProjectImport = { name: 'repo', source: 'alice/repo', startedAt: '2026-10-15T00:00:40.000Z' };
const render = (record: RepositoryMirror | null, pending?: ProjectImport) => renderToStaticMarkup(<MirrorContext.Provider value={record}><MirrorImportBar source={source} importing={pending} /></MirrorContext.Provider>);
afterEach(() => vi.useRealTimers());

describe('mirror elapsed time', () => {
  it('uses the persisted reservation when the public snapshot has no import yet, including after a revisit', () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-15T00:01:00.000Z');
    expect(render(mirror)).toContain('Preparing mirror');
    expect(render(mirror)).toContain('45s');
    vi.setSystemTime('2026-10-15T00:01:10.000Z');
    expect(render(mirror)).toContain('55s');
    // The later workspace record must not reset the timer after a cache refresh.
    expect(render(mirror, importing)).toContain('Copying');
    expect(render(mirror, importing)).toContain('55s');
  });

  it('uses the actual import time on older addresses and never guesses an unknown start', () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-15T00:01:00.000Z');
    expect(render(null, importing)).toContain('20s');
    expect(render({ ...mirror, startedAt: undefined })).not.toMatch(/>\d+s</);
    expect(render({ ...mirror, importing: false }, importing)).toContain('20s');
  });
});
