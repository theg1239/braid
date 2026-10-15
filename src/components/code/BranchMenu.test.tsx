import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../shared/types';
import { textOf } from '../../test/fixtures';
import { BranchMenu } from './BranchMenu';

const state = vi.hoisted(() => ({ project: {} as Project, branchCopy: undefined as { remaining: number } | undefined }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => state }));
vi.mock('../../lib/router', () => ({ paths: { code: (_path: string, { ref }: { ref: string }) => `/example/relay/tree/${encodeURIComponent(ref)}`, branches: () => '/example/relay/branches' } }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
// Only portals are replaced; branch rows and their links are the production component.
vi.mock('@cloudflare/kumo', async original => {
  const actual = await original<typeof import('@cloudflare/kumo')>();
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return { ...actual, Popover: Object.assign(Wrapper, { Trigger: ({ render }: { render: ReactNode }) => render, Content: Wrapper, Title: Wrapper }) };
});
const html = () => renderToStaticMarkup(<BranchMenu current={state.project.branch} />);
beforeEach(() => { state.project = { id: 'relay', name: 'relay', description: '', branch: 'main', head: 'a'.repeat(40), stack: [] }; state.branchCopy = undefined; });

describe('branch menu snapshot refs', () => {
  it('shows the recorded proposal immediately after the default branch', () => {
    state.project.branches = ['main', 'refund-rounding'];
    const out = html();
    expect(textOf(out)).toMatch(/main default refund-rounding View all branches/);
    expect(out).toContain('href="/example/relay/tree/refund-rounding"');
    expect(out).toContain('href="/example/relay/branches"');
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
  });
  it('keeps imported branch order and slash refs while more branches are copied', () => {
    state.project.branch = 'stable'; state.project.branches = ['stable', 'feature/retries', 'release']; state.branchCopy = { remaining: 3 };
    const out = html();
    expect(textOf(out)).toMatch(/stable default feature\/retries release Copying 3 more/);
    expect(out).toContain('href="/example/relay/tree/feature%2Fretries"');
    expect(out).not.toContain('refund-rounding');
  });
  it.each([undefined, []])('keeps a new repository usable with branch metadata %j', branches => {
    state.project.branches = branches; state.project.head = '';
    const out = html();
    expect(textOf(out)).toContain('main default View all branches');
    expect(out).not.toContain('refund-rounding');
    expect(out.match(/class="branch-menu__name"/g)).toHaveLength(1);
  });
});
