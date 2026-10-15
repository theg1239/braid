import { useState, type RefObject } from 'react';
import { InlineCopyText, Popover, Tabs } from '@cloudflare/kumo';
import { connectCommand, mcpEndpoint } from '../../lib/agent-commands';
import { useRepository } from '../../account/RepositoryGate';
import { SetupPromptButton } from '../../account/SetupPrompt';

type Method = 'prompt' | 'mcp' | 'cli';

/** The ways an agent connects, opened from the composer's agent picker and placed under it. */
export function ConnectAgentPopover({ open, onOpenChange, anchor }: { open: boolean; onOpenChange: (open: boolean) => void; anchor: RefObject<HTMLElement | null> }) {
  const [method, setMethod] = useState<Method>('prompt');
  const { workspace } = useRepository();
  const command = connectCommand(workspace?.id);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Content align="start" anchor={anchor} className="agent-connect">
        <Popover.Title className="agent-connect__title">Connect an agent</Popover.Title>
        <Tabs variant="segmented" size="sm" value={method} onValueChange={(value) => setMethod(value as Method)} tabs={[{ value: 'prompt', label: 'Setup prompt' }, { value: 'mcp', label: 'MCP' }, { value: 'cli', label: 'CLI' }]} />
        {method === 'prompt' ? (
          <div className="agent-connect__body"><p>Paste into your coding agent.</p><SetupPromptButton /></div>
        ) : method === 'mcp' ? (
          <div className="agent-connect__body">
            <InlineCopyText labels={{ copyAction: 'Copy MCP endpoint', copied: 'Copied' }}>{mcpEndpoint()}</InlineCopyText>
            <McpHeaders workspaceId={workspace?.id} />
            <a className="text-link" href="/auth.md" target="_blank" rel="noreferrer">Get an access token</a>
          </div>
        ) : (
          <div className="agent-connect__body">
            <InlineCopyText value={command} labels={{ copyAction: 'Copy CLI command', copied: 'Copied' }}><code className="agent-connect__command">{command}</code></InlineCopyText>
            <p>Run in your terminal, then approve access.</p>
          </div>
        )}
      </Popover.Content>
    </Popover>
  );
}

/** The headers an MCP client sends; without a workspace the placeholder names the one to use. */
export function McpHeaders({ workspaceId }: { workspaceId?: string }) {
  return (
    <dl className="agent-connect__headers">
      <dt>Authorization</dt><dd>Bearer &lt;access token&gt;</dd>
      <dt>X-Braid-Workspace</dt><dd>{workspaceId ? <InlineCopyText labels={{ copyAction: 'Copy workspace ID', copied: 'Copied' }}>{workspaceId}</InlineCopyText> : '<workspace ID>'}</dd>
    </dl>
  );
}
