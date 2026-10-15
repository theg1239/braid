/** Repository access, rather than sign-in alone, decides background polling. */
export const PUBLIC_POLL_INTERVAL = 30_000;
let publicViewer = true;
export function setPublicPolling(value: boolean) { publicViewer = value; }
export function publicPolling() { return publicViewer; }
/** A visitor's own write lands in their copy within seconds, so polls follow it closely for a minute. */
const FOLLOW_FOR = 60_000;
let followUntil = 0;
const followers = new Set<() => void>();
export function followOwnWrite() {
  followUntil = Date.now() + FOLLOW_FOR;
  for (const listener of followers) listener();
}
export function onFollow(listener: () => void): () => void { followers.add(listener); return () => followers.delete(listener); }
/** Whether background polls keep the visitor's thirty-second floor right now. */
export function pollingFloored() { return publicViewer && Date.now() >= followUntil; }
export function pollInterval(interval: number): number { return pollingFloored() ? Math.max(PUBLIC_POLL_INTERVAL, interval) : interval; }
export function pollKey(key: string | null): string | null { return publicViewer && key === 'changes:list:attention' ? null : key; }
