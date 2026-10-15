import { useEffect, useState } from 'react';
import claude from './agents/claude.svg';
import codex from './agents/codex.svg';
import cursor from './agents/cursor.svg';
import opencode from './agents/opencode.svg';

/** The coding agents whose marks the pill shows, in Cloudflare's order. */
const LOGOS = [
  { name: 'claude', src: claude },
  { name: 'codex', src: codex },
  { name: 'cursor', src: cursor },
  { name: 'opencode', src: opencode },
];
/** How long the pill says it copied, as Cloudflare's does. */
const COPIED_MS = 1500;

/** What the pill copies: the instructions this deployment serves, for whichever agent reads them. */
export const setupPrompt = () => `Fetch and follow the instructions to set me up for Braid from ${window.location.origin}/setup.md`;

/**
 * Cloudflare's Copy prompt pill, as developers.cloudflare.com draws it: four agents' marks and two words. A click
 * copies the prompt and says so for a moment. Both labels share one cell, so the pill never changes width.
 */
export function Prompt() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy() {
    // A browser that refuses the clipboard leaves the pill as it was, as Cloudflare's does.
    try {
      await navigator.clipboard.writeText(setupPrompt());
    } catch {
      return;
    }
    setCopied(true);
  }
  return (
    <span className="lp-prompt-slot">
      <button type="button" className="lp-prompt" data-copied={copied || undefined} title="Sets up your coding agent for Braid" onClick={() => void copy()}>
        <span className="lp-prompt__logos" aria-hidden="true">
          {LOGOS.map(({ name, src }) => (
            <img key={name} src={src} alt="" width={20} height={20} decoding="async" draggable={false} />
          ))}
        </span>
        <span className="lp-prompt__label">
          <span data-label="copy">Copy prompt</span>
          <span data-label="copied">Prompt copied!</span>
        </span>
      </button>
      <span className="sr-only" role="status">
        {copied ? 'Prompt copied' : ''}
      </span>
    </span>
  );
}
