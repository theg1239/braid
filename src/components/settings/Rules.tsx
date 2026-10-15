import { Banner } from '@cloudflare/kumo';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { GOVERNANCE, POLICY_PATH, type GuardAction, type Policy } from '../../../shared/policy';
import { describePolicy, type PolicySummary, type Safeguard } from '../../../shared/questions';
import { changes } from '../../lib/api';
import { plural } from '../../lib/format';
import { queueInterval } from '../../lib/lists';
import { useLive } from '../../lib/live';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { SkeletonLine } from '../ui/Skeleton';
import { ErrorPanel } from '../ui/States';
import { Chips, Row, Section, SettingsEmpty, SettingsSkeleton } from './Section';

/** Rules and Code security both read `.braid/policy.json`, and the queue's GitHub link for its checks. */
function usePolicy() {
  return { policy: useLive('policy', changes.policy, 30_000), queue: useLive('queue', changes.queue, queueInterval) };
}

function PolicyLink() {
  return (
    <RouterLink href={paths.code(POLICY_PATH, { kind: 'file' })} className="text-link mono">
      {POLICY_PATH}
    </RouterLink>
  );
}

const DECIDES: Record<PolicySummary['areas'][number]['decides'], string> = { auto: 'Merge automatically', review: 'Require review', human: 'Require a person' };
/** Said by the protected row of the table, and by Settings › Code security, so not repeated as sentences here. */
const SAID_ELSEWHERE = new Set<Safeguard>(['governance', 'secrets', 'tests', 'dependencies', 'dependency-review']);
/** The protected paths the table names; the rest of `GOVERNANCE` sits behind a count. */
const PROTECTED_SHOWN = [POLICY_PATH, 'CODEOWNERS', '.github/workflows/**', 'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.coderabbit.yaml'];
const PROTECTED_REST = GOVERNANCE.filter((pattern) => !PROTECTED_SHOWN.includes(pattern));

