import { useEffect, useState } from 'react';
import { Button, DropdownMenu, LinkButton, Tabs, useKumoToastManager, type TabsItem } from '@cloudflare/kumo';
import { ArrowSquareOutIcon, DotsThreeIcon, GitMergeIcon, GithubLogoIcon, LinkIcon, ProhibitIcon } from '@phosphor-icons/react';
import type { Change } from '../../shared/types';
import { questionFor } from '../../shared/questions';
import { changes } from '../lib/api';
import { changeInterval } from '../lib/lists';
import { labelTone, pullState } from '../lib/changes';
import { plural } from '../lib/format';
import { useCopy, useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { refreshLive, setLive, useLive } from '../lib/live';
import { canPrefetch, prefetchHref } from '../lib/prefetch';
import { recordRecent } from '../lib/recent';
import { isPlainLeftClick, navigate, paths, useRoute, type PullTab } from '../lib/router';
import { answerBlocker, useSnapshot } from '../store/workspace';
import { AuthorChip, Label, PullStateBadge } from '../components/pulls/Bits';
import { Checks, checkRowCount } from '../components/pulls/Checks';
import { Conflicts } from '../components/pulls/Conflicts';
import { Conversation } from '../components/pulls/Conversation';
import { CommentComposer } from '../components/pulls/Comments';
import { MergeBox, sentBackDetail } from '../components/pulls/MergeBox';
import { StackLinks } from '../components/pulls/Stack';
import { Reviewers } from '../components/pulls/Reviewers';
import { filesTab, guideTab, prefetchFirstDiff } from '../components/pulls/prefetch';
import { useGuide } from '../components/pulls/guide';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { RouterLink } from '../components/ui/Link';
import { PullSkeleton } from '../components/ui/ScreenSkeleton';
import { PageState, ErrorPanel, ErrorNotice } from '../components/ui/States';
import { Stats } from '../components/ui/Status';

import '../components/pulls/detail.css';

const FilesChanged = filesTab.Component;
const GuideTab = guideTab.Component;

/** Statuses the merge box does not offer Close for, so the header menu does. A pull request that asks a person has Close among its answers. */
const CLOSABLE = new Set<Change['status']>(['open', 'revise', 'queued']);

/**
 * The header's menu, as Graphite keeps the lesser actions behind one button: a link to copy, GitHub
 * when the pull request is mirrored there, and Close where the merge box does not already offer it.
 */
function HeaderMenu({ change, onUpdated }: { change: Change; onUpdated: (next: Change) => void }) {
  const snapshot = useSnapshot();
  const toasts = useKumoToastManager();
  const [, copy] = useCopy();
  const [closing, setClosing] = useState(false);
  const blocker = answerBlocker(snapshot);
  const link = `${window.location.origin}${paths.pull(change.number)}`;
  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger>
          <Button size="sm" variant="ghost" shape="square" icon={DotsThreeIcon} aria-label="More actions" className="pull-head__more" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item
            icon={LinkIcon}
            onClick={async () => {
              if (await copy(link)) toasts.add({ title: 'Link copied', description: link });
            }}
          >
            Copy link
          </DropdownMenu.Item>
          {change.status === 'landed' ? (
            <DropdownMenu.LinkItem
              href={`${paths.pull(change.number)}#merge-status`}
              icon={GitMergeIcon}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                navigate(`${paths.pull(change.number)}#merge-status`);
                const box = document.getElementById('merge-status');
                box?.scrollIntoView({ block: 'center' });
                box?.focus({ preventScroll: true });
              }}
            >
              View merge
            </DropdownMenu.LinkItem>
          ) : null}
          {change.github?.url ? (
            <DropdownMenu.LinkItem href={change.github.url} target="_blank" rel="noreferrer" icon={ArrowSquareOutIcon}>
              Open on GitHub
            </DropdownMenu.LinkItem>
          ) : null}
          {CLOSABLE.has(change.status) ? (
            <DropdownMenu.Item icon={ProhibitIcon} variant="danger" disabled={!!blocker} title={blocker ?? undefined} onClick={() => setClosing(true)}>
              Close pull request
            </DropdownMenu.Item>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu>
      <ConfirmDialog
        open={closing}
        title={`Close #${change.number}?`}
        description="It will not merge."
        confirmLabel="Close pull request"
        onClose={() => setClosing(false)}
        onConfirm={async () => {
          onUpdated(await changes.close(change.id, 'rejected'));
          toasts.add({ title: 'Closed', description: `#${change.number} ${change.title}` });
          refreshLive('changes');
          refreshLive('queue');
        }}
      />
    </>
  );
}

