import { redactPublicText } from '../../shared/privacy';

/** Redact before bounding, so truncation cannot leave part of a credential behind. */
export function redactHostedText(value: string, secrets: string[] = []): string {
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  return redactPublicText(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w-]*)["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/([?&](?:signature|sig|key|code|x-amz-[\w-]+)=)[^\s&#"']+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]'))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Streaming tail retains the end of output, including after its capture limit. */
export class HostedOutputTail {
  private lines: string[] = [];
  private pending = '';
  private key = false;
  private keyLine = false;
  private markers = '';
  private oversized = false;
  constructor(private secrets: string[] = []) {}
  write(chunk: string) {
    const pieces = chunk.replace(/\r\n/g, '\n').split('\n');
    for (let index = 0; index < pieces.length; index++) {
      const scan = this.markers + pieces[index];
      for (const marker of scan.matchAll(/-----(BEGIN|END) (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/g)) {
        this.keyLine = true; this.key = marker[1] === 'BEGIN';
      }
      this.markers = scan.slice(-100);
      // Retain the beginning for PEM markers even when a line exceeds the bound.
      if (!this.oversized) this.pending += pieces[index].slice(0, Math.max(0, 8192 - this.pending.length));
      if (this.pending.length === 8192) this.oversized = true;
      if (index < pieces.length - 1) this.line();
    }
  }
  private line() {
    const text = this.pending;
    this.lines.push(this.key || this.keyLine || this.oversized ? '[redacted]' : redactHostedText(text, this.secrets));
    this.lines = this.lines.slice(-40);
    this.pending = ''; this.oversized = false; this.keyLine = false; this.markers = '';
  }
  finish() { if (this.pending || this.oversized) this.line(); return this.lines.map(line => line.length > 390 ? `${line.slice(0, 377)} [truncated]` : line).join('\n'); }
}
export function hostedOutput(value: string, secrets: string[] = []) { const tail = new HostedOutputTail(secrets); tail.write(value); return tail.finish(); }
