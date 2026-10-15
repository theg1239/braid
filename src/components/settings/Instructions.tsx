import { useState, type FormEvent } from 'react';
import { Banner, Button, Dialog, Input, InputArea, useKumoToastManager } from '@cloudflare/kumo';
import { PlusIcon, TrashIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import type { Change, Instruction } from '../../../shared/types';
import { INSTRUCTIONS_PATH } from '../../../shared/instructions-file';
import { changes, errorMessage } from '../../lib/api';
import { plural } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/hooks';
import { refreshLive, useLive } from '../../lib/live';
import { navigate, paths } from '../../lib/router';
import { liveBlocker, useSnapshot } from '../../store/workspace';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LoadingRegion, SkeletonLine } from '../ui/Skeleton';
import { RouterLink } from '../ui/Link';
import { ErrorPanel } from '../ui/States';
import { Chips, Row, Section, SettingsEmpty } from './Section';

/*
 * The instructions every agent follows, from `.braid/instructions.json` on main and mirrored
 * into AGENTS.md. Adding or removing one opens a pull request of the owner's own, which lands
 * under the repository's rules like any other; the list here changes when it merges.
 */

/** One instruction: its text, then what it blocks and where, in the words AGENTS.md uses. */
function InstructionRow({ item, blocker, onRemove }: { item: Instruction; blocker: string | null; onRemove: () => void }) {
  return (
    <li>
      <Row compact label={item.text} hint={item.block || item.paths ? <span className="instruction__meta">
        {item.block ? <><span>Blocked</span><Chips values={item.block} />{item.paths ? <span>in</span> : null}</> : <span>Applies to</span>}
        {item.paths ? <Chips values={item.paths} /> : null}
      </span> : undefined}>
        <span title={blocker ?? undefined}><Button size="sm" variant="ghost" shape="square" icon={TrashIcon} aria-label={`Remove “${item.text}”`} disabled={!!blocker} onClick={onRemove} /></span>
      </Row>
    </li>
  );
}

export function Instructions() {
  const snapshot = useSnapshot();
  const toasts = useKumoToastManager();
  const attempt = useIdempotencyKey();
  const file = useLive(snapshot.project.id ? 'instructions' : null, changes.instructions, 60_000);
  const blocker = liveBlocker(snapshot);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Instruction | null>(null);
  if (!snapshot.project.id) return null;

  const opened = (change: Change) => {
    toasts.add({ title: 'Pull request opened', description: `#${change.number} ${change.title}`, variant: 'success', actions: [{ children: 'View', size: 'sm', variant: 'secondary', onClick: () => navigate(paths.pull(change.number)) }] });
    refreshLive('changes');
  };

  const body =
    file.error && !file.data ? (
      <ErrorPanel title="Couldn’t load the instructions" message={file.error} onRetry={() => void file.refresh()} retrying={file.refreshing} />
    ) : !file.data ? (
      <LoadingRegion label="Loading the instructions">
        <ul className="instructions instructions--skeleton" aria-hidden="true">
          {[66, 58, 88].map(width => <li key={width}>
            <Row compact label={<SkeletonLine width={`${width}%`} />} hint={<span className="instruction__meta"><SkeletonLine width="76%" height={10} /></span>}>
              <SkeletonLine width={28} height={28} />
            </Row>
          </li>)}
        </ul>
      </LoadingRegion>
    ) : file.data.instructions.length ? (
      <ul className="instructions" aria-label="Instructions">
        {file.data.instructions.map((item) => (
          <InstructionRow key={item.id} item={item} blocker={blocker} onRemove={() => setRemoving(item)} />
        ))}
      </ul>
    ) : (
      <SettingsEmpty>No instructions.</SettingsEmpty>
    );

  return (
    <Section
      id="instructions"
      title="Instructions"
      rows
      aside={
        <span className="settings-section__aside">
          <RouterLink href={paths.code(INSTRUCTIONS_PATH, { kind: 'file' })} className="text-link mono">
            {INSTRUCTIONS_PATH}
          </RouterLink>
          <span title={blocker ?? undefined}>
            <Button variant="secondary" size="sm" icon={PlusIcon} disabled={!!blocker} onClick={() => setAdding(true)}>
              Add
            </Button>
          </span>
        </span>
      }
    >
      {file.data?.errors.length ? (
        <Banner
          variant="alert"
          size="sm"
          icon={<WarningCircleIcon weight="fill" />}
          title={`${plural(file.data.errors.length, 'problem')} in ${INSTRUCTIONS_PATH}`}
          description={
            <ul className="rules-errors">
              {file.data.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      {body}
      <AddInstruction open={adding && !blocker} onOpenChange={setAdding} onOpened={opened} />
      <ConfirmDialog
        open={!!removing}
        title="Remove this instruction?"
        description="A pull request takes it out of every agent’s instructions."
        confirmLabel="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const key = attempt.key(['remove', removing!.id]);
          try {
            opened(await changes.removeInstruction(removing!.id, key));
            attempt.settle();
          } catch (err) {
            attempt.settle(err);
            throw err;
          }
        }}
      />
    </Section>
  );
}

const lines = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean);
const patterns = (value: string) => value.split(',').map((pattern) => pattern.trim()).filter(Boolean);

/** What every agent should do, what a change may not add, and the files it covers; sent as one pull request. */
function AddInstruction({ open, onOpenChange, onOpened }: { open: boolean; onOpenChange: (open: boolean) => void; onOpened: (change: Change) => void }) {
  const attempt = useIdempotencyKey();
  const [text, setText] = useState('');
  const [block, setBlock] = useState('');
  const [files, setFiles] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!text.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    const input = { text: text.trim(), ...(lines(block).length ? { block: lines(block) } : {}), ...(patterns(files).length ? { paths: patterns(files) } : {}) };
    const key = attempt.key(input);
    setBusy(true);
    setError(null);
    try {
      const change = await changes.addInstruction(input, key);
      attempt.settle();
      setText('');
      setBlock('');
      setFiles('');
      onOpenChange(false);
      onOpened(change);
    } catch (err) {
      attempt.settle(err);
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
            <Dialog.Title className="dialog__title">Add an instruction</Dialog.Title>
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="Close" />} />
          </div>
          <InputArea label="Instruction" placeholder="What should every agent check before opening a pull request?" value={text} onValueChange={setText} autoResize minRows={2} maxRows={6} maxLength={500} autoFocus />
          <InputArea label="Blocked strings" placeholder="Exact text that changes must not add" required={false} description="One per line" value={block} onValueChange={setBlock} autoResize minRows={1} maxRows={8} className="mono" />
          <Input label="Files" required={false} placeholder="src/**, docs/**" value={files} onChange={(event) => setFiles(event.target.value)} maxLength={400} passwordManagerIgnore className="mono" />
          {error ? <Banner variant="error" size="sm" description={error} /> : null}
          <div className="dialog__actions">
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" disabled={busy}>Cancel</Button>} />
            <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
              Open pull request
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
