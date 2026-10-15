import * as v from 'valibot';
import type { Account } from '../../shared/account';
import { earlyAccount, readAccount } from '../lib/api';

/*
 * The account read every page starts with, apart from the account endpoints only some screens call (api.ts), so
 * the shell carries just this.
 */

// Rollout boundary: old Workers return teams and teamId; components only receive organizations.
const repositoryFields = { id: v.string(), name: v.string(), slug: v.string(), visibility: v.picklist(['public', 'private']), createdAt: v.string(), canWrite: v.optional(v.boolean()) };
const repositoryResponse = v.union([
  v.object({ ...repositoryFields, organizationId: v.string() }),
  v.pipe(v.object({ ...repositoryFields, teamId: v.string() }), v.transform(({ teamId, ...repository }) => ({ ...repository, organizationId: teamId }))),
]);
export const organizationResponse = v.object({ kind: v.optional(v.picklist(['user', 'organization']), 'organization'), id: v.string(), name: v.string(), slug: v.string(), role: v.picklist(['owner', 'member']), workspaces: v.array(repositoryResponse) });
export const accountFields = {
  personalOwner: v.optional(v.nullable(organizationResponse), null),
  usernameSuggestion: v.optional(v.nullable(v.string()), null),
  user: v.nullable(v.object({ id: v.string(), email: v.string(), name: v.string(), username: v.optional(v.nullable(v.string()), null), avatarUrl: v.optional(v.nullable(v.string()), null) })),
  provider: v.picklist(['github', 'access', 'owner-key']), signupEnabled: v.boolean(),
  methods: v.object({ github: v.boolean(), email: v.boolean(), passkeys: v.boolean() }),
};
const accountResponse = v.union([
  v.object({ ...accountFields, organizations: v.array(organizationResponse) }),
  v.pipe(v.object({ ...accountFields, teams: v.array(organizationResponse) }), v.transform(({ teams, ...account }) => ({ ...account, organizations: teams }))),
]);

/** An account read started before React renders; the provider's first read takes it over. */
let primed: Promise<Account> | null = null;
let reading: Promise<Account> | null = null;

function read(): Promise<Account> {
  // Strict Mode and simultaneous retries share one request.
  return reading ??= (earlyAccount<unknown>() ?? readAccount<unknown>()).then(value => v.parse(accountResponse, value)).finally(() => { reading = null; });
}

export function primeAccount() {
  primed = read();
  // loadAccount hands this read to the account screen, which shows a failure.
  primed.catch(() => undefined);
}

/** The account: the read primed before the first render, once, and a new read after that. */
export function loadAccount(): Promise<Account> {
  if (!primed) return read();
  const promise = primed;
  primed = null;
  return promise;
}
