import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Banner, Button, LinkButton, Popover, Tabs } from '@cloudflare/kumo';
import { BookOpenIcon, CheckIcon, CopyIcon, EyeIcon, FolderIcon, GitBranchIcon, GitPullRequestIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { api, changes, errorMessage } from '../lib/api';
import { textSize } from '../lib/diff';
import { basename, plural, shortHash } from '../lib/format';
import { downloadBlob, useCopy } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { useHeaderCounts } from '../lib/needs';
import { openPalette } from '../lib/palette';
import { recordRecent } from '../lib/recent';
import { knownDirectory, useRepositoryFile, useRepositoryTree } from '../lib/resources';
import { primeBlame } from '../lib/reads';
import { navigate, paths, useRoute } from '../lib/router';
import { canWrite, useSnapshot } from '../store/workspace';
import { useRepository } from '../account/RepositoryGate';
import { MIRROR_TOO_LARGE, useMirror } from '../account/mirrors';
import { MirrorError } from '../components/repo/MirrorError';
import { MirrorImport } from '../components/repo/MirrorImport';
import { ReadmeSkeleton } from '../components/ui/ScreenSkeleton';
import { ConnectButton } from '../components/repo/ConnectButton';
import { ImportBar } from '../components/repo/ImportBar';
import { MirrorCodeHeader } from '../components/repo/MirrorCodeHeader';
import { RepositorySetup } from '../components/repo/RepositorySetup';
import { FileView, isMarkdown, type FileRender } from '../components/code';
import { BlameView } from '../components/code/blame';
import { BranchMenu, referenceLabel } from '../components/code/BranchMenu';
import { CodeSearch } from '../components/code/CodeSearch';
import { RouterLink } from '../components/ui/Link';
import { EmptyPanel, ErrorPanel } from '../components/ui/States';
import { Kbd } from '../components/ui/Kbd';
import { SkeletonLine, SkeletonParagraph } from '../components/ui/Skeleton';
import { BlameSkeleton, CodeSkeleton } from '../components/code/CodeSkeleton';
import { Branch, useBranch, useCodeHref } from '../components/code/branch';
import { FileTree } from '../components/code/FileTree';
import { Listing } from '../components/code/Listing';
import { LatestCommit } from '../components/repo/LatestCommit';
import '../styles/pages.css';

/** The repository home, as on GitHub: the branch, the latest commit, the files and the README. A path opens a directory or a file. */
export function CodeScreen() {
  const snapshot = useSnapshot();
  const route = useRoute();
  const mirror = useMirror();
  const project = snapshot.project;
  const importing = snapshot.importing;
  const requested = route.path.replace(/\/+$/, '');
  // Another branch the repository has, or a commit; anything else reads the default branch.
  const named = route.ref && route.ref !== project.branch && (/^[a-f0-9]{40}$/.test(route.ref) || !project.branches || project.branches.includes(route.ref)) ? route.ref : null;
  // A GitHub import shows its files from GitHub at once, and Braid's copy replaces them when it lands.
  const streamed = !project.id && importing?.preview && importing.branch && !importing.error ? importing.branch : null;
  const branch = useMemo(
    () => (streamed ? { name: streamed, gitRef: streamed, main: false, streaming: true } : { name: named ?? project.branch, gitRef: named ?? project.head, main: !named, streaming: false }),
    [streamed, named, project.branch, project.head],
  );
  const title = (project.id ? project.name : importing?.name) || 'Braid';

  useDocumentTitle(requested ? `${requested} · ${title}` : title);

  if (!project.id && mirror && !streamed) return importing?.error && route.repo
    ? <MirrorError message={importing.code === MIRROR_TOO_LARGE ? importing.error : 'Could not mirror this repository.'} code={importing.code} address={route.repo} />
    : <MirrorImport importing={importing} source={mirror.source} branch={project.branch} route={route} />;
  if (!project.id && !streamed) return <RepositorySetup />;

  return (
    <Branch.Provider value={branch}>
      <div className="page">
        {branch.streaming ? null : <ReviewNotice />}
        {requested ? <Entry path={requested} head={branch.gitRef} directory={route.view === 'tree'} /> : <Root head={branch.gitRef} />}
      </div>
    </Branch.Provider>
  );
}

/** One notice when pull requests wait for the viewer, as GitHub shows above the files. */
function ReviewNotice() {
  const snapshot = useSnapshot();
  const counts = useHeaderCounts(snapshot);
  // A visitor or a member cannot review, so nothing waits for them.
  if (!counts.review || !canWrite(snapshot)) return null;
  return (
    <div className="notice">
      <Banner
        variant="default"
        size="sm"
        icon={<EyeIcon weight="fill" />}
        description={`${plural(counts.review, 'pull request')} need${counts.review === 1 ? 's' : ''} your review`}
        action={
          <LinkButton size="sm" variant="primary" href={paths.pulls('review')}>
            Review
          </LinkButton>
        }
      />
    </div>
  );
}

/** GitHub's "Go to file": the command menu, scoped to files. The `t` key opens it too. */
function GoToFile({ disabled = false }: { disabled?: boolean }) {
  return (
    <Button size="sm" variant="secondary" icon={MagnifyingGlassIcon} className="repo-bar__find" disabled={disabled} onClick={() => openPalette('files')}>
      Go to file
      <Kbd>t</Kbd>
    </Button>
  );
}

function Root({ head }: { head: string }) {
  const snapshot = useSnapshot();
  const mirror = useMirror();
  const branch = useBranch();
  const { tree, error, pending, more, retry } = useRepositoryTree('', head);
  const readme = tree?.entries.find((entry) => entry.kind === 'file' && /^readme(\.(md|markdown|txt))?$/i.test(entry.name))?.path;
  return (
    <>
      <h1 className="sr-only">{snapshot.project.name} files</h1>
      <div className="repo-bar">
        <BranchMenu current={branch.name} />
        <GoToFile disabled={branch.streaming} />
        <CodeSearch gitRef={branch.main ? undefined : branch.name} disabled={branch.streaming} />
        <span className="repo-bar__right">
          <ConnectButton />
        </span>
      </div>
      <div className="repo-box">
        {mirror && (branch.main || branch.streaming) ? <MirrorCodeHeader /> : branch.streaming && snapshot.importing ? (
          <ImportBar importing={snapshot.importing} />
        ) : branch.main ? (
          <LatestCommit />
        ) : (
          <div className="commit-bar">
            <span className="commit-bar__author">
              <GitBranchIcon size={14} aria-hidden="true" /> {referenceLabel(branch.name)}
            </span>
            <span className="commit-bar__right">{tree ? <span className="mono commit-bar__hash">{shortHash(tree.ref)}</span> : null}</span>
          </div>
        )}
        <Listing path="" tree={tree} error={error} pending={pending} more={more} retry={retry} />
      </div>
      {readme ? <Readme key={readme} path={readme} /> : !tree && !error && head ? <ReadmeSkeleton /> : null}
    </>
  );
}

/** The README as GitHub shows it under the files: rendered when it is Markdown. */
function Readme({ path }: { path: string }) {
  const snapshot = useSnapshot();
  const branch = useBranch();
  const href = useCodeHref();
  // Read at the commit, as the home's warm start asks for it.
  const { result, retry } = useRepositoryFile(path, branch.gitRef, branch.gitRef, branch.main ? snapshot.files[path] : undefined);
  return (
    <section className="readme" aria-labelledby="readme-title">
      <header className="file-bar">
        <BookOpenIcon size={16} className="file-bar__icon" aria-hidden="true" />
        <h2 className="file-bar__path" id="readme-title">
          <RouterLink href={href(path, { kind: 'file' })}>{path}</RouterLink>
        </h2>
      </header>
      {result.status === 'error' ? (
        result.httpStatus === 404 ? <EmptyPanel title="File not found" action={<RouterLink className="text-link" href={href('')}>Browse files</RouterLink>} /> : <ErrorPanel title="Couldn’t read this file" message={result.message} onRetry={retry} />
      ) : result.status === 'loading' ? (
        <SkeletonParagraph />
      ) : result.kind === 'large' || result.kind === 'binary' ? (
        <p className="quiet file-note">Open this file to download it.</p>
      ) : (
        <FileView content={result.content} path={path} id={`${branch.gitRef}:${path}`} render={isMarkdown(path) ? 'preview' : 'code'} />
      )}
    </section>
  );
}

function Breadcrumb({ path, missing = false }: { path: string; missing?: boolean }) {
  const snapshot = useSnapshot();
  const { address } = useRepository();
  const href = useCodeHref();
  const parts = path.split('/');
  return (
    <span className="crumbs">
      <RouterLink href={href('')} className="crumbs__link crumbs__root">
        {address?.repo ?? snapshot.project.name}
      </RouterLink>
      {parts.map((part, index) => {
        const sub = parts.slice(0, index + 1).join('/');
        const last = index === parts.length - 1;
        return (
          <Fragment key={sub}>
            <span className="crumbs__sep">/</span>
            {last || missing ? (
              <span className="crumbs__current">{part}</span>
            ) : (
              <RouterLink href={href(sub, { kind: 'dir' })} className="crumbs__link">
                {part}
              </RouterLink>
            )}
          </Fragment>
        );
      })}
    </span>
  );
}

/**
 * A path under main beside the tree, as GitHub shows every directory and file below the
 * repository home. Directories and files share the layout, so opening one never moves the page.
 */
function Entry({ path, head, directory }: { path: string; head: string; directory: boolean }) {
  return directory || knownDirectory(path, head)
    ? <EntryLayout path={path} head={head}><Directory path={path} head={head} /></EntryLayout>
    : <Opening path={path} head={head} />;
}

function EntryLayout({ path, head, children }: { path: string; head: string; children: ReactNode }) {
  const branch = useBranch();
  const requested = useRoute().path;
  const treeId = useId();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const treeOpen = openPath === requested;
  return (
    <div className="repo-layout" data-tree-open={treeOpen || undefined}>
      <div className="repo__phone-bar">
        <Button size="sm" variant="secondary" icon={FolderIcon} aria-expanded={treeOpen} aria-controls={treeId} onClick={() => setOpenPath(treeOpen ? null : requested)}>Files</Button>
        <BranchMenu current={branch.name} />
        <GoToFile disabled={branch.streaming} />
      </div>
      <nav id={treeId} className="repo__tree" aria-label="Files">
        <div className="repo__tree-head">
          <BranchMenu current={branch.name} />
        </div>
        <FileTree path={path} head={head} />
      </nav>
      <section className="repo__file" aria-label={path}>
        {children}
      </section>
    </div>
  );
}

/** A path no listing has described yet, such as a shared link: read it, and list it if it is a directory. */
function Opening({ path, head }: { path: string; head: string }) {
  const { result, pending, retry } = useRepositoryFile(path, head, head);
  const branch = useBranch();
  const route = useRoute();
  const current = { path, head, result, branch, route };
  const [settled, setSettled] = useState<typeof current | null>(null);
  // File reads at a commit are immutable. Retain the entire last panel while the next
  // address loads, including its branch, breadcrumb and selected tree path. An error
  // settles the new address too, so it can never leave another file's contents behind.
  if (result.status !== 'loading' && (settled?.path !== path || settled.head !== head || settled.route.href !== route.href || settled.result.status !== result.status)) setSettled(current);
  const keeping = result.status === 'loading' && settled?.result.status === 'ready' && settled.result.kind !== 'dir';
  const shown = keeping ? settled : current;
  return <Branch.Provider value={shown.branch}>
    <EntryLayout path={shown.path} head={shown.head}>
      {shown.result.status === 'ready' && shown.result.kind === 'dir' ? <Directory path={shown.path} head={shown.head} /> : <File path={shown.path} result={shown.result} pending={pending} retry={retry} head={shown.head} route={shown.route} />}
    </EntryLayout>
  </Branch.Provider>;
}

function Directory({ path, head }: { path: string; head: string }) {
  const { streaming, main, name } = useBranch();
  const dir = useRepositoryTree(path, head);
  return (
    <>
      <header className="file-bar">
        <h1 className="file-bar__path">
          <Breadcrumb path={path} />
        </h1>
        <div className="file-bar__end">{streaming ? null : <><GoToFile /><CodeSearch gitRef={main ? undefined : name} /></>}</div>
      </header>
      <Listing path={path} {...dir} />
    </>
  );
}

/** GitHub's switch on a file: Preview for Markdown, Code, and Blame, who last changed each line. */
type FileSwitch = FileRender | 'blame';
const VIEW_LABEL: Record<FileSwitch, string> = { preview: 'Preview', code: 'Code', blame: 'Blame' };

function File({ path, result, pending, retry, head, route }: { path: string; result: ReturnType<typeof useRepositoryFile>['result']; pending: boolean; retry: () => void; head: string; route: ReturnType<typeof useRoute> }) {
  const snapshot = useSnapshot();
  const { main, streaming, name } = useBranch();
  const href = useCodeHref();
  const [copied, copy] = useCopy();
  const markdown = isMarkdown(path);
  const anchored = /^#L[1-9]\d*$/.test(route.hash);
  const [render, setRender] = useState<FileRender>(anchored ? 'code' : 'preview');
  useEffect(() => { if (anchored) setRender('code'); }, [anchored, route.hash]);
  // Blame is in the address, so it can be linked to; Preview and Code are the person's choice for this file.
  // Agents' blame follows what merged into the default branch, so a live repository's other branches show the code
  // alone; the recorded example's branches carry their blame at their pinned commits.
  const blameable = main || snapshot.capabilities.mode === 'demo';
  const blame = blameable && route.view === 'blame';
  const view: FileSwitch = blame ? 'blame' : markdown ? render : 'code';
  const switches: readonly FileSwitch[] = markdown ? ['preview', 'code', ...(blameable ? (['blame'] as const) : [])] : ['code', ...(blameable ? (['blame'] as const) : [])];
  const failed = result.status === 'error';
  const views = switches.map((value) => ({ value, label: VIEW_LABEL[value], render: failed ? <button disabled /> : undefined }));
  const show = (next: FileSwitch) => {
    if (next === 'blame') navigate(href(path, { view: 'blame' }));
    else {
      setRender(next);
      if (blame) navigate(href(path, { kind: 'file' }));
    }
  };
  const content = result.status === 'ready' && (!result.kind || result.kind === 'text' || result.kind === 'symlink') ? result.content : null;
  const textControls = content !== null || result.status !== 'ready';
  // Counted without splitting: a file on main can be as large as the review limit allows.
  const lines = useMemo(() => (content === null ? 0 : textSize(content).lines), [content]);
  const project = snapshot.project.id;

  const opened = content !== null;
  const recent = href(path, { kind: 'file' });
  useEffect(() => {
    if (opened) recordRecent(project, { kind: 'file', href: recent, title: path });
  }, [project, path, opened, recent]);

  return (
    <>
      <header className="file-bar">
        <div className="file-bar__location">
          <h1 className="file-bar__path">
            <Breadcrumb path={path} missing={result.status === 'error' && result.httpStatus === 404} />
          </h1>
          {main ? <OpenPulls path={path} /> : null}
        </div>
        {textControls ? (
          <span className="file-bar__view" onPointerEnter={blameable ? () => primeBlame(path, head) : undefined} onFocus={blameable ? () => primeBlame(path, head) : undefined}>
            <Tabs size="sm" variant="segmented" aria-label="View" value={view} onValueChange={(value) => show(value as FileSwitch)} tabs={views} />
          </span>
        ) : null}
        {textControls ? <span className="file-bar__meta">{failed ? '—' : content === null ? <SkeletonLine width={36} height={12} /> : plural(lines, 'line')}</span> : null}
        {!streaming && (result.status === 'ready' ? <LinkButton size="sm" variant="ghost" href={paths.commits(route.ref ?? snapshot.project.branch, path)}>History</LinkButton> : <Button size="sm" variant="ghost" disabled>History</Button>)}
        {!streaming && (result.status === 'ready' ? result.kind !== 'submodule' ? <DownloadFile path={path} gitRef={head} /> : null : <Button size="sm" variant="ghost" disabled>Download</Button>)}
        {textControls ? (
          <Button size="sm" variant="ghost" icon={copied === path ? CheckIcon : CopyIcon} onClick={() => content !== null && void copy(content, path, true)} disabled={pending || failed} aria-label={copied === path ? 'Copied' : 'Copy file'} />
        ) : null}
        {streaming ? null : <CodeSearch gitRef={main ? undefined : name} />}
      </header>
      <div className="file-body" data-pending={pending || undefined}>
        {result.status === 'error' ? (
          result.httpStatus === 404 ? <EmptyPanel title="File not found" action={<RouterLink className="text-link" href={href('')}>Browse files</RouterLink>} /> : <ErrorPanel title="Couldn’t read this file" message={result.message} onRetry={retry} />
        ) : result.status === 'ready' && result.kind === 'submodule' ? (
          <EmptyPanel title="Submodule" description={`Commit ${result.hash}`} />
        ) : result.status === 'ready' && (result.kind === 'large' || result.kind === 'binary') ? (
          <EmptyPanel title={result.kind === 'binary' ? 'Binary file' : 'Large file'} description="Download it to view it." />
        ) : content === null ? (
          view === 'blame' ? <BlameSkeleton /> : <CodeSkeleton label="Loading file" />
        ) : view === 'blame' ? (
          <BlameView path={path} content={content} head={head} />
        ) : (
          <FileView content={content} path={path} id={`${head}:${path}`} render={markdown ? render : 'code'} />
        )}
      </div>
    </>
  );
}

/** Open pull requests that touch this file, so reading main alone does not mislead. */
function OpenPulls({ path }: { path: string }) {
  const touching = useLive(`touching:${path}`, () => changes.touching([path]), 20_000);
  const list = touching.data?.[path] ?? [];
  if (!list.length) return null;
  return (
    <Popover>
      <Popover.Trigger render={<button type="button" className="file-open" aria-label={plural(list.length, 'open pull request')} title={plural(list.length, 'open pull request')} />}>
        <GitPullRequestIcon size={14} aria-hidden="true" />{list.length}
      </Popover.Trigger>
      <Popover.Content align="end" className="file-open__list">
        <Popover.Title>{plural(list.length, 'open pull request')}</Popover.Title>
        {list.map(change => <RouterLink key={change.changeId} href={paths.pull(change.number)} className="text-link">#{change.number} {change.title}</RouterLink>)}
      </Popover.Content>
    </Popover>
  );
}

function DownloadFile({ path, gitRef }: { path: string; gitRef: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      downloadBlob(basename(path), await api.downloadFile(path, gitRef));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void download()}>
        Download
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </>
  );
}

