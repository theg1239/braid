import { describe, expect, it, vi } from 'vitest';
import { dependencyReview } from './advisories';
import type { Dependency } from '../../shared/dependencies';

const npm = (name: string, version: string): Dependency => ({ ecosystem: 'npm', name, version, path: 'package-lock.json' });
function osv(vulns: Record<string, string[]>, severities: Record<string, string>) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/querybatch')) {
      const { queries } = JSON.parse(String(init!.body)) as { queries: { package: { name: string }; version: string }[] };
      return Response.json({ results: queries.map(query => ({ vulns: (vulns[`${query.package.name}@${query.version}`] ?? []).map(id => ({ id })) })) });
    }
    const id = decodeURIComponent(input.split('/').pop()!);
    return Response.json({ id, summary: `Advisory ${id}`, database_specific: severities[id] ? { severity: severities[id] } : {} });
  }) as unknown as typeof fetch;
}

describe('dependency review on OSV.dev', () => {
  it('fails on a malicious package or a high-severity advisory and names it', async () => {
    const result = await dependencyReview([npm('left-pad', '1.3.0'), npm('lodash', '4.17.20'), npm('evil-pkg', '1.0.0')], 'block',
      osv({ 'lodash@4.17.20': ['GHSA-35jh-r3h4-6jhm'], 'evil-pkg@1.0.0': ['MAL-2026-1234'] }, { 'GHSA-35jh-r3h4-6jhm': 'HIGH' }));
    expect(result).toMatchObject({ kind: 'dependencies', label: 'Dependency review', status: 'failed', source: 'braid' });
    expect(result!.detail.split('\n')).toEqual([
      'evil-pkg@1.0.0: reported as malicious (MAL-2026-1234), Advisory MAL-2026-1234.',
      'lodash@4.17.20: high severity (GHSA-35jh-r3h4-6jhm), Advisory GHSA-35jh-r3h4-6jhm.',
      'From OSV.dev.',
    ]);
  });

  it('only warns when the policy says so, or for lower severities', async () => {
    const fetcher = osv({ 'lodash@4.17.20': ['GHSA-35jh-r3h4-6jhm'] }, { 'GHSA-35jh-r3h4-6jhm': 'HIGH' });
    expect(await dependencyReview([npm('lodash', '4.17.20')], 'warn', fetcher)).toMatchObject({ status: 'warning' });
    expect(await dependencyReview([npm('ms', '2.0.0')], 'block', osv({ 'ms@2.0.0': ['GHSA-low'] }, { 'GHSA-low': 'LOW' }))).toMatchObject({ status: 'warning' });
  });

  it('passes a clean lookup, skips when off, and never passes when OSV is unreachable', async () => {
    expect(await dependencyReview([npm('hono', '4.6.0')], 'block', osv({}, {}))).toMatchObject({ status: 'passed', detail: expect.stringContaining('1 dependency version this change adds') });
    expect(await dependencyReview([npm('hono', '4.6.0')], 'off', osv({}, {}))).toBeNull();
    expect(await dependencyReview([], 'block', osv({}, {}))).toBeNull();
    const down = vi.fn(async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await dependencyReview([npm('hono', '4.6.0')], 'block', down)).toMatchObject({ status: 'warning', detail: expect.stringContaining('could not be reached') });
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(['dependency_review_failed']);
    warn.mockRestore();
  });
});
