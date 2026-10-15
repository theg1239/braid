import type { ProvenanceOwner } from './types';

/** GitHub's private commit address also names the login, including addresses from before 2017. */
const NOREPLY = /^(?:\d+\+)?([a-z\d](?:[a-z\d-]{0,38}))@users\.noreply\.github\.com$/i;
export const githubLogin = (email: string) => email.match(NOREPLY)?.[1];
/** A GitHub App acts under its slug with `[bot]` appended. */
const BOT = /\[bot\]$/i;
export const isBotLogin = (login: string) => BOT.test(login);
export const appSlug = (login: string) => login.replace(BOT, '');

/** Prefer the Braid username, then GitHub's login, and keep an unmatched Git name. */
export function personHandle(owner: ProvenanceOwner): string {
  const login = owner.github || githubLogin(owner.email ?? '');
  return login ? `@${login}` : owner.name;
}
