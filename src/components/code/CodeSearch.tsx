import { useEffect, useRef, useState } from 'react';
import { Input } from '@cloudflare/kumo';
import { navigate, paths } from '../../lib/router';
import { Kbd } from '../ui/Kbd';
import '../../styles/search.css';
import { isModifierKey } from '../../lib/format';

/** The slash shortcut belongs to Code; typing in another control never steals focus. */
export function CodeSearch({ gitRef, disabled = false }: { gitRef?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (disabled) return;
    const focus = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented || isModifierKey(event) || event.altKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, [disabled]);
  return (
    <form className="repo-search" role="search" onSubmit={event => {
      event.preventDefault();
      if (disabled) return;
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (gitRef) params.set('ref', gitRef);
      navigate(`${paths.search()}${params.size ? `?${params}` : ''}`);
    }}>
      <Input ref={input} disabled={disabled} size="sm" type="search" aria-label="Search this repository" placeholder="Search code" value={query} onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (query) setQuery('');
        else event.currentTarget.blur();
      }} onChange={event => setQuery(event.target.value)} maxLength={256} autoComplete="off" passwordManagerIgnore />
      <Kbd>/</Kbd>
    </form>
  );
}
