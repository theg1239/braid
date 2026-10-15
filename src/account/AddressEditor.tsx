import type { ReactNode } from 'react';
import { SLUG } from '../../shared/routes';
import { InlineEdit } from '../components/settings/InlineEdit';

export function AddressEditor({ label, slug, display, save }: { label: string; slug: string; display?: ReactNode; save: (slug: string) => Promise<void> }) {
  return <InlineEdit label={label} value={slug} display={display ?? <span className="srow__value mono">{slug}</span>} action="Change" maxLength={39} validate={value => SLUG.test(value) ? null : 'Use 1–39 lowercase letters, digits and single hyphens.'} save={save} />;
}