/** Who decides for each path, the required checks and the safeguards, from `.braid/policy.json`, laid out like GitHub rulesets. */
export function Rules() {
  const { policy, queue } = usePolicy();
  if (!policy.data && policy.error) return <ErrorPanel title="Couldn’t load the rules" message={policy.error} onRetry={() => void policy.refresh()} retrying={policy.refreshing} />;
  if (!policy.data || (!queue.data && !queue.error)) return <SettingsSkeleton label="Loading the rules" />;
  const summary = describePolicy(policy.data.policy);
  const safeguards = summary.safeguards.filter((safeguard) => !safeguard.about.every((about) => SAID_ELSEWHERE.has(about))).map((safeguard) => safeguard.text);
  const required = summary.checks.required;
  const github = queue.data?.github;

  return (
    <>
      {policy.data.errors.length ? (
        <div className="notice">
          <Banner
            variant="alert"
            icon={<WarningCircleIcon weight="fill" />}
            title={`${plural(policy.data.errors.length, 'problem')} in ${POLICY_PATH}`}
            description={
              <>
                <p>Pull requests wait for a person until the policy file is fixed.</p>
                <ul className="rules-errors">
                  {policy.data.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </>
            }
          />
        </div>
      ) : null}
      <Section id="rulesets" title="Rulesets" aside={<PolicyLink />}>
        <table className="rules">
          <thead>
            <tr>
              <th>Files</th>
              <th>Merge</th>
              <th>Reviews</th>
            </tr>
          </thead>
          <tbody>
            {summary.areas.map((area, index) => (
              <tr key={index} data-decides={area.protected ? 'protected' : area.decides}>
                <td>
                  <span className="rules__paths">
                    <Chips values={area.paths} />
                  </span>
                </td>
                <td>
                  <span className="rules__decides">{area.protected ? 'Protected' : DECIDES[area.decides]}</span>
                  {area.note ? <span className="rules__note">{area.note}</span> : null}
                </td>
                <td className="rules__count">{area.protected || area.decides === 'auto' ? '' : area.reviewers}</td>
              </tr>
            ))}
            <tr data-decides={summary.fallback.decides}>
              <td>Everything else</td>
              <td>
                <span className="rules__decides">{DECIDES[summary.fallback.decides]}</span>
              </td>
              <td className="rules__count">{summary.fallback.decides === 'auto' ? '' : summary.fallback.reviewers}</td>
            </tr>
            <tr data-decides="human">
              <td>
                <span className="rules__paths">
                  <Chips values={PROTECTED_SHOWN} />
                  <span className="rules__more" title={PROTECTED_REST.join(', ')}>
                    +{PROTECTED_REST.length} more
                  </span>
                </span>
              </td>
              <td>
                <span className="rules__decides">Require a person</span>
              </td>
              <td className="rules__count" />
            </tr>
          </tbody>
        </table>
      </Section>
      <Section id="checks" title="Required checks" rows>
        {summary.checks.install ? <Row label="Install"><Chips values={[summary.checks.install]} /></Row> : null}
        {summary.checks.commands.length ? <Row label="Commands"><Chips values={summary.checks.commands} /></Row> : null}
        {required.length ? <Row label="Commit statuses"><Chips values={required} /></Row> : null}
        {github ? <Row label="GitHub checks"><span className="srow__value mono">{github.fullName}</span></Row> : null}
        {!summary.checks.install && !summary.checks.commands.length && !required.length && !github ? <SettingsEmpty>No required checks.</SettingsEmpty> : null}
        {summary.checks.commands.length || required.length ? <Row label="Timeout"><span className="srow__value">{plural(summary.checks.minutes, 'minute')}</span></Row> : null}
      </Section>
      <Section id="safeguards" title="Safeguards" rows>
        {safeguards.map(sentence => <Row key={sentence} label={sentence} />)}
      </Section>
    </>
  );
}

const SCAN_EFFECT: Record<GuardAction, string> = { revise: 'Sends back', attention: 'Asks a person', off: 'Off' };
const DEPENDENCY_EFFECT: Record<Policy['dependencyReview'], string> = { block: 'Sends back', warn: 'Warns', off: 'Off' };

/**
 * GitHub's Code security page, read from `.braid/policy.json`: what each scan does when it finds
 * something, the review apps asked to review each merge-queue pull request on GitHub, and where
 * code scanning happens. Read-only, like Rules.
 */
export function Security() {
  const { policy, queue } = usePolicy();
  if (!policy.data && policy.error) return <ErrorPanel title="Couldn’t load the rules" message={policy.error} onRetry={() => void policy.refresh()} retrying={policy.refreshing} />;
  if (!policy.data) return <SettingsSkeleton label="Loading code security" />;
  const security = describePolicy(policy.data.policy).security;
  const github = queue.data?.github;
  const rows: { name: string; effect: string; tone: GuardAction | 'on' | 'none'; note?: string }[] = [
    { name: 'Secret scanning', effect: SCAN_EFFECT[security.secrets], tone: security.secrets },
    { name: 'Dependency review', note: 'OSV.dev', effect: DEPENDENCY_EFFECT[security.dependencies], tone: security.dependencies === 'block' ? 'revise' : security.dependencies === 'warn' ? 'attention' : 'off' },
    { name: 'Test changes', effect: SCAN_EFFECT[security.tests], tone: security.tests },
    { name: 'Dependency downgrades', effect: SCAN_EFFECT[security.downgrades], tone: security.downgrades },
    { name: 'Review apps', note: 'on GitHub', effect: security.reviewApps.length ? `${security.reviewApps.join(', ')}, waits ${plural(security.reviewWait, 'minute')}` : 'None', tone: security.reviewApps.length ? 'on' : 'none' },
  ];
  return (
    <Section id="scans" title="Scans" aside={<PolicyLink />} rows>
      {rows.map(row => <Row compact key={row.name} label={row.name} hint={row.note}>
        <span className="security__effect" data-tone={row.tone}>{row.effect}</span>
      </Row>)}
      {/* Only a queue answer without a link asks for one; until it arrives the row holds the answer's place. */}
      <Row compact label="Code scanning">
        {github?.mode === 'pull-requests' ? <span className="security__effect" data-tone="on">On GitHub <span className="mono">{github.fullName}</span></span>
          : queue.data ? <RouterLink href={paths.settings('github')} className="text-link">Link GitHub for pull requests</RouterLink>
          : queue.error ? <span className="security__effect" data-tone="none">Couldn’t load the GitHub link</span>
          : <SkeletonLine width={150} />}
      </Row>
    </Section>
  );
}
