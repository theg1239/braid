import { Button } from '@cloudflare/kumo';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useCopy } from '../../lib/hooks';

/** A button that copies a text it does not show, and says Copied for a moment. */
export function CopyButton({ text, label, variant = 'secondary', size, describe, title }: { text: string; label: string; variant?: 'primary' | 'secondary' | 'outline'; size?: 'sm'; describe?: string; title?: string }) {
  const [copied, copy] = useCopy();
  return (
    <Button variant={variant} size={size} icon={copied ? CheckIcon : CopyIcon} aria-label={describe && (copied ? 'Copied' : describe)} title={title} onClick={() => void copy(text)}>
      {copied ? 'Copied' : label}
    </Button>
  );
}
