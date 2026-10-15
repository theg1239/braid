import { Button } from '@cloudflare/kumo';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useCopy } from '../../lib/hooks';

export function CopyValue({ value, label, text = false }: { value: string; label: string; text?: boolean }) {
  const [copied, copy] = useCopy();
  const action = () => void copy(value);
  const accessible = copied ? `${label} copied` : `Copy ${label}`;
  return text ? <Button size="sm" variant="secondary" icon={copied ? CheckIcon : CopyIcon} aria-label={accessible} onClick={action}>{copied ? 'Copied' : 'Copy link'}</Button> : <Button size="sm" variant="ghost" shape="square" icon={copied ? CheckIcon : CopyIcon} aria-label={accessible} onClick={action} />;
}
