import type { CommandEvidence, Evidence, EvidenceInput, ScreenshotEvidence } from '../../shared/types';
import { base64Bytes, digest } from '../http/auth';

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
/** The content type an image is served with, by its extension. */
export const imageType = (image: string) => ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' })[image.slice(image.lastIndexOf('.') + 1) as 'png' | 'jpg' | 'webp'];
/** Screenshots can show a private repository, so only the viewer's own browser keeps them; named by hash, they never change. */
export const IMAGE_CACHE = 'private, max-age=31536000, immutable';

/** A command and how it ended, before Braid records the revision, source and time. */
export type CommandRun = Omit<CommandEvidence, 'revision' | 'source' | 'at'>;
/** Evidence as a revision brings it, before Braid records its revision, source and time. */
export type Reported = Omit<ScreenshotEvidence, 'revision' | 'source' | 'at'> | CommandRun;

/** Decodes a revision's screenshots and names each by its hash; the images are stored only once the revision is accepted. */
export async function decodeEvidence(inputs: EvidenceInput[]): Promise<{ items: Reported[]; images: Map<string, Uint8Array> }> {
  const items: Reported[] = [], images = new Map<string, Uint8Array>();
  for (const input of inputs) {
    if (input.kind === 'command') { items.push(input); continue; }
    const { data, contentType, ...rest } = input;
    const bytes = base64Bytes(data);
    const image = `${await digest(bytes)}.${EXTENSIONS[contentType]}`;
    images.set(image, bytes);
    items.push({ ...rest, image });
  }
  return { items, images };
}

/** The most evidence a change keeps across its revisions; the current revision's always stays. */
const KEPT = { items: 48, output: 96_000 };
/**
 * A change's evidence after a revision adds to it: all of the current
 * revision's, then earlier revisions' newest first while they fit, so a
 * change revised many times stays small enough to read and poll.
 */
export function keptEvidence(evidence: Evidence[], revision: number): Evidence[] {
  const current = evidence.filter(item => item.revision === revision);
  let items = current.length, output = current.reduce((sum, item) => sum + (item.kind === 'command' ? item.output.length : 0), 0);
  const kept = new Set(current);
  for (const item of evidence.filter(item => item.revision !== revision).reverse()) {
    const size = item.kind === 'command' ? item.output.length : 0;
    if (items + 1 > KEPT.items || output + size > KEPT.output) break;
    items++; output += size; kept.add(item);
  }
  return evidence.filter(item => kept.has(item));
}

/** The end of a command's output, as a check's detail shows it. */
export const outputTail = (output: string) => output.slice(-1500).trim();
