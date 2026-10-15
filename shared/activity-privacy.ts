import { redactPublicText } from './privacy';

/** A model/tool identifier is a name, never a machine path or credential. */
export const safeActivityIdentity = (value: string) => /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,119}$/.test(value) && !value.includes('..') && redactPublicText(value) === value;

/** Only a command's known operation leaves the machine. Never arguments, assignments, scripts or output. */
export function activityCommand(command: string): string {
  const words = command.trim().split(/\s+/);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift();
  const [program, action, script] = words;
  if (/^(npm|pnpm|yarn|bun)$/.test(program ?? '') && /^(test|build|lint|typecheck|check)$/.test(action ?? '')) return `${program} ${action}`;
  if (/^(npm|pnpm|yarn|bun)$/.test(program ?? '') && action === 'run' && /^(test(?::[a-z-]+)?|build|lint|typecheck|check)$/.test(script ?? '')) return `${program} run ${script}`;
  if (program === 'git' && /^(status|diff|log|show|add|commit|fetch|push|pull|rebase|merge|checkout|switch|branch|rev-parse)$/.test(action ?? '')) return `git ${action}`;
  if (/^(pytest|python|python3|node|deno|tsc|vitest|jest|make|cargo|go|ruby|bundle|sh|bash|zsh|curl|wget|ls|cat|rg|sed)$/.test(program ?? '')) return `${program} [arguments omitted]`;
  return '[command omitted]';
}

/** Defense in depth on the receiving side; absolute paths and traversal are never displayed. */
export function activityRelativePath(path: string): string {
  if (!path || path.length > 240 || /[\x00-\x1f\x7f\\:]/.test(path) || path.startsWith('/') || path.startsWith('~') || path.split('/').some(part => part === '..' || part === '.git')) return '[outside repository]';
  return redactPublicText(path);
}
