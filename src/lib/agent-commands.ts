import { workspaceScopeNow } from './api';

/*
 * What a person hands a coding agent: the setup prompt, the CLI commands and the guides. None of
 * them carries a credential; the agent asks for an owner-approved connection itself.
 */

/** The prompt a person pastes into their coding agent. The agent reads the guide and connects as the person on its own. */
export function setupPrompt(): string {
  return `Set up Braid for this repository by following ${window.location.origin}/setup.md. Sign me in with the GitHub CLI if gh is signed in; otherwise ask me for my email address, then for the code Braid emails me.`;
}

/** Connects the CLI to this deployment, and to one repository when given; the owner approves the connection in Braid. */
export function connectCommand(workspaceId: string | undefined): string {
  return `${braidCli()} connect --url "${window.location.origin}"${workspaceId ? ` --workspace "${workspaceId}"` : ''}`;
}

/** The public guide, served by this deployment, that a local coding agent reads for one lane of a task. */
export function localAgentGuide(missionId?: string, agentId?: string): string {
  const url = new URL('/local-agents.md', window.location.origin);
  if (missionId) url.searchParams.set('mission', missionId);
  if (agentId) url.searchParams.set('agent', agentId);
  const workspace = workspaceScopeNow();
  if (workspace) url.searchParams.set('workspace', workspace);
  return url.toString();
}

/** Where an MCP client connects to this deployment. A client with OAuth needs nothing more; others send an agent token. */
export function mcpEndpoint(): string {
  return `${window.location.origin}/mcp`;
}

/**
 * A path segment that stays safe inside a double-quoted shell argument. encodeURIComponent
 * leaves `!`, `'`, `(`, `)` and `*` alone and an interactive shell may expand `!`; ids never
 * contain them, but the link is built to hold even if one did.
 */
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The task link the CLI accepts. The repository rides along so a checkout can never bind to a
 * task in another one; an agent id is only needed for older tasks with several proposals.
 */
function taskLink(missionId: string, agentId?: string): string {
  const url = new URL(`/tasks/${encodeSegment(missionId)}`, window.location.origin);
  if (agentId) url.searchParams.set('agent', agentId);
  const workspace = workspaceScopeNow();
  if (workspace) url.searchParams.set('workspace', workspace);
  return url.toString();
}

/**
 * The Braid CLI, fetched into the agent's home directory, outside any repository, and run from
 * there. The URL is double-quoted: an IPv6 development origin such as http://[::1]:5173 would
 * otherwise be read as a glob.
 */
function braidCli(): string {
  return `curl -fsSL --create-dirs -o ~/.braid/braid.mjs "${window.location.origin}/cli/braid.mjs" && node ~/.braid/braid.mjs`;
}

/**
 * The one command a coding agent runs from its own checkout to take a task. Running it again
 * resumes the same task. The percent-encoded link contains nothing a shell expands inside quotes.
 */
export function startCommand(missionId: string, agentId?: string): string {
  return `${braidCli()} start "${taskLink(missionId, agentId)}"`;
}

/**
 * What a connected agent needs to carry its existing checkout onto the new main and submit the
 * same task again. The checkout stays the agent's own and nothing here runs from the browser:
 * `update` only fetches, and the next submission is what moves the task's base and checks.
 */
export function updateInstructions(missionId: string): string {
  const link = taskLink(missionId);
  return [
    'Main moved after this Braid task started. Update the same task instead of starting a new one.',
    `Task: ${link}`,
    `1. From the root of the checkout you already use for this task, run: ${braidCli()} update --dir .`,
    `   It fetches the new main without changing your files. If your connection expired, run node ~/.braid/braid.mjs start "${link}" there first.`,
    '2. Integrate the fetched main into your work and rerun the project checks.',
    '3. Commit the integrated work, then submit the same task again: node ~/.braid/braid.mjs submit --dir . --summary "What changed" --tests .braid/tests.json. Record fresh checks in that file; omit --tests if none were run.',
  ].join('\n');
}
