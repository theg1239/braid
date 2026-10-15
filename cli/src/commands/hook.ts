import { buildCommand, buildRouteMap } from '@stricli/core';
import type { BraidContext } from '../context';
import { canCommit, recordRun } from '../hooks';
import { detectRun } from '../identity';
import { openRepository } from '../repository';
import { queueActivity, recordActivityHook, uploadActivity } from '../activity';
import { gitText } from '../git';

async function committed(this: BraidContext) {
  const { root } = openRepository(this);
  if (canCommit(this, root)) recordRun(this, root, detectRun(this));
  if (this.env.BRAID_ACTIVITY_DIR) try { queueActivity(this.env.BRAID_ACTIVITY_DIR, { source: 'git', kind: 'commit', commit: gitText(this, ['rev-parse', 'HEAD'], { cwd: root }) }, this.now()); } catch { /* Never block a commit for telemetry. */ }
}

export const hookRoutes = buildRouteMap({
  routes: {
    'post-commit': buildCommand({ func: committed, parameters: {}, docs: { brief: 'Record the agent run in a refs/notes/braid note on HEAD' } }),
    activity: buildCommand({ func: async function (this: BraidContext, _flags: Record<never, never>, source: string, payload?: string) { await recordActivityHook(this, source, payload); }, parameters: { positional: { kind: 'tuple', parameters: [{ parse: String, brief: 'Hook provider', placeholder: 'provider' }, { parse: String, brief: 'Notification payload', placeholder: 'payload', optional: true }] } }, docs: { brief: 'Queue a local observation' } }),
    upload: buildCommand({ func: async function (this: BraidContext, _flags: Record<never, never>, root: string) { await uploadActivity(this, root); }, parameters: { positional: { kind: 'tuple', parameters: [{ parse: String, brief: 'Checkout root', placeholder: 'directory' }] } }, docs: { brief: 'Deliver queued activity' } }),
  },
  docs: { brief: 'What the Git hook from braid init runs' },
});
