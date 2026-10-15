import { addedBraidTokens, secretFindings } from '../../shared/secrets';
import type { GuardFinding } from '../../shared/guards';

/** Scan every byte without retaining the blob. Overlap keeps credentials crossing stream boundaries visible. */
export async function scanBlob(path: string, blob: Blob) {
  const reader = blob.stream().getReader(), decoder = new TextDecoder(), tokens = new Set<string>();
  const findings: GuardFinding[] = [];
  let tail = '';
  const scan = (text: string) => {
    const file = { path, before: null, after: text };
    for (const token of addedBraidTokens([file])) tokens.add(token);
    for (const secret of secretFindings([file])) if (findings.length < 20)
      findings.push({ kind: 'secrets', path, detail: `Contains what looks like a ${secret.label} in ${path}.` });
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { scan(tail + decoder.decode()); break; }
      // A stream can deliver a large chunk. Slice it before decoding or scanning it.
      for (let offset = 0; offset < value.length; offset += 32_768) {
        const text = tail + decoder.decode(value.subarray(offset, offset + 32_768), { stream: true });
        scan(text); tail = text.slice(-8_192);
      }
    }
  } finally { reader.releaseLock(); }
  return { findings, tokens: [...tokens] };
}
