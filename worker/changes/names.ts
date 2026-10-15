import type { BraidEnv } from '../env';
import { hex } from '../http/auth';

/**
 * One repository spreads its changes across shards so that agent traffic for
 * different changes never queues behind a single object. The shard is encoded
 * in each change ID and number, so lookups never need a directory.
 */
export const CHANGE_SHARDS = 16;
export const PATH_SHARDS = 16;

export const changeShardName = (repository: string, shard: number) => `${repository}#changes:${shard}`;
export const pathShardName = (repository: string, shard: number) => `${repository}#paths:${shard}`;
export const trunkName = (repository: string) => `${repository}#trunk`;
export const swarmName = (repository: string) => `${repository}#swarm`;
export const runnerName = (repository: string, job: string) => `${repository}#runner:${job}`;

/** A team repository's key, which names its Workspace and every object that holds its changes. */
export const repositoryKey = (teamId: string, workspaceId: string) => `team:${teamId}:repository:${workspaceId}`;
/** The team and workspace a repository key names, or null for other keys, such as the example's `demo:`. */
export function repositoryParts(key: string | undefined): { teamId: string; workspaceId: string } | null {
  const parts = key ? /^team:([^:]+):repository:([^:]+)$/.exec(key) : null;
  return parts ? { teamId: parts[1], workspaceId: parts[2] } : null;
}

type Options = DurableObjectNamespaceGetDurableObjectOptions;
export const trunkOf = (env: Pick<BraidEnv, 'TRUNKS'>, repository: string, options?: Options) => env.TRUNKS.getByName(trunkName(repository), options);
export const changeShardOf = (env: Pick<BraidEnv, 'CHANGES'>, repository: string, shard: number, options?: Options) => env.CHANGES.getByName(changeShardName(repository, shard), options);
export const pathShardOf = (env: Pick<BraidEnv, 'PATHS'>, repository: string, shard: number) => env.PATHS.getByName(pathShardName(repository, shard));
export const swarmOf = (env: Pick<BraidEnv, 'SWARMS'>, repository: string) => env.SWARMS.getByName(swarmName(repository));

export function hash(text: string, value = 2166136261) {
  for (let i = 0; i < text.length; i++) { value ^= text.charCodeAt(i); value = Math.imul(value, 16777619); }
  return value >>> 0;
}
export const pathShard = (path: string) => hash(path) % PATH_SHARDS;
/** Paths grouped by the path shard that holds them. */
export function byPathShard(paths: string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const path of paths) {
    const shard = pathShard(path), group = groups.get(shard);
    if (group) group.push(path); else groups.set(shard, [path]);
  }
  return groups;
}
/** A retried submission must reach the same shard, so the request key chooses it. */
export const submissionShard = (key: string) => hash(key) % CHANGE_SHARDS;

export function changeId(shard: number) {
  return `ch_${shard.toString(16)}${hex(crypto.getRandomValues(new Uint8Array(6)))}`;
}
/** Change IDs carry their shard; numbers are resolved through the landing queue's block directory. */
export function shardOf(reference: string): number | null {
  const id = reference.match(/^ch_([0-9a-f])[0-9a-f]{12}$/);
  return id ? parseInt(id[1], 16) : null;
}
