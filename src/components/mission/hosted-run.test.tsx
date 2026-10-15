import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Agent } from '../../../shared/types';
import { HostedAgentRun } from './HostedRun';

vi.mock('../agents/ActivitySummary', () => ({ ActivitySummary: () => null }));

const agent = (environment: Agent['environment']) => ({ id: 'a', name: 'Claude Haiku 5.5', status: 'working', environment }) as unknown as Agent;
const preflight = { commit: 'c', checks: [], runtimes: [{ name: 'Go' as const, version: '1.24', path: 'go.mod' }], lockfiles: ['go.sum'], missing: [] };

it('shows the commands the agent prepared the repository with when no setup is configured', () => {
  const html = renderToStaticMarkup(<HostedAgentRun agent={agent({ status: 'running', preflight, prepared: [{ command: 'mise use go@1.24', status: 'passed' }, { command: 'go mod download', status: 'failed' }] })} />);
  expect(html).toContain('Prepared by the agent');
  expect(html).toContain('mise use go@1.24\ngo mod download  # failed');
  expect(renderToStaticMarkup(<HostedAgentRun agent={agent({ status: 'running', preflight })} />)).toContain('Not configured');
  expect(renderToStaticMarkup(<HostedAgentRun agent={agent({ status: 'running', preflight: { ...preflight, setup: 'make deps' } })} />)).toContain('<code>make deps</code>');
});
it('keeps configured setup failures and subsequent repairs visible with actual final checks', () => {
  const lane = agent({ status: 'completed', preflight: { ...preflight, setup: 'npm ci', checks: ['npm test'], runtimes: [] }, prepared: [{ command: 'npm ci', status: 'failed' }, { command: 'pnpm install --frozen-lockfile', status: 'passed' }] });
  lane.checks = [{ kind: 'runtime', label: 'pnpm test', status: 'passed', detail: 'exit 0' }];
  const html = renderToStaticMarkup(<HostedAgentRun agent={lane} />);
  expect(html).toContain('npm ci  # failed\npnpm install --frozen-lockfile');
  expect(html).toContain('pnpm test  # passed'); expect(html).not.toContain('No version declared');
});

it('shows a timed-out command once with its limit and elapsed duration', () => {
  const command = 'go build ./cmd/lecrev';
  const lane = agent({ status: 'failed', failure: { cause: 'timeout', phase: 'command', message: 'Vague', action: 'more_time', retryable: false,
    evidence: Object.assign({ source: 'process' as const, operation: command, timedOut: true }, { limitKind: 'command' as const, timeoutMs: 180_000, elapsedMs: 180_619 }), output: '', at: '2026-10-14T15:58:48Z' } });
  const html = renderToStaticMarkup(<HostedAgentRun agent={lane} />);
  expect(html.split(command)).toHaveLength(2); expect(html).toContain('ran past its 3-minute limit'); expect(html).toContain('181s elapsed');
});
