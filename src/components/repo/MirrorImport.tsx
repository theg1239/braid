import { Button, Tabs } from '@cloudflare/kumo';
import { CodeIcon, CopyIcon, FolderIcon, GitBranchIcon, GithubLogoIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import type { ProjectImport } from '../../../shared/types';
import type { Route } from '../../lib/router';
import { useNow } from '../../lib/hooks';
import { useWorkspace } from '../../store/workspace';
import { isMirrorFailure, useMirror } from '../../account/mirrors';
import { MirrorError } from './MirrorError';
import { durationLabel } from '../mission/timing';
import { CodeSearch } from '../code/CodeSearch';
import { isMarkdown } from '../code';
import { BlameSkeleton, CodeSkeleton } from '../code/CodeSkeleton';
import { FileRowsSkeleton, ReadmeSkeleton } from '../ui/ScreenSkeleton';
import { SkeletonLine, SkeletonRows } from '../ui/Skeleton';
import { Kbd } from '../ui/Kbd';

/** Real elapsed time and the source, in the row the commit will occupy. No estimated progress. */
export function MirrorImportBar({ importing, source, className = 'commit-bar' }: { importing?: ProjectImport; source: string; className?: string }) {
  const now = useNow(1000);
  const mirror = useMirror();
  const startedAt = (mirror?.importing ? mirror.startedAt : undefined) ?? importing?.startedAt;
  const inline = className === 'file-bar__location';
  return <div className={className} role="status" style={inline ? { display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 } : undefined}>
    <span className="commit-bar__author" style={{ display: 'inline-flex', gap: 6 }}><GithubLogoIcon size={15} aria-hidden="true" />{importing ? 'Copying' : 'Preparing mirror'}</span>
    <a className="commit-bar__title" href={source}>{new URL(source).pathname.slice(1)}</a>
    <span className="commit-bar__right" aria-live="off" style={{ fontVariantNumeric: 'tabular-nums', flex: inline ? 'none' : undefined }}>
      {startedAt ? durationLabel(Math.max(0, now - Date.parse(startedAt))) : null}
    </span>
  </div>;
}

/** Keep the Code layout while the copy runs; the workspace's import poll replaces it with the files. */
export function MirrorImport({ importing, source, branch, route }: { importing?: ProjectImport; source: string; branch: string; route: Route }) {
  const { error, errorCode } = useWorkspace();
  // A later poll can refuse the copy while the store retains the last importing snapshot.
  if (error && isMirrorFailure(errorCode) && route.repo) return <MirrorError message={error} code={errorCode} address={route.repo} />;
  const branchButton = <Button size="sm" variant="secondary" icon={GitBranchIcon} disabled>{importing?.branch ?? branch}</Button>;
  const find = <Button size="sm" variant="secondary" icon={MagnifyingGlassIcon} className="repo-bar__find" disabled>Go to file<Kbd>t</Kbd></Button>;
  const views = [...(isMarkdown(route.path) ? [{ value: 'preview', label: 'Preview' }] : []), { value: 'code', label: 'Code' }, { value: 'blame', label: 'Blame' }];
  return <div className="page">
    {route.path ? <div className="repo-layout">
      <div className="repo__phone-bar"><Button size="sm" variant="secondary" icon={FolderIcon} disabled>Files</Button>{branchButton}{find}</div>
      <nav className="repo__tree" aria-label="Files"><div className="repo__tree-head">{branchButton}</div><SkeletonRows rows={11} height={31} label="Copying file tree" /></nav>
      <section className="repo__file" aria-label={route.path}>
        <header className="file-bar">
          <MirrorImportBar importing={importing} source={source} className="file-bar__location" />
          {route.view === 'tree' ? <div className="file-bar__end">{find}<CodeSearch disabled /></div> : <>
            <span className="file-bar__view"><Tabs size="sm" variant="segmented" aria-label="View" value={route.view === 'blame' ? 'blame' : views[0].value} tabs={views.map(view => ({ ...view, render: <button disabled /> }))} /></span>
            <span className="file-bar__meta"><SkeletonLine width={36} height={12} /></span>
            <Button size="sm" variant="ghost" disabled>History</Button>
            <Button size="sm" variant="ghost" disabled>Download</Button>
            <Button size="sm" variant="ghost" icon={CopyIcon} aria-label="Copy file" disabled />
            <CodeSearch disabled />
          </>}
        </header>
        <div className="file-body">{route.view === 'tree' ? <FileRowsSkeleton /> : route.view === 'blame' ? <BlameSkeleton /> : <CodeSkeleton label="Copying file" />}</div>
      </section>
    </div> : <>
      <div className="repo-bar">
        {branchButton}{find}<CodeSearch disabled />
        <span className="repo-bar__right"><Button size="sm" variant="secondary" icon={CodeIcon} disabled>Code</Button></span>
      </div>
      <div className="repo-box"><MirrorImportBar importing={importing} source={source} /><FileRowsSkeleton /></div>
      <ReadmeSkeleton />
    </>}
  </div>;
}
