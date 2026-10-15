import { setupPrompt } from '../lib/agent-commands';
import { CopyButton } from '../components/ui/CopyButton';

/** Copies the one-line prompt that lets a coding agent walk someone through connecting a repository. */
export function SetupPromptButton({ variant, size, label = 'Copy setup prompt', prompt = setupPrompt() }: { variant?: 'primary' | 'secondary' | 'outline'; size?: 'sm'; label?: string; prompt?: string }) {
  return <CopyButton text={prompt} label={label} variant={variant} size={size} />;
}

/** The guides agents read. They are served by this deployment. */
export function AgentDocs() {
  return (
    <span className="agent-docs">
      {['/setup.md', '/auth.md', '/llms.txt'].map((path) => (
        <a key={path} href={path} target="_blank" rel="noreferrer" className="text-link mono">
          {path.slice(1)}
        </a>
      ))}
    </span>
  );
}
