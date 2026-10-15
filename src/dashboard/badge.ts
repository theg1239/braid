import mark from '../../public/favicon.svg?raw';

/** Keep Braid's mark; the number is the only colour added to the browser tab. */
export function inboxFavicon(count: number): string {
  const label = count > 99 ? '99+' : String(count);
  const badge = `<rect x="13" y="17" width="19" height="15" rx="4" fill="#cf3b3b"/><text x="22.5" y="28" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${label.length > 2 ? 8 : 10}" font-weight="700" fill="white">${label}</text>`;
  return `data:image/svg+xml,${encodeURIComponent(mark.replace('</svg>', `${badge}</svg>`))}`;
}

/** The dashboard owns the tab badge while mounted; zero and sign-out restore the original icon. */
export function setInboxBadge(count: number): () => void {
  const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const original = icon?.getAttribute('href');
  document.title = count ? `(${count}) Braid` : 'Braid';
  if (icon && count) icon.href = inboxFavicon(count);
  return () => {
    document.title = 'Braid';
    if (icon && original !== null && original !== undefined) icon.setAttribute('href', original);
  };
}
