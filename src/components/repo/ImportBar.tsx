import { GithubLogoIcon } from '@phosphor-icons/react';
import type { ProjectImport } from '../../../shared/types';
import { durationLabel } from '../mission/timing';
import { useNow } from '../../lib/hooks';
import '../../styles/code.css';

/** An import still copying, where the latest commit goes: its files are already read from the source meanwhile. */
export function ImportBar({ importing }: { importing: ProjectImport }) {
  const now = useNow(1000);
  return (
    <div className="commit-bar import-bar" role="status">
      <span className="commit-bar__author import-bar__label">
        <GithubLogoIcon size={15} aria-hidden="true" />
        Copying from GitHub
      </span>
      <span className="commit-bar__right import-bar__time" aria-live="off">{durationLabel(now - Date.parse(importing.startedAt))}</span>
    </div>
  );
}
