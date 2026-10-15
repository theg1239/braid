import { useId, useState } from 'react';
import { Button, Input } from '@cloudflare/kumo';
import { githubRepository } from '../../lib/github-repository';
import { navigate, paths } from '../../lib/router';
import './github-repository-field.css';

export function GitHubRepositoryField({ label = 'Open a GitHub repository' }: { label?: string }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  return <form className="github-entry" onSubmit={event => {
    event.preventDefault();
    const address = githubRepository(value);
    setInvalid(!address);
    if (address) navigate(paths.repo(address));
  }}>
    <label id={`${id}-label`} htmlFor={id}>{label}</label>
    <div className="github-entry__field">
      <Input id={id} aria-labelledby={`${id}-label`} placeholder="owner/repo or GitHub URL" value={value} onChange={event => { setValue(event.target.value); setInvalid(false); }} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined} maxLength={2048} passwordManagerIgnore />
      <Button type="submit" variant="secondary">Open</Button>
    </div>
    <p id={`${id}-error`} className="github-entry__error" role="status">{invalid ? 'Enter owner/repo or a github.com URL.' : '\u00a0'}</p>
  </form>;
}
