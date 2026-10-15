// The diff implementation lives in shared/diff.ts so the Worker computes the
// same line counts the review UI renders. This module re-exports it and adds
// the limits that decide whether a text is rendered as rows or offered whole.
export * from '../../shared/diff';

/** Past either limit a text is not split into rows; the person downloads it instead. */
const LARGE_TEXT = { lines: 5_000, bytes: 200 * 1024 } as const;
/** A large text can still be shown on request up to here. Beyond it, only downloads are offered. */
const SHOWABLE_TEXT = { lines: 20_000, bytes: 1024 * 1024 } as const;

export interface TextSize {
  lines: number;
  bytes: number;
}

/**
 * Lines and UTF-8 bytes in one pass, without allocating a string per line. Lines are
 * counted the way the diff splits them: a trailing newline ends the last line rather
 * than starting an empty one.
 */
export function textSize(text: string): TextSize {
  let lines = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) lines++;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  if (text.length && text.charCodeAt(text.length - 1) !== 10) lines++;
  return { lines, bytes };
}

export function isLargeText(size: TextSize): boolean {
  return size.lines > LARGE_TEXT.lines || size.bytes > LARGE_TEXT.bytes;
}

export function isShowableText(size: TextSize): boolean {
  return size.lines <= SHOWABLE_TEXT.lines && size.bytes <= SHOWABLE_TEXT.bytes;
}
