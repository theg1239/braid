import './dialogs.css';
import { useMirror } from '../../account/mirrors';
import { useMemo, useState, type ReactNode } from 'react';
import { CommandPalette } from '@cloudflare/kumo';
import { ArrowClockwiseIcon, CodeIcon, CompassIcon, CopyIcon, FileIcon, GearSixIcon, GitMergeIcon, GitPullRequestIcon, KeyIcon, MagnifyingGlassIcon, PlusIcon, RobotIcon, ShieldCheckIcon, StackIcon, UsersIcon } from '@phosphor-icons/react';
import type { ChangeSummary, WorkspaceSnapshot } from '../../../shared/types';
import { listInterval } from '../../lib/lists';
import { pullState } from '../../lib/changes';
import { phaseLabel, sortByNewest } from '../../lib/derive';
import { isModifierKey } from '../../lib/format';
import { useCopy } from '../../lib/hooks';
import { useLive } from '../../lib/live';
import { ATTENTION_KEY, SEARCH_KEY, attentionList, searchList } from '../../lib/needs';
import { paletteOpener, type PaletteScope } from '../../lib/palette';
import { readRecent, type RecentKind } from '../../lib/recent';
import { navigate, paths } from '../../lib/router';
import { canWrite, newMissionBlocker, useWorkspace } from '../../store/workspace';
import { useAccount } from '../../account/AccountProvider';
import { setupPrompt } from '../../lib/agent-commands';
import { Kbd } from '../ui/Kbd';

interface Command {
  id: string;
  title: string;
  hint?: string;
  /** Keys that run it from anywhere, shown on the row. */
  keys?: string[];
  keywords?: string;
  icon: ReactNode;
  run: () => void;
}

interface CommandGroup {
  id: string;
  label: string;
  items: Command[];
}

const ICON = { size: 16 } as const;
const IDLE_LIMIT: Record<string, number> = { recent: 4, review: 5, pulls: 0, tasks: 6, files: 6 };
const RECENT_ICON: Record<RecentKind, ReactNode> = { pull: <GitPullRequestIcon {...ICON} />, task: <StackIcon {...ICON} />, file: <FileIcon {...ICON} /> };

