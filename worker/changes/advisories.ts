import * as v from 'valibot';
import type { ChangeCheck } from '../../shared/types';
import type { Dependency } from '../../shared/dependencies';
import type { Policy } from '../../shared/policy';
import { plural } from '../../shared/labels';
import { logFailure } from '../errors';

type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
const OSV = 'https://api.osv.dev/v1';
const RANK: Severity[] = ['unknown', 'low', 'moderate', 'high', 'critical'];
/** OSV.dev's answers, reduced to what the check reads; an unrecognised severity counts as unknown. */
const vulnerability = v.object({
  summary: v.optional(v.pipe(v.string(), v.transform(text => text.slice(0, 160))), ''),
  database_specific: v.optional(v.object({ severity: v.fallback(v.pipe(v.string(), v.toLowerCase(), v.picklist(RANK)), 'unknown') }), { severity: 'unknown' }),
});
const batch = v.object({ results: v.array(v.object({ vulns: v.optional(v.array(v.object({ id: v.string() })), []) })) });

/** One advisory's severity and summary. One that cannot be read counts as unknown, so its package still warns rather than passes. */
async function advisory(fetcher: typeof fetch, id: string): Promise<{ severity: Severity; summary: string }> {
  try {
    const response = await fetcher(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) });
    const data = response.ok ? v.safeParse(vulnerability, await response.json()) : null;
    return data?.success ? { severity: data.output.database_specific.severity, summary: data.output.summary } : { severity: 'unknown', summary: '' };
  } catch { return { severity: 'unknown', summary: '' }; }
}

/**
 * Looks up the dependency versions a change adds on OSV.dev, the open
 * vulnerability database that also carries OpenSSF's malicious-package
 * reports. A malicious package or a high or critical advisory fails the check
 * when the policy blocks; anything else is a warning, and so is an
 * unreachable database: missing evidence never counts as a pass.
 */
export async function dependencyReview(dependencies: Dependency[], action: Policy['dependencyReview'], fetcher: typeof fetch = globalThis.fetch): Promise<Omit<ChangeCheck, 'revision'> | null> {
  if (!dependencies.length || action === 'off') return null;
  const label = 'Dependency review';
  try {
    const response = await fetcher(`${OSV}/querybatch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ queries: dependencies.map(dependency => ({ package: { name: dependency.name, ecosystem: dependency.ecosystem }, version: dependency.version })) }),
    });
    if (!response.ok) throw new Error(`OSV answered ${response.status}`);
    const { results } = v.parse(batch, await response.json());
    if (results.length !== dependencies.length) throw new Error('OSV answered for a different set of packages.');
    const hits = dependencies.map((dependency, index) => ({ dependency, ids: results[index].vulns.map(found => found.id) })).filter(hit => hit.ids.length);
    const count = plural(dependencies.length, 'dependency version');
    if (!hits.length) return { kind: 'dependencies', label, status: 'passed', source: 'braid', detail: `OSV.dev lists no known vulnerabilities or malicious packages in the ${count} this change adds.` };
    const ids = [...new Set(hits.flatMap(hit => hit.ids))].slice(0, 25);
    const details = new Map(await Promise.all(ids.map(async id => [id, await advisory(fetcher, id)] as const)));
    const rated = hits.map(hit => {
      const malicious = hit.ids.some(id => id.startsWith('MAL-'));
      const worst = hit.ids.reduce<Severity>((best, id) => { const severity = details.get(id)?.severity ?? 'unknown'; return RANK.indexOf(severity) > RANK.indexOf(best) ? severity : best; }, 'unknown');
      const lead = hit.ids.find(id => id.startsWith('MAL-')) ?? hit.ids.find(id => details.get(id)?.severity === worst) ?? hit.ids[0];
      const summary = details.get(lead)?.summary;
      return { ...hit, malicious, worst, line: `${hit.dependency.name}@${hit.dependency.version}: ${malicious ? 'reported as malicious' : worst === 'unknown' ? 'known vulnerability' : `${worst} severity`} (${lead}${hit.ids.length > 1 ? ` and ${hit.ids.length - 1} more` : ''})${summary ? `, ${summary}` : ''}.` };
    }).sort((a, b) => Number(b.malicious) - Number(a.malicious) || RANK.indexOf(b.worst) - RANK.indexOf(a.worst));
    const blocking = rated.some(hit => hit.malicious || hit.worst === 'high' || hit.worst === 'critical');
    return { kind: 'dependencies', label, status: blocking && action === 'block' ? 'failed' : 'warning', source: 'braid',
      detail: `${rated.slice(0, 5).map(hit => hit.line).join('\n')}${rated.length > 5 ? `\nand ${rated.length - 5} more` : ''}\nFrom OSV.dev.` };
  } catch (error) {
    logFailure('dependency_review_failed', error);
    return { kind: 'dependencies', label, status: 'warning', source: 'braid', detail: 'OSV.dev could not be reached, so the dependencies this change adds were not checked.' };
  }
}
