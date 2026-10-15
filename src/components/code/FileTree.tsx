import { useCallback, useEffect, useState } from 'react';
import { Button } from '@cloudflare/kumo';
import { CaretRightIcon, FileIcon, FolderIcon } from '@phosphor-icons/react';
import type { RepositoryEntry } from '../../../shared/repository';
import { errorMessage } from '../../lib/api';
import { primeTree, trees } from '../../lib/reads';
import { useRepositoryTree } from '../../lib/resources';
import { RouterLink } from '../ui/Link';
import { LoadingRegion, SkeletonLine, SkeletonRows } from '../ui/Skeleton';
import { ErrorPanel } from '../ui/States';
import { useCodeHref } from './branch';

/** Reveal an expanded tree together: a late child listing must not move the sibling rows. */
export function FileTree({ path, head }: { path: string; head: string }) {
  const key = `${head}:${path}`;
  const [ready, setReady] = useState<{ key: string; path: string; head: string } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  useEffect(() => {
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [retry]);
  useEffect(() => {
    let cancelled = false;
    const parts = path.split('/');
    const parents = parts.map((_, index) => parts.slice(0, index).join('/'));
    void Promise.all(parents.map(parent => trees.load(parent, head))).then(() => {
      if (!cancelled) { setReady({ key, path, head }); setFailure(null); }
    }).catch(error => {
      if (!cancelled) setFailure({ key, message: errorMessage(error) });
    });
    return () => { cancelled = true; };
  }, [path, head, key, attempt]);
  if (failure?.key === key) return <ErrorPanel title="Couldn’t load files" message={failure.message} onRetry={retry} />;
  return ready?.head === head ? <Tree path="" gitRef={head} selected={ready.key === key ? path : ready.path} depth={0} /> : <SkeletonRows rows={11} height={31} label="Loading file tree" />;
}

function Tree({ path, gitRef, selected, depth }: { path: string; gitRef: string; selected: string; depth: number }) {
  const { tree, error, pending, more, retry } = useRepositoryTree(path, gitRef);
  const href = useCodeHref();
  return (
    <ul className="tree" role="list">
      {error ? (
        <li>
          <ErrorPanel title="Couldn’t load files" message={error} onRetry={retry} />
        </li>
      ) : null}
      {/* Git stores no empty directories, so one row is the least an opening folder holds: it can only grow. */}
      {!tree && !error ? <li><LoadingRegion label="Loading files"><span className="tree__item tree__item--loading" style={{ paddingLeft: 28 + depth * 14 }}><SkeletonLine width={14} height={14} /><SkeletonLine width="45%" /></span></LoadingRegion></li> : null}
      {tree?.entries.map((node) => (
        <li key={node.path}>
          {node.kind === 'dir' ? (
            <DirectoryNode node={node} gitRef={gitRef} selected={selected} depth={depth} />
          ) : (
            <RouterLink href={href(node.path, { kind: 'file' })} className="tree__item" aria-current={selected === node.path ? 'page' : undefined} style={{ paddingLeft: 28 + depth * 14 }}>
              <FileIcon size={14} aria-hidden="true" className="tree__icon" />
              <span className="tree__name">{node.name}</span>
            </RouterLink>
          )}
        </li>
      ))}
      {tree?.nextCursor ? (
        <li>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void more()}>
            Load more
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

function DirectoryNode({ node, gitRef, selected, depth }: { node: RepositoryEntry; gitRef: string; selected: string; depth: number }) {
  const containsSelected = selected === node.path || selected.startsWith(`${node.path}/`);
  const [open, setOpen] = useState(containsSelected);
  useEffect(() => {
    if (containsSelected) setOpen(true);
  }, [containsSelected]);
  // Read the listing while the pointer or focus is on the folder, so opening it usually shows it at once.
  const prime = () => primeTree(node.path, gitRef);
  return (
    <details className="tree__dir" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="tree__item tree__summary" style={{ paddingLeft: 10 + depth * 14 }} aria-current={selected === node.path ? 'page' : undefined} onPointerEnter={prime} onFocus={prime}>
        <CaretRightIcon size={11} weight="bold" className="tree__caret" aria-hidden="true" />
        <FolderIcon size={14} weight="fill" aria-hidden="true" className="tree__icon tree__icon--dir" />
        <span className="tree__name">{node.name}</span>
      </summary>
      {open ? <Tree path={node.path} gitRef={gitRef} selected={selected} depth={depth + 1} /> : null}
    </details>
  );
}
