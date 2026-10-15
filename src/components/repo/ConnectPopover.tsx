import type { ReactNode } from 'react';
import { Button, Popover } from '@cloudflare/kumo';
import { CheckIcon, CodeIcon, CopyIcon } from '@phosphor-icons/react';
import { useCopy } from '../../lib/hooks';
import { useAccount } from '../../account/AccountProvider';
import { connectCommand, mcpEndpoint } from '../../lib/agent-commands';
import { useRepository } from '../../account/RepositoryGate';
import { AgentDocs, SetupPromptButton } from '../../account/SetupPrompt';
import { useSnapshot } from '../../store/workspace';
import { useMirror } from '../../account/mirrors';

function Way({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="connect-pop__way">
      <span className="connect-pop__label">{label}</span>
      <span className="connect-pop__control">{children}</span>
    </div>
  );
}

function Value({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  // An address wraps after its slashes rather than inside a name.
  const shown = /\s/.test(text) ? text : text.split('/').flatMap((part, index) => (index ? [<wbr key={index} />, `/${part}`] : [part]));
  return (
    <>
      <code className="connect-pop__value">{shown}</code>
      <Button size="sm" variant="ghost" shape="square" icon={copied ? CheckIcon : CopyIcon} aria-label={copied ? 'Copied' : 'Copy'} onClick={onCopy} />
    </>
  );
}

/** GitHub's Code popover: a public repository's clone address, then the ways an agent connects. Never a token. */
export function ConnectPopover({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { accounts, account } = useAccount();
  const { workspace, address, visibility } = useRepository();
  const { project, capabilities } = useSnapshot();
  const mirror = useMirror();
  const [copied, copy] = useCopy();
  const endpoint = mcpEndpoint();
  const command = connectCommand(workspace?.id);
  // Anyone, signed in or not, can clone a public repository from its address; a private one is reached through a
  // connection, and the recorded example has no Git remote.
  const clone = mirror && !project.id ? `${mirror.source}.git` : address && visibility === 'public' && capabilities.mode === 'live' && project.id ? `${window.location.origin}/${address.owner}/${address.repo}.git` : null;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        render={
          <Button size="sm" variant="secondary" icon={CodeIcon}>
            Code
          </Button>
        }
      />
      <Popover.Content align="end" className="connect-pop">
        {clone ? (
          <>
            <Popover.Title className="connect-pop__title">Clone</Popover.Title>
            <Way label="HTTPS">
              <Value text={clone} copied={copied === clone} onCopy={() => void copy(clone)} />
            </Way>
            {!mirror ? <h3 className="connect-pop__title connect-pop__title--next">Connect an agent</h3> : null}
          </>
        ) : (
          <Popover.Title className="connect-pop__title">Connect an agent</Popover.Title>
        )}
        {!mirror ? <>{accounts && account?.user ? (
          <Way label="Setup prompt">
            <SetupPromptButton size="sm" variant="outline" label="Copy" />
          </Way>
        ) : null}
        <Way label="MCP">
          <Value text={endpoint} copied={copied === endpoint} onCopy={() => void copy(endpoint)} />
        </Way>
        <Way label="CLI">
          <Value text={command} copied={copied === command} onCopy={() => void copy(command)} />
        </Way>
        {accounts ? (
          <p className="connect-pop__docs">
            <AgentDocs />
          </p>
        ) : null}</> : null}
      </Popover.Content>
    </Popover>
  );
}
