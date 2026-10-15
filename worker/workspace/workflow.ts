import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { BraidEnv, RunParams } from '../env';
import { HOSTED_RETRIES, runtimeFailure } from '../agents/hosted-failures';

export class MissionWorkflow extends WorkflowEntrypoint<BraidEnv, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { workspaceId, missionId, action, agentIds, operationId } = event.payload;
    const workspace = this.env.WORKSPACES.get(this.env.WORKSPACES.idFromString(workspaceId));
    if (action === 'merge') {
      try {
        return await step.do('integrate reviewed lanes', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, async () => { using result = await workspace.integrateMission(missionId, operationId); return { commit: result.commit ?? null }; });
      } catch (error) {
        await step.do('record integration failure', () => workspace.failMerge(missionId, 'The integration could not complete. Review the current branch and try again.', operationId));
        throw error;
      }
    }
    // Starting every durable step before awaiting them is intentional: all agents run concurrently.
    await Promise.all(agentIds.map(async agentId => {
      // Each attempt is a durable step. Returning typed terminal failures prevents Workflow
      // from turning a failed install, OOM or deadline into a fresh expensive agent run.
      for (let attempt = 0; attempt <= HOSTED_RETRIES; attempt++) {
        try {
          const result = await step.do(`run ${agentId}${attempt ? ` retry ${attempt}` : ''}`, { retries: { limit: 0, delay: '1 second' }, timeout: '60 minutes' }, async () => {
            using outcome = await workspace.runAgent(missionId, agentId, operationId);
            return { commit: outcome.commit ?? null, failure: 'failure' in outcome ? outcome.failure : null };
          });
          if (result.failure) await step.do(`record ${agentId} failure`, () => workspace.failAgent(missionId, agentId, result.failure!.message, operationId));
          break;
        } catch (error) {
          const reason = runtimeFailure(error, 'workflow', `run ${agentId}`);
          reason.evidence.step = `run ${agentId}${attempt ? ` retry ${attempt}` : ''}`;
          const retry = attempt < HOSTED_RETRIES ? attempt + 1 : 0;
          await step.do(`record ${agentId} workflow ${attempt}`, () => workspace.hostedWorkflowFailure(missionId, agentId, reason, retry, operationId));
          if (!retry) {
            await step.do(`record ${agentId} failure`, () => workspace.failAgent(missionId, agentId, reason.message, operationId));
            break;
          }
          await step.sleep(`backoff ${agentId} ${retry}`, `${2 ** attempt} seconds`);
        }
      }
    }));
    await step.do('open human review', { retries: { limit: HOSTED_RETRIES, delay: '1 second', backoff: 'exponential' }, timeout: '1 minute' }, () => workspace.finishMission(missionId, operationId));
    return { missionId };
  }
}
