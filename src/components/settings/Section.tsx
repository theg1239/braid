import type { ReactNode } from 'react';
import { LayerCard } from '@cloudflare/kumo';
import { SkeletonBox, SkeletonRows } from '../ui/Skeleton';
import '../../styles/settings.css';

/**
 * One settings card. The id is the anchor settings links point at; a title is optional, since a
 * card under a page of the same name says nothing by repeating it. With `rows`, the body is a
 * list of rows and `foot` holds the card's one action.
 */
export function Section({ id, title, children, aside, rows = false, foot, danger = false }: { id: string; title?: string; children: ReactNode; aside?: ReactNode; rows?: boolean; foot?: ReactNode; danger?: boolean }) {
  return (
    <section id={id} className={`settings-section${danger ? ' settings-section--danger' : ''}`} aria-labelledby={title ? `${id}-title` : undefined}>
      <LayerCard>
        {title || aside ? (
          <LayerCard.Secondary className="settings-section__head">
            {title ? (
              <h2 id={`${id}-title`} className="settings-section__title">
                {title}
              </h2>
            ) : (
              <span />
            )}
            {aside}
          </LayerCard.Secondary>
        ) : null}
        <LayerCard.Primary className={rows ? 'settings-section__body settings-section__body--rows' : 'settings-section__body'}>{children}</LayerCard.Primary>
        {foot ? <div className="settings-section__foot">{foot}</div> : null}
      </LayerCard>
    </section>
  );
}

export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <p className="settings-empty">{children}</p>;
}

export function SettingsError({ children }: { children: ReactNode }) {
  return <span className="settings-error" role="alert">{children}</span>;
}

/** One settings row: a label and an optional one-line hint on the left, the value or control on the right. */
export function Row({ label, hint, children, compact = false }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={compact ? 'srow srow--compact' : 'srow'}>
      <div className="srow__text">
        <span className="srow__label">{label}</span>
        {hint ? <span className="srow__hint">{hint}</span> : null}
      </div>
      {children ? <div className="srow__control">{children}</div> : null}
    </div>
  );
}

/** A settings card still being read, in the shape it will take. */
export function SettingsSkeleton({ label }: { label: string }) {
  return <SkeletonBox><SkeletonRows rows={3} label={label} /></SkeletonBox>;
}

/** Paths, commands and blocked strings, each as a code chip. */
export function Chips({ values }: { values: string[] }) {
  return (
    <>
      {values.map((value) => (
        <span key={value} className="mono rules__pattern">
          {value}
        </span>
      ))}
    </>
  );
}
