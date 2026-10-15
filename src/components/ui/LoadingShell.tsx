import { useContext } from 'react';
import { isExample, useRoute, type Screen } from '../../lib/router';
import { RepositoryHeader } from '../shell/RepositoryHeader';
import { ExampleBanner } from '../shell/ExampleBanner';
import { SitePage } from '../shell/SiteBar';
import { LoadingContent } from './LoadingContent';
import { ScreenSkeleton } from './ScreenSkeleton';

/** The URL gives the frame even while the account and repository address are unresolved. */
export function LoadingShell({ label, screen }: { label?: string; screen?: Screen }) {
  const current = useRoute();
  const contentOnly = useContext(LoadingContent);
  const route = screen ? { ...current, screen } : current;
  const content = <ScreenSkeleton route={route} />;
  if (contentOnly) return content;
  if (!route.repo) return <SitePage>{content}</SitePage>;
  return <div className="app" aria-label={label}>
    <a href="#main" className="skip-link">Skip to content</a>
    <RepositoryHeader snapshot={null} screen={route.screen === 'home' ? 'code' : route.screen} address={route.repo} visibility={isExample(route.repo) ? 'public' : null} />
    {isExample(route.repo) ? <ExampleBanner /> : null}
    <main id="main" className="main" tabIndex={-1}>{content}</main>
  </div>;
}
