import './dialogs.css';
import { useState } from 'react';
import { CommandPalette } from '@cloudflare/kumo';
import { CompassIcon, GearSixIcon, GitBranchIcon, HouseIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { accountOwners } from '../../../shared/account';
import { useAccount } from '../../account/AccountProvider';
import { EXAMPLE_ADDRESS, navigate, paths } from '../../lib/router';
import { CREATE_LINKS } from './HeaderLinks';

/** Site search shares the repository palette's shortcut and searches the person's repositories. */
export function SiteCommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { account } = useAccount();
  const [query, setQuery] = useState('');
  const text = query.trim().toLowerCase();
  const items = [
    ...(account?.user ? [
      { label: 'Dashboard', href: paths.site, icon: HouseIcon },
      { label: 'Settings', href: paths.accountSettings, icon: GearSixIcon },
      ...CREATE_LINKS,
    ] : []),
    { label: 'Explore', href: paths.explore, icon: CompassIcon },
    { label: 'Tour', href: () => paths.repo(EXAMPLE_ADDRESS), icon: GitBranchIcon },
    ...accountOwners(account).flatMap(owner => owner.workspaces.map(repo => ({ label: `${owner.slug} / ${repo.name}`, href: () => paths.repo({ owner: owner.slug, repo: repo.slug }), icon: GitBranchIcon }))),
  ].filter(item => text.split(/\s+/).every(word => item.label.toLowerCase().includes(word)));
  if (text) items.push(
    { label: `Search code for “${query.trim()}”`, href: () => paths.globalSearch(query.trim()), icon: MagnifyingGlassIcon },
    { label: `Search public repositories for “${query.trim()}”`, href: () => `${paths.explore()}?q=${encodeURIComponent(query.trim())}`, icon: MagnifyingGlassIcon },
  );
  const close = (next: boolean) => { onOpenChange(next); if (!next) setQuery(''); };
  const select = (item: typeof items[number]) => { close(false); navigate(item.href()); };
  return <CommandPalette.Root open={open} onOpenChange={close} items={items} value={query} onValueChange={setQuery} itemToStringValue={item => item.label} onSelect={select}>
    <CommandPalette.Input placeholder="Search or jump to…" autoComplete="off" spellCheck={false} />
    <CommandPalette.List><CommandPalette.Results>{(item: typeof items[number]) => <CommandPalette.Item key={item.label} value={item} onClick={() => select(item)}><span className="palette-item"><item.icon size={16} aria-hidden="true" /><span className="palette-item__title">{item.label}</span></span></CommandPalette.Item>}</CommandPalette.Results><CommandPalette.Empty>No matches</CommandPalette.Empty></CommandPalette.List>
  </CommandPalette.Root>;
}
