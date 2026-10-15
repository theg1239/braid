import { SECRET_RULES } from '../../shared/secrets';
import { redactEmails } from '../../shared/privacy';
import { fail } from './context';

/**
 * What a credential looks like: the prefixed provider formats Braid's own scanner knows, plus the broader shapes the
 * downloadable braid.mjs refuses, such as `password = "…"` assignments and credentials embedded in URLs.
 */
const PATTERNS: RegExp[] = [
  ...SECRET_RULES.map(rule => rule.pattern),
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  /\bbraid_(?:agent|at)_[a-zA-Z0-9_.-]{16,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[a-zA-Z0-9]{20,}/,
  /\bgithub_pat_[a-zA-Z0-9_]{20,}/,
  /\bsk-(?:proj-|ant-)?[a-zA-Z0-9_-]{16,}/,
  /\bxox[baprs]-[a-zA-Z0-9-]{16,}/,
  /https?:\/\/[^\s/:"'<>]+:[^\s/@"'<>]+@/,
  /\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_=.-]{12,}/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token|_authToken)\b["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|_authToken)\s*=\s*[a-zA-Z0-9+/_=-]{12,}(?:\s|$)/i,
];
const GLOBAL = PATTERNS.map(pattern => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));

/** Whether text holds one of the given secrets or anything shaped like a credential. */
export const hasSecret = (content: string, secrets: readonly string[]) =>
  secrets.some(secret => secret.length >= 4 && content.includes(secret)) || PATTERNS.some(pattern => pattern.test(content));

export function assertNoSecrets(content: string, secrets: readonly string[], message: string) {
  if (hasSecret(content, secrets)) fail(message);
}

/** Refuses a submission that holds anything shaped like a credential; base64 screenshots are not text, so they are left out. */
export function assertSubmittable(payload: { evidence?: readonly { kind: string; data?: string }[] }, secrets: readonly string[]) {
  const text = JSON.stringify({ ...payload, evidence: payload.evidence?.map(item => item.kind === 'screenshot' ? { ...item, data: '' } : item) });
  assertNoSecrets(text, secrets, 'Possible secret detected. Remove credentials from the files, title, summary, rationale and test reports before submitting.');
}

/** Text with the given secrets and anything shaped like a credential replaced, for printing what others wrote. */
export function redact(content: string, secrets: readonly string[] = []) {
  let result = redactEmails(content);
  for (const secret of secrets) if (secret.length >= 4) result = result.replaceAll(secret, '[redacted]');
  for (const pattern of GLOBAL) result = result.replace(pattern, '[redacted]');
  return result;
}
