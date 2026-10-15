import { BuildingsIcon, DownloadSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { paths } from '../../lib/router';

export const CREATE_LINKS = [
  { label: 'New repository', href: () => paths.newRepository(), icon: PlusIcon },
  { label: 'Import repository', href: () => paths.newRepository(undefined, true), icon: DownloadSimpleIcon },
  { label: 'New organization', href: () => paths.newOrganization(), icon: BuildingsIcon },
];
