import { buildApplication, buildCommand, buildRouteMap, help, run, text_en, version } from '@stricli/core';
import { version as current } from '../package.json';
import { CliError, type BraidContext } from './context';
import { agentRoutes } from './commands/agent';
import { blameCommand } from './commands/blame';
import { restackCommand, statusCommand, syncCommand, waitCommand } from './commands/follow';
import { hookRoutes } from './commands/hook';
import { initCommand } from './commands/init';
import { instructionRoutes } from './commands/instructions';
import { logCommand } from './commands/log';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login';
import { submitCommand } from './commands/submit';
import { statsCommand } from './commands/stats';
import { taskRoutes } from './commands/task';
import { credentialCommand } from './commands/credential';
import { redact } from './secrets';
import { plain } from './terminal';

/** `braid help [command]`: the same help as `--help`. */
const helpCommand = buildCommand({
  func: async function (this: BraidContext, _flags: Record<never, never>, ...topic: string[]) { await run(app, [...topic, '--help'], this); },
  parameters: { positional: { kind: 'array', parameter: { brief: 'A command, such as submit or agent run', parse: String, placeholder: 'command' } } },
  docs: { brief: 'Show help for braid or one of its commands' },
});

const routes = buildRouteMap({
  routes: {
    login: loginCommand, logout: logoutCommand, whoami: whoamiCommand, init: initCommand,
    restack: restackCommand, agent: agentRoutes, submit: submitCommand, status: statusCommand, wait: waitCommand, sync: syncCommand, task: taskRoutes,
    blame: blameCommand, stats: statsCommand, log: logCommand, instructions: instructionRoutes, help: helpCommand,
    hook: hookRoutes, 'git-credential': credentialCommand,
  },
  // braid.mjs and the guides call signing in `connect`.
  aliases: { connect: 'login' },
  docs: {
    brief: 'Braid: agents and people changing one repository, with every line traced to who wrote it',
    hideRoute: { hook: true, 'git-credential': true },
  },
});

/** Failures braid explains are printed as they are; anything else is a bug, shown without a stack or any secret. */
const failure = (error: unknown) => redact(plain(error instanceof CliError ? error.message : `braid failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`));
const formatting = { caseStyle: 'convert-camel-to-kebab', useAliasInUsageLine: false, onlyRequiredInUsageLine: false } as const;

export const app = buildApplication(routes, {
  name: 'braid',
  scanner: { caseStyle: 'allow-kebab-for-camel', allowArgumentEscapeSequence: true },
  localization: { text: { ...text_en, exceptionWhileRunningCommand: failure, commandErrorResult: failure } },
}, {
  help: help({ brief: text_en.briefs.help, alias: 'h', defaultForRouteMap: true, formatting }),
  version: version({ brief: text_en.briefs.version, alias: 'v', info: { currentVersion: current } }),
});
