import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubLinkStatus } from '../../../shared/types';
import { textOf } from '../../test/fixtures';
import { GitHubSummary } from './GitHubSummary';

vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-13T12:10:00Z') }));
const link: GitHubLinkStatus = { fullName: 'acme/relay', defaultBranch: 'main', mode: 'pull-requests', status: 'synced', linkedBy: 'Maya Chen', linkedAt: '2026-10-13T12:00:00Z', mirroredHead: 'a'.repeat(40) };

describe('GitHub summary', () => {
  it('shows the recorded login and repository without a fictional GitHub link', () => {
    const before = structuredClone(link);
    const html = renderToStaticMarkup(<GitHubSummary link={link} recorded />);
    expect(textOf(html)).toContain('acme/relay'); expect(textOf(html)).toContain('by @maya-chen');
    expect(html).not.toContain('Maya Chen'); expect(html).not.toContain('<a ');
    expect(textOf(html)).toContain('Through pull requests on main');
    expect(link).toEqual(before);
  });
  it('retains the real repository link and stored login on live repositories', () => {
    const html = renderToStaticMarkup(<GitHubSummary link={{ ...link, fullName: 'octocat/hello-world', linkedBy: '@octocat' }} />);
    expect(html).toContain('href="https://github.com/octocat/hello-world"'); expect(html).toContain('rel="noreferrer"');
    expect(textOf(html)).toContain('by @octocat'); expect(html).not.toContain('@maya-chen');
  });
  it('does not treat a live repository as recorded just because its name matches', () => {
    const html = renderToStaticMarkup(<GitHubSummary link={{ ...link, linkedBy: '@real-owner' }} />);
    expect(html).toContain('href="https://github.com/acme/relay"'); expect(textOf(html)).toContain('by @real-owner');
  });
});
