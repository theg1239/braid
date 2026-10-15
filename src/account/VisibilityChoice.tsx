import { Radio } from '@cloudflare/kumo';
import type { Visibility } from '../../shared/account';

export function VisibilityChoice({ value, onChange, disabled = false, personal = false }: { value: Visibility; onChange: (value: Visibility) => void; disabled?: boolean; personal?: boolean }) {
  return <Radio.Group<Visibility> legend="Visibility" value={value} onValueChange={onChange} appearance="card" disabled={disabled}>
    <Radio.Item value="public" label="Public" description="Anyone can see it" />
    <Radio.Item value="private" label="Private" description={personal ? 'Only you' : 'Organization members'} />
  </Radio.Group>;
}
