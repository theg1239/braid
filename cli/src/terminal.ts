import type { BraidContext } from './context';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Text from a server, a repository or a command as it may safely reach a terminal: no escape sequences or control characters. */
/** A count with its noun, as people read it: `1 file`, `111,068 lines`. */
export const count = (n: number, noun: string) => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
export const plain = (text: string) => text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(CONTROL, '');
/** A command's output as a person read it: plain text, with a line redrawn by carriage returns as it ended. */
export const screenText = (text: string) => text.replace(ANSI, '').replace(/\r\n/g, '\n').split('\n').map(row => row.split('\r').findLast(Boolean) ?? '').join('\n').replace(CONTROL, '');

/** One line of text at most `width` characters long, ending in an ellipsis when cut. */
function clip(text: string, width: number) {
  const characters = [...text];
  return characters.length <= width ? text : `${characters.slice(0, Math.max(0, width - 1)).join('')}…`;
}
export function fitLast(context: BraidContext, rows: string[][]) {
  if (!rows.length) return;
  const last = rows[0].length - 1, width = context.process.stdout.isTTY ? context.process.stdout.columns ?? 120 : 120;
  let fixed = 0;
  for (let column = 0; column < last; column++) fixed += Math.max(...rows.map(row => [...row[column]].length)) + 2;
  for (const row of rows) row[last] = clip(row[last], Math.max(20, width - fixed));
}
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - [...text].length));

/** Colour for stdout when it is a terminal that wants it; NO_COLOR and FORCE_COLOR are honoured. */
export function colours(context: BraidContext) {
  const { env, process } = context;
  const enabled = env.FORCE_COLOR ? env.FORCE_COLOR !== '0' : !env.NO_COLOR && env.TERM !== 'dumb' && process.stdout.isTTY === true;
  const style = (open: number, close: number) => (text: string) => enabled && text ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return { dim: style(2, 22), bold: style(1, 22), yellow: style(33, 39), cyan: style(36, 39) };
}

/** How long ago, in the fewest characters: `now`, `5m`, `3h`, `2d`, `6w`, `5mo`, `2y`. */
export function age(at: string, now: number) {
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  const units: [number, string][] = [[365 * 86_400, 'y'], [30 * 86_400, 'mo'], [7 * 86_400, 'w'], [86_400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [size, unit] of units) if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
  return 'now';
}

/**
 * Rows as aligned columns. Cells come from commits and servers, so each is reduced to plain text on one line first;
 * every column but the last is padded to its widest cell, and `style` colours a cell after its width is measured, so
 * escape codes never skew the alignment.
 */
export function columns(rows: string[][], style: ((cell: string, column: number, row: number) => string) = cell => cell) {
  const cells = rows.map(row => row.map(cell => plain(cell).replace(/\s/g, ' ')));
  const widths = cells.reduce<number[]>((max, row) => row.map((cell, index) => Math.max(max[index] ?? 0, [...cell].length)), []);
  return cells.map((row, index) => row.map((cell, column) => style(column === row.length - 1 ? cell : pad(cell, widths[column]), column, index)).join('  ').trimEnd());
}

/** A command line quoted for a POSIX shell, so it can be pasted as printed. */
export function shellCommand(words: readonly string[]) {
  return words.map(word => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
}
