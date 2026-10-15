import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Kumo's documented build for apps without Tailwind. It must load before app styles.
import '@cloudflare/kumo/styles/standalone';
import './styles/index.css';
import './styles/shell.css';
import './styles/pulls.css';
import { captureInboundLinks } from './account/session';
import { warmStart } from './lib/prefetch';
import { warmEntry } from './startup';
import { App } from './App';

// Invitation tokens and agent codes leave the address bar before anything renders.
captureInboundLinks();
// The account, the snapshot and the first screen's code and data start now, together.
warmStart();
warmEntry();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
