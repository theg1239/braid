import type { Workspace } from './workspace/workspace';
import type { Security } from './accounts/security';
import type { Directory } from './accounts/directory';
import type { ChangeShard } from './changes/shard';
import type { Trunk } from './changes/trunk';
import type { PathIndex } from './changes/paths';
import type { Swarm } from './changes/swarm';
import type { GitHubRepo } from './github/webhook';
import type { VerifyParams } from './changes/verify';
import { HttpError } from './errors';
/** The deployment's public HTTPS origin, which signed-in sessions, links in email and GitHub's callbacks all use. */
export function publicOrigin(env: Pick<BraidEnv, 'PUBLIC_ORIGIN' | 'SESSION_SECRET'>): URL {
  const url = URL.parse(env.PUBLIC_ORIGIN);
  if (!url) throw new HttpError(503, 'The public application URL is not configured.');
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new HttpError(503, 'Configure an HTTPS application origin.');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(503, 'The session signing secret is not configured.');
  return url;
}

/** The one Directory and the one Security object that every request and object shares. */
export const directoryOf = (env: Pick<BraidEnv, 'DIRECTORY'>) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory-v1'));
export const securityOf = (env: Pick<BraidEnv, 'SECURITY'>) => env.SECURITY.get(env.SECURITY.idFromName('security-v1'));

/**
 * A stub whose methods pass their answers through `answered`. A stub answers every property remotely, `bind` and
 * `then` included, so each method is called on the stub itself and the wrapper is never mistaken for a promise.
 */
function answering<T extends object>(stub: T, answered: (method: string, answer: unknown) => unknown): T {
  return new Proxy(stub, { get(target, prop) {
    if (prop === 'then') return undefined;
    const value = Reflect.get(target, prop);
    if (typeof value !== 'function') return value;
    const call = (...args: unknown[]) => (target as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[prop](...args);
    return typeof prop === 'symbol' ? call : async (...args: unknown[]) => answered(prop, await call(...args));
  } });
}
/** Runs the disposer workerd puts on an object an RPC call returns. Its data stays readable. */
const disposed = (answer: unknown) => { (answer as Partial<Disposable> | null)?.[Symbol.dispose]?.(); return answer; };
/**
 * The Artifacts binding. Each object an Artifacts call returns comes with a disposer that workerd expects the caller
 * to run; left to garbage collection, the call is held until the request ends and workerd logs "An RPC result was not
 * disposed properly".
 * These handles run it as each answer arrives, so callers read plain data. A repository from `get` is itself a stub,
 * held with `using`.
 */
export const artifactsOf = (env: Pick<BraidEnv, 'ARTIFACTS'>): Artifacts =>
  answering(env.ARTIFACTS, (method, answer) => method === 'get' ? answering(answer as ArtifactsRepo, (_, data) => disposed(data)) : disposed(answer));
export interface RunParams { workspaceId: string; missionId: string; action: 'run' | 'merge'; agentIds: string[]; operationId?: string }
export interface BraidEnv {
  WORKSPACES: DurableObjectNamespace<Workspace>;
  SECURITY: DurableObjectNamespace<Security>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  CHANGES: DurableObjectNamespace<ChangeShard>;
  TRUNKS: DurableObjectNamespace<Trunk>;
  PATHS: DurableObjectNamespace<PathIndex>;
  SWARMS: DurableObjectNamespace<Swarm>;
  GITHUB_REPOS: DurableObjectNamespace<GitHubRepo>;
  VERIFICATIONS: Workflow<VerifyParams>;
  MISSIONS: Workflow<RunParams>;
  ARTIFACTS: Artifacts;
  AI: Ai;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  LIVE_ENABLED: string;
  AI_MODEL: string;
  REVIEW_MODEL: string;
  ARTIFACTS_NAMESPACE: string;
  AUTH_MODE: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_OWNER_EMAILS: string;
  DAILY_TASK_LIMIT: string;
  GLOBAL_DAILY_TASK_LIMIT: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  /** The operator's key for seeding mirrors past the visitor admission budget; declared only where an operator seeds. */
  MIRROR_SEED_TOKEN?: string;
  SESSION_SECRET: string;
  PUBLIC_ORIGIN: string;
  SIGNUP_ENABLED: string;
  EMAIL?: SendEmail;
  /** Per-location request throttles; absent in tests, where the Security object's budgets apply instead. */
  IP_LIMITER?: RateLimit;
  ANONYMOUS_LIMITER?: RateLimit;
  PUBLIC_EXPENSIVE_LIMITER?: RateLimit;
  AGENT_LIMITER?: RateLimit;
  EMAIL_FROM: string;
  /** Set per deploy by cloudflare.config.ts; the shared example's copies and cached answers are keyed by it. Absent in tests. */
  BUILD_ID?: string;
}
