import type { CommandContext, StricliProcess } from '@stricli/core';
import { redactEmails } from '../../shared/privacy';

/** A failure the person or agent running braid can act on. Its message is printed as it is, without a stack. */
export class CliError extends Error {}
export function fail(message: string): never { throw new CliError(message); }

interface Terminal {
  write(text: string): void;
  readonly isTTY?: boolean;
  readonly columns?: number;
  getColorDepth?(env?: Readonly<Partial<Record<string, string>>>): number;
}

export interface BraidContext extends CommandContext {
  readonly process: StricliProcess & { readonly stdout: Terminal; readonly stderr: Terminal };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signals: Pick<NodeJS.Process, 'on' | 'off'>;
  readonly parentPid: number;
  readonly self: readonly string[];
  readonly script: string;
  readonly input: () => Promise<string>;
}

export const print = (context: BraidContext, text = '') => context.process.stdout.write(`${redactEmails(text)}\n`);
export const note = (context: BraidContext, text: string) => context.process.stderr.write(`${redactEmails(text)}\n`);
