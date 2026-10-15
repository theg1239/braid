/**
 * Secret scanning for added lines. The rules match credential formats that
 * providers publish with fixed prefixes, following the high-confidence rules of
 * Gitleaks' default configuration (MIT). Findings name the kind and location,
 * never the value.
 */
interface SecretRule { id: string; label: string; pattern: RegExp; capturedPrefix?: true }
/** Bump when detection changes so stored negative findings never bypass newer rules. */
export const SECRET_SCAN_VERSION = 2;

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/, PRIVATE_KEY_END = /-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/;
export const SECRET_RULES: SecretRule[] = [
  { id: 'aws-access-key', label: 'AWS access key', pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/ },
  { id: 'aws-secret-key', label: 'AWS secret access key', pattern: /\baws[_-]secret[_-]access[_-]key["']?[ \t]*[=:][ \t]*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i },
  { id: 'github-token', label: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{82}\b/ },
  { id: 'gitlab-token', label: 'GitLab token', pattern: /\bglpat-[0-9A-Za-z_-]{20}\b/ },
  { id: 'slack-token', label: 'Slack token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b|https:\/\/hooks\.slack\.com\/services\/T[0-9A-Za-z_]{8,12}\/B[0-9A-Za-z_]{8,12}\/[0-9A-Za-z_]{24}/ },
  { id: 'stripe-key', label: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,99}\b/ },
  { id: 'google-api-key', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Seek the fixed marker first; a bounded lookbehind captures the whole prefix for redaction.
  { id: 'openai-key', label: 'OpenAI key', pattern: /(?<=(\bsk-(?:proj-|svcacct-|admin-)?[0-9A-Za-z_-]{20,128}))T3BlbkFJ[0-9A-Za-z_-]{20,128}\b/, capturedPrefix: true },
  { id: 'anthropic-key', label: 'Anthropic key', pattern: /\bsk-ant-(?:api|admin)\d{2}-[0-9A-Za-z_-]{80,256}\b/ },
  { id: 'npm-token', label: 'npm token', pattern: /\bnpm_[0-9A-Za-z]{36}\b/ },
  { id: 'sendgrid-key', label: 'SendGrid key', pattern: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b/ },
  { id: 'braid-token', label: 'Braid token', pattern: /\bbraid_(?:agent|at)_[0-9A-Za-z_.-]{20,4096}/ },
  { id: 'private-key', label: 'private key', pattern: PRIVATE_KEY_BEGIN },
];
// Documentation and tests use these on purpose.
const PLACEHOLDER = /EXAMPLE|example|x{8,}|X{8,}|0{16,}|placeholder|dummy|fake|redacted|your[_-]?(?:key|token)/;

/** Matches include any captured prefix so detection and metadata redaction cover the same whole credential. */
function* matches(text: string, rule: SecretRule) {
  for (const match of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '') + 'g'))) {
    const prefix = rule.capturedPrefix ? match[1] : '';
    yield { value: prefix + match[0], index: match.index - prefix.length };
  }
}
export function redactSecret(text: string, rule: SecretRule): string {
  const parts: string[] = [];
  let end = 0;
  for (const match of matches(text, rule)) {
    if (match.index < end) continue;
    parts.push(text.slice(end, match.index), '[redacted]');
    end = match.index + match.value.length;
  }
  return parts.length ? parts.join('') + text.slice(end) : text;
}

export interface SecretFinding { rule: string; label: string; path: string; line: number }

/** Lines in `after` that `before` did not have, with their one-based line numbers. */
export function addedLines(before: string | null, after: string) {
  const previous = new Map<string, number>();
  for (const line of (before ?? '').split('\n')) previous.set(line, (previous.get(line) ?? 0) + 1);
  const added: { line: number; text: string }[] = [];
  after.split('\n').forEach((text, index) => {
    const count = previous.get(text) ?? 0;
    if (count) previous.set(text, count - 1);
    else added.push({ line: index + 1, text });
  });
  return added;
}

/** Credentials a change adds, at most one per rule and line, never echoing the value. */
export function secretFindings(files: { path: string; before: string | null; after: string | null }[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    if (file.after === null) continue;
    const privateLines = new Set<number>();
    let privateKey = false;
    file.after.split('\n').forEach((text, index) => {
      if (PRIVATE_KEY_BEGIN.test(text)) privateKey = true;
      if (privateKey) privateLines.add(index + 1);
      if (PRIVATE_KEY_END.test(text)) privateKey = false;
    });
    for (const { line, text } of addedLines(file.before, file.after)) {
      for (const rule of SECRET_RULES) {
        if (rule.id === 'private-key' && privateLines.has(line) || credentialMatches(text, rule).length) findings.push({ rule: rule.id, label: rule.label, path: file.path, line });
      }
      if (findings.length >= 20) return findings;
    }
  }
  return findings;
}

/** Live Braid credentials on the same added lines the secret guard inspects. Values never enter findings or logs. */
export function addedBraidTokens(files: { before: string | null; after: string | null }[]): string[] {
  const rule = SECRET_RULES.find(rule => rule.id === 'braid-token')!;
  return [...new Set(files.flatMap(file => file.after === null ? [] : addedLines(file.before, file.after).flatMap(({ text }) => credentialMatches(text, rule, true))))];
}

/** Fixed-size scans bound regex work even on a single huge line. Access tokens are capped at 4096
 * bytes; 8192 bytes of overlap cover them and every provider format, including surrounding syntax. */
function credentialMatches(text: string, rule: SecretRule, complete = false): string[] {
  const found = new Set<string>();
  for (let offset = 0; offset < text.length; offset += 8192) {
    const window = text.slice(offset, offset + 16384);
    for (const match of matches(window, rule)) {
      // Findings can flag a credential prefix; revocation needs the complete value, not a window fragment.
      if (complete && offset + window.length < text.length && match.index + match.value.length === window.length) continue;
      if (!PLACEHOLDER.test(match.value)) found.add(match.value);
    }
  }
  return [...found];
}