export function CommandMenu({ open, onOpenChange, snapshot, onNewTask, scope, onScopeChange }: { open: boolean; onOpenChange: (open: boolean) => void; snapshot: WorkspaceSnapshot | null; onNewTask: () => void; scope: PaletteScope; onScopeChange: (scope: PaletteScope) => void }) {
  const { refresh } = useWorkspace();
  const { accounts, account } = useAccount();
  const mirror = useMirror();
  const [, copy] = useCopy();
  const [query, setQuery] = useState('');
  const attention = useLive(snapshot?.project.id ? ATTENTION_KEY : null, attentionList, listInterval);
  const needsReview = attention.data;
  const project = snapshot?.project.id ?? '';
  // Every pull request a search can find, read while the menu is open; the pull list's filter box shares it.
  const latest = useLive(open && project ? SEARCH_KEY : null, searchList, listInterval);
  const loaded = latest.data;

  // Kumo's palette opens without a trigger, so closing would drop focus on the body: it goes back to where the menu was asked for.
  const close = () => {
    onOpenChange(false);
    setQuery('');
    paletteOpener()?.focus();
  };
  /** The palette's dialog has no name of its own; it takes one when its list mounts. */
  const nameDialog = (list: HTMLElement | null) => {
    list?.closest('[role="dialog"]')?.setAttribute('aria-label', 'Search or jump to');
  };

  const groups = useMemo<CommandGroup[]>(() => {
    const go = (to: string) => () => navigate(to);
    const files: Command[] = snapshot
      ? Object.keys(snapshot.files)
          .sort()
          .map((path) => ({ id: `file-${path}`, title: path, icon: <FileIcon {...ICON} />, run: go(paths.code(path, { kind: 'file' })) }))
      : [];
    if (scope === 'files') return [{ id: 'files', label: 'Files', items: files }];

    const recent: Command[] = readRecent(project).map((item) => ({ id: `recent-${item.href}`, title: item.title, icon: RECENT_ICON[item.kind], run: go(item.href) }));

    const actions: Command[] = [];
    if (!newMissionBlocker(snapshot)) actions.push({ id: 'new-task', title: 'New task', keys: ['n'], keywords: 'ask agents create start', icon: <PlusIcon {...ICON} />, run: onNewTask });
    if (files.length) actions.push({ id: 'go-to-file', title: 'Go to file', keys: ['t'], keywords: 'find open path', icon: <MagnifyingGlassIcon {...ICON} />, run: () => onScopeChange('files') });
    if (snapshot && !snapshot.project.id && canWrite(snapshot)) actions.push({ id: 'setup', title: 'Set up repository', keywords: 'create import', icon: <CodeIcon {...ICON} />, run: go(paths.settings()) });
    if (snapshot?.capabilities.mode === 'demo') {
      if (!accounts) actions.push({ id: 'unlock', title: 'Use your own repository', keywords: 'owner key unlock login live', icon: <KeyIcon {...ICON} />, run: go(paths.settings('account')) });
      if (canWrite(snapshot)) actions.push({ id: 'reset', title: 'Reset the example', keywords: 'clear seed restart recorded demo', icon: <ArrowClockwiseIcon {...ICON} />, run: go(paths.settings()) });
    } else if (snapshot && !accounts) {
      actions.push({ id: 'lock', title: 'Lock workspace', keywords: 'logout sign out demo', icon: <KeyIcon {...ICON} />, run: go(paths.settings('account')) });
    }
    if (accounts && account?.user) {
      if (!mirror) actions.push({ id: 'prompt', title: 'Copy setup prompt', keywords: 'agent connect onboard', icon: <CopyIcon {...ICON} />, run: () => void copy(setupPrompt(), 'prompt') });
      if (!mirror) actions.push({ id: 'collaborators', title: 'Collaborators', keywords: 'team invite people owners members', icon: <UsersIcon {...ICON} />, run: go(paths.settings('collaborators')) });
      actions.push({ id: 'repositories', title: 'Your repositories', keywords: 'dashboard home teams', icon: <StackIcon {...ICON} />, run: go(paths.site()) });
    }
    if (accounts) actions.push({ id: 'explore', title: 'Explore public repositories', keywords: 'browse discover', icon: <CompassIcon {...ICON} />, run: go(paths.explore()) });
    if (accounts && !account?.user) actions.push({ id: 'signin', title: 'Sign in', keywords: 'login account github', icon: <KeyIcon {...ICON} />, run: go(paths.signin(window.location.pathname + window.location.search)) });
    actions.push({ id: 'refresh', title: 'Refresh', keywords: 'reload sync', icon: <ArrowClockwiseIcon {...ICON} />, run: () => void refresh() });

    const pages: Command[] = [
      { id: 'code', title: 'Code', keys: ['g', 'c'], keywords: 'repository files readme main home', icon: <CodeIcon {...ICON} />, run: go(paths.home()) },
      { id: 'pulls', title: 'Pull requests', keys: ['g', 'p'], keywords: 'changes open closed merged review', icon: <GitPullRequestIcon {...ICON} />, run: go(paths.pulls()) },
      { id: 'queue', title: 'Merge queue', keywords: 'landing pause resume checks', icon: <GitMergeIcon {...ICON} />, run: go(paths.queue()) },
      { id: 'agents', title: 'Agents', keys: ['g', 'a'], keywords: 'tasks missions', icon: <RobotIcon {...ICON} />, run: go(paths.agents()) },
      { id: 'rules', title: 'Rules', keywords: 'policy who decides checks safeguards settings', icon: <GearSixIcon {...ICON} />, run: go(paths.settings('rules')) },
      { id: 'security', title: 'Code security', keywords: 'secret scanning dependency review osv review apps copilot coderabbit code scanning codeql settings', icon: <ShieldCheckIcon {...ICON} />, run: go(paths.settings('security')) },
      { id: 'settings', title: 'Settings', keys: ['g', 's'], keywords: 'repository github agents collaborators account', icon: <GearSixIcon {...ICON} />, run: go(paths.settings()) },
    ];

    const pull = (change: ChangeSummary, keywords: string): Command => ({
      id: `pull-${change.id}`,
      title: `#${change.number} ${change.title}`,
      hint: change.author.name,
      keywords: `#${change.number} ${change.author.name} ${keywords}`,
      icon: pullState(change.status) === 'merged' ? <GitMergeIcon {...ICON} /> : <GitPullRequestIcon {...ICON} />,
      run: go(paths.pull(change.number)),
    });
    const review: Command[] = (needsReview?.items ?? []).map((change) => pull(change, `${change.next ?? ''} review`));
    const reviewing = new Set(review.map((item) => item.id));
    // Searched only: an idle menu leads with what needs the viewer.
    const pulls: Command[] = (loaded?.items ?? []).map((change) => pull(change, pullState(change.status))).filter((item) => !reviewing.has(item.id));

    const tasks: Command[] = snapshot
      ? sortByNewest(snapshot.missions).map((m) => ({
          id: `task-${m.id}`,
          title: m.title,
          hint: phaseLabel(m, snapshot.project.head).label,
          keywords: `${m.intent} ${m.agents.map((a) => a.name).join(' ')}`,
          icon: <StackIcon {...ICON} />,
          run: go(paths.task(m.id)),
        }))
      : [];

    return [
      { id: 'recent', label: 'Recent', items: recent },
      { id: 'actions', label: 'Actions', items: actions },
      { id: 'pages', label: 'Go to', items: mirror ? pages.filter(page => ['code', 'pulls', 'queue'].includes(page.id)) : pages },
      { id: 'review', label: 'Needs your review', items: review },
      { id: 'pulls', label: 'Pull requests', items: pulls },
      { id: 'tasks', label: 'Agent tasks', items: mirror ? [] : tasks },
      { id: 'files', label: 'Files', items: files },
    ];
    // Recents are read when the menu opens; `open` is a dependency for that reason.
  }, [snapshot, onNewTask, refresh, accounts, account, copy, needsReview, loaded, scope, onScopeChange, project, open, mirror]);

  const filtered = useMemo(() => {
    const text = query.trim();
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    // Search the current repository first; searching all repositories needs an account.
    const search: CommandGroup[] =
      text && scope !== 'files' && (project || accounts)
        ? [{ id: 'search', label: 'Code', items: [
          ...(project ? [{ id: 'search-repository', title: `Search code for “${text}”`, hint: 'This repository', icon: <MagnifyingGlassIcon {...ICON} />, run: () => navigate(paths.search(text)) }] : []),
          ...(accounts ? [{ id: 'search-code', title: `Search code for “${text}”`, hint: account?.user ? 'All repositories' : 'All repositories · Sign in', icon: <MagnifyingGlassIcon {...ICON} />, run: () => navigate(account?.user ? paths.globalSearch(text) : paths.signin(paths.globalSearch(text))) }] : []),
        ] }]
        : [];
    const found = groups
      .map((group) => {
        // Recents only lead; a search looks through everything else.
        if (group.id === 'recent' && tokens.length) return { ...group, items: [] };
        const items = tokens.length
          ? group.items.filter((item) => {
              const haystack = `${item.title} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
              return tokens.every((token) => haystack.includes(token));
            })
          : scope === 'files'
            ? group.items
            : group.items.slice(0, IDLE_LIMIT[group.id] ?? group.items.length);
        return { ...group, items };
      })
      .filter((group) => group.items.length > 0);
    return [...found, ...search];
  }, [groups, query, scope, project, accounts, account]);

  const select = (item: Command) => {
    if (item.id === 'go-to-file') {
      setQuery('');
      item.run();
      return;
    }
    const from = window.location.pathname + window.location.search;
    close();
    item.run();
    // A command that opened another page continues on it.
    if (window.location.pathname + window.location.search !== from) document.getElementById('main')?.focus();
  };

  return (
    <CommandPalette.Root
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      items={filtered}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(group: CommandGroup) => group.label}
      getSelectableItems={(list: CommandGroup[]) => list.flatMap((group) => group.items)}
      onSelect={(item: Command) => select(item)}
    >
      <CommandPalette.Input
        placeholder={scope === 'files' ? 'Go to file' : 'Search or jump to…'}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(event) => {
          // ⌘K closes the menu it opened, through the same path as Escape.
          if (isModifierKey(event) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            close();
          }
        }}
      />
      <CommandPalette.List ref={nameDialog}>
        <CommandPalette.Results>
          {(group: CommandGroup) => (
            <CommandPalette.Group key={group.id} items={group.items}>
              <CommandPalette.GroupLabel>{group.label}</CommandPalette.GroupLabel>
              <CommandPalette.Items>
                {(item: Command) => (
                  <CommandPalette.Item key={item.id} value={item} onClick={() => select(item)}>
                    <span className="palette-item">
                      <span className="palette-item__icon">{item.icon}</span>
                      <span className="palette-item__title">{item.title}</span>
                      {item.hint ? <span className="palette-item__hint">{item.hint}</span> : null}
                      {item.keys ? (
                        <span className="palette-item__keys" aria-label={`Shortcut ${item.keys.join(' ')}`}>
                          {item.keys.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </CommandPalette.Item>
                )}
              </CommandPalette.Items>
            </CommandPalette.Group>
          )}
        </CommandPalette.Results>
        <CommandPalette.Empty>No matches</CommandPalette.Empty>
      </CommandPalette.List>
      <CommandPalette.Footer>
        <span className="palette-keys">
          <span>
            <Kbd>↑↓</Kbd> Move
          </span>
          <span>
            <Kbd>↵</Kbd> Open
          </span>
          <span>
            <Kbd>esc</Kbd> Close
          </span>
        </span>
      </CommandPalette.Footer>
    </CommandPalette.Root>
  );
}
