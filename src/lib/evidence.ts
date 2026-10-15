import type { CommandEvidence, Evidence, EvidenceSource, ScreenshotEvidence } from '../../shared/types';
import type { CheckState } from './changes';
import { joinNames, plural } from './format';

/*
 * What a change was shown doing: screenshots of its pages and the commands run against it, for
 * one revision at a time. Where each item ran is part of it; a run on the agent's machine is
 * reported, never verified. The pull request page and its merge box read these.
 */

/** Where evidence ran, as the interface names it. */
export const SOURCE_LABEL: Record<EvidenceSource, string> = { braid: 'Braid', agent: 'agent’s machine' };
export const VIEWPORT_LABEL: Record<ScreenshotEvidence['viewport'], string> = { desktop: 'Desktop', mobile: 'Phone' };
const VIEWPORT_ORDER: Record<ScreenshotEvidence['viewport'], number> = { desktop: 0, mobile: 1 };

/** One page of a revision with its screenshots, desktop before phone. */
export interface ProofPage { page: string; shots: ScreenshotEvidence[] }
/** The evidence of one revision: its pages and its command runs, with the runs that failed. */
export interface RevisionProof { revision: number; pages: ProofPage[]; commands: CommandEvidence[]; failed: CommandEvidence[] }

/** The evidence of one revision, or null when it carries none. */
export function proofOf(evidence: Evidence[] | undefined, revision: number): RevisionProof | null {
  const items = (evidence ?? []).filter((item) => item.revision === revision);
  if (!items.length) return null;
  const pages = new Map<string, ScreenshotEvidence[]>();
  for (const item of items) if (item.kind === 'screenshot') pages.set(item.page, [...(pages.get(item.page) ?? []), item]);
  const commands = items.filter((item): item is CommandEvidence => item.kind === 'command');
  return {
    revision,
    pages: [...pages].map(([page, shots]) => ({ page, shots: [...shots].sort((a, b) => VIEWPORT_ORDER[a.viewport] - VIEWPORT_ORDER[b.viewport]) })),
    commands,
    failed: commands.filter((command) => command.exitCode !== 0),
  };
}

/** The revisions before `revision` that carry evidence, earliest first. */
export function earlierRevisions(evidence: Evidence[] | undefined, revision: number): number[] {
  return [...new Set((evidence ?? []).map((item) => item.revision).filter((item) => item < revision))].sort((a, b) => a - b);
}

/** The state of one command run: a failure, a verified pass, or a pass the agent reported. */
export function commandState(command: CommandEvidence): CheckState {
  return command.exitCode !== 0 ? 'failed' : command.source === 'agent' ? 'reported' : 'passed';
}

/** What a revision's proof adds up to, as one line: "2 pages · 3 commands passed" or "npm test failed". */
export function proofLabel(proof: RevisionProof): { state: CheckState; label: string } {
  if (proof.failed.length) {
    const names = proof.failed.map((command) => command.command);
    return { state: 'failed', label: names.length <= 2 ? `${joinNames(names)} failed` : `${names.length} of ${proof.commands.length} commands failed` };
  }
  const verified = proof.commands.some((command) => command.source === 'braid');
  const parts: string[] = [];
  if (proof.pages.length) parts.push(plural(proof.pages.length, 'page'));
  if (proof.commands.length) parts.push(`${plural(proof.commands.length, 'command')} passed${verified ? '' : ' on the agent’s machine'}`);
  return { state: !proof.commands.length ? 'none' : verified ? 'passed' : 'reported', label: parts.join(' · ') };
}
