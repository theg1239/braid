import { useState, type FormEvent } from 'react';
import { Banner, Button, Collapsible, Dialog, Input, InputArea, Radio, useKumoToastManager } from '@cloudflare/kumo';
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import type { ContextItem } from '../../../shared/types';
import { AgentConnections } from '../../account/AccountSettings';
import { useAccount } from '../../account/AccountProvider';
import { useRepository } from '../../account/RepositoryGate';
import { AgentDocs, SetupPromptButton } from '../../account/SetupPrompt';
import { mcpEndpoint, setupPrompt } from '../../lib/agent-commands';
import { api, errorMessage } from '../../lib/api';
import { sortByNewest } from '../../lib/derive';
import { useNow } from '../../lib/hooks';
import { addressPath, paths } from '../../lib/router';
import { liveBlocker, useSnapshot, useWorkspace } from '../../store/workspace';
import { KIND_LABEL } from '../ui/Kind';
import { RouterLink } from '../ui/Link';
import { CopyValue } from './CopyValue';
import { Instructions } from './Instructions';
import { Providers } from './Providers';
import { Row, Section, SettingsEmpty } from './Section';
import { RelativeTime } from '../ui/Time';

/** How agents connect, what they are told, and the notes Braid's own agents read. */
export function AgentSettings({ signedIn }: { signedIn: boolean }) {
  const { accounts } = useAccount();
  const { address } = useRepository();
  const prompt = `${setupPrompt()}${address ? ` Connect to ${window.location.origin}${addressPath(address)}.` : ''}`;
  return <>
    {accounts ? <Section id="setup" title="Connect an agent" rows>
      <Row label="Setup prompt">
        <SetupPromptButton variant="primary" size="sm" prompt={prompt} />
      </Row>
      <Row label="Guides"><AgentDocs /></Row>
    </Section> : null}
    {signedIn ? <Section id="connections" title="Connected agents" rows><AgentConnections /></Section> : null}
    {signedIn ? <Providers /> : null}
    <Mcp />
    <Instructions />
    <TaskNotes />
  </>;
}

function Mcp() {
  const { scope } = useRepository();
  const endpoint = mcpEndpoint();
  const headers = ['Authorization: Bearer <access token>', `X-Braid-Workspace: ${scope ?? '<workspace id>'}`];
  return <Section id="mcp" title="MCP" rows>
    <Row label="Endpoint"><span className="srow__value mono">{endpoint}</span><CopyValue value={endpoint} label="endpoint" /></Row>
    {headers.map(header => <Row key={header} label={header.split(':')[0]}><span className="srow__value mono">{header.slice(header.indexOf(':') + 2)}</span><CopyValue value={header} label={`${header.split(':')[0]} header`} /></Row>)}
  </Section>;
}

/**
 * Notes Braid's own agents read when a task starts, and the decisions made on tasks. The rules
 * every agent follows are the instructions above; these stay with this workspace's tasks.
 */
function TaskNotes() {
  const snapshot = useSnapshot();
  const now = useNow();
  const [adding, setAdding] = useState(false);
  const blocker = liveBlocker(snapshot);
  const items = sortByNewest(snapshot.context);
  return (
    <Section
      id="notes"
      title="Task notes"
      rows
      aside={
        <span title={blocker ?? undefined}>
          <Button variant="secondary" size="sm" icon={PlusIcon} onClick={() => setAdding(true)} disabled={!!blocker}>
            Add
          </Button>
        </span>
      }
    >
      {items.length ? <ul className="settings-notes">
        {items.map(item => <li key={item.id}>
          <Collapsible.Root>
            <Row compact label={item.title} hint={<>{item.author} · <RelativeTime at={item.createdAt} now={now} /></>}>
              <span className="srow__value">{KIND_LABEL[item.kind]}</span>
              <Collapsible.Trigger render={props => <Button {...props} size="sm" variant="ghost">Details</Button>} />
            </Row>
            <Collapsible.Panel className="settings-note-detail"><p>{item.body}</p>{item.missionId ? <RouterLink href={paths.task(item.missionId)} className="text-link">View task</RouterLink> : null}</Collapsible.Panel>
          </Collapsible.Root>
        </li>)}
      </ul> : <SettingsEmpty>No task notes.</SettingsEmpty>}
      <AddNoteDialog open={adding && !blocker} onOpenChange={setAdding} />
    </Section>
  );
}

function AddNoteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const [kind, setKind] = useState<Extract<ContextItem['kind'], 'constraint' | 'learning'>>('constraint');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!title.trim() && !!body.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addContext({ title: title.trim(), body: body.trim(), kind });
      toasts.add({ title: 'Note added', description: title.trim(), variant: 'success' });
      setTitle('');
      setBody('');
      onOpenChange(false);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog size="lg" className="dialog">
        <form onSubmit={submit} className="dialog__form">
          <div className="dialog__head">
            <Dialog.Title className="dialog__title">Add a task note</Dialog.Title>
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="Close" />} />
          </div>
          <Radio.Group legend="Kind" orientation="horizontal" value={kind} onValueChange={(value) => setKind(value as 'constraint' | 'learning')}>
            <Radio.Item value="constraint" label="Constraint" />
            <Radio.Item value="learning" label="Learning" />
          </Radio.Group>
          <Input label="Title" placeholder="What should the agents remember?" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} autoFocus passwordManagerIgnore />
          <InputArea label="Note" placeholder={kind === 'constraint' ? 'Which behavior or files should stay unchanged?' : 'What worked, and when should agents use it again?'} value={body} onValueChange={setBody} autoResize minRows={4} maxRows={10} maxLength={4000} />
          {error ? <Banner variant="error" size="sm" description={error} /> : null}
          <div className="dialog__actions">
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" disabled={busy}>Cancel</Button>} />
            <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
              Add
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