/** One pull request, laid out as on GitHub: title and state, Conversation, Checks and Files changed, and the merge box. */
export function PullScreen() {
  const snapshot = useSnapshot();
  const route = useRoute();
  const now = useNow();
  const reference = route.id ?? '';
  const [comment, setComment] = useState('');
  useEffect(() => setComment(''), [reference]);
  const tab: PullTab = route.sub === 'checks' ? 'checks' : route.sub === 'files' ? 'files' : route.sub === 'guide' ? 'guide' : 'conversation';
  const key = `changes:item:${reference}`;
  const live = useLive(reference ? key : null, () => changes.get(reference), changeInterval);
  const policy = useLive('policy', changes.policy, 60_000);
  const change = live.data;
  // Start the selected guide while its screen chunk loads.
  useGuide(change, tab === 'guide');
  const openPath = route.query.get('file');
  // Files changed can compare against an earlier revision of the same pull request.
  const sinceQuery = Number(route.query.get('since'));
  const since = change && Number.isInteger(sinceQuery) && sinceQuery >= 1 && sinceQuery < change.revision ? sinceQuery : null;

  useEffect(() => {
    if (tab === 'guide') void guideTab.prefetch();
    if (tab !== 'files') return;
    // The chunk and first diff can load while the page still holds its skeleton.
    void filesTab.prefetch();
    if (change && !since) prefetchFirstDiff(change, openPath);
  }, [tab, change, since, openPath]);

  useEffect(() => {
    if (route.hash === 'merge-status' && change && tab === 'conversation') {
      const box = document.getElementById('merge-status');
      box?.scrollIntoView({ block: 'center' });
      box?.focus({ preventScroll: true });
    }
  }, [route.hash, tab, change?.id]);

  useDocumentTitle(change ? `${change.title} · #${change.number} · Braid` : 'Pull request · Braid');

  const project = snapshot.project.id;
  const number = change?.number;
  const title = change?.title;
  useEffect(() => {
    if (number && title) recordRecent(project, { kind: 'pull', href: paths.pull(number), title: `#${number} ${title}` });
  }, [project, number, title]);

  if (live.error && !change) {
    if (live.errorStatus === 404) {
      return (
        <div className="page">
          <PageState title="Pull request not found"><LinkButton href={paths.pulls()}>Pull requests</LinkButton></PageState>
        </div>
      );
    }
    return (
      <div className="page">
        <ErrorPanel title="Couldn’t load this pull request" message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} />
      </div>
    );
  }
  if (!change) return <PullSkeleton route={route} />;

  const state = pullState(change.status);
  const branch = snapshot.project.branch || 'main';
  const question = questionFor(change, policy.data?.policy);
  // What the merge box says below, so the timeline does not say it again.
  const quoted = question?.detail ?? sentBackDetail(change);
  const update = (next: Change) => setLive(key, next);
  const task = change.taskId ? snapshot.missions.find((mission) => mission.id === change.taskId) : undefined;
  const files = plural(change.files.length, 'file');
  const warmTab = (value: PullTab) => {
    if (!canPrefetch()) return;
    prefetchHref(paths.pull(change.number, { tab: value }));
    if (value === 'files') {
      void filesTab.prefetch();
      prefetchFirstDiff(change);
    }
    if (value === 'guide') void guideTab.prefetch();
  };
  const tabs: TabsItem[] = (
    [
      { value: 'conversation', label: 'Conversation', count: change.commentCount ?? 0 },
      { value: 'guide', label: 'Guide', count: 0 },
      { value: 'checks', label: 'Checks', count: checkRowCount(change, policy.data?.policy) },
      { value: 'files', label: 'Files changed', count: change.files.length },
    ] as const
  ).map((item) => ({
    value: item.value,
    className: 'pull-tab',
    nativeButton: false,
    label: (
      <span className="pull-tab__label">
        {item.label}
        {item.count ? <span className="tab-count">{item.count}</span> : null}
      </span>
    ),
    render: (props) => (
      <a
        {...props}
        href={paths.pull(change.number, { tab: item.value })}
        onPointerEnter={() => warmTab(item.value)}
        onPointerDown={() => warmTab(item.value)}
        onFocus={(event) => {
          props.onFocus?.(event);
          warmTab(item.value);
        }}
        onClick={(event) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          props.onClick?.(event);
          navigate(paths.pull(change.number, { tab: item.value }));
        }}
      />
    ),
  }));

  return (
    <div className="page pull">
      {live.error ? (
        <div className="notice">
          <ErrorNotice message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} />
        </div>
      ) : null}
      <header className="pull-head">
        <h1 className="pull-head__title">
          {change.title} <span className="pull-head__num">#{change.number}</span>
        </h1>
        <div className="pull-head__meta">
          <PullStateBadge status={change.status} />
          <AuthorChip author={change.author} />
          <span>
            {state === 'merged' ? 'merged' : state === 'closed' ? 'wanted to merge' : 'wants to merge'} {files} into <span className="branch-chip">{branch}</span>
          </span>
          <span className="pull-head__right">
            {change.status !== 'landed' ? <RouterLink
              href={change.status === 'queued' || change.status === 'landing' ? paths.queue() : `${paths.pull(change.number)}#merge-status`}
              className="pull-head__next"
              data-status={change.status}
              onClick={(event) => {
                if (tab === 'conversation' && isPlainLeftClick(event)) {
                  const box = document.getElementById('merge-status');
                  box?.scrollIntoView({ block: 'center' });
                  box?.focus({ preventScroll: true });
                }
              }}
            >
              {change.status === 'attention' ? 'Review required' : change.status === 'revise' ? 'Changes requested' : change.status === 'queued' ? 'Queued to merge' : change.status === 'landing' ? 'Merging' : 'Merge status'}
            </RouterLink> : null}
            <Stats additions={change.additions} deletions={change.deletions} className="pull-head__stats" />
            <HeaderMenu change={change} onUpdated={update} />
          </span>
        </div>
        <StackLinks change={change} />
        <Tabs variant="underline" className="pull-tabs" listClassName="pull-tabs__list" value={tab} onValueChange={(value) => navigate(paths.pull(change.number, { tab: value as PullTab }))} tabs={tabs} />
      </header>

      <div className="pull-body" data-tab={tab}>
        <div className="pull-main">
          {tab === 'conversation' ? (
            <>
              <Conversation change={change} now={now} quoted={quoted} onUpdated={update} localActivity={snapshot.capabilities.mode === 'live' && !!snapshot.capabilities.identity} hostedAgents={task?.source === 'live' ? task.agents : undefined} />
              <CommentComposer change={change} onUpdated={update} value={comment} onValueChange={setComment} />
              <MergeBox change={change} policy={policy.data?.policy} branch={branch} onUpdated={update} comment={comment} onCommentUsed={() => setComment('')} />
            </>
          ) : tab === 'checks' ? (
            <Checks change={change} policy={policy.data?.policy} />
          ) : tab === 'guide' ? (
            <GuideTab key={`${change.id}:${change.revision}`} change={change} />
          ) : (
            <FilesChanged key={`${change.id}:${change.revision}:${since ?? 'all'}`} change={change} since={since} focus={openPath} onUpdated={update} notice={change.status === 'revise' ? <Conflicts change={change} branch={branch} /> : null} />
          )}
        </div>
        {tab === 'conversation' ? (
          <aside className="pull-side" aria-label="About this pull request">
            <div className="pull-side__group">
              <h3 className="pull-side__title">Reviewers</h3>
              <Reviewers change={change} policy={policy.data?.policy} />
            </div>
            {change.label || change.author.kind === 'simulated' ? (
              <div className="pull-side__group">
                <h3 className="pull-side__title">Labels</h3>
                <p className="pull-side__labels">
                  {change.label ? <Label tone={labelTone(change.status)}>{change.label}</Label> : null}
                  {change.author.kind === 'simulated' ? <Label tone="simulated">simulated</Label> : null}
                </p>
              </div>
            ) : null}
            {change.taskId ? (
              <div className="pull-side__group">
                <h3 className="pull-side__title">Agent task</h3>
                <RouterLink href={paths.task(change.taskId)} className="text-link">
                  {task?.title ?? 'Task'}
                </RouterLink>
              </div>
            ) : null}
            {change.github?.url ? (
              <div className="pull-side__group">
                <h3 className="pull-side__title">GitHub</h3>
                <a href={change.github.url} target="_blank" rel="noreferrer" className="text-link pull-side__github">
                  <GithubLogoIcon size={14} aria-hidden="true" />
                  {change.github.pullNumber ? `#${change.github.pullNumber}` : 'Pull request'}
                </a>
              </div>
            ) : null}
            {change.overlaps.length ? (
              <div className="pull-side__group">
                <h3 className="pull-side__title">Also changing these files</h3>
                <ul className="pull-side__list">
                  {change.overlaps.slice(0, 6).map((overlap) => (
                    <li key={overlap.changeId}>
                      <RouterLink href={paths.pull(overlap.number)} className="text-link">
                        #{overlap.number} {overlap.title}
                      </RouterLink>
                    </li>
                  ))}
                  {change.overlaps.length > 6 ? <li className="quiet">+{change.overlaps.length - 6} more</li> : null}
                </ul>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
