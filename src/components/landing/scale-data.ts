/**
 * Local scripted-change experiment, 2026-10-13. Independent of the recorded example:
 * scripts/landing-data.mjs must not regenerate these results. See public/scale-evidence.txt
 * for the workload, Git comparator and verification boundaries.
 */
export const SCALE = {
  runs: [
    { agents: 25, braid: 16, git: 9, breaksCaught: 2 },
    { agents: 50, braid: 29, git: 12, breaksCaught: 4 },
    { agents: 100, braid: 55, git: 18, breaksCaught: 8 },
  ],
  evidence: '/scale-evidence.txt',
} as const;
