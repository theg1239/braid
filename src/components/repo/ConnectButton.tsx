import { Suspense, useState } from 'react';
import { Button } from '@cloudflare/kumo';
import { CodeIcon } from '@phosphor-icons/react';
import { lazyComponent } from '../../lib/lazy';

// The popover and its positioning arrive only when someone reaches for the button.
const connect = lazyComponent(() => import('./ConnectPopover'), (m) => m.ConnectPopover);
const ConnectPopover = connect.Component;

function CodeButton({ onOpen, onIntent }: { onOpen?: () => void; onIntent?: () => void }) {
  return (
    <Button size="sm" variant="secondary" icon={CodeIcon} onClick={onOpen} onPointerEnter={onIntent} onFocus={onIntent}>
      Code
    </Button>
  );
}

/** GitHub's Code button: a plain button until it is wanted, then the popover with the ways an agent connects. */
export function ConnectButton() {
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
  const warm = () => void connect.prefetch();
  if (!wanted) {
    return (
      <CodeButton
        onIntent={warm}
        onOpen={() => {
          setWanted(true);
          setOpen(true);
        }}
      />
    );
  }
  return (
    <Suspense fallback={<CodeButton />}>
      <ConnectPopover open={open} onOpenChange={setOpen} />
    </Suspense>
  );
}
