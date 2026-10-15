import { useState } from 'react';
import { Button, Input, Popover } from '@cloudflare/kumo';
import { CaretDownIcon, CheckIcon, GitBranchIcon, GitCommitIcon } from '@phosphor-icons/react';
import { shortHash } from '../../lib/format';
import { paths } from '../../lib/router';
import { useSnapshot } from '../../store/workspace';
import { RouterLink } from '../ui/Link';
import '../../styles/code.css';
import '../../styles/branches.css';

export const referenceLabel = (ref: string) => /^[a-f0-9]{7,40}$/i.test(ref) ? shortHash(ref) : ref;

/** GitHub's branch switcher, shared by browsing and comparing refs. */
export function BranchMenu({ current, label, allowCommit = false, hrefForBranch = name => paths.code('', { ref: name }) }: { current: string; label?: string; allowCommit?: boolean; hrefForBranch?: (name: string) => string }) {
  const { project, branchCopy } = useSnapshot();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const branches = project.branches?.length ? project.branches : [project.branch || 'main'];
  const needle = query.trim().toLowerCase();
  const shown = needle ? branches.filter((name) => name.toLowerCase().includes(needle)) : branches;
  const display = referenceLabel(current);
  const commit = allowCommit && /^[a-f0-9]{7,40}$/i.test(query.trim()) ? query.trim().toLowerCase() : null;
  const find = allowCommit ? 'Find a branch or commit' : 'Find a branch';
  const toggle = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  };
  return (
    <Popover open={open} onOpenChange={toggle}>
      <Popover.Trigger
        render={
          <Button size="sm" variant="secondary" icon={GitBranchIcon} className="branch-menu__trigger" aria-label={label ? `${label}: ${display}` : `Switch branch: ${display}`}>
            <span className="branch-menu__current">{label ? <span className="quiet">{label}: </span> : null}{display}</span>
            <CaretDownIcon size={12} aria-hidden="true" />
          </Button>
        }
      />
      <Popover.Content align="start" className="branch-menu">
        <Popover.Title className="sr-only">Switch branch</Popover.Title>
        <Input aria-label={find} placeholder={find} value={query} onChange={(event) => setQuery(event.target.value)} autoFocus passwordManagerIgnore />
        <ul className="branch-menu__list" aria-label="Branches">
          {shown.map((name) => (
            <li key={name}>
              <RouterLink href={hrefForBranch(name)} className="branch-menu__item" aria-current={name === current ? 'page' : undefined} onClick={() => toggle(false)}>
                <CheckIcon size={13} weight="bold" className="branch-menu__check" aria-hidden="true" />
                <span className="branch-menu__name">{name}</span>
                {name === project.branch ? <span className="branch-menu__default">default</span> : null}
              </RouterLink>
            </li>
          ))}
          {commit ? <li><RouterLink href={hrefForBranch(commit)} className="branch-menu__item" onClick={() => toggle(false)}><GitCommitIcon size={13} aria-hidden="true" /><span className="branch-menu__name">{referenceLabel(commit)}</span></RouterLink></li> : null}
          {shown.length || commit ? null : <li className="branch-menu__empty">No branch matches</li>}
        </ul>
        {branchCopy ? <p className="branch-menu__copying">{branchCopy.remaining ? `Copying ${branchCopy.remaining} more` : 'Copying branches'}</p> : null}
        <RouterLink href={paths.branches()} className="branch-menu__all" onClick={() => toggle(false)}>View all branches</RouterLink>
      </Popover.Content>
    </Popover>
  );
}
