import { Button, Dialog } from '@cloudflare/kumo';
import { XIcon } from '@phosphor-icons/react';
import { useWorkspace } from '../../store/workspace';
import { TaskComposer } from '../agents/TaskComposer';
import type { MissionDraft } from '../mission/NextStep';

/**
 * New task from anywhere, by keyboard or Start again: the Agents tab's composer in a dialog, so a task starts the same
 * way everywhere. In the recorded example it replays the sample task.
 */
export function NewTaskDialog({ open, onOpenChange, draft }: { open: boolean; onOpenChange: (open: boolean) => void; draft: MissionDraft | null }) {
  const demo = useWorkspace().snapshot?.capabilities.mode === 'demo';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="dialog">
        <div className="dialog__form">
          <div className="dialog__head">
            <Dialog.Title className="dialog__title">{demo ? 'Replay task' : 'New task'}</Dialog.Title>
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="Close" />} />
          </div>
          <Dialog.Description className="sr-only">{demo ? 'Replays the recorded task with simulated agents.' : 'Describe the change you want. Agents open it as a pull request.'}</Dialog.Description>
          <TaskComposer draft={draft} autoFocus onStarted={() => onOpenChange(false)} />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
