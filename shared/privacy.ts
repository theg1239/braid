import { redactSecret, SECRET_RULES } from './secrets';

/** Includes internationalized local parts and domain names. Account ids can contain these too. */
export const EMAIL_PATTERN = /(?<![\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}.-]*[\p{L}\p{N}\p{M}])?\.[\p{L}\p{M}]{2,}/gu;
export const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----|$)/g;
export const CREDENTIAL_URL = /https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s<>"']+/gi;
export const BRAID_CREDENTIAL = /\bbraid_(?:agent|at)_[A-Za-z0-9_.-]+\b/g;
export const redactEmails = (text: string) => text.replace(EMAIL_PATTERN, '[private email]');
export function redactPublicText(text: string): string {
  return SECRET_RULES.reduce(redactSecret,
    redactEmails(text.replace(PRIVATE_KEY_BLOCK, '[redacted]')).replace(CREDENTIAL_URL, '[redacted]').replace(BRAID_CREDENTIAL, '[redacted]'));
}
