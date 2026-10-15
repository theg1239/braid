import { Button } from '@cloudflare/kumo';
import { FileIcon, FolderIcon, GitPullRequestIcon } from '@phosphor-icons/react';
import type { RepositoryEntry } from '../../../shared/repository';
import { api, changes } from '../../lib/api';
import { PALETTE_KEYS, plural } from '../../lib/format';
import { useLive } from '../../lib/live';
import { openPalette } from '../../lib/palette';
import { useRead, type useRepositoryTree } from '../../lib/resources';
import { reader } from '../../lib/reads';
import { useNow } from '../../lib/hooks';
import { paths } from '../../lib/router';
import { Kbd } from '../ui/Kbd';
import { RouterLink } from '../ui/Link';
import { FileRowsSkeleton } from '../ui/ScreenSkeleton';
import { ErrorPanel } from '../ui/States';
import { RelativeTime } from '../ui/Time';
import { useBranch, useCodeHref } from './branch';
import './listing-commits.css';

type TreeState = ReturnType<typeof useRepositoryTree>;
const PAGE_SIZE = 200;
const commits = reader((ref: string, path: string, cursor: string) => `${ref}:${path}:${cursor}`, (ref, path, cursor) => api.treeCommits(ref, path, cursor));

function ListingRows({ entries, ref, path, cursor, touching }: { entries: RepositoryEntry[]; ref: string; path: string; cursor: string; touching: Record<string, unknown[]> | null }) {
  const href = useCodeHref(), now = useNow();
  const { streaming } = useBranch();
  const read = useRead(commits, !streaming && ref ? [ref, path, cursor] : null), metadata = read.value;
  const history = metadata?.ref === ref && metadata.path === path ? metadata : null;
  const byPath = new Map(history?.entries.map(item => [item.path, item.lastCommit]) ?? []);
  return entries.map((entry, index) => {
    const lastCommit = entry.lastCommit ?? byPath.get(entry.path), open = touching?.[entry.path]?.length ?? 0;
    const label = `${plural(open, 'open pull request')} touch${open === 1 ? 'es' : ''} this file`;
    return <li key={entry.path} className="listing__row listing__row--commits" data-kind={entry.kind}>
      <RouterLink href={href(entry.path, { kind: entry.kind === 'dir' ? 'dir' : 'file' })} className="listing__file">
        {entry.kind === 'dir' ? <FolderIcon size={16} weight="fill" className="listing__icon listing__icon--dir" aria-hidden="true" /> : <FileIcon size={16} className="listing__icon" aria-hidden="true" />}
        <span className="listing__name">{entry.name}</span>
        {entry.kind === 'submodule' || entry.kind === 'symlink' ? <span className="listing__kind">{entry.kind}</span> : null}
        {open ? <span className="listing__open" role="img" aria-label={label} title={label}><GitPullRequestIcon size={13} weight="bold" aria-hidden="true" />{open}</span> : null}
      </RouterLink>
      <span className="listing__commit">{lastCommit ? <RouterLink href={paths.commit(lastCommit.hash)} title={lastCommit.title}>{lastCommit.title}</RouterLink>
        // A failed read is not missing history: the first row's empty cell says so and reads it again.
        : index === 0 && read.error ? <>Couldn’t load commits · <button type="button" className="text-link listing__retry" onClick={read.retry}>Retry</button></> : history?.historyComplete === false ? <span className="listing__unknown" title="History not loaded" aria-label="History not loaded">—</span> : null}</span>
      <span className="listing__time">{lastCommit ? <RelativeTime at={lastCommit.at} now={now} /> : null}</span>
    </li>;
  });
}

/** Nothing to list yet: one line and the ways in, as a code view with nothing open offers them. */
function EmptyListing({ path }: { path: string }) {
  return (
    <div className="listing-empty">
      <p className="quiet">{path ? 'Empty directory' : 'No files yet'}</p>
      {!path ? (
        <ul className="shortcuts" aria-label="Shortcuts">
          <li>
            <button type="button" className="shortcut" onClick={() => openPalette('files')}>
              Go to file <Kbd>t</Kbd>
            </button>
          </li>
          <li>
            <button type="button" className="shortcut" onClick={() => openPalette()}>
              Search <Kbd>{PALETTE_KEYS.label}</Kbd>
            </button>
          </li>
          <li>
            <RouterLink href={paths.agents()} className="shortcut">
              New task <Kbd>n</Kbd>
            </RouterLink>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

/** A directory as GitHub lists it: folders first, then files, with open pull requests that touch each one. */
export function Listing({ path, tree, error, pending, more, retry }: { path: string } & TreeState) {
  const { gitRef: head, main } = useBranch();
  const href = useCodeHref();
  const files = tree?.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path) ?? [];
  // Pull requests merge into the default branch, so only its files show the ones touching them.
  const touching = useLive(main && files.length ? `touching:dir:${path}:${files.length}` : null, () => changes.touching(files), 20_000);
  if (error) return <ErrorPanel title="Couldn’t load files" message={error} onRetry={retry} />;
  if (!head) return <EmptyListing path={path} />;
  if (!tree) return <FileRowsSkeleton />;
  if (!tree.entries.length) return <EmptyListing path={path} />;
  return (
    <ul className="listing" aria-label="Files">
      {path ? (
        <li>
          <RouterLink href={href(path.split('/').slice(0, -1).join('/'), { kind: 'dir' })} className="listing__row">
            <span className="listing__icon" aria-hidden="true" />
            <span className="listing__name">..</span>
          </RouterLink>
        </li>
      ) : null}
      {Array.from({ length: Math.ceil(tree.entries.length / PAGE_SIZE) }, (_, page) => <ListingRows key={`${tree.ref}:${path}:${page}`} entries={tree.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)} ref={tree.ref} path={path} cursor={String(page * PAGE_SIZE)} touching={touching.data} />)}
      {tree.nextCursor ? (
        <li className="listing__more">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void more()}>
            Load more
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
