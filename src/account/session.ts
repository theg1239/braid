import { navigate } from '../lib/router';
import { readStored, writeStored } from '../lib/storage';

/** This tab's memory. It holds a repository id, an invitation token or an agent code, never a credential. */
const KEYS = {
  workspace: 'braid.workspace',
  invite: 'braid.invite',
  connect: 'braid.connect',
  /** Where to return after signing in on another site, such as GitHub. */
  next: 'braid.next',
} as const;

type SessionKey = keyof typeof KEYS;

/** The recorded example, selected with X-Braid-Workspace: demo. */
export const DEMO_SCOPE = 'demo';

const ACCOUNTS_HINT = 'braid.accounts';

/**
 * Whether this deployment has accounts, as the last account answer said, so the first requests of
 * the next visit can start before the account answers again. Null until a first answer.
 */
export function readAccountsHint(): boolean | null {
  const value = readStored('localStorage', ACCOUNTS_HINT);
  return value === null ? null : value === '1';
}

export function writeAccountsHint(accounts: boolean) {
  writeStored('localStorage', ACCOUNTS_HINT, accounts ? '1' : '0');
}

export const readSession = (key: SessionKey) => readStored('sessionStorage', KEYS[key]);
export const writeSession = (key: SessionKey, value: string | null) => writeStored('sessionStorage', KEYS[key], value);

/** Agent codes use an unambiguous alphabet: eight characters, no 0, 1, I or O. */
function normalizeConnectCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null;
}

export function formatConnectCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Moves an invitation token or agent code from the address bar into this tab's storage
 * before anything renders, so it survives sign-in without staying in history or the URL.
 */
export function captureInboundLinks() {
  const url = new URL(window.location.href);
  const invite = url.searchParams.get('invite');
  const connect = url.searchParams.get('connect');
  const workspace = url.searchParams.get('workspace');
  if (invite === null && connect === null && workspace === null) return;
  if (workspace && /^[a-zA-Z0-9_-]{1,128}$/.test(workspace)) writeSession('workspace', workspace);
  if (invite && invite.length <= 200) writeSession('invite', invite);
  const code = connect ? normalizeConnectCode(connect) : null;
  if (code) writeSession('connect', code);
  url.searchParams.delete('invite');
  url.searchParams.delete('connect');
  url.searchParams.delete('workspace');
  navigate(`${url.pathname}${url.search}${url.hash}`, { replace: true });
}
